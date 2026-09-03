import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	discoverCommands,
	expandArguments,
	expandCommand,
	expandFileReferences,
	expandShell,
	SHELL_DISABLED_MARKER,
	splitArguments,
} from "../src/commands.ts";
import { readManifest } from "../src/manifest.ts";
import type { SubstitutionVars } from "../src/types.ts";
import { FIXTURE_PLUGIN } from "./helpers.ts";

const vars: SubstitutionVars = {
	CLAUDE_PLUGIN_ROOT: FIXTURE_PLUGIN,
	CLAUDE_PLUGIN_DATA: "/data/demo",
	CLAUDE_PROJECT_DIR: "/work",
};

describe("splitArguments", () => {
	it("keeps quoted groups together", () => {
		expect(splitArguments('Button "click handler" plain')).toEqual(["Button", "click handler", "plain"]);
	});

	it("preserves an explicitly empty argument", () => {
		expect(splitArguments('a "" b')).toEqual(["a", "", "b"]);
	});
});

describe("expandArguments", () => {
	it("indexes positional placeholders from zero, unlike pi templates", () => {
		const { text } = expandArguments("$0 to $1", "SearchBar TypeScript", []);
		expect(text).toBe("SearchBar to TypeScript");
	});

	it("supports $ARGUMENTS[N]", () => {
		const { text } = expandArguments("$ARGUMENTS[1]", "first second", []);
		expect(text).toBe("second");
	});

	it("resolves named arguments by declaration order", () => {
		const { text } = expandArguments("$path / $focus", "src/a.ts security", ["path", "focus"]);
		expect(text).toBe("src/a.ts / security");
	});

	it("expands a named argument with no value to an empty string", () => {
		const { text, consumed } = expandArguments("[$focus]", "", ["focus"]);
		expect(text).toBe("[]");
		expect(consumed).toBe(true);
	});

	it("leaves an out-of-range positional placeholder as literal text", () => {
		const { text } = expandArguments("$0 $3", "only", []);
		expect(text).toContain("only $3");
	});

	it("appends ARGUMENTS when no placeholder consumed the input", () => {
		const { text } = expandArguments("Do the thing.", "now", []);
		expect(text).toBe("Do the thing.\n\nARGUMENTS: now");
	});

	it("does not append ARGUMENTS when there is nothing to append", () => {
		const { text } = expandArguments("Do the thing.", "  ", []);
		expect(text).toBe("Do the thing.");
	});
});

describe("expandShell", () => {
	it("substitutes inline and fenced command output", async () => {
		const body = "inline: !`echo one`\n\n```!\necho two\n```\n";
		const result = await expandShell(body, true, async (command) => `<${command}>`);
		expect(result).toContain("<echo one>");
		expect(result).toContain("<echo two>");
	});

	it("replaces commands with a marker when shell execution is not permitted", async () => {
		const result = await expandShell("status: !`whoami`", false, async () => {
			throw new Error("must not run");
		});
		expect(result).toBe(`status: ${SHELL_DISABLED_MARKER}`);
	});

	it("leaves a body with no commands untouched", async () => {
		const body = "nothing to run here";
		expect(await expandShell(body, true, async () => "x")).toBe(body);
	});
});

describe("expandFileReferences", () => {
	let dir: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pcp-refs-"));
		writeFileSync(join(dir, "notes.md"), "line one\n");
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("inlines a referenced file", () => {
		const result = expandFileReferences("See @notes.md for details", dir);
		expect(result).toContain("// notes.md");
		expect(result).toContain("line one");
	});

	it("leaves an unresolvable reference and an email address alone", () => {
		const body = "@missing.md and someone@example.com";
		expect(expandFileReferences(body, dir)).toBe(body);
	});
});

describe("discoverCommands", () => {
	it("reads the fixture plugin's commands with their frontmatter", () => {
		const { commands } = discoverCommands("demo-plugin", FIXTURE_PLUGIN, readManifest(FIXTURE_PLUGIN));
		const names = commands.map((command) => command.name).sort();
		expect(names).toEqual(["review", "status"]);

		const review = commands.find((command) => command.name === "review");
		expect(review?.description).toBe("Review a file against the demo checklist");
		expect(review?.argumentNames).toEqual(["path", "focus"]);
	});
});

describe("expandCommand", () => {
	it("applies substitution, arguments, shell and file references in order", async () => {
		const { commands } = discoverCommands("demo-plugin", FIXTURE_PLUGIN, readManifest(FIXTURE_PLUGIN));
		const review = commands.find((command) => command.name === "review");
		expect(review).toBeDefined();
		if (!review) return;

		const expanded = await expandCommand({
			command: review,
			rawArguments: "src/index.ts security",
			vars,
			cwd: FIXTURE_PLUGIN,
			allowShell: false,
			run: async () => "",
		});

		expect(expanded).toContain("Review src/index.ts with a focus on security.");
		expect(expanded).toContain(`Plugin root: ${FIXTURE_PLUGIN}`);
		expect(expanded).toContain("First argument: src/index.ts");
		expect(expanded).toContain("All arguments: src/index.ts security");
	});

	it("runs the shell only when permitted", async () => {
		const { commands } = discoverCommands("demo-plugin", FIXTURE_PLUGIN, readManifest(FIXTURE_PLUGIN));
		const status = commands.find((command) => command.name === "status");
		expect(status).toBeDefined();
		if (!status) return;

		const blocked = await expandCommand({
			command: status,
			rawArguments: "",
			vars,
			cwd: FIXTURE_PLUGIN,
			allowShell: false,
			run: async () => "alive",
		});
		expect(blocked).toContain(SHELL_DISABLED_MARKER);

		const allowed = await expandCommand({
			command: status,
			rawArguments: "",
			vars,
			cwd: FIXTURE_PLUGIN,
			allowShell: true,
			run: async () => "alive",
		});
		expect(allowed).toContain("alive");
	});
});
