import type { SubstitutionVars } from "./types.ts";

const CLAUDE_PLACEHOLDER = /\$\{(CLAUDE_[A-Z0-9_]*)\}/g;
const ENV_PLACEHOLDER = /\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Expands only the documented `${CLAUDE_*}` placeholders.
 *
 * Skill, command, agent and hook content must never reach through to the process environment:
 * a plugin body that expanded `${AWS_SECRET_ACCESS_KEY}` would copy the value straight into the
 * model prompt. Claude Code confines generic `${VAR}` expansion to MCP configuration.
 */
export function substituteClaudeVars(input: string, vars: SubstitutionVars): string {
	return input.replace(CLAUDE_PLACEHOLDER, (match, name: string) => {
		const known = (vars as unknown as Record<string, string | undefined>)[name];
		return known ?? match;
	});
}

export function substituteClaudeVarsDeep<T>(value: T, vars: SubstitutionVars): T {
	return mapStrings(value, (text) => substituteClaudeVars(text, vars));
}

export interface EnvSubstituteOptions {
	env: NodeJS.ProcessEnv;
	/** Collects names that had neither a value nor a default, as Claude Code warns about. */
	unresolved?: string[];
}

/** `${CLAUDE_*}` plus Claude's `${VAR}` / `${VAR:-default}` MCP syntax. */
export function substituteEnv(input: string, vars: SubstitutionVars, options: EnvSubstituteOptions): string {
	return substituteClaudeVars(input, vars).replace(
		ENV_PLACEHOLDER,
		(match, name: string, fallback: string | undefined) => {
			const fromEnv = options.env[name];
			if (fromEnv !== undefined) return fromEnv;
			if (fallback !== undefined) return fallback;
			options.unresolved?.push(name);
			return match;
		},
	);
}

export function substituteEnvDeep<T>(value: T, vars: SubstitutionVars, options: EnvSubstituteOptions): T {
	return mapStrings(value, (text) => substituteEnv(text, vars, options));
}

function mapStrings<T>(value: T, transform: (text: string) => string): T {
	if (typeof value === "string") return transform(value) as T;
	if (Array.isArray(value)) return value.map((item) => mapStrings(item, transform)) as T;
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) out[key] = mapStrings(item, transform);
		return out as T;
	}
	return value;
}
