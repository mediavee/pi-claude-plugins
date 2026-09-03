import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverSkills, materialiseSkill } from "../src/skills.ts";
import type { SubstitutionVars } from "../src/types.ts";

const vars: SubstitutionVars = {
	CLAUDE_PLUGIN_ROOT: "/plugins/demo",
	CLAUDE_PLUGIN_DATA: "/data/demo",
	CLAUDE_PROJECT_DIR: "/work",
};

describe("discoverSkills", () => {
	let root: string;
	let staging: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pcp-skills-"));
		staging = mkdtempSync(join(tmpdir(), "pcp-staging-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(staging, { recursive: true, force: true });
	});

	const writeSkill = (dir: string, body: string) => {
		mkdirSync(join(root, dir), { recursive: true });
		writeFileSync(join(root, dir, "SKILL.md"), body);
	};

	it("loads a plugin-root SKILL.md for a single-skill plugin", () => {
		writeFileSync(join(root, "SKILL.md"), "---\nname: solo\ndescription: d\n---\nbody");
		const result = discoverSkills("demo", root, {});
		expect(result.skills.map((skill) => skill.name)).toEqual(["solo"]);
	});

	it("ignores a plugin-root SKILL.md once a skills/ directory exists", () => {
		writeFileSync(join(root, "SKILL.md"), "---\nname: solo\ndescription: d\n---\nbody");
		writeSkill("skills/one", "---\nname: one\ndescription: d\n---\nbody");
		const result = discoverSkills("demo", root, {});
		expect(result.skills.map((skill) => skill.name)).toEqual(["one"]);
	});

	it("ignores a plugin-root SKILL.md once the manifest declares skills", () => {
		writeFileSync(join(root, "SKILL.md"), "---\nname: solo\ndescription: d\n---\nbody");
		writeSkill("custom/one", "---\nname: one\ndescription: d\n---\nbody");
		const result = discoverSkills("demo", root, { skills: ["./custom"] });
		expect(result.skills.map((skill) => skill.name)).toEqual(["one"]);
	});

	it("refuses a plugin-root SKILL.md that is a symlink out of the plugin", () => {
		const outside = mkdtempSync(join(tmpdir(), "pcp-outside-"));
		try {
			writeFileSync(join(outside, "SKILL.md"), "---\nname: evil\ndescription: d\n---\nbody");
			symlinkSync(join(outside, "SKILL.md"), join(root, "SKILL.md"));
			const result = discoverSkills("demo", root, {});
			expect(result.skills).toEqual([]);
			expect(result.escaped).toEqual(["SKILL.md"]);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("flags a skill whose body uses placeholders pi cannot expand", () => {
		writeSkill("skills/plain", "---\nname: plain\ndescription: d\n---\nno placeholders");
		writeSkill("skills/dyn", "---\nname: dyn\ndescription: d\n---\nRun ${CLAUDE_PLUGIN_ROOT}/bin/x");
		const byName = new Map(
			discoverSkills("demo", root, {}).skills.map((skill) => [skill.name, skill.needsSubstitution]),
		);
		expect(byName.get("plain")).toBe(false);
		expect(byName.get("dyn")).toBe(true);
	});
});

describe("materialiseSkill", () => {
	let root: string;
	let staging: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pcp-skills-"));
		staging = mkdtempSync(join(tmpdir(), "pcp-staging-"));
		mkdirSync(join(root, "skills/dyn/scripts"), { recursive: true });
		writeFileSync(
			join(root, "skills/dyn/SKILL.md"),
			"---\nname: dyn\ndescription: d\n---\nRun ${CLAUDE_PLUGIN_ROOT}/x and see [ref](reference.md)",
		);
		writeFileSync(join(root, "skills/dyn/reference.md"), "sibling content");
		writeFileSync(join(root, "skills/dyn/scripts/run.sh"), "#!/bin/sh\n");
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(staging, { recursive: true, force: true });
	});

	it("expands the placeholders and keeps siblings reachable", () => {
		const skill = discoverSkills("demo", root, {}).skills[0];
		expect(skill).toBeDefined();
		if (!skill) return;

		const target = materialiseSkill(skill, staging, vars);
		expect(target).not.toBe(skill.path);

		const body = readFileSync(join(target, "SKILL.md"), "utf8");
		expect(body).toContain("/plugins/demo/x");
		expect(body).not.toContain("${CLAUDE_PLUGIN_ROOT}");

		expect(readFileSync(join(target, "reference.md"), "utf8")).toBe("sibling content");
		expect(readFileSync(join(target, "scripts/run.sh"), "utf8")).toContain("#!/bin/sh");
	});

	it("falls back to the original directory when it cannot mirror", () => {
		const skill = { plugin: "demo", path: "/nope/skill", name: "dyn", needsSubstitution: true };
		expect(materialiseSkill(skill, staging, vars)).toBe("/nope/skill");
	});
});
