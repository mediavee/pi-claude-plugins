import { describe, expect, it } from "vitest";
import {
	substituteClaudeVars,
	substituteClaudeVarsDeep,
	substituteEnv,
	substituteEnvDeep,
} from "../src/substitute.ts";
import type { SubstitutionVars } from "../src/types.ts";

const vars: SubstitutionVars = {
	CLAUDE_PLUGIN_ROOT: "/plugins/demo",
	CLAUDE_PLUGIN_DATA: "/data/demo",
	CLAUDE_PROJECT_DIR: "/work",
};

describe("substituteClaudeVars", () => {
	it("expands the plugin placeholders", () => {
		expect(substituteClaudeVars("${CLAUDE_PLUGIN_ROOT}/bin/run", vars)).toBe("/plugins/demo/bin/run");
		expect(substituteClaudeVars("${CLAUDE_PROJECT_DIR}", vars)).toBe("/work");
	});

	it("never reaches the environment, so plugin prose cannot exfiltrate secrets", () => {
		process.env.PCP_FAKE_SECRET = "s3cret";
		try {
			expect(substituteClaudeVars("${PCP_FAKE_SECRET}", vars)).toBe("${PCP_FAKE_SECRET}");
			expect(substituteClaudeVars("${AWS_SECRET_ACCESS_KEY}", vars)).toBe("${AWS_SECRET_ACCESS_KEY}");
			expect(substituteClaudeVars("${PCP_FAKE_SECRET:-x}", vars)).toBe("${PCP_FAKE_SECRET:-x}");
		} finally {
			delete process.env.PCP_FAKE_SECRET;
		}
	});

	it("leaves an unknown CLAUDE_ placeholder verbatim", () => {
		expect(substituteClaudeVars("${CLAUDE_SESSION_ID}", vars)).toBe("${CLAUDE_SESSION_ID}");
	});

	it("walks nested structures", () => {
		const input = { args: ["${CLAUDE_PLUGIN_ROOT}", 3], env: { DATA: "${CLAUDE_PLUGIN_DATA}" } };
		expect(substituteClaudeVarsDeep(input, vars)).toEqual({
			args: ["/plugins/demo", 3],
			env: { DATA: "/data/demo" },
		});
	});
});

describe("substituteEnv", () => {
	it("expands MCP variables with defaults", () => {
		expect(substituteEnv("${TOKEN}", vars, { env: { TOKEN: "abc" } })).toBe("abc");
		expect(substituteEnv("${TOKEN:-none}", vars, { env: {} })).toBe("none");
		expect(substituteEnv("${CLAUDE_PLUGIN_ROOT}/s", vars, { env: {} })).toBe("/plugins/demo/s");
	});

	it("keeps an unresolved reference verbatim and reports it", () => {
		const unresolved: string[] = [];
		expect(substituteEnv("Bearer ${API_KEY}", vars, { env: {}, unresolved })).toBe("Bearer ${API_KEY}");
		expect(unresolved).toEqual(["API_KEY"]);
	});

	it("ignores lowercase and positional placeholders", () => {
		expect(substituteEnv("${1:-two} ${lower}", vars, { env: {} })).toBe("${1:-two} ${lower}");
	});

	it("walks nested structures", () => {
		const input = { env: { DATA: "${CLAUDE_PLUGIN_DATA}", TOKEN: "${T:-anon}" } };
		expect(substituteEnvDeep(input, vars, { env: {} })).toEqual({
			env: { DATA: "/data/demo", TOKEN: "anon" },
		});
	});
});
