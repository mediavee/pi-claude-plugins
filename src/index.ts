import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveAgent, runAgent } from "./agents.ts";
import { expandCommand } from "./commands.ts";
import { resolveSettings } from "./config.ts";
import { loadPlugins } from "./discovery.ts";
import {
	type HookDecision,
	type HookEventName,
	type HookExecution,
	type HookInput,
	hooksFor,
	mergeDecisions,
	plainContext,
	runHook,
} from "./hooks.ts";
import { type McpRegistration, registerMcpServer } from "./mcp.ts";
import { formatReport } from "./report.ts";
import { materialiseSkill, sweepStaleStaging } from "./skills.ts";
import { claudeInputToPi, piInputToClaude, piToolToClaude } from "./tool-names.ts";
import type { LoadedPlugin, PluginAgent, PluginHook, SubstitutionVars } from "./types.ts";

const AGENT_TOOL = "claude_plugin_agent";
const MESSAGE_TYPE = "claude-plugins";
/** Matches Claude Code, which ends a turn after eight consecutive Stop-hook continuations. */
const MAX_STOP_CONTINUATIONS = 8;
const SHELL_TIMEOUT_MS = 120_000;
const MAX_SHELL_OUTPUT_BYTES = 1_000_000;

interface State {
	plugins: LoadedPlugin[];
	hooks: PluginHook[];
	agents: PluginAgent[];
	registrations: McpRegistration[];
	report: string;
	skillPaths: string[];
	dataRoot: string;
	stagingRoot: string;
	pendingContext: string[];
	stopContinuations: number;
	registeredCommands: Set<string>;
	/** Calls a PreToolUse hook denied, so PostToolUse hooks skip them as they do upstream. */
	blockedCalls: Set<string>;
}

function emptyState(): State {
	return {
		plugins: [],
		hooks: [],
		agents: [],
		registrations: [],
		report: "",
		skillPaths: [],
		dataRoot: "",
		stagingRoot: "",
		pendingContext: [],
		stopContinuations: 0,
		registeredCommands: new Set(),
		blockedCalls: new Set(),
	};
}

