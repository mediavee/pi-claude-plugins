import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import {
	claudeInputToPi,
	claudeToolToPi,
	DEFAULT_PI_TOOLS,
	mapClaudeToolList,
	piInputToClaude,
	piToolToClaude,
} from "../src/tool-names.ts";

describe("tool names", () => {
	it("maps the built-in tools both ways", () => {
		expect(claudeToolToPi("Glob")).toBe("find");
		expect(claudeToolToPi("Grep")).toBe("grep");
		expect(piToolToClaude("find")).toBe("Glob");
		expect(piToolToClaude("bash")).toBe("Bash");
	});

	it("keeps unknown pi tool names so MCP and extension tools stay matchable", () => {
		expect(piToolToClaude("mcp__memory__store")).toBe("mcp__memory__store");
	});

	it("lists pi's built-in tools as the default allowlist", () => {
		expect(DEFAULT_PI_TOOLS).toContain("bash");
		expect(DEFAULT_PI_TOOLS).toContain("read");
	});

	it("drops Claude tools with no pi equivalent instead of passing them through", () => {
		expect(mapClaudeToolList(["Read", "Task", "Grep", "WebFetch"])).toEqual({
			tools: ["read", "grep"],
			dropped: ["Task", "WebFetch"],
		});
	});

	it("collapses the edit family onto a single pi tool", () => {
		expect(mapClaudeToolList(["Edit", "MultiEdit", "NotebookEdit"]).tools).toEqual(["edit"]);
	});
});

describe("tool input shapes", () => {
	const cwd = "/repo";

	it("renames path to file_path for the file tools", () => {
		expect(piInputToClaude("read", { path: "/a.ts", limit: 10 }, cwd)).toEqual({
			file_path: "/a.ts",
			limit: 10,
		});
		expect(claudeInputToPi("read", { file_path: "/a.ts" })).toEqual({ path: "/a.ts" });
	});

	it("makes the path absolute so a hook cannot be dodged by spelling it relatively", () => {
		expect(piInputToClaude("read", { path: "src/a.ts" }, cwd)).toEqual({ file_path: "/repo/src/a.ts" });
		expect(piInputToClaude("write", { path: "./src/../src/a.ts" }, cwd)).toEqual({
			file_path: "/repo/src/a.ts",
		});
		expect(piInputToClaude("edit", { path: "~" }, cwd).file_path).toBe(homedir());
	});

	it("round-trips a file tool input that was already absolute", () => {
		const input = { path: "/a.ts", offset: 2 };
		expect(claudeInputToPi("read", piInputToClaude("read", input, cwd))).toEqual(input);
	});

	it("leaves tools whose shapes already agree untouched", () => {
		const bash = { command: "ls", timeout: 5 };
		expect(piInputToClaude("bash", bash, cwd)).toEqual(bash);
		const grep = { pattern: "TODO", path: "src" };
		expect(piInputToClaude("grep", grep, cwd)).toEqual(grep);
	});
});
