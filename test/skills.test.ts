import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
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

	const demoSkill = () => {
		const skill = discoverSkills("demo", root, {}).skills[0];
		if (!skill) throw new Error("fixture skill missing");
		return skill;
	};

	it("serves the same path to every process that stages the same content", () => {
		const first = materialiseSkill(demoSkill(), staging, vars);
		const marker = join(first, "reference.md");
		const before = lstatSync(marker).ino;

		const second = materialiseSkill(demoSkill(), staging, vars);

		expect(second).toBe(first);
		expect(lstatSync(marker).ino).toBe(before);
		expect(readdirSync(staging).filter((name) => name.startsWith("."))).toEqual([]);
	});

	it("keeps a mirror another process may still read when the content changes", () => {
		const first = materialiseSkill(demoSkill(), staging, vars);

		const second = materialiseSkill(demoSkill(), staging, { ...vars, CLAUDE_PLUGIN_ROOT: "/elsewhere" });

		expect(second).not.toBe(first);
		expect(readFileSync(join(first, "SKILL.md"), "utf8")).toContain("/plugins/demo/x");
		expect(readFileSync(join(second, "SKILL.md"), "utf8")).toContain("/elsewhere/x");
	});

	it("replaces a mirror whose SKILL.md is not what the plugin expands to", () => {
		const target = materialiseSkill(demoSkill(), staging, vars);
		writeFileSync(join(target, "SKILL.md"), "tampered");

		expect(materialiseSkill(demoSkill(), staging, vars)).toBe(target);
		expect(readFileSync(join(target, "SKILL.md"), "utf8")).toContain("/plugins/demo/x");
	});

	it("never leaves a reader without the mirror while it repairs one", async () => {
		const target = materialiseSkill(demoSkill(), staging, vars);
		const shared = new Int32Array(new SharedArrayBuffer(12));
		const reader = new Worker(
			`const { workerData } = require("node:worker_threads");
			const { readFileSync } = require("node:fs");
			const state = new Int32Array(workerData.buffer);
			Atomics.store(state, 2, 1);
			while (Atomics.load(state, 0) === 0) {
				try { readFileSync(workerData.path); } catch { Atomics.add(state, 1, 1); }
			}`,
			{ eval: true, workerData: { buffer: shared.buffer, path: join(target, "SKILL.md") } },
		);
		while (Atomics.load(shared, 2) === 0) await new Promise((resolve) => setTimeout(resolve, 5));

		for (let round = 0; round < 300; round++) {
			writeFileSync(join(target, "SKILL.md"), "tampered");
			expect(materialiseSkill(demoSkill(), staging, vars)).toBe(target);
		}
		Atomics.store(shared, 0, 1);
		await reader.terminate();

		expect(Atomics.load(shared, 1)).toBe(0);
		expect(readFileSync(join(target, "SKILL.md"), "utf8")).toContain("/plugins/demo/x");
	});

	it.each([
		["missing", (link: string) => rmSync(link)],
		[
			"pointing elsewhere",
			(link: string) => {
				rmSync(link);
				symlinkSync("/elsewhere/run.sh", link);
			},
		],
	])("repairs a side link that is %s before reusing the mirror", (_, damage) => {
		const target = materialiseSkill(demoSkill(), staging, vars);
		const link = join(target, "scripts");
		damage(link);

		expect(materialiseSkill(demoSkill(), staging, vars)).toBe(target);

		expect(readlinkSync(link)).toBe(join(root, "skills/dyn/scripts"));
		expect(readFileSync(join(link, "run.sh"), "utf8")).toContain("#!/bin/sh");
	});

	it("lists the skill from its own directory and says why when the root cannot be written", () => {
		const readOnly = join(staging, "ro");
		mkdirSync(readOnly);
		chmodSync(readOnly, 0o500);
		const failures: unknown[] = [];

		const target = materialiseSkill(demoSkill(), join(readOnly, "stage"), vars, (error) =>
			failures.push(error),
		);

		chmodSync(readOnly, 0o700);
		expect(target).toBe(join(root, "skills/dyn"));
		expect(failures).toHaveLength(1);
	});
});
