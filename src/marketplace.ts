import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isInsidePlugin } from "./manifest.ts";

export const MARKETPLACE_PATH = ".claude-plugin/marketplace.json";

export interface MarketplaceEntry {
	name: string;
	source: unknown;
}

export interface MarketplaceFile {
	name?: string;
	plugins?: MarketplaceEntry[];
	metadata?: { pluginRoot?: string };
}

export interface ResolvedMarketplace {
	name: string;
	root: string;
	/** Entries whose source resolved to a directory inside the marketplace. */
	plugins: Array<{ name: string; root: string }>;
	/** Entries pointing at a remote source, which this loader does not fetch. */
	unresolved: Array<{ name: string; reason: string }>;
}

export class MarketplaceError extends Error {}

function describeSource(source: unknown): string {
	if (typeof source === "string") return `path "${source}"`;
	if (typeof source === "object" && source !== null) {
		const kind = (source as { source?: unknown }).source;
		if (typeof kind === "string") return `"${kind}" source`;
	}
	return "unrecognised source";
}

/**
 * Reads a marketplace checkout and resolves the entries whose plugins are on disk.
 *
 * Remote sources are reported rather than fetched: cloning and caching them duplicates what
 * `pi install git:…` already does, and shelling out to git on startup is a supply-chain
 * surface this loader declines to add.
 */
export function readMarketplace(root: string): ResolvedMarketplace {
	const file = resolve(root, MARKETPLACE_PATH);
	if (!existsSync(file)) {
		throw new MarketplaceError(`no ${MARKETPLACE_PATH} in ${root}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new MarketplaceError(`${MARKETPLACE_PATH} is not valid JSON: ${(error as Error).message}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new MarketplaceError(`${MARKETPLACE_PATH} must contain a JSON object`);
	}

	const manifest = parsed as MarketplaceFile;
	const entries = Array.isArray(manifest.plugins) ? manifest.plugins : [];
	const pluginRoot = manifest.metadata?.pluginRoot;

	const plugins: ResolvedMarketplace["plugins"] = [];
	const unresolved: ResolvedMarketplace["unresolved"] = [];

	for (const entry of entries) {
		if (!entry || typeof entry.name !== "string" || entry.name.length === 0) continue;
		const relativePath = localSourcePath(entry.source, pluginRoot);
		if (relativePath === undefined) {
			unresolved.push({ name: entry.name, reason: `${describeSource(entry.source)} is not a local path` });
			continue;
		}
		if (!isInsidePlugin(root, relativePath)) {
			unresolved.push({ name: entry.name, reason: "source escapes the marketplace directory" });
			continue;
		}
		const pluginDir = resolve(root, relativePath);
		if (!existsSync(pluginDir)) {
			unresolved.push({ name: entry.name, reason: `source directory ${relativePath} does not exist` });
			continue;
		}
		plugins.push({ name: entry.name, root: pluginDir });
	}

	return { name: manifest.name ?? root, root, plugins, unresolved };
}

/** A relative `./path`, or a bare name when `metadata.pluginRoot` gives it a home. */
function localSourcePath(source: unknown, pluginRoot: string | undefined): string | undefined {
	if (typeof source !== "string") return undefined;
	if (source.startsWith("./")) return source;
	if (!source.includes("/") && pluginRoot !== undefined) return `${pluginRoot.replace(/\/$/, "")}/${source}`;
	return undefined;
}
