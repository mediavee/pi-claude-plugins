import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveAgent, runAgent } from "./agents.ts";
import { expandCommand } from "./commands.ts";
import { resolveSettings } from "./config.ts";
import { loadPlugins } from "./discovery.ts";
import {
	type HookDecision,
	type HookEventName,
	type HookInput,
	hooksFor,
	mergeDecisions,
	runHook,
} from "./hooks.ts";
import { type McpRegistration, registerMcpServer } from "./mcp.ts";
import { formatReport } from "./report.ts";
import { claudeInputToPi, piInputToClaude, piToolToClaude } from "./tool-names.ts";
import type { LoadedPlugin, PluginAgent, PluginHook, SubstitutionVars } from "./types.ts";

const AGENT_TOOL = "claude_plugin_agent";
const MESSAGE_TYPE = "claude-plugins";
/** Matches Claude Code, which ends a turn after eight consecutive Stop-hook continuations. */
const MAX_STOP_CONTINUATIONS = 8;

interface State {
	plugins: LoadedPlugin[];
	hooks: PluginHook[];
	agents: PluginAgent[];
	registrations: McpRegistration[];
	report: string;
	allowShell: boolean;
	dataRoot: string;
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
		allowShell: false,
		dataRoot: "",
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
		state.allowShell = settings.allowShellCommands;
		state.dataRoot = resolve(agentDir, "claude-plugins", "data");

		const result = loadPlugins({ settings, cwd: ctx.cwd, dataRoot: state.dataRoot });
		state.plugins = result.plugins;
		state.hooks = result.plugins.flatMap((plugin) => plugin.hooks);
		state.agents = result.plugins.flatMap((plugin) => plugin.agents);

		registerCommands(pi, state, ctx);
		registerAgentTool(pi, state);

		const mcpUnavailable = registerMcpServers(pi, state);
		state.report = formatReport({
			plugins: result.plugins,
			diagnostics: result.diagnostics,
			collisions: result.collisions,
			mcpUnavailable,
			shellAllowed: settings.allowShellCommands,
		});
		announce(ctx, state.report);

