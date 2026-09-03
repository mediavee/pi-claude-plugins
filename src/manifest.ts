import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { PluginManifest } from "./types.ts";

export const MANIFEST_PATH = ".claude-plugin/plugin.json";

export class ManifestError extends Error {}

const PATH_FIELDS = ["skills", "commands", "agents"] as const;
const PATH_OR_INLINE_FIELDS = ["hooks", "mcpServers"] as const;

export function readManifest(root: string): PluginManifest {
	const path = resolve(root, MANIFEST_PATH);
	if (!existsSync(path)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new ManifestError(`${MANIFEST_PATH} is not valid JSON: ${(error as Error).message}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new ManifestError(`${MANIFEST_PATH} must contain a JSON object`);
	}

	const manifest = parsed as Record<string, unknown>;
	if (manifest.name !== undefined && typeof manifest.name !== "string") {
		throw new ManifestError(`${MANIFEST_PATH} "name" must be a string`);
	}
	if (manifest.keywords !== undefined && !Array.isArray(manifest.keywords)) {
		throw new ManifestError(`${MANIFEST_PATH} "keywords" must be an array`);
	}
	// Without this, a number or object here reaches path APIs later and throws mid-discovery,
	// taking every plugin queued behind it down with it.
	for (const field of PATH_FIELDS) {
		if (!isPathList(manifest[field])) {
			throw new ManifestError(`${MANIFEST_PATH} "${field}" must be a string or an array of strings`);
		}
	}
	for (const field of PATH_OR_INLINE_FIELDS) {
		const value = manifest[field];
		if (!isPathList(value) && !isPlainObject(value)) {
			throw new ManifestError(
				`${MANIFEST_PATH} "${field}" must be a string, an array of strings, or an object`,
			);
		}
	}
	return manifest as PluginManifest;
}

function isPathList(value: unknown): boolean {
	if (value === undefined || typeof value === "string") return true;
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPlainObject(value: unknown): boolean {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function pluginNameFor(root: string, manifest: PluginManifest): string {
	return manifest.name?.trim() || basename(resolve(root));
}

/** True when `candidate` resolves to `root` itself or somewhere beneath it, symlinks followed. */
export function isInside(root: string, candidate: string): boolean {
	const realRoot = canonical(resolve(root));
	const realCandidate = canonical(resolve(realRoot, candidate));
	if (realRoot === realCandidate) return true;
	const rel = relative(realRoot, realCandidate);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Realpath of the deepest existing ancestor, with the remaining segments appended.
 *
 * A path that does not exist yet still has to be comparable against a canonicalised root, or a
 * containment check would fail wherever the root itself is behind a symlink such as macOS /var.
 */
function canonical(path: string): string {
	let head = path;
	const tail: string[] = [];
	for (;;) {
		try {
			return join(realpathSync(head), ...tail);
		} catch {
			const parent = dirname(head);
			if (parent === head) return path;
			tail.unshift(basename(head));
			head = parent;
		}
	}
}

function asList(value: string | string[] | undefined): string[] {
	if (value === undefined) return [];
	return Array.isArray(value) ? value : [value];
}

export interface ResolvedPaths {
	paths: string[];
	escaped: string[];
	invalid: string[];
}

/**
 * Resolves a manifest component key against the plugin root.
 *
 * `skills` adds to its default directory while every other key replaces it, which is the one
 * asymmetry in the plugin manifest spec.
 */
export function resolveComponentPaths(
	root: string,
	declared: string | string[] | undefined,
	defaultDir: string,
	mode: "replace" | "add",
): ResolvedPaths {
	const entries = asList(declared);
	const candidates = entries.length > 0 && mode === "replace" ? entries : [defaultDir, ...entries];

	const paths: string[] = [];
	const escaped: string[] = [];
	const invalid: string[] = [];
	for (const entry of candidates) {
		if (typeof entry !== "string") {
			invalid.push(`ignored a non-string entry in "${defaultDir}"`);
			continue;
		}
		const normalized = entry === "." ? "./" : entry;
		if (!isInside(root, normalized)) {
			escaped.push(entry);
			continue;
		}
		const absolute = resolve(root, normalized);
		if (!existsSync(absolute)) continue;
		if (!paths.includes(absolute)) paths.push(absolute);
	}
	return { paths, escaped, invalid };
}

export function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}
