import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isInside } from "./manifest.ts";
import { substituteClaudeVarsDeep } from "./substitute.ts";
import type {
	HookEventName,
	HookMatcherGroup,
	HooksConfig,
	PluginHook,
	PluginManifest,
	SubstitutionVars,
} from "./types.ts";

export type { HookEventName } from "./types.ts";

export const SUPPORTED_EVENTS: readonly HookEventName[] = [
	"PreToolUse",
	"PostToolUse",
	"UserPromptSubmit",
	"Stop",
	"SessionStart",
	"PreCompact",
];

/** The events on which Claude Code evaluates a handler's `if` rule at all. */
const TOOL_EVENTS: readonly HookEventName[] = ["PreToolUse", "PostToolUse"];

const DEFAULT_TIMEOUT_MS = 600_000;
const PROMPT_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 2_000;
const MAX_OUTPUT_BYTES = 1_000_000;

export interface HookDiscovery {
	hooks: PluginHook[];
	escaped: string[];
	/** Events and handler types present in the config but with no pi counterpart. */
	unsupported: string[];
	warnings: string[];
}

export function discoverHooks(
	plugin: string,
	root: string,
	manifest: PluginManifest,
	vars: SubstitutionVars,
): HookDiscovery {
	const escaped: string[] = [];
	const warnings: string[] = [];
	const configs: HooksConfig[] = [];

	const declared = manifest.hooks;
	if (declared !== undefined && !Array.isArray(declared) && typeof declared === "object") {
		configs.push(asHooksConfig(declared as Record<string, unknown>));
	} else {
		const entries =
			declared === undefined ? ["hooks/hooks.json"] : Array.isArray(declared) ? declared : [declared];
		for (const entry of entries) {
			if (typeof entry !== "string") continue;
			if (!isInside(root, entry)) {
				escaped.push(entry);
				continue;
			}
			const path = resolve(root, entry);
			if (!existsSync(path)) continue;
			const parsed = readHooksFile(path);
			if (parsed.config) configs.push(parsed.config);
			// An unreadable policy file must not silently become an empty policy.
			if (parsed.error) warnings.push(`hooks file ${entry} was ignored: ${parsed.error}`);
		}
	}

	const hooks: PluginHook[] = [];
	const unsupported = new Set<string>();

	for (const config of configs) {
		for (const [event, groups] of Object.entries(config.hooks ?? {})) {
			if (!Array.isArray(groups)) continue;
			if (!SUPPORTED_EVENTS.includes(event as HookEventName)) {
				unsupported.add(`event ${event}`);
				continue;
			}
			for (const group of groups as HookMatcherGroup[]) {
				for (const handler of group?.hooks ?? []) {
					if (handler?.type !== "command") {
						unsupported.add(`handler type ${handler?.type ?? "unknown"}`);
						continue;
					}
					if (handler.if !== undefined && !TOOL_EVENTS.includes(event as HookEventName)) {
						warnings.push(`hook on ${event} declares "if", which only applies to tool events`);
						continue;
					}
					hooks.push({
						plugin,
						root,
						event: event as HookEventName,
						...(group.matcher === undefined ? {} : { matcher: group.matcher }),
						handler: substituteClaudeVarsDeep(handler, vars),
					});
				}
			}
		}
	}

	return { hooks, escaped, unsupported: [...unsupported], warnings };
}

/**
 * A hooks file wraps the event map in `{ "hooks": … }`; an inline manifest value is the event map
 * itself, matching how `hooks` is written in a settings file.
 */
function asHooksConfig(value: Record<string, unknown>): HooksConfig {
	const nested = value.hooks;
	if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
		return value as HooksConfig;
	}
	return { hooks: (value ?? {}) as NonNullable<HooksConfig["hooks"]> };
}

function readHooksFile(path: string): { config?: HooksConfig; error?: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return { error: (error as Error).message };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { error: "expected a JSON object" };
	}
	return { config: asHooksConfig(parsed as Record<string, unknown>) };
}

