import { describe, expect, it } from "vitest";
import {
	claudeInputToPi,
	claudeToolToPi,
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
	it("renames path to file_path for the file tools", () => {
		expect(piInputToClaude("read", { path: "/a.ts", limit: 10 })).toEqual({
			file_path: "/a.ts",
			limit: 10,
		});
		expect(claudeInputToPi("read", { file_path: "/a.ts" })).toEqual({ path: "/a.ts" });
	});

	it("round-trips a file tool input", () => {
		const input = { path: "/a.ts", offset: 2 };
		expect(claudeInputToPi("read", piInputToClaude("read", input))).toEqual(input);
	});

	it("leaves tools whose shapes already agree untouched", () => {
		const bash = { command: "ls", timeout: 5 };
		expect(piInputToClaude("bash", bash)).toEqual(bash);
		const grep = { pattern: "TODO", path: "src" };
		expect(piInputToClaude("grep", grep)).toEqual(grep);
	});
});
