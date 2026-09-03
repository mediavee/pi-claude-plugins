import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { isDirectory, resolveComponentPaths } from "./manifest.ts";
import { substitute } from "./substitute.ts";
import type { PluginCommand, PluginManifest, SubstitutionVars } from "./types.ts";

export const SHELL_DISABLED_MARKER = "[shell command execution disabled by pi-claude-plugins]";

export interface CommandDiscovery {
	commands: PluginCommand[];
	escaped: string[];
}

export function discoverCommands(plugin: string, root: string, manifest: PluginManifest): CommandDiscovery {
	const { paths, escaped } = resolveComponentPaths(root, manifest.commands, "commands", "replace");
	const commands: PluginCommand[] = [];
	for (const path of paths) {
		for (const file of markdownFiles(path)) {
			const command = parseCommand(plugin, file);
			if (command) commands.push(command);
		}
	}
	return { commands, escaped };
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

function parseCommand(plugin: string, file: string): PluginCommand | undefined {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(raw);
	const name =
		typeof frontmatter.name === "string" && frontmatter.name.length > 0
			? frontmatter.name
			: basename(file, ".md");

	return {
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

const INDEXED = /\$ARGUMENTS\[(\d+)\]/g;
const POSITIONAL = /\$(\d+)/g;

export interface ArgumentExpansion {
	text: string;
	/** False when no placeholder consumed an argument, mirroring Claude's ARGUMENTS: fallback. */
	consumed: boolean;
}

/**
 * Claude Code indexes skill arguments from zero (`$0` is the first argument), unlike pi's
 * one-based prompt templates. Content authored for Claude Code must keep its own base.
 */
export function expandArguments(
	body: string,
	rawArguments: string,
	argumentNames: readonly string[],
): ArgumentExpansion {
	const args = splitArguments(rawArguments);
	const trimmed = rawArguments.trim();
	let consumed = false;

	const take = (index: number): string | undefined => {
		const value = args[index];
		if (value === undefined) return undefined;
		consumed = true;
		return value;
	};

	let text = body.replace(INDEXED, (match, index: string) => take(Number(index)) ?? match);

	text = text.replace(/\$ARGUMENTS\b/g, () => {
		if (trimmed.length > 0) consumed = true;
		return trimmed;
	});

	for (const [position, name] of argumentNames.entries()) {
		const pattern = new RegExp(`\\$${escapeRegExp(name)}\\b`, "g");
		text = text.replace(pattern, () => {
			consumed = true;
			return args[position] ?? "";
		});
	}

	text = text.replace(POSITIONAL, (match, index: string) => take(Number(index)) ?? match);

	if (!consumed && trimmed.length > 0) {
		text = `${text.replace(/\s+$/, "")}\n\nARGUMENTS: ${trimmed}`;
	}
	return { text, consumed };
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const INLINE_SHELL = /!`([^`]+)`/g;
const FENCED_SHELL = /```!\n([\s\S]*?)```/g;
const SHELL_SLOT = /\uE000(\d+)\uE000/g;

export type ShellRunner = (command: string) => Promise<string>;

export async function expandShell(body: string, allowed: boolean, run: ShellRunner): Promise<string> {
	const commands: string[] = [];
	const slotFor = (script: string): string => `\uE000${commands.push(script.trim()) - 1}\uE000`;
	const marked = body
		.replace(FENCED_SHELL, (_match, script: string) => slotFor(script))
		.replace(INLINE_SHELL, (_match, command: string) => slotFor(command));

	if (commands.length === 0) return body;
	if (!allowed) return marked.replace(SHELL_SLOT, SHELL_DISABLED_MARKER);

	const outputs = await Promise.all(commands.map((command) => run(command)));
	return marked.replace(SHELL_SLOT, (_match, index: string) => outputs[Number(index)] ?? "");
}

const FILE_REFERENCE = /(?<![\w@/.])@([^\s`"'()]+)/g;

/**
 * `@path` names a file Claude Code attaches to the prompt. pi has no attachment channel for
 * extension-sent messages, so the contents are inlined in a labelled fence instead. A path
 * that does not resolve to a readable file is left as written.
 */
export function expandFileReferences(body: string, cwd: string): string {
	return body.replace(FILE_REFERENCE, (match, path: string) => {
		const absolute = isAbsolute(path) ? path : resolve(cwd, path);
		if (!existsSync(absolute) || isDirectory(absolute)) return match;
		let contents: string;
		try {
			contents = readFileSync(absolute, "utf8");
		} catch {
			return match;
		}
		return `\n\`\`\`\n// ${path}\n${contents.replace(/\s+$/, "")}\n\`\`\`\n`;
	});
}

export interface ExpandCommandOptions {
	command: PluginCommand;
	rawArguments: string;
	vars: SubstitutionVars;
	cwd: string;
	allowShell: boolean;
	run: ShellRunner;
	env?: NodeJS.ProcessEnv;
}

export async function expandCommand(options: ExpandCommandOptions): Promise<string> {
	const substituted = substitute(options.command.body, options.vars, {
		env: options.env ?? process.env,
	});
	const { text } = expandArguments(substituted, options.rawArguments, options.command.argumentNames);
	const shelled = await expandShell(text, options.allowShell, options.run);
	return expandFileReferences(shelled, options.cwd);
}
