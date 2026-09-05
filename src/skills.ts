import {
	type Dirent,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { isDirectory, isInside, resolveComponentPaths } from "./manifest.ts";
import { substituteClaudeVars } from "./substitute.ts";
import type { PluginManifest, SkillSource, SubstitutionVars } from "./types.ts";

const SKILL_FILE = "SKILL.md";
const MAX_DEPTH = 8;
const CLAUDE_PLACEHOLDER = /\$\{CLAUDE_[A-Z0-9_]*\}/;

export interface SkillDiscovery {
	skills: SkillSource[];
	/** Component paths dropped because they resolved outside the plugin root. */
	escaped: string[];
	warnings: string[];
}

/**
 * Plugin skill directories are handed to pi untouched, so relative links, bundled scripts and
 * assets keep working. Names are read only to report collisions: pi keeps the first skill of a
 * given name and warns, without saying which plugins clashed.
 */
export function discoverSkills(plugin: string, root: string, manifest: PluginManifest): SkillDiscovery {
	const resolved = resolveComponentPaths(root, manifest.skills, "skills", "add");
	const warnings = [...resolved.invalid];
	const paths = [...resolved.paths];
	const escaped = [...resolved.escaped];

	// Claude Code loads a plugin-root SKILL.md only for a plugin that ships exactly one skill,
	// so it must not shadow or duplicate a skills/ tree.
	if (paths.length === 0 && manifest.skills === undefined) {
		const rootSkill = resolve(root, SKILL_FILE);
		if (existsSync(rootSkill)) {
			if (isInside(root, SKILL_FILE)) paths.push(rootSkill);
			else escaped.push(SKILL_FILE);
		}
	}

	const skills: SkillSource[] = [];
	for (const path of paths) {
		if (!isDirectory(path)) {
			if (basename(path) === SKILL_FILE) skills.push(toSkill(plugin, path));
			continue;
		}
		for (const file of findSkillFiles(path, 0)) skills.push(toSkill(plugin, file));
	}
	return { skills, escaped, warnings };
}

function toSkill(plugin: string, skillFile: string): SkillSource {
	const dir = dirname(skillFile);
	let body = "";
	try {
		body = readFileSync(skillFile, "utf8");
	} catch {
		// A skill we cannot read still reaches pi, which reports its own diagnostic.
	}
	return {
		plugin,
		path: dir,
		name: readSkillName(body) ?? basename(dir),
		needsSubstitution: CLAUDE_PLACEHOLDER.test(body),
	};
}

function readSkillName(body: string): string | undefined {
	try {
		const { frontmatter } = parseFrontmatter<{ name?: unknown }>(body);
		return typeof frontmatter.name === "string" && frontmatter.name.length > 0 ? frontmatter.name : undefined;
	} catch {
		return undefined;
	}
}

function findSkillFiles(dir: string, depth: number): string[] {
	if (depth > MAX_DEPTH) return [];
	const found: string[] = [];
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return found;
	}
	if (entries.some((entry) => entry.isFile() && entry.name === SKILL_FILE)) {
		found.push(join(dir, SKILL_FILE));
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		found.push(...findSkillFiles(join(dir, entry.name), depth + 1));
	}
	return found;
}

/**
 * Rewrites a skill whose body uses `${CLAUDE_*}` placeholders, which pi does not understand.
 *
 * The mirror symlinks every sibling file and directory so relative links and bundled scripts
 * still resolve; only `SKILL.md` is materialised, with the placeholders expanded.
 */
export function materialiseSkill(skill: SkillSource, stagingRoot: string, vars: SubstitutionVars): string {
	const target = join(stagingRoot, skill.plugin.replace(/[^\w-]+/g, "-"), skill.name);
	try {
		rmSync(target, { recursive: true, force: true });
		mkdirSync(target, { recursive: true });

		for (const entry of readdirSync(skill.path, { withFileTypes: true })) {
			if (entry.name === SKILL_FILE) continue;
			try {
				symlinkSync(join(skill.path, entry.name), join(target, entry.name));
			} catch {
				// A sibling we cannot link is simply absent from the mirror.
			}
		}

		const body = readFileSync(join(skill.path, SKILL_FILE), "utf8");
		writeFileSync(join(target, SKILL_FILE), substituteClaudeVars(body, vars), "utf8");
		return target;
	} catch {
		return skill.path;
	}
}

/**
 * Removes staging directories left behind by pi processes that are no longer running. Each
 * session stages under its own pid so concurrent sessions never wipe each other's mirrors.
 */
export function sweepStaleStaging(stagingParent: string): void {
	let entries: Dirent[];
	try {
		entries = readdirSync(stagingParent, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
		const pid = Number(entry.name);
		if (pid === process.pid || isRunning(pid)) continue;
		rmSync(join(stagingParent, entry.name), { recursive: true, force: true });
	}
}

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export interface SkillCollision {
	name: string;
	plugins: string[];
}

export function findSkillCollisions(skills: readonly SkillSource[]): SkillCollision[] {
	const byName = new Map<string, string[]>();
	for (const skill of skills) {
		const owners = byName.get(skill.name) ?? [];
		if (!owners.includes(skill.plugin)) owners.push(skill.plugin);
		byName.set(skill.name, owners);
	}
	return [...byName.entries()]
		.filter(([, plugins]) => plugins.length > 1)
		.map(([name, plugins]) => ({ name, plugins }));
}
