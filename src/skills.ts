import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { isDirectory, resolveComponentPaths } from "./manifest.ts";
import type { PluginManifest, SkillSource } from "./types.ts";

const SKILL_FILE = "SKILL.md";
const MAX_DEPTH = 8;

export interface SkillDiscovery {
	skills: SkillSource[];
	/** Component paths dropped because they resolved outside the plugin root. */
	escaped: string[];
}

/**
 * Plugin skill directories are handed to pi untouched, so relative links, bundled scripts and
 * assets inside each skill keep resolving. Names are read only to report collisions: pi keeps
 * the first skill of a given name and warns, without saying which plugins clashed.
 */
export function discoverSkills(plugin: string, root: string, manifest: PluginManifest): SkillDiscovery {
	const { paths, escaped } = resolveComponentPaths(root, manifest.skills, "skills", "add");

	const rootSkill = resolve(root, SKILL_FILE);
	if (existsSync(rootSkill) && !paths.includes(rootSkill)) paths.unshift(rootSkill);

	const skills: SkillSource[] = [];
	for (const path of paths) {
		if (!isDirectory(path)) {
			if (basename(path) === SKILL_FILE) skills.push(toSkill(plugin, path));
			continue;
		}
		for (const file of findSkillFiles(path, 0)) skills.push(toSkill(plugin, file));
	}
	return { skills, escaped };
}

function toSkill(plugin: string, skillFile: string): SkillSource {
	const dir = dirname(skillFile);
	return { plugin, path: dir, name: readSkillName(skillFile) ?? basename(dir) };
}

function readSkillName(skillFile: string): string | undefined {
	try {
		const { frontmatter } = parseFrontmatter<{ name?: unknown }>(readFileSync(skillFile, "utf8"));
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
