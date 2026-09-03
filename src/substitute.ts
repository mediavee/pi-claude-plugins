import type { SubstitutionVars } from "./types.ts";

const PLACEHOLDER = /\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/g;

export interface SubstituteOptions {
	/** Environment consulted for `${VAR}` once the CLAUDE_* names are exhausted. */
	env?: NodeJS.ProcessEnv;
	/** Names left as literal text when unresolved, instead of being reported. */
	unresolved?: string[];
}

/**
 * Expands `${CLAUDE_*}` plugin placeholders and Claude's `${VAR}` / `${VAR:-default}`
 * environment syntax. An unresolved reference is kept verbatim, as Claude Code does, so a
 * missing variable degrades the value instead of failing the load.
 */
export function substitute(input: string, vars: SubstitutionVars, options: SubstituteOptions = {}): string {
	const env = options.env;
	return input.replace(PLACEHOLDER, (match, name: string, fallback: string | undefined) => {
		const known = (vars as unknown as Record<string, string | undefined>)[name];
		if (known !== undefined) return known;
		const fromEnv = env?.[name];
		if (fromEnv !== undefined) return fromEnv;
		if (fallback !== undefined) return fallback;
		options.unresolved?.push(name);
		return match;
	});
}

export function substituteDeep<T>(value: T, vars: SubstitutionVars, options: SubstituteOptions = {}): T {
	if (typeof value === "string") return substitute(value, vars, options) as T;
	if (Array.isArray(value)) return value.map((item) => substituteDeep(item, vars, options)) as T;
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) out[key] = substituteDeep(item, vars, options);
		return out as T;
	}
	return value;
}
