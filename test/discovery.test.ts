import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandHome, resolveSettings } from "../src/config.ts";
import { loadPlugins } from "../src/discovery.ts";
import { formatReport } from "../src/report.ts";
import { findSkillCollisions } from "../src/skills.ts";
import type { PluginSettings } from "../src/types.ts";
import { FIXTURE_MARKETPLACE, FIXTURE_PLUGIN } from "./helpers.ts";

function settings(overrides: Partial<PluginSettings> = {}): PluginSettings {
	return {
		paths: [],
		marketplaces: [],
		allowShellCommands: false,
		allowHooks: false,
		trustedPlugins: [],
		disabledPlugins: [],
		agents: true,
		...overrides,
	};
}

const loadOptions = { cwd: "/work", dataRoot: "/data" };

describe("loadPlugins", () => {
	it("loads every supported component of the fixture plugin", () => {
		const result = loadPlugins({ settings: settings({ paths: [FIXTURE_PLUGIN] }), ...loadOptions });
		expect(result.plugins).toHaveLength(1);

		const plugin = result.plugins[0];
		expect(plugin?.name).toBe("demo-plugin");
		expect(plugin?.skills.map((skill) => skill.name)).toEqual(["demo-greeting"]);
		expect(plugin?.commands.map((command) => command.name).sort()).toEqual(["review", "status"]);
		expect(plugin?.agents.map((agent) => agent.name)).toEqual(["echo"]);
		expect(plugin?.mcpServers.map((server) => server.name)).toEqual(["demo-plugin__docs"]);
	});

	it("refuses hooks until the plugin is trusted", () => {
		const untrusted = loadPlugins({ settings: settings({ paths: [FIXTURE_PLUGIN] }), ...loadOptions });
		expect(untrusted.plugins[0]?.hooks).toEqual([]);
		expect(untrusted.plugins[0]?.refused.join(" ")).toContain("hook handler");

		const trusted = loadPlugins({
			settings: settings({ paths: [FIXTURE_PLUGIN], trustedPlugins: ["demo-plugin"] }),
			...loadOptions,
		});
		expect(trusted.plugins[0]?.hooks).toHaveLength(3);

		const global = loadPlugins({
			settings: settings({ paths: [FIXTURE_PLUGIN], allowHooks: true }),
			...loadOptions,
		});
		expect(global.plugins[0]?.hooks).toHaveLength(3);
	});

	it("maps Claude agent tool names onto pi's", () => {
		const result = loadPlugins({
			settings: settings({ paths: [FIXTURE_PLUGIN] }),
			...loadOptions,
		});
		expect(result.plugins[0]?.agents[0]?.tools).toEqual(["read", "grep"]);
	});

	it("expands MCP placeholders and defers env resolution to the default", () => {
		const result = loadPlugins({
			settings: settings({ paths: [FIXTURE_PLUGIN] }),
			...loadOptions,
			env: {},
		});
		const server = result.plugins[0]?.mcpServers[0];
		expect(server?.definition.command).toBe(`${FIXTURE_PLUGIN}/scripts/mcp-server.sh`);
		expect(server?.definition.args).toEqual(["--root", FIXTURE_PLUGIN]);
		expect(server?.definition.env).toEqual({
			DEMO_DATA: "/data/demo-plugin",
			DEMO_TOKEN: "anonymous",
		});
		expect(server?.definition.literalEnv).toBe(true);
	});

	it("skips a disabled plugin", () => {
		const result = loadPlugins({
			settings: settings({ paths: [FIXTURE_PLUGIN], disabledPlugins: ["demo-plugin"] }),
			...loadOptions,
		});
		expect(result.plugins).toEqual([]);
	});

	it("loads a plugin through a marketplace and reports unresolved sources", () => {
		const result = loadPlugins({
			settings: settings({ marketplaces: [FIXTURE_MARKETPLACE] }),
			...loadOptions,
		});
		expect(result.plugins.map((plugin) => plugin.name)).toEqual(["tiny"]);
		expect(result.plugins[0]?.marketplace).toBe("demo-marketplace");

		const messages = result.diagnostics.map((diagnostic) => diagnostic.message).join("\n");
		expect(messages).toContain("not a local path");
	});

	it("reports a plugin path that does not exist", () => {
		const result = loadPlugins({
			settings: settings({ paths: ["/nope/plugin"] }),
			...loadOptions,
		});
		expect(result.plugins).toEqual([]);
		expect(result.diagnostics[0]?.level).toBe("error");
	});
});

