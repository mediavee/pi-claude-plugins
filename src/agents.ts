import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { isDirectory, resolveComponentPaths } from "./manifest.ts";
import { substituteClaudeVars } from "./substitute.ts";
import { DEFAULT_PI_TOOLS, mapClaudeToolList } from "./tool-names.ts";
import type { PluginAgent, PluginManifest, SubstitutionVars } from "./types.ts";

/** Refused for plugin-shipped agents upstream, so refused here too. */
const FORBIDDEN_FRONTMATTER = ["hooks", "mcpServers", "permissionMode"] as const;

/** Fields that constrain an agent; ignoring one would run it with more freedom than declared. */
const RESTRICTING_FRONTMATTER = ["isolation", "maxTurns", "memory", "skills", "background"] as const;

const THINKING_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

const KILL_GRACE_MS = 2_000;
const MAX_OUTPUT_BYTES = 1_000_000;

export interface AgentDiscovery {
	agents: PluginAgent[];
	escaped: string[];
	warnings: string[];
}

export function discoverAgents(
	plugin: string,
	root: string,
	manifest: PluginManifest,
	vars: SubstitutionVars,
): AgentDiscovery {
	const resolved = resolveComponentPaths(root, manifest.agents, "agents", "replace");
	const agents: PluginAgent[] = [];
	const warnings: string[] = [...resolved.invalid];

	for (const path of resolved.paths) {
		for (const file of markdownFiles(path)) {
			const parsed = parseAgent(plugin, file, vars);
			if (parsed.agent) agents.push(parsed.agent);
			warnings.push(...parsed.warnings);
		}
	}
	return { agents, escaped: resolved.escaped, warnings };
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

function parseAgent(
	plugin: string,
	file: string,
	vars: SubstitutionVars,
): { agent?: PluginAgent; warnings: string[] } {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return { warnings: [`agent ${basename(file)} could not be read`] };
	}

	const warnings: string[] = [];
	let frontmatter: Record<string, unknown> = {};
	let body = raw;
	try {
		const parsed = parseFrontmatter<Record<string, unknown>>(raw);
		frontmatter = parsed.frontmatter;
		body = parsed.body;
	} catch {
		// Claude Code still loads a plugin agent whose frontmatter fails to parse, using the
		// file name and ignoring every declared field.
		warnings.push(`agent ${basename(file)} has unparseable frontmatter; every field ignored`);
		frontmatter = {};
		body = raw;
	}

	const name =
		typeof frontmatter.name === "string" && frontmatter.name.length > 0
			? frontmatter.name
			: basename(file, ".md");

	for (const key of FORBIDDEN_FRONTMATTER) {
		if (key in frontmatter) warnings.push(`agent ${name} declares "${key}", which plugins may not set`);
	}

	// A restriction pi cannot honour must not be silently dropped: the agent would then run
	// with wider access than its author declared.
	for (const key of RESTRICTING_FRONTMATTER) {
		if (key in frontmatter) {
			warnings.push(`agent ${name} declares "${key}", which pi cannot honour; the agent is not loaded`);
			return { warnings };
		}
	}

	const { tools, dropped } = mapClaudeToolList(toolList(frontmatter.tools));
	if (dropped.length > 0) {
		warnings.push(`agent ${name} requests tools with no pi equivalent: ${dropped.join(", ")}`);
	}
	if ("tools" in frontmatter && tools.length === 0) {
		warnings.push(`agent ${name} restricts itself to tools pi does not provide; the agent is not loaded`);
		return { warnings };
	}

	const disallowed = mapClaudeToolList(toolList(frontmatter.disallowedTools));
	if (disallowed.dropped.length > 0) {
		warnings.push(`agent ${name} disallows tools with no pi equivalent: ${disallowed.dropped.join(", ")}`);
	}

	const effort = typeof frontmatter.effort === "string" ? frontmatter.effort : undefined;
	if (effort !== undefined && !THINKING_LEVELS.has(effort)) {
		warnings.push(`agent ${name} requests effort "${effort}", which has no pi thinking level`);
	}

	const agent: PluginAgent = {
		plugin,
		name,
		path: file,
		description:
			typeof frontmatter.description === "string"
				? frontmatter.description
				: `Agent from the ${plugin} plugin`,
		systemPrompt: substituteClaudeVars(body, vars),
		...(typeof frontmatter.model === "string" ? { model: frontmatter.model } : {}),
		...(effort !== undefined && THINKING_LEVELS.has(effort) ? { thinkingLevel: effort } : {}),
		...(tools.length > 0 ? { tools } : {}),
		...(disallowed.tools.length > 0 ? { excludeTools: disallowed.tools } : {}),
	};
	return { agent, warnings };
}