export default function claudePlugins(pi: ExtensionAPI): void {
	const state = emptyState();

	pi.on("session_start", async (event, ctx) => {
		state.registrations = [];
		state.pendingContext = [];
		state.stopContinuations = 0;
		state.blockedCalls.clear();

		const agentDir = getAgentDir();
		const settings = resolveSettings({
			cwd: ctx.cwd,
			agentDir,
			projectTrusted: ctx.isProjectTrusted(),
		});
		state.dataRoot = resolve(agentDir, "claude-plugins", "data");
		// Staged per process: concurrent headless sessions must not wipe each other's mirrors.
		state.stagingRoot = resolve(agentDir, "claude-plugins", "skills", String(process.pid));
		sweepStaleStaging(dirname(state.stagingRoot));
		rmSync(state.stagingRoot, { recursive: true, force: true });

		const result = loadPlugins({ settings, cwd: ctx.cwd, dataRoot: state.dataRoot });
		state.plugins = result.plugins;
		state.hooks = result.plugins.flatMap((plugin) => plugin.hooks);
		state.agents = result.plugins.flatMap((plugin) => plugin.agents);
		state.skillPaths = resolveSkillPaths(state, ctx);

		registerCommands(pi, state, settings.allowShellCommands, ctx);
		registerAgentTool(pi, state);

		const mcpUnavailable = registerMcpServers(pi, state);
		state.report = formatReport({
			plugins: result.plugins,
			diagnostics: result.diagnostics,
			collisions: result.collisions,
			mcpUnavailable,
			available: result.available,
		});
		announce(ctx, state.report);

		await runSessionStartHooks(pi, state, ctx, event.reason);
	});

	pi.on("session_shutdown", async () => {
		const registrations = state.registrations;
		state.registrations = [];
		await Promise.all(registrations.map((registration) => registration.dispose().catch(() => {})));
		if (state.stagingRoot) rmSync(state.stagingRoot, { recursive: true, force: true });
	});

	pi.on("resources_discover", () => ({ skillPaths: state.skillPaths }));

	pi.registerCommand("claude-plugins", {
		description: "Show which Claude Code plugins are loaded",
		handler: async (_args, ctx) => {
			ctx.ui.notify(state.report || "claude-plugins: nothing loaded yet", "info");
		},
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" as const };
		const hooks = hooksFor(state.hooks, "UserPromptSubmit", undefined);
		if (hooks.length === 0) return { action: "continue" as const };

		const executions = await runHooks(state, ctx, hooks, {
			...baseInput(ctx, "UserPromptSubmit"),
			prompt: event.text,
		});
		const decision = mergeDecisions(executions);
		notifyWarnings(ctx, decision);

		if (decision.outcome === "deny" || decision.terminate) {
			ctx.ui.notify(decision.stopReason ?? decision.reason ?? "prompt blocked by a plugin hook", "warning");
			return { action: "handled" as const };
		}
		// Plain stdout is context on this event, unlike everywhere else.
		state.pendingContext.push(...decision.additionalContext, ...plainContext(executions));
		return { action: "continue" as const };
	});

	pi.on("before_agent_start", () => {
		if (state.pendingContext.length === 0) return;
		const content = state.pendingContext.join("\n\n");
		state.pendingContext = [];
		return { message: { customType: MESSAGE_TYPE, content, display: false } };
	});

	pi.on("tool_call", async (event, ctx) => {
		const claudeName = piToolToClaude(event.toolName);
		const input = event.input as Record<string, unknown>;
		const claudeInput = piInputToClaude(event.toolName, input, ctx.cwd);
		const hooks = hooksFor(state.hooks, "PreToolUse", claudeName, claudeInput);
		if (hooks.length === 0) return;

		const executions = await runHooks(state, ctx, hooks, {
			...baseInput(ctx, "PreToolUse"),
			tool_name: claudeName,
			tool_input: claudeInput,
			tool_use_id: event.toolCallId,
		});
		const decision = mergeDecisions(executions);
		notifyWarnings(ctx, decision);

		if (decision.updatedInput) {
			replaceInput(input, claudeInputToPi(event.toolName, decision.updatedInput));
		}
		for (const context of decision.additionalContext) {
			pi.sendMessage({ customType: MESSAGE_TYPE, content: context, display: false });
		}

		const outcome = await resolveOutcome(ctx, decision, claudeName);
		if (outcome === "deny") {
			state.blockedCalls.add(event.toolCallId);
			return {
				block: true,
				reason: decision.reason ?? "blocked by a plugin hook",
				terminate: decision.terminate,
			};
		}
		if (decision.terminate) ctx.abort();
	});

	pi.on("tool_result", async (event, ctx) => {
		if (state.blockedCalls.delete(event.toolCallId)) return;
		// Claude Code routes a failed call to PostToolUseFailure, an event pi cannot express.
		if (event.isError) return;

		const claudeName = piToolToClaude(event.toolName);
		const claudeInput = piInputToClaude(event.toolName, event.input, ctx.cwd);
		const hooks = hooksFor(state.hooks, "PostToolUse", claudeName, claudeInput);
		if (hooks.length === 0) return;

		const decision = mergeDecisions(
			await runHooks(state, ctx, hooks, {
				...baseInput(ctx, "PostToolUse"),
				tool_name: claudeName,
				tool_input: claudeInput,
				tool_response: toolResponse(event.content, event.details),
				tool_use_id: event.toolCallId,
			}),
		);
		notifyWarnings(ctx, decision);

		if (decision.terminate) ctx.abort();

		if (decision.updatedToolOutput !== undefined) {
			return { content: [{ type: "text" as const, text: renderOutput(decision.updatedToolOutput) }] };
		}
		const extra = [...decision.additionalContext];
		if (decision.outcome === "deny" && decision.reason) extra.push(decision.reason);
		if (extra.length === 0) return;
		return { content: [...event.content, { type: "text" as const, text: extra.join("\n\n") }] };
	});

	pi.on("agent_end", async (event, ctx) => {
		const hooks = hooksFor(state.hooks, "Stop", undefined);
		if (hooks.length === 0) return;
		// Claude Code does not run Stop hooks when the user interrupted the turn.
		if (wasAborted(event.messages)) return;

		const decision = mergeDecisions(
			await runHooks(state, ctx, hooks, {
				...baseInput(ctx, "Stop"),
				stop_hook_active: state.stopContinuations > 0,
				last_assistant_message: lastAssistantText(event.messages),
			}),
		);
		notifyWarnings(ctx, decision);

		// `continue: false` outranks a block: the hook asked to stop, not to keep going.
		if (decision.terminate) {
			state.stopContinuations = 0;
			ctx.ui.notify(decision.stopReason ?? "a plugin hook stopped the run", "warning");
			return;
		}
		if (decision.outcome === "deny" && state.stopContinuations < MAX_STOP_CONTINUATIONS) {
			state.stopContinuations += 1;
			pi.sendMessage(
				{
					customType: MESSAGE_TYPE,
					content: decision.reason ?? "A plugin hook asked you to keep working.",
					display: true,
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
			return;
		}
		state.stopContinuations = 0;
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const trigger = event.reason === "manual" ? "manual" : "auto";
		const hooks = hooksFor(state.hooks, "PreCompact", trigger);
		if (hooks.length === 0) return;

		const decision = mergeDecisions(
			await runHooks(state, ctx, hooks, {
				...baseInput(ctx, "PreCompact"),
				trigger,
				custom_instructions: event.customInstructions ?? null,
			}),
		);
		notifyWarnings(ctx, decision);
		if (decision.outcome === "deny" || decision.terminate) {
			ctx.ui.notify(
				decision.stopReason ?? decision.reason ?? "compaction blocked by a plugin hook",
				"warning",
			);
			return { cancel: true };
		}
	});

	// As in Claude Code, SessionStart runs again after a compaction, whose summary dropped its context.
	pi.on("session_compact", async (_event, ctx) => {
		await runSessionStartHooks(pi, state, ctx, "compact");
	});
}

function announce(ctx: ExtensionContext, message: string): void {
	if (!message) return;
	// stdout carries the JSONL protocol in rpc and json modes, so stderr is the only safe sink.
	if (ctx.mode === "tui") ctx.ui.notify(message, "info");
	else console.error(message);
}

/** pi cannot expand `${CLAUDE_*}`, so a skill that uses one is served from a rewritten mirror. */
function resolveSkillPaths(state: State, ctx: ExtensionContext): string[] {
	const paths: string[] = [];
	for (const plugin of state.plugins) {
		for (const skill of plugin.skills) {
			if (!skill.needsSubstitution) {
				paths.push(skill.path);
				continue;
			}
			const vars: SubstitutionVars = {
				CLAUDE_PLUGIN_ROOT: plugin.root,
				CLAUDE_PLUGIN_DATA: dataDirFor(state, plugin.id),
				CLAUDE_PROJECT_DIR: ctx.cwd,
				CLAUDE_SKILL_DIR: skill.path,
			};
			paths.push(materialiseSkill(skill, state.stagingRoot, vars));
		}
	}
	return paths;
}

function baseInput(ctx: ExtensionContext, event: HookEventName): HookInput {
	return {
		session_id: ctx.sessionManager.getSessionId(),
		cwd: ctx.cwd,
		hook_event_name: event,
		permission_mode: "default",
		transcript_path: ctx.sessionManager.getSessionFile() ?? "",
	};
}

function replaceInput(target: Record<string, unknown>, next: Record<string, unknown>): void {
	for (const key of Object.keys(target)) delete target[key];
	Object.assign(target, next);
}

/** pi reports a rendered result; `details` is the closest thing to Claude's structured response. */
function toolResponse(content: unknown, details: unknown): unknown {
	if (details !== undefined && details !== null && Object.keys(details).length > 0) return details;
	return content;
}

function renderOutput(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value);
}

interface AgentMessageLike {
	role?: string;
	stopReason?: string;
	content?: Array<{ type?: string; text?: string }>;
}

function wasAborted(messages: readonly unknown[]): boolean {
	return messages.some((message) => (message as AgentMessageLike)?.stopReason === "aborted");
}

function lastAssistantText(messages: readonly unknown[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as AgentMessageLike;
		if (message?.role !== "assistant") continue;
		const text = (message.content ?? [])
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text as string)
			.join("");
		if (text) return text;
	}
	return "";
}

