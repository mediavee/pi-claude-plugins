import { describe, expect, it } from "vitest";
import {
	discoverHooks,
	type HookExecution,
	matches,
	mergeDecisions,
	parseHookJson,
	runHook,
	timeoutFor,
} from "../src/hooks.ts";
import { readManifest } from "../src/manifest.ts";
import type { PluginHook, SubstitutionVars } from "../src/types.ts";
import { FIXTURE_PLUGIN } from "./helpers.ts";

const vars: SubstitutionVars = {
	CLAUDE_PLUGIN_ROOT: FIXTURE_PLUGIN,
	CLAUDE_PLUGIN_DATA: "/data/demo",
	CLAUDE_PROJECT_DIR: "/work",
};

function hook(overrides: Partial<PluginHook> = {}): PluginHook {
	return {
		plugin: "demo-plugin",
		root: FIXTURE_PLUGIN,
		event: "PreToolUse",
		handler: { type: "command", command: "true" },
		...overrides,
	};
}

function execution(overrides: Partial<HookExecution> = {}): HookExecution {
	return { hook: hook(), exitCode: 0, stdout: "", stderr: "", timedOut: false, ...overrides };
}

describe("matches", () => {
	it("matches everything for an absent, empty or star matcher", () => {
		for (const matcher of [undefined, "", "*"]) {
			expect(matches(matcher, "Bash")).toBe(true);
		}
	});

	it("treats a plain matcher as a list of exact names", () => {
		expect(matches("Write|Edit", "Edit")).toBe(true);
		expect(matches("Write, Edit", "Write")).toBe(true);
		expect(matches("Edit", "NotebookEdit")).toBe(false);
		expect(matches("code-reviewer", "senior-code-reviewer")).toBe(false);
	});

	it("treats anything else as an unanchored regular expression", () => {
		expect(matches("^Notebook", "NotebookEdit")).toBe(true);
		expect(matches("Edit.*", "NotebookEdit")).toBe(true);
		expect(matches("^Edit$", "NotebookEdit")).toBe(false);
		expect(matches("mcp__memory__.*", "mcp__memory__store")).toBe(true);
	});

	it("never matches on an invalid regular expression", () => {
		expect(matches("[unclosed", "Bash")).toBe(false);
	});
});

describe("discoverHooks", () => {
	it("keeps supported command handlers and reports the rest", () => {
		const result = discoverHooks("demo-plugin", FIXTURE_PLUGIN, readManifest(FIXTURE_PLUGIN), vars);
		expect(result.hooks.map((entry) => entry.event).sort()).toEqual([
			"PostToolUse",
			"PreToolUse",
			"SessionStart",
		]);
		expect(result.unsupported).toContain("event Notification");
		expect(result.unsupported).toContain("handler type http");
	});

	it("substitutes the plugin root into handler commands", () => {
		const result = discoverHooks("demo-plugin", FIXTURE_PLUGIN, readManifest(FIXTURE_PLUGIN), vars);
		const pre = result.hooks.find((entry) => entry.event === "PreToolUse");
		expect(pre?.handler.command).toContain(FIXTURE_PLUGIN);
		expect(pre?.handler.command).not.toContain("${CLAUDE_PLUGIN_ROOT}");
	});
});

describe("parseHookJson", () => {
	it("parses stdout that starts with { and ends with }", () => {
		expect(parseHookJson('  {"decision":"block"}  ')).toEqual({ decision: "block" });
	});

	it("ignores plain text, arrays and truncated objects", () => {
		expect(parseHookJson("all good")).toBeUndefined();
		expect(parseHookJson('["a"]')).toBeUndefined();
		expect(parseHookJson('{"decision":')).toBeUndefined();
	});
});

describe("timeoutFor", () => {
	it("uses a shorter default on UserPromptSubmit", () => {
		expect(timeoutFor(hook({ event: "UserPromptSubmit" }))).toBe(30_000);
		expect(timeoutFor(hook({ event: "PreToolUse" }))).toBe(600_000);
	});

	it("honours an explicit timeout in seconds", () => {
		expect(timeoutFor(hook({ handler: { type: "command", command: "true", timeout: 5 } }))).toBe(5000);
	});
});

