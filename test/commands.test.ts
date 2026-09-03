import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	discoverCommands,
	expandArguments,
	expandCommand,
	FILE_REFUSED_MARKER,
	SHELL_DISABLED_MARKER,
	splitArguments,
} from "../src/commands.ts";
import { readManifest } from "../src/manifest.ts";
import type { PluginCommand, SubstitutionVars } from "../src/types.ts";
import { FIXTURE_PLUGIN } from "./helpers.ts";

const vars: SubstitutionVars = {
	CLAUDE_PLUGIN_ROOT: FIXTURE_PLUGIN,
	CLAUDE_PLUGIN_DATA: "/data/demo",
	CLAUDE_PROJECT_DIR: "/work",
};

function command(body: string, overrides: Partial<PluginCommand> = {}): PluginCommand {
	return {
		plugin: "demo-plugin",
		name: "demo",
		path: join(FIXTURE_PLUGIN, "commands/demo.md"),
		argumentNames: [],
		body,
		...overrides,
	};
}

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
		expect(expandArguments("$0 to $1", "SearchBar TypeScript", []).text).toBe("SearchBar to TypeScript");
	});

	it("supports $ARGUMENTS[N]", () => {
		expect(expandArguments("$ARGUMENTS[1]", "first second", []).text).toBe("second");
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
		expect(expandArguments("$0 $3", "only", []).text).toContain("only $3");
	});

	it("leaves an undeclared $name alone", () => {
		expect(expandArguments("cost is $total", "x", []).text).toContain("cost is $total");
	});

	it("does not rescan text an argument brought in", () => {
		const { text } = expandArguments("$ARGUMENTS", "literal $0 and $ARGUMENTS", []);
		expect(text).toBe("literal $0 and $ARGUMENTS");
	});

	it("appends ARGUMENTS when no placeholder consumed the input", () => {
		expect(expandArguments("Do the thing.", "now", []).text).toBe("Do the thing.\n\nARGUMENTS: now");
	});

	it("does not append ARGUMENTS when there is nothing to append", () => {
		expect(expandArguments("Do the thing.", "  ", []).text).toBe("Do the thing.");
	});
});

describe("expandCommand shell injection", () => {
	const base = { vars, cwd: FIXTURE_PLUGIN, pluginRoot: FIXTURE_PLUGIN, allowShell: true };

	it("never executes a shell command an argument smuggled in", async () => {
		const run = vi.fn(async () => "authored output");
		const expanded = await expandCommand({
			...base,
			command: command("Review $ARGUMENTS"),
			rawArguments: "!`touch /tmp/pcp-pwned`",
			run,
		});
		expect(run).not.toHaveBeenCalled();
		expect(expanded).toContain("!`touch /tmp/pcp-pwned`");
	});

	it("never reads a file an argument smuggled in", async () => {
		const expanded = await expandCommand({
			...base,
			command: command("Review $ARGUMENTS"),
			rawArguments: "@/etc/hosts",
			run: async () => "",
		});
		expect(expanded).toBe("Review @/etc/hosts");
	});

	it("cannot be tricked by an argument forging a slot delimiter", async () => {
		const expanded = await expandCommand({
			...base,
			command: command("!`echo authored` then $ARGUMENTS"),
			rawArguments: "deadbeef:s:0",
			run: async () => "AUTHORED",
		});
		expect(expanded).toBe("AUTHORED then deadbeef:s:0");
	});

	it("still runs the commands the plugin author wrote", async () => {
		const expanded = await expandCommand({
			...base,
			command: command("inline: !`echo one`\n\n```!\necho two\n```\n"),
			rawArguments: "",
			run: async (shellCommand) => `<${shellCommand}>`,
		});
		expect(expanded).toContain("<echo one>");
		expect(expanded).toContain("<echo two>");
	});

	it("expands plugin placeholders inside an authored shell command", async () => {
		const run = vi.fn(async () => "ok");
		await expandCommand({
			...base,
			command: command("!`${CLAUDE_PLUGIN_ROOT}/scripts/x.sh`"),
			rawArguments: "",
			run,
		});
		expect(run).toHaveBeenCalledWith(`${FIXTURE_PLUGIN}/scripts/x.sh`);
	});

	it("marks authored commands when shell execution is not permitted", async () => {
		const expanded = await expandCommand({
			...base,
			allowShell: false,
			command: command("status: !`whoami`"),
			rawArguments: "",
			run: async () => {
				throw new Error("must not run");
			},
		});
		expect(expanded).toBe(`status: ${SHELL_DISABLED_MARKER}`);
	});
});

describe("expandCommand file references", () => {
	let projectDir: string;

	beforeAll(() => {
		projectDir = mkdtempSync(join(tmpdir(), "pcp-refs-"));
		writeFileSync(join(projectDir, "notes.md"), "line one\n");
	});
	afterAll(() => rmSync(projectDir, { recursive: true, force: true }));

	const expand = (body: string, cwd: string) =>
		expandCommand({
			command: command(body),
			rawArguments: "",
			vars,
			cwd,
			pluginRoot: FIXTURE_PLUGIN,
			allowShell: false,
			run: async () => "",
		});

	it("inlines a file inside the project", async () => {
		const result = await expand("See @notes.md for details", projectDir);
		expect(result).toContain("// notes.md");
		expect(result).toContain("line one");
	});

	it("inlines a file inside the plugin", async () => {
		const result = await expand("See @skills/greeting/reference.md", FIXTURE_PLUGIN);
		expect(result).toContain("House style");
	});

	it("refuses a file outside the project and the plugin", async () => {
		const result = await expand("See @/etc/hosts", projectDir);
		expect(result).toContain(FILE_REFUSED_MARKER);
		expect(result).not.toContain("localhost");
	});

	it("refuses an escaping relative path", async () => {
		const result = await expand("See @../../etc/hosts", projectDir);
		expect(result).toContain(FILE_REFUSED_MARKER);
	});

	it("leaves an unresolvable reference and an email address alone", async () => {
		const body = "@missing.md and someone@example.com";
		expect(await expand(body, projectDir)).toBe(body);
	});
});

describe("discoverCommands", () => {
	it("reads the fixture plugin's commands with their frontmatter", () => {
		const { commands } = discoverCommands("demo-plugin", FIXTURE_PLUGIN, readManifest(FIXTURE_PLUGIN));
		expect(commands.map((entry) => entry.name).sort()).toEqual(["review", "status"]);

		const review = commands.find((entry) => entry.name === "review");
		expect(review?.description).toBe("Review a file against the demo checklist");
		expect(review?.argumentNames).toEqual(["path", "focus"]);
	});
});

describe("expandCommand", () => {
	it("applies substitution, arguments, shell and file references in order", async () => {
		const { commands } = discoverCommands("demo-plugin", FIXTURE_PLUGIN, readManifest(FIXTURE_PLUGIN));
		const review = commands.find((entry) => entry.name === "review");
		expect(review).toBeDefined();
		if (!review) return;

		const expanded = await expandCommand({
			command: review,
			rawArguments: "src/index.ts security",
			vars,
			cwd: FIXTURE_PLUGIN,
			pluginRoot: FIXTURE_PLUGIN,
			allowShell: false,
			run: async () => "",
		});

		expect(expanded).toContain("Review src/index.ts with a focus on security.");
		expect(expanded).toContain(`Plugin root: ${FIXTURE_PLUGIN}`);
		expect(expanded).toContain("First argument: src/index.ts");
		expect(expanded).toContain("All arguments: src/index.ts security");
	});
});