		await runSessionStartHooks(pi, state, ctx, event.reason);
	});

	pi.on("session_shutdown", async () => {
		const registrations = state.registrations;
		state.registrations = [];
		await Promise.all(registrations.map((registration) => registration.dispose().catch(() => {})));
	});

	pi.on("resources_discover", () => ({
		skillPaths: state.plugins.flatMap((plugin) => plugin.skills.map((skill) => skill.path)),
	}));

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

		const decision = await runHooks(state, ctx, hooks, {
			...baseInput(ctx, "UserPromptSubmit"),
			prompt: event.text,
		});
		notifyWarnings(ctx, decision);
		if (decision.blocked) {
			ctx.ui.notify(decision.reason ?? "prompt blocked by a plugin hook", "warning");
			return { action: "handled" as const };
		}
		state.pendingContext.push(...decision.additionalContext);
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
		const hooks = hooksFor(state.hooks, "PreToolUse", claudeName);
		if (hooks.length === 0) return;

		const input = event.input as Record<string, unknown>;
		const decision = await runHooks(state, ctx, hooks, {
			...baseInput(ctx, "PreToolUse"),
			tool_name: claudeName,
			tool_input: piInputToClaude(event.toolName, input),
			tool_use_id: event.toolCallId,
		});
		notifyWarnings(ctx, decision);

		if (decision.updatedInput) {
			replaceInput(input, claudeInputToPi(event.toolName, decision.updatedInput));
		}
		for (const context of decision.additionalContext) {
			await pi.sendMessage({ customType: MESSAGE_TYPE, content: context, display: false });
		}
		if (decision.blocked) {
			state.blockedCalls.add(event.toolCallId);
			return {
				block: true,
				reason: decision.reason ?? "blocked by a plugin hook",
				terminate: decision.terminate,
			};
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (state.blockedCalls.delete(event.toolCallId)) return;
		const claudeName = piToolToClaude(event.toolName);
		const hooks = hooksFor(state.hooks, "PostToolUse", claudeName);
		if (hooks.length === 0) return;

		const decision = await runHooks(state, ctx, hooks, {
			...baseInput(ctx, "PostToolUse"),
			tool_name: claudeName,
			tool_input: piInputToClaude(event.toolName, event.input),
			tool_response: event.content,
			tool_use_id: event.toolCallId,
		});
		notifyWarnings(ctx, decision);

		const extra = [...decision.additionalContext];
		if (decision.blocked && decision.reason) extra.push(decision.reason);
		if (extra.length === 0) return;
		return { content: [...event.content, { type: "text" as const, text: extra.join("\n\n") }] };
	});

	pi.on("agent_end", async (_event, ctx) => {
		const hooks = hooksFor(state.hooks, "Stop", undefined);
		if (hooks.length === 0) return;

		const active = state.stopContinuations > 0;
		const decision = await runHooks(state, ctx, hooks, {
			...baseInput(ctx, "Stop"),
			stop_hook_active: active,
		});
		notifyWarnings(ctx, decision);

		// Claude Code's Stop block continues the conversation with the reason handed to the model.
		if (decision.blocked && state.stopContinuations < MAX_STOP_CONTINUATIONS) {
			state.stopContinuations += 1;
			await pi.sendMessage(
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

		const decision = await runHooks(state, ctx, hooks, {
			...baseInput(ctx, "PreCompact"),
			trigger,
			custom_instructions: event.customInstructions ?? null,
		});
		notifyWarnings(ctx, decision);
		if (decision.blocked) {
			ctx.ui.notify(decision.reason ?? "compaction blocked by a plugin hook", "warning");
			return { cancel: true };
		}
	});
}

function announce(ctx: ExtensionContext, message: string): void {
	if (!message) return;
	// stdout carries the JSONL protocol in rpc and json modes, so stderr is the only safe sink.
	if (ctx.mode === "tui") ctx.ui.notify(message, "info");
	else console.error(message);
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

async function runHooks(
	state: State,
	ctx: ExtensionContext,
	hooks: readonly PluginHook[],
	input: HookInput,
): Promise<HookDecision> {
	const executions = await Promise.all(
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
	return mergeDecisions(executions);
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

function notifyWarnings(ctx: ExtensionContext, decision: HookDecision): void {
	for (const warning of decision.warnings) ctx.ui.notify(warning, "warning");
}

async function runSessionStartHooks(
	pi: ExtensionAPI,
	state: State,
	ctx: ExtensionContext,
	reason: "startup" | "reload" | "new" | "resume" | "fork",
): Promise<void> {
	const source = reason === "resume" || reason === "fork" ? reason : "startup";
	const hooks = hooksFor(state.hooks, "SessionStart", source);
	if (hooks.length === 0) return;

	const decision = await runHooks(state, ctx, hooks, { ...baseInput(ctx, "SessionStart"), source });
	notifyWarnings(ctx, decision);
	if (decision.additionalContext.length === 0) return;
	await pi.sendMessage(
		{ customType: MESSAGE_TYPE, content: decision.additionalContext.join("\n\n"), display: false },
		{ deliverAs: "nextTurn" },
	);
}

function registerCommands(pi: ExtensionAPI, state: State, sessionCtx: ExtensionContext): void {
	for (const plugin of state.plugins) {
		for (const command of plugin.commands) {
			const invocation = `${plugin.name}:${command.name}`;
			if (state.registeredCommands.has(invocation)) continue;
			state.registeredCommands.add(invocation);

			const vars: SubstitutionVars = {
				CLAUDE_PLUGIN_ROOT: plugin.root,
				CLAUDE_PLUGIN_DATA: dataDirFor(state, plugin.name),
				CLAUDE_PROJECT_DIR: sessionCtx.cwd,
			};

			pi.registerCommand(invocation, {
				...(command.description ? { description: command.description } : {}),
				handler: async (args, ctx) => {
					const expanded = await expandCommand({
						command,
						rawArguments: args,
						vars: { ...vars, CLAUDE_SESSION_ID: ctx.sessionManager.getSessionId() },
						cwd: ctx.cwd,
						allowShell: state.allowShell,
						run: (shellCommand) => runShell(shellCommand, ctx.cwd),
					});
					await pi.sendUserMessage(expanded);
				},
			});
		}
	}
}

/** Claude Code merges stderr into stdout for injected commands, so failures stay visible. */
function runShell(command: string, cwd: string): Promise<string> {
	return new Promise((resolvePromise) => {
		const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			output += chunk;
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			output += chunk;
		});
		child.on("error", (error) => resolvePromise(`${output}${error.message}`));
		child.on("close", () => resolvePromise(output.replace(/\s+$/, "")));
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
				...(ctx.model?.id ? { fallbackModel: ctx.model.id } : {}),
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
