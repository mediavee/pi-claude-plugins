import { createHash } from "node:crypto";
import {
	type Dirent,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
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
 *
 * The mirror is content-addressed: its path is a function of the skill's directory, its sibling
 * names and the expanded body, never of the process. Pi lists a skill's location in the system
 * prompt, so a path that changed per process would stop every process from sharing the prompt
 * cache and re-send the whole skills section at each respawn. A mirror is built beside the
 * others and renamed into place, so a reader never sees it half written, and an existing one is
 * reused and never removed: another process may be reading it.
 *
 * It falls back to the skill's own directory, and reports why through `onFailure`, when no
 * mirror can be written (a read-only root): the skill is still listed, only its placeholders
 * stay unexpanded.
 */
export function materialiseSkill(
	skill: SkillSource,
	stagingRoot: string,
	vars: SubstitutionVars,
	onFailure?: (error: unknown) => void,
): string {
	try {
		const body = substituteClaudeVars(readFileSync(join(skill.path, SKILL_FILE), "utf8"), vars);
		const siblings = readdirSync(skill.path)
			.filter((name) => name !== SKILL_FILE)
			.sort();
		const key = createHash("sha256")
			.update(JSON.stringify([skill.path, siblings, body]))
			.digest("hex")
			.slice(0, 16);
		const slot = join(stagingRoot, key);
		const dirName = skill.name.replace(/[^\w-]+/g, "-");
		const target = join(slot, dirName);
		if (isMirrorOf(target, body)) return target;

		mkdirSync(stagingRoot, { recursive: true });
		const scratch = mkdtempSync(join(stagingRoot, ".tmp-"));
		try {
			const built = join(scratch, dirName);
			mkdirSync(built);
			for (const name of siblings) {
				try {
					symlinkSync(join(skill.path, name), join(built, name));
				} catch {
					// A sibling we cannot link is simply absent from the mirror.
				}
			}
			writeFileSync(join(built, SKILL_FILE), body, "utf8");
			try {
				renameSync(scratch, slot);
			} catch {
				// Another process renamed the same content first, or something else sits at
				// the slot; only a copy that is not what we would have written is replaced.
				if (isMirrorOf(target, body)) return target;
				rmSync(slot, { recursive: true, force: true });
				renameSync(scratch, slot);
			}
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
		return target;
	} catch (error) {
		onFailure?.(error);
		return skill.path;
	}
}

function isMirrorOf(target: string, body: string): boolean {
	try {
		return readFileSync(join(target, SKILL_FILE), "utf8") === body;
	} catch {
		return false;
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