function toolList(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
	if (typeof value === "string") return value.split(/[\s,]+/).filter((item) => item.length > 0);
	return [];
}

export interface RunAgentOptions {
	agent: PluginAgent;
	task: string;
	cwd: string;
	signal?: AbortSignal;
	/** Model inherited from the dispatching session when the agent declares none. */
	fallbackModel?: string;
	onText?: (text: string) => void;
}

/**
 * Without an explicit allowlist the child falls back to pi's full default tool set, which is
 * wider than an author who wrote `disallowedTools` expects.
 */
export function agentInvocationArgs(agent: PluginAgent, fallbackModel: string | undefined): string[] {
	const args = ["--mode", "json", "-p", "--no-session"];

	const model = agent.model ?? fallbackModel;
	if (model) args.push("--model", model);
	if (agent.thinkingLevel) args.push("--thinking", agent.thinkingLevel);

	const allowed = agent.tools ?? [...DEFAULT_PI_TOOLS];
	const effective = allowed.filter((tool) => !agent.excludeTools?.includes(tool));
	if (effective.length > 0) args.push("--tools", effective.join(","));
	else args.push("--no-tools");

	return args;
}

export interface RunAgentResult {
	output: string;
	exitCode: number;
	stderr: string;
}

/**
 * Runs an agent in a child `pi` process so it gets its own context window, mirroring pi's own
 * subagent example. `--mode json` gives one JSON object per line to stream from.
 */
export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
	const { agent } = options;
	const args = agentInvocationArgs(agent, options.fallbackModel);

	let promptDir: string | undefined;
	try {
		if (agent.systemPrompt.trim().length > 0) {
			promptDir = mkdtempSync(join(tmpdir(), "pi-claude-plugins-"));
			const promptFile = join(promptDir, `${agent.name.replace(/[^\w.-]+/g, "_")}.md`);
			writeFileSync(promptFile, agent.systemPrompt, { encoding: "utf8", mode: 0o600 });
			args.push("--append-system-prompt", promptFile);
		}
		args.push(`Task: ${options.task}`);
		return await spawnPi(args, options);
	} finally {
		if (promptDir) rmSync(promptDir, { recursive: true, force: true });
	}
}

/** Prefer the running script so the child is the same pi build as the parent. */
export function piInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/root/") && existsSync(script)) {
		return { command: process.execPath, args: [script, ...args] };
	}
	const runtime = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(runtime)) return { command: process.execPath, args };
	return { command: "pi", args };
}

function spawnPi(args: string[], options: RunAgentOptions): Promise<RunAgentResult> {
	return new Promise((resolvePromise) => {
		const invocation = piInvocation(args);
		const child = spawn(invocation.command, invocation.args, {
			cwd: options.cwd,
			shell: false,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});

		const texts: string[] = [];
		let stderr = "";
		let buffer = "";
		let killScheduled = false;

		const signalGroup = (signal: NodeJS.Signals) => {
			if (child.pid === undefined) return;
			try {
				if (process.platform === "win32") child.kill(signal);
				else process.kill(-child.pid, signal);
			} catch {
				// The process group is already gone.
			}
		};

		// A child that ignores SIGTERM would otherwise keep the tool call pending forever.
		const onAbort = () => {
			signalGroup("SIGTERM");
			if (killScheduled) return;
			killScheduled = true;
			setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS).unref();
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				const text = assistantText(line);
				if (text) {
					texts.push(text);
					options.onText?.(text);
				}
				newline = buffer.indexOf("\n");
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk;
		});

		const finish = (exitCode: number) => {
			options.signal?.removeEventListener("abort", onAbort);
			resolvePromise({ output: texts.join("\n").trim(), exitCode, stderr: stderr.trim() });
		};
		child.on("error", (error) => {
			stderr += `${stderr ? "\n" : ""}${error.message}`;
			finish(1);
		});
		child.on("close", (code) => finish(code ?? 1));
	});
}

interface JsonModeEvent {
	type?: string;
	message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
}

function assistantText(line: string): string | undefined {
	if (!line.trim()) return undefined;
	let event: JsonModeEvent;
	try {
		event = JSON.parse(line) as JsonModeEvent;
	} catch {
		return undefined;
	}
	if (event.type !== "message_end" || event.message?.role !== "assistant") return undefined;
	const text = (event.message.content ?? [])
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("");
	return text.trim() || undefined;
}

export function resolveAgent(agents: readonly PluginAgent[], requested: string): PluginAgent | undefined {
	const [maybePlugin, ...rest] = requested.split(":");
	if (rest.length > 0) {
		const bare = rest.join(":");
		return agents.find((agent) => agent.plugin === maybePlugin && agent.name === bare);
	}
	return agents.find((agent) => agent.name === requested);
}
