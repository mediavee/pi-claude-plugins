import { describe, expect, it } from "vitest";
import {
	discoverHooks,
	type HookExecution,
	hooksFor,
	matches,
	matchesIf,
	mergeDecisions,
	parseHookJson,
	plainContext,
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

describe("matchesIf", () => {
	it("runs the hook when no rule is declared", () => {
		expect(matchesIf(undefined, "Bash", { command: "rm -rf /" })).toBe(true);
	});

	it("only fires for the tool the rule names", () => {
		expect(matchesIf("Bash(git *)", "Write", { file_path: "/a" })).toBe(false);
	});

	it("narrows a Bash rule to matching commands", () => {
		expect(matchesIf("Bash(git *)", "Bash", { command: "git push" })).toBe(true);
		expect(matchesIf("Bash(git *)", "Bash", { command: "npm test" })).toBe(false);
	});

	it("strips leading assignments and checks chained subcommands", () => {
		expect(matchesIf("Bash(git *)", "Bash", { command: "FOO=bar git push" })).toBe(true);
		expect(matchesIf("Bash(git *)", "Bash", { command: "npm test && git push" })).toBe(true);
		expect(matchesIf("Bash(rm *)", "Bash", { command: "echo $(rm -rf /)" })).toBe(true);
		expect(matchesIf("Bash(rm *)", "Bash", { command: "echo $(date)" })).toBe(false);
	});

	it("errs towards running when the command is opaque", () => {
		expect(matchesIf("Bash(git *)", "Bash", { command: "$TOOL git push" })).toBe(true);
	});

	it("matches a file rule against the absolute path", () => {
		expect(matchesIf("Edit(**/src/**)", "Edit", { file_path: "/repo/src/a.ts" })).toBe(true);
		expect(matchesIf("Edit(**/src/**)", "Edit", { file_path: "/repo/lib/a.ts" })).toBe(false);
	});

	it("runs the hook when the rule cannot be parsed", () => {
		expect(matchesIf("not a rule", "Bash", { command: "ls" })).toBe(true);
	});
});

describe("hooksFor", () => {
	it("applies the if filter alongside the matcher", () => {
		const gated = hook({ handler: { type: "command", command: "true", if: "Bash(git *)" } });
		const plain = hook();
		const all = [gated, plain];

		expect(hooksFor(all, "PreToolUse", "Bash", { command: "git push" })).toHaveLength(2);
		expect(hooksFor(all, "PreToolUse", "Bash", { command: "npm test" })).toEqual([plain]);
	});
});

describe("discoverHooks", () => {
	it("keeps supported command handlers and reports the rest", () => {
		const result = discoverHooks("demo-plugin", FIXTURE_PLUGIN, readManifest(FIXTURE_PLUGIN), vars);
		expect(result.hooks.map((entry) => entry.event).sort()).toEqual([
			"PostToolUse",
			"PreToolUse",
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

	it("accepts an inline manifest hooks map that is already the event map", () => {
		const manifest = {
			hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "true" }] }] },
		};
		const result = discoverHooks("demo-plugin", FIXTURE_PLUGIN, manifest, vars);
		expect(result.hooks).toHaveLength(1);
		expect(result.hooks[0]?.matcher).toBe("Bash");
	});

	it("accepts an inline manifest hooks map that keeps the file wrapper", () => {
		const manifest = {
			hooks: {
				hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "true" }] }] },
			},
		};
		expect(discoverHooks("demo-plugin", FIXTURE_PLUGIN, manifest, vars).hooks).toHaveLength(1);
	});

	it("drops an if rule declared on a non-tool event", () => {
		const manifest = {
			hooks: { Stop: [{ hooks: [{ type: "command", command: "true", if: "Bash(git *)" }] }] },
		};
		const result = discoverHooks("demo-plugin", FIXTURE_PLUGIN, manifest, vars);
		expect(result.hooks).toHaveLength(0);
		expect(result.warnings.join(" ")).toContain('declares "if"');
	});

	it("reports a hooks file it cannot parse instead of treating it as empty", () => {
		const manifest = { hooks: "./hooks/broken.json" };
		const result = discoverHooks("demo-plugin", FIXTURE_PLUGIN, manifest, vars);
		expect(result.hooks).toHaveLength(0);
		expect(result.warnings.join(" ")).toContain("was ignored");
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
		expect(decision.outcome).toBe("deny");
		expect(decision.reason).toBe("no rm allowed");
	});

	it("keeps exit code 2 blocking even when the hook also printed ask", () => {
		const decision = mergeDecisions([
			execution({
				exitCode: 2,
				stderr: "policy",
				json: { hookSpecificOutput: { permissionDecision: "ask" } },
			}),
		]);
		expect(decision.outcome).toBe("deny");
	});

	it("keeps exit code 2 blocking even when the hook also printed defer", () => {
		const decision = mergeDecisions([
			execution({ exitCode: 2, json: { hookSpecificOutput: { permissionDecision: "defer" } } }),
		]);
		expect(decision.outcome).toBe("deny");
	});

	it("blocks on an explicit deny and prefers its reason", () => {
		const decision = mergeDecisions([
			execution({
				json: {
					hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "policy" },
				},
			}),
		]);
		expect(decision.outcome).toBe("deny");
		expect(decision.reason).toBe("policy");
	});

	it("lets deny win over allow and ask regardless of order", () => {
		const allow = execution({ json: { hookSpecificOutput: { permissionDecision: "allow" } } });
		const ask = execution({ json: { hookSpecificOutput: { permissionDecision: "ask" } } });
		const deny = execution({ json: { hookSpecificOutput: { permissionDecision: "deny" } } });
		expect(mergeDecisions([allow, deny]).outcome).toBe("deny");
		expect(mergeDecisions([deny, allow]).outcome).toBe("deny");
		expect(mergeDecisions([ask, deny]).outcome).toBe("deny");
		expect(mergeDecisions([allow, ask]).outcome).toBe("ask");
	});

	it("surfaces ask for confirmation rather than allowing it", () => {
		const decision = mergeDecisions([
			execution({ json: { hookSpecificOutput: { permissionDecision: "ask" } } }),
		]);
		expect(decision.outcome).toBe("ask");
	});

	it("denies defer, which pi cannot suspend and resume", () => {
		const decision = mergeDecisions([
			execution({ json: { hookSpecificOutput: { permissionDecision: "defer" } } }),
		]);
		expect(decision.outcome).toBe("deny");
		expect(decision.reason).toContain("defer");
	});

	it("honours valid JSON even on a non-zero, non-2 exit code", () => {
		const decision = mergeDecisions([
			execution({ exitCode: 3, json: { hookSpecificOutput: { permissionDecision: "deny" } } }),
		]);
		expect(decision.outcome).toBe("deny");
		expect(decision.warnings).toEqual([]);
	});

	it("treats a bare non-zero exit as a non-blocking error", () => {
		const decision = mergeDecisions([execution({ exitCode: 1, stderr: "boom" })]);
		expect(decision.outcome).toBe("allow");
		expect(decision.warnings.join(" ")).toContain("non-blocking status code 1");
	});

	it("reports continue:false as a termination, not as a block", () => {
		const decision = mergeDecisions([
			execution({ json: { continue: false, stopReason: "build is broken" } }),
		]);
		expect(decision.terminate).toBe(true);
		expect(decision.stopReason).toBe("build is broken");
		expect(decision.outcome).toBe("allow");
	});

	it("collects additional context, updatedInput and updatedToolOutput", () => {
		const decision = mergeDecisions([
			execution({ json: { hookSpecificOutput: { additionalContext: "first" } } }),
			execution({
				json: {
					hookSpecificOutput: {
						additionalContext: "second",
						updatedInput: { command: "ls" },
						updatedToolOutput: "redacted",
					},
				},
			}),
		]);
		expect(decision.additionalContext).toEqual(["first", "second"]);
		expect(decision.updatedInput).toEqual({ command: "ls" });
		expect(decision.updatedToolOutput).toBe("redacted");
	});

	it("accepts updatedMCPToolOutput as the MCP-only alias", () => {
		const decision = mergeDecisions([
			execution({ json: { hookSpecificOutput: { updatedMCPToolOutput: "x" } } }),
		]);
		expect(decision.updatedToolOutput).toBe("x");
	});

	it("renders no decision for a timed-out hook", () => {
		const decision = mergeDecisions([execution({ timedOut: true, exitCode: 2, stderr: "late" })]);
		expect(decision.outcome).toBe("allow");
		expect(decision.warnings.join(" ")).toContain("timed out");
	});
});

describe("plainContext", () => {
	it("keeps plain stdout from successful hooks only", () => {
		const context = plainContext([
			execution({ stdout: "branch: main\n" }),
			execution({ stdout: '{"decision":"block"}', json: { decision: "block" } }),
			execution({ stdout: "ignored", exitCode: 1 }),
			execution({ stdout: "late", timedOut: true }),
		]);
		expect(context).toEqual(["branch: main"]);
	});
});

describe("runHook", () => {
	const base = { cwd: process.cwd(), projectDir: process.cwd(), dataDir: "/tmp/pcp-data" };
	const input = { session_id: "s1", cwd: process.cwd(), hook_event_name: "PreToolUse" as const };

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

	it("reports a timeout instead of a decision, without waiting for the command", async () => {
		const started = Date.now();
		const result = await runHook({
			hook: hook({ handler: { type: "command", command: "sleep 30; exit 2", timeout: 0.2 } }),
			input,
			...base,
		});
		expect(result.timedOut).toBe(true);
		expect(result.json).toBeUndefined();
		expect(Date.now() - started).toBeLessThan(5000);
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