const PLAIN_MATCHER = /^[\w\-, |]+$/;

/**
 * A matcher made only of word characters, spaces, commas and pipes is a list of exact names;
 * anything else is an unanchored regular expression. `Edit.*` therefore also matches
 * `NotebookEdit`, as it does in Claude Code.
 */
export function matches(matcher: string | undefined, value: string): boolean {
	if (matcher === undefined || matcher === "" || matcher === "*") return true;
	if (PLAIN_MATCHER.test(matcher)) {
		return matcher
			.split(/[,|]/)
			.map((part) => part.trim())
			.filter((part) => part.length > 0)
			.includes(value);
	}
	try {
		return new RegExp(matcher).test(value);
	} catch {
		return false;
	}
}

const IF_RULE = /^([A-Za-z_][\w-]*)\(([\s\S]*)\)$/;

/**
 * `crossesSeparator` distinguishes the two rule flavours: in a command rule `*` stands for the
 * rest of the command line, while in a path rule a single `*` stops at a directory boundary.
 */
function globToRegExp(pattern: string, crossesSeparator: boolean): RegExp {
	const single = crossesSeparator ? ".*" : "[^/]*";
	const singleChar = crossesSeparator ? "." : "[^/]";
	let source = "";
	for (let index = 0; index < pattern.length; index += 1) {
		const char = pattern[index] ?? "";
		if (char === "*") {
			if (pattern[index + 1] === "*") {
				source += ".*";
				index += 1;
				if (pattern[index + 1] === "/") index += 1;
				continue;
			}
			source += single;
			continue;
		}
		if (char === "?") {
			source += singleChar;
			continue;
		}
		source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${source}$`);
}

/** The full command plus its `$(…)`, backtick and chained subcommands, less leading assignments. */
function bashSubcommands(command: string): string[] {
	const parts = [command];
	for (const match of command.matchAll(/\$\(([^)]*)\)|`([^`]*)`/g)) {
		parts.push(match[1] ?? match[2] ?? "");
	}
	for (const chunk of command.split(/&&|\|\||[;|]/)) parts.push(chunk);
	return parts.map((part) => part.trim().replace(/^(?:\w+=\S*\s+)+/, "")).filter((part) => part.length > 0);
}

/**
 * Evaluates a handler's `if` permission rule.
 *
 * Claude Code documents this filter as best-effort and runs the hook whenever it cannot
 * determine what a Bash input executes, so an unparseable rule or an opaque command errs
 * towards running the hook.
 */
export function matchesIf(
	rule: string | undefined,
	claudeTool: string,
	input: Record<string, unknown>,
): boolean {
	if (rule === undefined || rule.trim() === "") return true;
	const parsed = IF_RULE.exec(rule.trim());
	if (!parsed) return true;

	const [, tool, pattern] = parsed;
	if (tool === undefined || pattern === undefined) return true;
	if (tool !== claudeTool) return false;

	if (tool === "Bash" || tool === "PowerShell") {
		const command = input.command;
		if (typeof command !== "string") return true;
		const tokens = pattern
			.trim()
			.split(/\s+/)
			.filter((token) => token.length > 0);
		const withoutStar = tokens.at(-1) === "*" ? tokens.slice(0, -1) : tokens;
		// A pattern stricter than `command *` cannot be checked inside $(...), backticks or $VAR.
		if (withoutStar.length > 1 && /\$\(|`/.test(command)) return true;
		// `$VAR` stays opaque for any pattern longer than one token, including `git *`.
		if (tokens.length > 1 && /\$\w|\$\{/.test(command)) return true;
		const test = globToRegExp(pattern, true);
		return bashSubcommands(command).some((part) => test.test(part));
	}

	const path = input.file_path ?? input.path;
	if (typeof path !== "string") return true;
	return globToRegExp(pattern, false).test(path);
}

export interface HookInput {
	session_id: string;
	cwd: string;
	hook_event_name: HookEventName;
	permission_mode?: string;
	[key: string]: unknown;
}

export interface HookSpecificOutput {
	hookEventName?: string;
	permissionDecision?: "allow" | "deny" | "ask" | "defer";
	permissionDecisionReason?: string;
	updatedInput?: Record<string, unknown>;
	updatedToolOutput?: unknown;
	updatedMCPToolOutput?: unknown;
	additionalContext?: string;
}

export interface HookJsonOutput {
	continue?: boolean;
	stopReason?: string;
	systemMessage?: string;
	decision?: string;
	reason?: string;
	hookSpecificOutput?: HookSpecificOutput;
}

export interface HookExecution {
	hook: PluginHook;
	exitCode: number;
	stdout: string;
	stderr: string;
	json?: HookJsonOutput;
	timedOut: boolean;
}

export interface RunHookOptions {
	hook: PluginHook;
	input: HookInput;
	cwd: string;
	projectDir: string;
	dataDir: string;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
}

export function timeoutFor(hook: PluginHook): number {
	if (typeof hook.handler.timeout === "number") return hook.handler.timeout * 1000;
	return hook.event === "UserPromptSubmit" ? PROMPT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

/** Claude Code runs shell-form handlers under bash, so bash-isms in existing hook scripts keep working. */
function shellFor(hook: PluginHook): string | boolean {
	if (hook.handler.args !== undefined) return false;
	if (hook.handler.shell === "powershell") {
		return process.platform === "win32" ? "powershell.exe" : "pwsh";
	}
	return process.platform === "win32" ? "bash.exe" : "bash";
}

/**
 * Runs one command handler with the event JSON on stdin. `args` selects exec form, where the
 * command is spawned directly and each argument passes through without shell interpretation.
 */
export function runHook(options: RunHookOptions): Promise<HookExecution> {
	const { hook } = options;
	const command = hook.handler.command ?? "";

	return new Promise((resolvePromise) => {
		const child = spawn(command, hook.handler.args ?? [], {
			cwd: options.cwd,
			shell: shellFor(hook),
			// Own process group so a timeout kills the shell's children too, not just the shell.
			detached: process.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...(options.env ?? process.env),
				CLAUDE_PLUGIN_ROOT: hook.root,
				CLAUDE_PLUGIN_DATA: options.dataDir,
				CLAUDE_PROJECT_DIR: options.projectDir,
			},
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
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

		// A handler that ignores SIGTERM would otherwise keep privileged descendants alive.
		const terminate = () => {
			signalGroup("SIGTERM");
			if (killScheduled) return;
			killScheduled = true;
			setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS).unref();
		};

		// Claude Code does not enforce timeout on a command hook with async: true.
		const timer =
			hook.handler.async === true
				? undefined
				: setTimeout(() => {
						timedOut = true;
						terminate();
						finish(1);
					}, timeoutFor(hook));

		const onAbort = () => terminate();
		options.signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk;
			else terminate();
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk;
			else terminate();
		});

		function finish(exitCode: number): void {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			resolvePromise({
				hook,
				exitCode,
				stdout,
				stderr,
				timedOut,
				...(timedOut ? {} : withJson(stdout)),
			});
		}

		child.on("error", (error) => {
			stderr += `${stderr ? "\n" : ""}${error.message}`;
			finish(127);
		});
		child.on("close", (code) => finish(code ?? 1));

		child.stdin.on("error", () => {
			// A handler that ignores stdin closes the pipe before we finish writing.
		});
		child.stdin.end(`${JSON.stringify(options.input)}\n`);
	});
}

/** Claude Code parses stdout as JSON only when it starts with `{` and ends with `}`. */
export function parseHookJson(stdout: string): HookJsonOutput | undefined {
	const trimmed = stdout.trim();
	if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return parsed as HookJsonOutput;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function withJson(stdout: string): { json?: HookJsonOutput } {
	const json = parseHookJson(stdout);
	return json ? { json } : {};
}

export type HookOutcome = "allow" | "ask" | "deny";

export interface HookDecision {
	outcome: HookOutcome;
	reason?: string;
	/** A hook returned `continue: false`; the run must stop rather than be steered. */
	terminate: boolean;
	stopReason?: string;
	updatedInput?: Record<string, unknown>;
	updatedToolOutput?: unknown;
	additionalContext: string[];
	warnings: string[];
}

const PRECEDENCE: Record<HookOutcome, number> = { allow: 0, ask: 1, deny: 2 };

/** `"block"` does what exit 2 does, except on Stop and on a hook that already ran in the background. */
function blocksOnFailure(execution: HookExecution): boolean {
	const handler = execution.hook.handler;
	return handler.onFailure === "block" && handler.async !== true && execution.hook.event !== "Stop";
}

/** A `{...}` stdout that is not one JSON object. Plain text is not a failure. */
function brokenObject(stdout: string): boolean {
	const trimmed = stdout.trim();
	if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		return typeof parsed !== "object" || parsed === null || Array.isArray(parsed);
	} catch {
		return true;
	}
}

function hookFailed(execution: HookExecution): boolean {
	if (execution.timedOut) return true;
	if (execution.exitCode !== 0 && execution.exitCode !== 2) return true;
	return execution.json === undefined && brokenObject(execution.stdout);
}

function onFailureReason(execution: HookExecution): string {
	if (execution.timedOut) return 'timed out; blocking because onFailure is "block"';
	const detail = execution.stderr.trim().split("\n")[0] ?? "";
	return `failed; blocking because onFailure is "block"${detail ? `: ${detail}` : ""}`;
}

/**
 * Starts every hook. Async hooks are handed to `onBackground` and are not in the returned list,
 * so the action proceeds without their decision.
 */
export async function beginHookRuns<T>(
	hooks: readonly PluginHook[],
	start: (hook: PluginHook) => Promise<T>,
	onBackground: (pending: Promise<T>) => void,
): Promise<T[]> {
	const blocking: Promise<T>[] = [];
	for (const hook of hooks) {
		const pending = start(hook);
		if (hook.handler.async === true) onBackground(pending);
		else blocking.push(pending);
	}
	return Promise.all(blocking);
}

/** What an async hook may still deliver: context for the model, never a decision. */
export function asyncModelContext(execution: HookExecution): string[] {
	const json = execution.json;
	if (!json) return [];
	const context: string[] = [];
	if (json.hookSpecificOutput?.additionalContext) context.push(json.hookSpecificOutput.additionalContext);
	if (json.systemMessage) context.push(json.systemMessage);
	return context;
}

export interface PreCompactResult {
	cancel: boolean;
	reason?: string;
	warnings: string[];
}

/**
 * Exit 2 and `decision: "block"` cancel compaction. `continue` does not.
 * pi 0.84.4 cannot attach hook stdout to the default summarizer, so this result
 * never turns that stdout into a replacement summary.
 */
export function preCompactResult(executions: readonly HookExecution[]): PreCompactResult {
	const decision = mergeDecisions(executions);
	return {
		cancel: decision.outcome === "deny",
		...(decision.reason === undefined ? {} : { reason: decision.reason }),
		warnings: decision.warnings,
	};
}

/**
 * Folds a batch of executions into one decision.
 *
 * Exit code 2 is evaluated for every execution regardless of what it printed, because it is the
 * one outcome JSON cannot override, and `deny` beats `ask` beats `allow`.
 */
export function mergeDecisions(executions: readonly HookExecution[]): HookDecision {
	const decision: HookDecision = {
		outcome: "allow",
		terminate: false,
		additionalContext: [],
		warnings: [],
	};

	const raise = (outcome: HookOutcome, reason: string | undefined) => {
		if (PRECEDENCE[outcome] < PRECEDENCE[decision.outcome]) return;
		if (PRECEDENCE[outcome] > PRECEDENCE[decision.outcome]) {
			decision.outcome = outcome;
			delete decision.reason;
		}
		if (reason !== undefined && decision.reason === undefined) decision.reason = reason;
	};

	for (const execution of executions) {
		// An async hook already returned. Its decision, permissionDecision and continue do nothing.
		if (execution.hook.handler.async === true) continue;

		const label = `${execution.hook.plugin}:${execution.hook.event}`;
		if (execution.timedOut) {
			if (blocksOnFailure(execution)) raise("deny", onFailureReason(execution));
			else decision.warnings.push(`${label} hook timed out; no decision applied`);
			continue;
		}

		const json = execution.json;
		const specific = json?.hookSpecificOutput;

		if (specific?.additionalContext) decision.additionalContext.push(specific.additionalContext);
		// PreCompact discards systemMessage, the same way it discards continue.
		if (json?.systemMessage && execution.hook.event !== "PreCompact") {
			decision.warnings.push(`${label}: ${json.systemMessage}`);
		}
		if (specific?.updatedInput) decision.updatedInput = specific.updatedInput;
		const updatedOutput = specific?.updatedToolOutput ?? specific?.updatedMCPToolOutput;
		if (updatedOutput !== undefined) decision.updatedToolOutput = updatedOutput;

		if (execution.exitCode === 2) {
			raise("deny", execution.stderr.trim() || json?.reason || "blocked by hook");
		} else if (blocksOnFailure(execution) && hookFailed(execution)) {
			raise("deny", onFailureReason(execution));
		}

		if (json?.continue === false && execution.hook.event !== "PreCompact") {
			decision.terminate = true;
			decision.stopReason ??= json.stopReason ?? "a hook requested a stop";
		}

		const permission = specific?.permissionDecision;
		if (permission === "deny" || json?.decision === "block") {
			raise("deny", specific?.permissionDecisionReason ?? json?.reason);
			continue;
		}
		if (permission === "ask") {
			raise("ask", specific?.permissionDecisionReason);
			continue;
		}
		if (permission === "defer") {
			// `defer` suspends a `claude -p` run for later resumption. pi has no resumable
			// suspension, so treating it as allow would turn a pause into a silent approval.
			raise("deny", specific?.permissionDecisionReason ?? '"defer" is not resumable under pi');
			continue;
		}

		if (
			execution.exitCode !== 0 &&
			execution.exitCode !== 2 &&
			json === undefined &&
			!blocksOnFailure(execution)
		) {
			const detail = execution.stderr.trim().split("\n")[0] ?? "";
			decision.warnings.push(
				`${label} failed with non-blocking status code ${execution.exitCode}${detail ? `: ${detail}` : ""}`,
			);
		}
	}

	return decision;
}

/**
 * Plain stdout that Claude Code adds to context. Only `UserPromptSubmit` and `SessionStart`
 * consume it; every other event writes it to the debug log instead.
 */
export function plainContext(executions: readonly HookExecution[]): string[] {
	return executions
		.filter((execution) => !execution.timedOut && execution.exitCode === 0 && execution.json === undefined)
		.map((execution) => execution.stdout.trim())
		.filter((text) => text.length > 0);
}

export function hooksFor(
	hooks: readonly PluginHook[],
	event: HookEventName,
	matchValue: string | undefined,
	input?: Record<string, unknown>,
): PluginHook[] {
	return hooks.filter((hook) => {
		if (hook.event !== event) return false;
		if (matchValue !== undefined && !matches(hook.matcher, matchValue)) return false;
		if (input !== undefined && matchValue !== undefined) {
			return matchesIf(hook.handler.if, matchValue, input);
		}
		return true;
	});
}
