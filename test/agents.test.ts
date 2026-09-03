import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentInvocationArgs, discoverAgents, resolveAgent, runAgent } from "../src/agents.ts";
import type { PluginAgent, SubstitutionVars } from "../src/types.ts";

const vars: SubstitutionVars = {
	CLAUDE_PLUGIN_ROOT: "/plugins/demo",
	CLAUDE_PLUGIN_DATA: "/data/demo",
	CLAUDE_PROJECT_DIR: "/work",
};

function agent(overrides: Partial<PluginAgent> = {}): PluginAgent {
	return {
		plugin: "demo-plugin",
		name: "worker",
		path: "/plugins/demo/agents/worker.md",
		description: "does work",
		systemPrompt: "be useful",
		...overrides,
	};
}

describe("discoverAgents", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pcp-agents-"));
		mkdirSync(join(root, "agents"), { recursive: true });
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	const write = (name: string, content: string) => writeFileSync(join(root, "agents", `${name}.md`), content);

	it("maps tools and disallowedTools onto pi's names", () => {
		write("a", "---\nname: a\ntools: Read, Grep, Bash\ndisallowedTools: Bash\n---\nbody");
		const result = discoverAgents("demo-plugin", root, {}, vars);
		expect(result.agents[0]?.tools).toEqual(["read", "grep", "bash"]);
		expect(result.agents[0]?.excludeTools).toEqual(["bash"]);
	});

	it("refuses an agent whose declared tools have no pi equivalent", () => {
		write("a", "---\nname: a\ntools: Task\n---\nbody");
		const result = discoverAgents("demo-plugin", root, {}, vars);
		expect(result.agents).toEqual([]);
		expect(result.warnings.join(" ")).toContain("not loaded");
	});

	it("refuses an agent that declares an empty tool list rather than widening it", () => {
		write("a", "---\nname: a\ntools: []\n---\nbody");
		const result = discoverAgents("demo-plugin", root, {}, vars);
		expect(result.agents).toEqual([]);
	});

	it("refuses an agent whose isolation pi cannot honour", () => {
		write("a", "---\nname: a\nisolation: worktree\n---\nbody");
		const result = discoverAgents("demo-plugin", root, {}, vars);
		expect(result.agents).toEqual([]);
		expect(result.warnings.join(" ")).toContain("isolation");
	});

	it("refuses an agent whose turn or memory limits pi cannot honour", () => {
		write("a", "---\nname: a\nmaxTurns: 3\n---\nbody");
		write("b", "---\nname: b\nmemory: project\n---\nbody");
		const result = discoverAgents("demo-plugin", root, {}, vars);
		expect(result.agents).toEqual([]);
		expect(result.warnings).toHaveLength(2);
	});

	it("warns about frontmatter a plugin agent may not set", () => {
		write("a", "---\nname: a\npermissionMode: bypassPermissions\n---\nbody");
		const result = discoverAgents("demo-plugin", root, {}, vars);
		expect(result.warnings.join(" ")).toContain("permissionMode");
	});

	it("maps a supported effort level onto a pi thinking level", () => {
		write("a", "---\nname: a\neffort: high\n---\nbody");
		write("b", "---\nname: b\neffort: turbo\n---\nbody");
		const result = discoverAgents("demo-plugin", root, {}, vars);
		expect(result.agents.find((entry) => entry.name === "a")?.thinkingLevel).toBe("high");
		expect(result.agents.find((entry) => entry.name === "b")?.thinkingLevel).toBeUndefined();
		expect(result.warnings.join(" ")).toContain("turbo");
	});

	it("expands plugin placeholders in the system prompt", () => {
		write("a", "---\nname: a\n---\nRun ${CLAUDE_PLUGIN_ROOT}/bin/x");
		const result = discoverAgents("demo-plugin", root, {}, vars);
		expect(result.agents[0]?.systemPrompt).toContain("/plugins/demo/bin/x");
	});
});

describe("agentInvocationArgs", () => {
	it("passes an explicit allowlist", () => {
		const args = agentInvocationArgs(agent({ tools: ["read", "grep"] }), undefined);
		expect(args).toContain("--tools");
		expect(args[args.indexOf("--tools") + 1]).toBe("read,grep");
	});

	it("subtracts disallowed tools from pi's defaults rather than passing none", () => {
		const args = agentInvocationArgs(agent({ excludeTools: ["bash", "write"] }), undefined);
		const allowlist = args[args.indexOf("--tools") + 1] ?? "";
		expect(allowlist).not.toContain("bash");
		expect(allowlist).not.toContain("write");
		expect(allowlist).toContain("read");
	});

	it("disables every tool when the exclusions cover the whole allowlist", () => {
		const args = agentInvocationArgs(agent({ tools: ["bash"], excludeTools: ["bash"] }), undefined);
		expect(args).toContain("--no-tools");
		expect(args).not.toContain("--tools");
	});

	it("inherits the dispatching model only when the agent declares none", () => {
		expect(agentInvocationArgs(agent(), "faux-model")).toContain("faux-model");
		expect(agentInvocationArgs(agent({ model: "own" }), "faux-model")).not.toContain("faux-model");
	});

	it("passes a thinking level when the agent declared an effort", () => {
		const args = agentInvocationArgs(agent({ thinkingLevel: "high" }), undefined);
		expect(args[args.indexOf("--thinking") + 1]).toBe("high");
	});
});

describe("runAgent cancellation", () => {
	it("does not wait forever for a child that ignores SIGTERM", async () => {
		const controller = new AbortController();
		const started = Date.now();
		const pending = runAgent({
			agent: agent({ systemPrompt: "" }),
			task: "loop",
			cwd: process.cwd(),
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 100);
		await pending;
		expect(Date.now() - started).toBeLessThan(15_000);
	}, 20_000);
});

describe("resolveAgent", () => {
	it("resolves a bare and a plugin-qualified name", () => {
		const agents = [agent({ name: "worker" })];
		expect(resolveAgent(agents, "worker")?.name).toBe("worker");
		expect(resolveAgent(agents, "demo-plugin:worker")?.name).toBe("worker");
		expect(resolveAgent(agents, "other:worker")).toBeUndefined();
	});
});
