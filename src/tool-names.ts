import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";

/**
 * Claude Code and pi name the same tools differently and shape their inputs differently.
 * Hook matchers and `tool_input` payloads written for Claude Code must see Claude's vocabulary,
 * so every crossing of that boundary goes through this module.
 */

const CLAUDE_TO_PI: Record<string, string> = {
	Read: "read",
	Write: "write",
	Edit: "edit",
	MultiEdit: "edit",
	NotebookEdit: "edit",
	Bash: "bash",
	BashOutput: "bash",
	PowerShell: "powershell",
	Glob: "find",
	Grep: "grep",
	LS: "ls",
	Ls: "ls",
};

const PI_TO_CLAUDE: Record<string, string> = {
	read: "Read",
	write: "Write",
	edit: "Edit",
	bash: "Bash",
	powershell: "PowerShell",
	find: "Glob",
	grep: "Grep",
	ls: "LS",
};

/** pi's built-in tools, the set a child process gets when no `--tools` allowlist is passed. */
export const DEFAULT_PI_TOOLS: readonly string[] = ["read", "write", "edit", "bash", "find", "grep", "ls"];

export function claudeToolToPi(name: string): string | undefined {
	return CLAUDE_TO_PI[name];
}

/** Falls back to the pi name so extension-registered and MCP tools keep an identity. */
export function piToolToClaude(name: string): string {
	return PI_TO_CLAUDE[name] ?? name;
}

export interface ToolNameMapping {
	tools: string[];
	dropped: string[];
}

export function mapClaudeToolList(names: readonly string[]): ToolNameMapping {
	const tools: string[] = [];
	const dropped: string[] = [];
	for (const name of names) {
		const mapped = CLAUDE_TO_PI[name];
		if (mapped === undefined) {
			dropped.push(name);
			continue;
		}
		if (!tools.includes(mapped)) tools.push(mapped);
	}
	return { tools, dropped };
}

type Json = Record<string, unknown>;

function rename(input: Json, from: string, to: string, transform?: (value: unknown) => unknown): Json {
	if (!(from in input)) return input;
	const { [from]: value, ...rest } = input;
	return { ...rest, [to]: transform ? transform(value) : value };
}

const FILE_TOOLS = new Set(["read", "write", "edit", "ls"]);

/**
 * pi tool input -> the shape a Claude Code hook expects to read.
 *
 * The path is made absolute because Claude Code guarantees that for the file tools, so a hook
 * that gates on a path prefix cannot be bypassed by spelling the same file relatively.
 */
export function piInputToClaude(piTool: string, input: Json, cwd: string): Json {
	if (!FILE_TOOLS.has(piTool)) return input;
	return rename(input, "path", "file_path", (value) =>
		typeof value === "string" ? absolutePath(value, cwd) : value,
	);
}

function absolutePath(value: string, cwd: string): string {
	const expanded = value === "~" || value.startsWith("~/") ? join(homedir(), value.slice(1)) : value;
	return isAbsolute(expanded) ? normalize(expanded) : resolve(cwd, expanded);
}

/** A hook's `updatedInput` -> the shape pi's tool actually validates. */
export function claudeInputToPi(piTool: string, input: Json): Json {
	switch (piTool) {
		case "read":
		case "write":
		case "edit":
		case "ls":
			return rename(input, "file_path", "path");
		default:
			return input;
	}
}