/** `${CLAUDE_PLUGIN_DATA}` is created on first reference upstream, so hooks can rely on it. */
function dataDirFor(state: State, plugin: string): string {
	const dir = resolve(state.dataRoot, plugin.replace(/[^\w-]+/g, "-"));
	try {
		mkdirSync(dir, { recursive: true });
	} catch {
		// A hook that needs the directory will report the failure itself.
	}
	return dir;
}

function runHooks(
	state: State,
	ctx: ExtensionContext,
	hooks: readonly PluginHook[],
	input: HookInput,
): Promise<HookExecution[]> {
	return Promise.all(
		hooks.map((hook) =>
			runHook({
				hook,
				input,
				cwd: ctx.cwd,
				projectDir: ctx.cwd,
				dataDir: dataDirFor(state, hook.plugin),
				...(ctx.signal ? { signal: ctx.signal } : {}),
			}),
		),
	);
}

/**
 * Turns an `ask` into a real confirmation. Without a UI there is nobody to ask, so the call is
 * denied: silently allowing it would turn a hook that asked for review into one that approved.
 */
async function resolveOutcome(
	ctx: ExtensionContext,
	decision: HookDecision,
	tool: string,
): Promise<"allow" | "deny"> {
	if (decision.outcome !== "ask") return decision.outcome;
	if (!ctx.hasUI) {
		decision.reason ??= "a plugin hook asked for confirmation and there is no UI to ask in";
		return "deny";
	}
	const allowed = await ctx.ui.confirm(
		`A plugin hook wants confirmation before ${tool}`,
		decision.reason ?? "Allow this tool call?",
	);
	if (allowed) return "allow";
	decision.reason ??= "declined at the plugin hook's confirmation prompt";
	return "deny";
}

