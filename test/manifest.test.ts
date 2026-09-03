import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	isInside,
	ManifestError,
	pluginNameFor,
	readManifest,
	resolveComponentPaths,
} from "../src/manifest.ts";
import { readMarketplace } from "../src/marketplace.ts";
import { FIXTURE_MARKETPLACE, FIXTURE_PLUGIN } from "./helpers.ts";

describe("readManifest", () => {
	it("reads the fixture manifest", () => {
		const manifest = readManifest(FIXTURE_PLUGIN);
		expect(manifest.name).toBe("demo-plugin");
		expect(manifest.version).toBe("1.0.0");
	});

	it("treats a manifest-less directory as a valid plugin", () => {
		expect(readManifest(tmpdir())).toEqual({});
	});
});

describe("plugin roots", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pcp-manifest-"));
		mkdirSync(join(root, ".claude-plugin"), { recursive: true });
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("rejects a manifest that is not a JSON object", () => {
		writeFileSync(join(root, ".claude-plugin/plugin.json"), "[]");
		expect(() => readManifest(root)).toThrow(ManifestError);
	});

	it("rejects a manifest with a mistyped field", () => {
		writeFileSync(join(root, ".claude-plugin/plugin.json"), '{"name":"x","keywords":"nope"}');
		expect(() => readManifest(root)).toThrow(ManifestError);
	});

	it("rejects a component path field that is not a string or array", () => {
		for (const manifest of ['{"commands":42}', '{"agents":{"a":1}}', '{"skills":[1]}']) {
			writeFileSync(join(root, ".claude-plugin/plugin.json"), manifest);
			expect(() => readManifest(root)).toThrow(ManifestError);
		}
	});

	it("accepts hooks and mcpServers as a path, a list or an inline object", () => {
		for (const manifest of [
			'{"hooks":"./h.json"}',
			'{"hooks":["./h.json"]}',
			'{"hooks":{"PreToolUse":[]}}',
			'{"mcpServers":{"docs":{}}}',
		]) {
			writeFileSync(join(root, ".claude-plugin/plugin.json"), manifest);
			expect(() => readManifest(root)).not.toThrow();
		}
	});

	it("falls back to the directory name when the manifest omits one", () => {
		expect(pluginNameFor(root, {})).toBe(root.split("/").pop());
	});

	it("refuses a path that leaves the plugin directory", () => {
		expect(isInside(root, "./skills")).toBe(true);
		expect(isInside(root, "../elsewhere")).toBe(false);
		expect(isInside(root, "/etc")).toBe(false);
	});

	it("refuses a symlink whose target resolves outside the plugin", () => {
		const outside = mkdtempSync(join(tmpdir(), "pcp-outside-"));
		try {
			symlinkSync(outside, join(root, "escape"));
			expect(isInside(root, "escape")).toBe(false);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});
});

describe("resolveComponentPaths", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pcp-paths-"));
		mkdirSync(join(root, "skills"), { recursive: true });
		mkdirSync(join(root, "extra"), { recursive: true });
		mkdirSync(join(root, "commands"), { recursive: true });
		mkdirSync(join(root, "custom"), { recursive: true });
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("adds declared skill paths on top of the default directory", () => {
		const { paths } = resolveComponentPaths(root, ["./extra"], "skills", "add");
		expect(paths).toEqual([resolve(root, "skills"), resolve(root, "extra")]);
	});

	it("replaces the default directory for every other component", () => {
		const { paths } = resolveComponentPaths(root, ["./custom"], "commands", "replace");
		expect(paths).toEqual([resolve(root, "custom")]);
	});

	it("keeps the default when nothing is declared", () => {
		const { paths } = resolveComponentPaths(root, undefined, "commands", "replace");
		expect(paths).toEqual([resolve(root, "commands")]);
	});

	it("drops an escaping path and reports it", () => {
		const { paths, escaped } = resolveComponentPaths(root, ["../outside"], "commands", "replace");
		expect(paths).toEqual([]);
		expect(escaped).toEqual(["../outside"]);
	});
});

describe("readMarketplace", () => {
	it("resolves local sources and reports the rest", () => {
		const marketplace = readMarketplace(FIXTURE_MARKETPLACE);
		expect(marketplace.name).toBe("demo-marketplace");
		expect(marketplace.plugins.map((plugin) => plugin.name)).toEqual(["tiny"]);

		const unresolved = Object.fromEntries(marketplace.unresolved.map((entry) => [entry.name, entry.reason]));
		expect(unresolved.remote).toContain("not a usable local path");
		// Claude Code rejects any source containing "..", even one that normalises back inside.
		expect(unresolved.escaping).toContain("not a usable local path");
		expect(unresolved.traversing).toContain("not a usable local path");
	});
});
