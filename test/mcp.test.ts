import { describe, expect, it, vi } from "vitest";
import { readManifest } from "../src/manifest.ts";
import { discoverMcpServers, MCP_RUNTIME_REGISTER_EVENT, registerMcpServer } from "../src/mcp.ts";
import type { PluginMcpServer, SubstitutionVars } from "../src/types.ts";
import { FIXTURE_PLUGIN } from "./helpers.ts";

const vars: SubstitutionVars = {
	CLAUDE_PLUGIN_ROOT: FIXTURE_PLUGIN,
	CLAUDE_PLUGIN_DATA: "/data/demo",
	CLAUDE_PROJECT_DIR: "/work",
};

const server: PluginMcpServer = {
	plugin: "demo-plugin",
	name: "demo-plugin__docs",
	definition: { command: "/bin/true" },
};

describe("discoverMcpServers", () => {
	it("warns about a variable that has neither a value nor a default", () => {
		const manifest = { mcpServers: { mcpServers: { api: { url: "${API_BASE}/mcp" } } } };
		const result = discoverMcpServers("demo-plugin", FIXTURE_PLUGIN, manifest, vars, {});
		expect(result.servers[0]?.definition.url).toBe("${API_BASE}/mcp");
		expect(result.warnings.join(" ")).toContain("API_BASE");
	});

	it("reads .mcp.json when the manifest declares nothing", () => {
		const result = discoverMcpServers("demo-plugin", FIXTURE_PLUGIN, readManifest(FIXTURE_PLUGIN), vars, {});
		expect(result.servers.map((entry) => entry.name)).toEqual(["demo-plugin__docs"]);
	});
});

describe("registerMcpServer", () => {
	it("reports a missing adapter rather than throwing", () => {
		const events = { emit: vi.fn() };
		expect(registerMcpServer(events, server)).toEqual({ status: "no-adapter" });
		expect(events.emit).toHaveBeenCalledWith(
			MCP_RUNTIME_REGISTER_EVENT,
			expect.objectContaining({ version: 1, name: "demo-plugin__docs" }),
		);
	});

	it("returns the registration the adapter writes back onto the request", () => {
		const registration = { dispose: async () => {} };
		const events = {
			emit: (_event: string, payload: unknown) => {
				(payload as { result?: unknown }).result = { ok: true, registration };
			},
		};
		expect(registerMcpServer(events, server)).toEqual({ status: "registered", registration });
	});

	it("surfaces an adapter failure", () => {
		const error = new Error("duplicate server name");
		const events = {
			emit: (_event: string, payload: unknown) => {
				(payload as { result?: unknown }).result = { ok: false, error };
			},
		};
		expect(registerMcpServer(events, server)).toEqual({ status: "failed", error });
	});
});