function notifyWarnings(ctx: ExtensionContext, decision: HookDecision): void {
	for (const warning of decision.warnings) ctx.ui.notify(warning, "warning");
}

async function runSessionStartHooks(
	pi: ExtensionAPI,
	state: State,
	ctx: ExtensionContext,
	reason: "startup" | "reload" | "new" | "resume" | "fork" | "compact",
): Promise<void> {
	const source = {
		startup: "startup",
		reload: "startup",
		new: "clear",
		resume: "resume",
		fork: "fork",
		compact: "compact",
	}[reason];
	const hooks = hooksFor(state.hooks, "SessionStart", source);
	if (hooks.length === 0) return;

	const executions = await runHooks(state, ctx, hooks, { ...baseInput(ctx, "SessionStart"), source });
	const decision = mergeDecisions(executions);
	notifyWarnings(ctx, decision);
	if (decision.terminate) {
		ctx.ui.notify(decision.stopReason ?? "a plugin hook stopped the session", "warning");
		return;
	}

	const context = [...decision.additionalContext, ...plainContext(executions)];
	if (context.length === 0) return;
	const content = context.join("\n\n");
	// A host that respawns pi per idle period resumes the same session many times: re-sending
	// context the model still sees would stack a copy into the history at every resume.
	if (inActiveContext(ctx, content)) return;
	pi.sendMessage({ customType: MESSAGE_TYPE, content, display: false }, { deliverAs: "nextTurn" });
}

// Only the latest copy counts: a hook whose output went A, B, then A again must resend A.
function inActiveContext(ctx: ExtensionContext, content: string): boolean {
	const latest = ctx.sessionManager
		.buildContextEntries()
		.findLast((entry) => entry.type === "custom_message" && entry.customType === MESSAGE_TYPE);
	return latest?.type === "custom_message" && latest.content === content;
}

function registerCommands(
	pi: ExtensionAPI,
	state: State,
	globalShell: boolean,
	sessionCtx: ExtensionContext,
): void {
	for (const plugin of state.plugins) {
		// The configuration contract promises trustedPlugins grants shell expansion too.
		const allowShell = globalShell || plugin.trusted;
		for (const command of plugin.commands) {
			const invocation = `${plugin.name}:${command.name}`;
			if (state.registeredCommands.has(invocation)) continue;
			state.registeredCommands.add(invocation);

			const vars: SubstitutionVars = {
				CLAUDE_PLUGIN_ROOT: plugin.root,
				CLAUDE_PLUGIN_DATA: dataDirFor(state, plugin.id),
				CLAUDE_PROJECT_DIR: sessionCtx.cwd,
			};

			const description = [command.argumentHint, command.description].filter(Boolean).join(" — ");
			pi.registerCommand(invocation, {
				...(description ? { description } : {}),
				handler: async (args, ctx) => {
					const expanded = await expandCommand({
						command,
						rawArguments: args,
						vars: { ...vars, CLAUDE_SESSION_ID: ctx.sessionManager.getSessionId() },
						cwd: ctx.cwd,
						pluginRoot: plugin.root,
						allowShell,
						run: (shellCommand) => runShell(shellCommand, ctx.cwd, vars, ctx.signal),
					});
					// sendUserMessage returns void and throws mid-stream without deliverAs, so the
					// queueing mode is chosen here and the generated turn is awaited explicitly.
					pi.sendUserMessage(expanded, ctx.isIdle() ? {} : { deliverAs: "followUp" });
					await ctx.waitForIdle();
				},
			});
		}
	}
}

