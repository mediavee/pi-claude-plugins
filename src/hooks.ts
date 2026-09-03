import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isInsidePlugin } from "./manifest.ts";
import { substitute, substituteDeep } from "./substitute.ts";
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

const DEFAULT_TIMEOUT_MS = 600_000;
const PROMPT_TIMEOUT_MS = 30_000;

export interface HookDiscovery {
	hooks: PluginHook[];
	escaped: string[];
	/** Events and handler types present in the config but with no pi counterpart. */
	unsupported: string[];
}

export function discoverHooks(
	plugin: string,
	root: string,
	manifest: PluginManifest,
	vars: SubstitutionVars,
): HookDiscovery {
	const escaped: string[] = [];
	const configs: HooksConfig[] = [];

	const declared = manifest.hooks;
	if (declared !== undefined && !Array.isArray(declared) && typeof declared === "object") {
		configs.push(declared);
	} else {
		const entries =
			declared === undefined ? ["hooks/hooks.json"] : Array.isArray(declared) ? declared : [declared];
		for (const entry of entries) {
			if (typeof entry !== "string") continue;
			if (!isInsidePlugin(root, entry)) {
				escaped.push(entry);
				continue;
			}
			const path = resolve(root, entry);
			if (!existsSync(path)) continue;
			const parsed = readHooksFile(path);
			if (parsed) configs.push(parsed);
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
					hooks.push({
						plugin,
						root,
						event: event as HookEventName,
						...(group.matcher === undefined ? {} : { matcher: group.matcher }),
						handler: substituteDeep(handler, vars),
					});
				}
			}
		}
	}

	return { hooks, escaped, unsupported: [...unsupported] };
}

function readHooksFile(path: string): HooksConfig | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return parsed as HooksConfig;
		}
	} catch {
		return undefined;
	}
	return undefined;
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

/**
 * Runs one command handler with the event JSON on stdin. `args` selects exec form, where the
 * command is spawned directly and each argument passes through without shell interpretation.
 */
export function runHook(options: RunHookOptions): Promise<HookExecution> {
	const { hook } = options;
	const command = hook.handler.command ?? "";
	const useShell = hook.handler.args === undefined;

	return new Promise((resolvePromise) => {
		const child = spawn(command, hook.handler.args ?? [], {
			cwd: options.cwd,
			shell: useShell,
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

		const terminate = () => {
			if (child.pid === undefined) return;
			try {
				if (process.platform === "win32") child.kill("SIGTERM");
				else process.kill(-child.pid, "SIGTERM");
			} catch {
				// The process group is already gone.
			}
		};

		const timer = setTimeout(() => {
			timedOut = true;
			terminate();
			finish(1);
		}, timeoutFor(hook));

		const onAbort = () => terminate();
		options.signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});

		function finish(exitCode: number): void {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
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

export interface HookDecision {
	blocked: boolean;
	reason?: string;
	/** Set when a hook returned `continue: false`, which stops the run outright. */
	terminate: boolean;
	updatedInput?: Record<string, unknown>;
	additionalContext: string[];
	warnings: string[];
}

/**
 * Folds a batch of executions into one decision, using Claude Code's precedence:
 * `deny` beats `ask` beats `allow`, and exit code 2 blocks regardless of JSON.
 */
export function mergeDecisions(executions: readonly HookExecution[]): HookDecision {
	const decision: HookDecision = {
		blocked: false,
		terminate: false,
		additionalContext: [],
		warnings: [],
	};
	let asked = false;

	for (const execution of executions) {
		const label = `${execution.hook.plugin}:${execution.hook.event}`;
		if (execution.timedOut) {
			decision.warnings.push(`${label} hook timed out; no decision applied`);
			continue;
		}

		const json = execution.json;
		const specific = json?.hookSpecificOutput;

		if (specific?.additionalContext) decision.additionalContext.push(specific.additionalContext);
		if (json?.systemMessage) decision.warnings.push(`${label}: ${json.systemMessage}`);
		if (specific?.updatedInput) decision.updatedInput = specific.updatedInput;

		if (json?.continue === false) {
			decision.blocked = true;
			decision.terminate = true;
			decision.reason = json.stopReason ?? decision.reason ?? "hook requested a stop";
			continue;
		}

		const permission = specific?.permissionDecision;
		if (permission === "deny" || json?.decision === "block") {
			decision.blocked = true;
			const reason = specific?.permissionDecisionReason ?? json?.reason ?? decision.reason;
			if (reason !== undefined) decision.reason = reason;
			continue;
		}
		if (permission === "ask") {
			// pi's tool_call has no "prompt the user" outcome, so an ask is allowed with a warning
			// rather than silently promoted to a block.
			asked = true;
			decision.warnings.push(
				`${label} requested confirmation, which pi cannot prompt for; the call was allowed`,
			);
			continue;
		}
		if (permission === "defer") {
			decision.warnings.push(`${label} returned "defer", which only applies to claude -p; ignored`);
			continue;
		}

		if (execution.exitCode === 2) {
			decision.blocked = true;
			decision.reason = execution.stderr.trim() || decision.reason || "blocked by hook";
			continue;
		}
		if (execution.exitCode !== 0 && json === undefined) {
			const detail = execution.stderr.trim().split("\n")[0] ?? "";
			decision.warnings.push(
				`${label} failed with non-blocking status code ${execution.exitCode}${detail ? `: ${detail}` : ""}`,
			);
		}
	}

	if (decision.blocked && !decision.reason && asked) decision.reason = "blocked by hook";
	return decision;
}

export function substituteHookCommand(hook: PluginHook, vars: SubstitutionVars): string {
	return substitute(hook.handler.command ?? "", vars);
}

export function hooksFor(
	hooks: readonly PluginHook[],
	event: HookEventName,
	matchValue: string | undefined,
): PluginHook[] {
	return hooks.filter(
		(hook) => hook.event === event && (matchValue === undefined || matches(hook.matcher, matchValue)),
	);
}