describe("mergeDecisions", () => {
	it("blocks on exit code 2 and uses stderr as the reason", () => {
		const decision = mergeDecisions([execution({ exitCode: 2, stderr: "no rm allowed\n" })]);
		expect(decision.blocked).toBe(true);
		expect(decision.reason).toBe("no rm allowed");
	});

	it("blocks on an explicit deny and prefers its reason", () => {
		const decision = mergeDecisions([
			execution({
				json: {
					hookSpecificOutput: {
						permissionDecision: "deny",
						permissionDecisionReason: "policy",
					},
				},
			}),
		]);
		expect(decision.blocked).toBe(true);
		expect(decision.reason).toBe("policy");
	});

	it("lets deny win over allow regardless of order", () => {
		const allow = execution({ json: { hookSpecificOutput: { permissionDecision: "allow" } } });
		const deny = execution({ json: { hookSpecificOutput: { permissionDecision: "deny" } } });
		expect(mergeDecisions([allow, deny]).blocked).toBe(true);
		expect(mergeDecisions([deny, allow]).blocked).toBe(true);
	});

	it("allows an ask with a warning, since pi cannot prompt from tool_call", () => {
		const decision = mergeDecisions([
			execution({ json: { hookSpecificOutput: { permissionDecision: "ask" } } }),
		]);
		expect(decision.blocked).toBe(false);
		expect(decision.warnings.join(" ")).toContain("confirmation");
	});

	it("honours valid JSON even on a non-zero, non-2 exit code", () => {
		const decision = mergeDecisions([
			execution({ exitCode: 3, json: { hookSpecificOutput: { permissionDecision: "deny" } } }),
		]);
		expect(decision.blocked).toBe(true);
		expect(decision.warnings).toEqual([]);
	});

	it("treats a bare non-zero exit as a non-blocking error", () => {
		const decision = mergeDecisions([execution({ exitCode: 1, stderr: "boom" })]);
		expect(decision.blocked).toBe(false);
		expect(decision.warnings.join(" ")).toContain("non-blocking status code 1");
	});

	it("stops the run when a hook returns continue: false", () => {
		const decision = mergeDecisions([
			execution({ json: { continue: false, stopReason: "build is broken" } }),
		]);
		expect(decision).toMatchObject({ blocked: true, terminate: true, reason: "build is broken" });
	});

	it("collects additional context and the last updatedInput", () => {
		const decision = mergeDecisions([
			execution({ json: { hookSpecificOutput: { additionalContext: "first" } } }),
			execution({
				json: { hookSpecificOutput: { additionalContext: "second", updatedInput: { command: "ls" } } },
			}),
		]);
		expect(decision.additionalContext).toEqual(["first", "second"]);
		expect(decision.updatedInput).toEqual({ command: "ls" });
	});

	it("renders no decision for a timed-out hook", () => {
		const decision = mergeDecisions([execution({ timedOut: true, exitCode: 2, stderr: "late" })]);
		expect(decision.blocked).toBe(false);
		expect(decision.warnings.join(" ")).toContain("timed out");
	});
});

describe("runHook", () => {
	const base = { cwd: process.cwd(), projectDir: process.cwd(), dataDir: "/tmp/pcp-data" };
	const input = {
		session_id: "s1",
		cwd: process.cwd(),
		hook_event_name: "PreToolUse" as const,
	};

	it("passes the event JSON on stdin and exposes the plugin environment", async () => {
		const result = await runHook({
			hook: hook({
				handler: {
					type: "command",
					command: 'jq -c "{seen: .hook_event_name, root: env.CLAUDE_PLUGIN_ROOT}"',
				},
			}),
			input,
			...base,
		});
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({ seen: "PreToolUse", root: FIXTURE_PLUGIN });
	});

	it("captures a blocking exit code and its stderr", async () => {
		const result = await runHook({
			hook: hook({ handler: { type: "command", command: 'echo "denied" >&2; exit 2' } }),
			input,
			...base,
		});
		expect(result.exitCode).toBe(2);
		expect(result.stderr.trim()).toBe("denied");
	});

	it("runs exec form without a shell", async () => {
		const result = await runHook({
			hook: hook({ handler: { type: "command", command: "echo", args: ["$HOME not expanded"] } }),
			input,
			...base,
		});
		expect(result.stdout.trim()).toBe("$HOME not expanded");
	});

	it("reports a timeout instead of a decision", async () => {
		const result = await runHook({
			hook: hook({ handler: { type: "command", command: "sleep 5; exit 2", timeout: 0.2 } }),
			input,
			...base,
		});
		expect(result.timedOut).toBe(true);
		expect(result.json).toBeUndefined();
	});

	it("survives a missing executable", async () => {
		const result = await runHook({
			hook: hook({ handler: { type: "command", command: "/nonexistent/hook.sh", args: [] } }),
			input,
			...base,
		});
		expect(result.exitCode).not.toBe(0);
	});
});
