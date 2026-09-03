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
		enabledPlugins: [],
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
		expect(plugin?.id).toBe("demo-plugin");
		expect(plugin?.skills.map((skill) => skill.name)).toEqual(["demo-greeting"]);
		expect(plugin?.commands.map((command) => command.name).sort()).toEqual(["review", "status"]);
		expect(plugin?.agents.map((agent) => agent.name)).toEqual(["echo"]);
		expect(plugin?.mcpServers.map((server) => server.name)).toEqual(["demo-plugin__docs"]);
	});

	it("refuses hooks until the plugin is trusted", () => {
		const untrusted = loadPlugins({ settings: settings({ paths: [FIXTURE_PLUGIN] }), ...loadOptions });
		expect(untrusted.plugins[0]?.hooks).toEqual([]);
		expect(untrusted.plugins[0]?.trusted).toBe(false);
		expect(untrusted.plugins[0]?.refused.join(" ")).toContain("hook handler");

		const trusted = loadPlugins({
			settings: settings({ paths: [FIXTURE_PLUGIN], trustedPlugins: ["demo-plugin"] }),
			...loadOptions,
		});
		expect(trusted.plugins[0]?.hooks).toHaveLength(4);
		expect(trusted.plugins[0]?.trusted).toBe(true);

		const global = loadPlugins({
			settings: settings({ paths: [FIXTURE_PLUGIN], allowHooks: true }),
			...loadOptions,
		});
		expect(global.plugins[0]?.hooks).toHaveLength(4);
	});

	it("maps Claude agent tool names onto pi's", () => {
		const result = loadPlugins({ settings: settings({ paths: [FIXTURE_PLUGIN] }), ...loadOptions });
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

	it("reports a plugin path that does not exist", () => {
		const result = loadPlugins({ settings: settings({ paths: ["/nope/plugin"] }), ...loadOptions });
		expect(result.plugins).toEqual([]);
		expect(result.diagnostics[0]?.level).toBe("error");
	});

	it("keeps loading after a malformed plugin", () => {
		const broken = mkdtempSync(join(tmpdir(), "pcp-broken-"));
		try {
			mkdirSync(join(broken, ".claude-plugin"), { recursive: true });
			writeFileSync(
				join(broken, ".claude-plugin/plugin.json"),
				JSON.stringify({ name: "broken", commands: 42 }),
			);
			const result = loadPlugins({
				settings: settings({ paths: [broken, FIXTURE_PLUGIN] }),
				...loadOptions,
			});
			expect(result.plugins.map((plugin) => plugin.id)).toEqual(["demo-plugin"]);
			expect(result.diagnostics.some((entry) => entry.level === "error")).toBe(true);
		} finally {
			rmSync(broken, { recursive: true, force: true });
		}
	});
});

describe("marketplace entries", () => {
	it("lists catalog entries without loading them", () => {
		const result = loadPlugins({
			settings: settings({ marketplaces: [FIXTURE_MARKETPLACE] }),
			...loadOptions,
		});
		expect(result.plugins).toEqual([]);
		expect(result.available).toEqual(["tiny@demo-marketplace"]);
	});

	it("loads an entry once it is enabled, with an origin-qualified id", () => {
		const result = loadPlugins({
			settings: settings({
				marketplaces: [FIXTURE_MARKETPLACE],
				enabledPlugins: ["tiny@demo-marketplace"],
			}),
			...loadOptions,
		});
		expect(result.plugins.map((plugin) => plugin.id)).toEqual(["tiny@demo-marketplace"]);
		expect(result.plugins[0]?.marketplace).toBe("demo-marketplace");
	});

	it("does not let a marketplace entry inherit a bare name's hook trust", () => {
		const result = loadPlugins({
			settings: settings({
				marketplaces: [FIXTURE_MARKETPLACE],
				enabledPlugins: ["tiny@demo-marketplace"],
				trustedPlugins: ["tiny"],
			}),
			...loadOptions,
		});
		expect(result.plugins[0]?.trusted).toBe(false);
	});

	it("reports unresolved sources, including a traversing one", () => {
		const result = loadPlugins({
			settings: settings({ marketplaces: [FIXTURE_MARKETPLACE] }),
			...loadOptions,
		});
		const messages = result.diagnostics.map((diagnostic) => diagnostic.message).join("\n");
		expect(messages).toContain("not a usable local path");
	});
});

describe("findSkillCollisions", () => {
	it("names the plugins that share a skill name", () => {
		const collisions = findSkillCollisions([
			{ plugin: "a", path: "/a", name: "review", needsSubstitution: false },
			{ plugin: "b", path: "/b", name: "review", needsSubstitution: false },
			{ plugin: "a", path: "/c", name: "unique", needsSubstitution: false },
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
			available: ["tiny@demo-marketplace"],
		});

		expect(report).toContain("loaded 1 plugin(s)");
		expect(report).toContain("1 skill, 2 commands, 1 agent, 1 mcp server");
		expect(report).toContain("refused:");
		expect(report).toContain("unsupported hook event Notification");
		expect(report).toContain("shell expansion in commands is disabled");
		expect(report).toContain("available but not enabled");
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
		expect(resolved.enabledPlugins).toEqual([]);
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

	it("appends plugin directories, enabled entries and flags from the environment", () => {
		const resolved = resolveSettings({
			cwd,
			agentDir,
			projectTrusted: false,
			env: {
				PI_CLAUDE_PLUGINS: `${FIXTURE_PLUGIN}:/second`,
				PI_CLAUDE_PLUGINS_ENABLED: "tiny@demo-marketplace,other",
				PI_CLAUDE_PLUGINS_ALLOW_HOOKS: "1",
				PI_CLAUDE_PLUGINS_ALLOW_SHELL: "true",
			},
		});
		expect(resolved.paths).toEqual([FIXTURE_PLUGIN, "/second"]);
		expect(resolved.enabledPlugins).toEqual(["tiny@demo-marketplace", "other"]);
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