/** Claude Code merges stderr into stdout for injected commands, so failures stay visible. */
function runShell(
	command: string,
	cwd: string,
	vars: SubstitutionVars,
	signal: AbortSignal | undefined,
): Promise<string> {
	return new Promise((resolvePromise) => {
		const child = spawn(command, {
			cwd,
			shell: process.platform === "win32" ? "bash.exe" : "bash",
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ...vars },
		});
		let output = "";
		let settled = false;

		const terminate = () => {
			if (child.pid === undefined) return;
			try {
				if (process.platform === "win32") child.kill("SIGTERM");
				else process.kill(-child.pid, "SIGTERM");
			} catch {
				// The process group is already gone.
			}
		};

		const finish = (text: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolvePromise(text.replace(/\s+$/, ""));
		};

		const timer = setTimeout(() => {
			terminate();
			finish(`${output}\n[command timed out]`);
		}, SHELL_TIMEOUT_MS);
		const onAbort = () => {
			terminate();
			finish(`${output}\n[command cancelled]`);
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		const collect = (chunk: string) => {
			if (output.length < MAX_SHELL_OUTPUT_BYTES) output += chunk;
			else terminate();
		};
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", collect);
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", collect);

		child.on("error", (error) => finish(`${output}${error.message}`));
		child.on("close", () => finish(output));
	});
}

function registerAgentTool(pi: ExtensionAPI, state: State): void {
	if (state.agents.length === 0) return;

	const names = state.agents.map((agent) => `${agent.plugin}:${agent.name}`);
	const catalogue = state.agents
		.map((agent) => `- ${agent.plugin}:${agent.name}: ${agent.description}`)
		.join("\n");

	pi.registerTool({
		name: AGENT_TOOL,
		label: "Plugin agent",
		description: `Delegate a task to a Claude Code plugin agent running in its own context window.\n\nAvailable agents:\n${catalogue}`,
		promptSnippet: "Delegate a task to a Claude Code plugin agent",
		parameters: Type.Object({
			agent: Type.String({ description: `Agent to run. One of: ${names.join(", ")}` }),
			task: Type.String({ description: "Self-contained task description for the agent" }),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agent = resolveAgent(state.agents, params.agent);
			if (!agent) {
				return {
					content: [
						{ type: "text", text: `Unknown agent "${params.agent}". Available: ${names.join(", ")}` },
					],
					isError: true,
					details: {},
				};
			}

			const result = await runAgent({
				agent,
				task: params.task,
				cwd: ctx.cwd,
				...(signal ? { signal } : {}),
				...(ctx.model ? { fallbackModel: `${ctx.model.provider}/${ctx.model.id}` } : {}),
				...(ctx.thinkingLevel ? { fallbackThinkingLevel: ctx.thinkingLevel } : {}),
				env: {
					...process.env,
					CLAUDE_PLUGIN_ROOT: agent.root,
					CLAUDE_PLUGIN_DATA: dataDirFor(state, agent.plugin),
					CLAUDE_PROJECT_DIR: ctx.cwd,
				},
				onText: (text) => onUpdate?.({ content: [{ type: "text", text }], details: {} }),
			});

			if (result.exitCode !== 0) {
				const detail = result.stderr || result.output || "no output";
				return {
					content: [
						{ type: "text", text: `Agent ${agent.name} failed (exit ${result.exitCode}): ${detail}` },
					],
					isError: true,
					details: { exitCode: result.exitCode },
				};
			}
			return {
				content: [{ type: "text", text: result.output || "(no output)" }],
				details: { agent: agent.name, plugin: agent.plugin },
			};
		},
	});
}

function registerMcpServers(pi: ExtensionAPI, state: State): string[] {
	const unavailable: string[] = [];
	for (const plugin of state.plugins) {
		for (const server of plugin.mcpServers) {
			const outcome = registerMcpServer(pi.events, server);
			if (outcome.status === "registered") state.registrations.push(outcome.registration);
			else if (outcome.status === "no-adapter") unavailable.push(server.name);
			else console.error(`claude-plugins: MCP server ${server.name} failed: ${outcome.error.message}`);
		}
	}
	return unavailable;
}
