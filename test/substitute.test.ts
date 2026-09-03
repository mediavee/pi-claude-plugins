import { describe, expect, it } from "vitest";
import { substitute, substituteDeep } from "../src/substitute.ts";
import type { SubstitutionVars } from "../src/types.ts";

const vars: SubstitutionVars = {
	CLAUDE_PLUGIN_ROOT: "/plugins/demo",
	CLAUDE_PLUGIN_DATA: "/data/demo",
	CLAUDE_PROJECT_DIR: "/work",
};

describe("substitute", () => {
	it("expands the plugin placeholders", () => {
		expect(substitute("${CLAUDE_PLUGIN_ROOT}/bin/run", vars)).toBe("/plugins/demo/bin/run");
		expect(substitute("${CLAUDE_PROJECT_DIR}", vars)).toBe("/work");
	});

	it("falls back to the environment, then to the default", () => {
		expect(substitute("${TOKEN}", vars, { env: { TOKEN: "abc" } })).toBe("abc");
		expect(substitute("${TOKEN:-none}", vars, { env: {} })).toBe("none");
	});

	it("keeps an unresolved reference verbatim and reports it", () => {
		const unresolved: string[] = [];
		expect(substitute("Bearer ${API_KEY}", vars, { env: {}, unresolved })).toBe("Bearer ${API_KEY}");
		expect(unresolved).toEqual(["API_KEY"]);
	});

	it("ignores lowercase and positional placeholders", () => {
		expect(substitute("${1:-two} ${lower}", vars, { env: {} })).toBe("${1:-two} ${lower}");
	});

	it("walks nested structures", () => {
		const input = { args: ["${CLAUDE_PLUGIN_ROOT}", 3], env: { DATA: "${CLAUDE_PLUGIN_DATA}" } };
		expect(substituteDeep(input, vars)).toEqual({
			args: ["/plugins/demo", 3],
			env: { DATA: "/data/demo" },
		});
	});
});
