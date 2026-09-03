import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { PluginManifest } from "./types.ts";

export const MANIFEST_PATH = ".claude-plugin/plugin.json";

export class ManifestError extends Error {}

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
	const manifest = parsed as PluginManifest;
	if (manifest.name !== undefined && typeof manifest.name !== "string") {
		throw new ManifestError(`${MANIFEST_PATH} "name" must be a string`);
	}
	if (manifest.keywords !== undefined && !Array.isArray(manifest.keywords)) {
		throw new ManifestError(`${MANIFEST_PATH} "keywords" must be an array`);
	}
	return manifest;
}

export function pluginNameFor(root: string, manifest: PluginManifest): string {
	return manifest.name?.trim() || basename(resolve(root));
}

/**
 * Claude Code rejects any component path that leaves the plugin directory, symlinks included.
 * The plugin still loads; only the offending component is dropped.
 */
export function isInsidePlugin(root: string, candidate: string): boolean {
	const realRoot = safeRealpath(resolve(root));
	const realCandidate = safeRealpath(resolve(root, candidate));
	if (realRoot === realCandidate) return true;
	const rel = relative(realRoot, realCandidate);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function safeRealpath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function asList(value: string | string[] | undefined): string[] {
	if (value === undefined) return [];
	return Array.isArray(value) ? value : [value];
}

export interface ResolvedPaths {
	paths: string[];
	escaped: string[];
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
	for (const entry of candidates) {
		const normalized = entry === "." ? "./" : entry;
		if (!isInsidePlugin(root, normalized)) {
			escaped.push(entry);
			continue;
		}
		const absolute = resolve(root, normalized);
		if (!existsSync(absolute)) continue;
		if (!paths.includes(absolute)) paths.push(absolute);
	}
	return { paths, escaped };
}

export function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

export function joinInside(root: string, ...segments: string[]): string {
	return resolve(root, segments.join(sep));
}