describe("findSkillCollisions", () => {
	it("names the plugins that share a skill name", () => {
		const collisions = findSkillCollisions([
			{ plugin: "a", path: "/a", name: "review" },
			{ plugin: "b", path: "/b", name: "review" },
			{ plugin: "a", path: "/c", name: "unique" },
		]);
		expect(collisions).toEqual([{ name: "review", plugins: ["a", "b"] }]);
	});
});

describe("formatReport", () => {
	it("lists what loaded, what was refused and what needs an adapter", () => {
		const result = loadPlugins({ settings: settings({ paths: [FIXTURE_PLUGIN] }), ...loadOptions });
		const report = formatReport({
			plugins: result.plugins,
			diagnostics: result.diagnostics,
			collisions: result.collisions,
			mcpUnavailable: ["demo-plugin__docs"],
			shellAllowed: false,
		});

		expect(report).toContain("loaded 1 plugin(s)");
		expect(report).toContain("1 skill, 2 commands, 1 agent, 1 mcp server");
		expect(report).toContain("refused:");
		expect(report).toContain("unsupported hook event Notification");
		expect(report).toContain("shell expansion in commands is disabled");
		expect(report).toContain("pi-mcp-adapter");
	});
});

describe("resolveSettings", () => {
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pcp-agent-"));
		cwd = mkdtempSync(join(tmpdir(), "pcp-project-"));
	});
	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	it("returns conservative defaults with no settings at all", () => {
		const resolved = resolveSettings({ cwd, agentDir, projectTrusted: true, env: {} });
		expect(resolved).toMatchObject({ allowHooks: false, allowShellCommands: false, agents: true });
		expect(resolved.paths).toEqual([]);
	});

	it("resolves relative paths against the settings file directory", () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ claudePlugins: { paths: ["./plugins/demo"] } }),
		);
		const resolved = resolveSettings({ cwd, agentDir, projectTrusted: false, env: {} });
		expect(resolved.paths).toEqual([join(agentDir, "plugins/demo")]);
	});

	it("ignores project settings until the project is trusted", () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi/settings.json"),
			JSON.stringify({ claudePlugins: { allowHooks: true, paths: ["./local"] } }),
		);

		const untrusted = resolveSettings({ cwd, agentDir, projectTrusted: false, env: {} });
		expect(untrusted.allowHooks).toBe(false);
		expect(untrusted.paths).toEqual([]);

		const trusted = resolveSettings({ cwd, agentDir, projectTrusted: true, env: {} });
		expect(trusted.allowHooks).toBe(true);
		expect(trusted.paths).toEqual([join(cwd, ".pi/local")]);
	});

	it("appends plugin directories and flags from the environment", () => {
		const resolved = resolveSettings({
			cwd,
			agentDir,
			projectTrusted: false,
			env: {
				PI_CLAUDE_PLUGINS: `${FIXTURE_PLUGIN}:/second`,
				PI_CLAUDE_PLUGINS_ALLOW_HOOKS: "1",
				PI_CLAUDE_PLUGINS_ALLOW_SHELL: "true",
			},
		});
		expect(resolved.paths).toEqual([FIXTURE_PLUGIN, "/second"]);
		expect(resolved.allowHooks).toBe(true);
		expect(resolved.allowShellCommands).toBe(true);
	});

	it("survives a settings file it cannot parse", () => {
		writeFileSync(join(agentDir, "settings.json"), "{ not json");
		expect(() => resolveSettings({ cwd, agentDir, projectTrusted: false, env: {} })).not.toThrow();
	});
});

describe("expandHome", () => {
	it("expands a leading tilde only", () => {
		expect(expandHome("~/plugins", "/home/u")).toBe("/home/u/plugins");
		expect(expandHome("~", "/home/u")).toBe("/home/u");
		expect(expandHome("/abs/~x", "/home/u")).toBe("/abs/~x");
	});
});
