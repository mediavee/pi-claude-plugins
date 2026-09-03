import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { discoverAgents } from "./agents.ts";
import { discoverCommands } from "./commands.ts";
import { isPluginEnabled, isPluginTrusted } from "./config.ts";
import { discoverHooks } from "./hooks.ts";
import { ManifestError, pluginNameFor, readManifest } from "./manifest.ts";
import { MarketplaceError, readMarketplace } from "./marketplace.ts";
import { discoverMcpServers } from "./mcp.ts";
import { discoverSkills, findSkillCollisions, type SkillCollision } from "./skills.ts";
import type { Diagnostic, LoadedPlugin, PluginSettings, SubstitutionVars } from "./types.ts";

export interface LoadOptions {
	settings: PluginSettings;
	cwd: string;
	/** Root for `${CLAUDE_PLUGIN_DATA}`; one subdirectory per plugin. */
	dataRoot: string;
	env?: NodeJS.ProcessEnv;
}

export interface LoadResult {
	plugins: LoadedPlugin[];
	diagnostics: Diagnostic[];
	collisions: SkillCollision[];
	/** Marketplace entries on disk that no `enabledPlugins` entry selects. */
	available: string[];
}

export function loadPlugins(options: LoadOptions): LoadResult {
	const diagnostics: Diagnostic[] = [];
	const available: string[] = [];
	const roots = collectRoots(options.settings, diagnostics, available);
	const plugins: LoadedPlugin[] = [];
	const seen = new Set<string>();

	for (const candidate of roots) {
		if (!existsSync(candidate.root)) {
			diagnostics.push({
				level: "error",
				plugin: candidate.name ?? candidate.root,
				message: `plugin directory ${candidate.root} does not exist`,
			});
			continue;
		}
		// One malformed plugin must not take down the plugins queued behind it.
		let loaded: LoadedPlugin | undefined;
		try {
			loaded = loadPlugin(candidate, options, diagnostics);
		} catch (error) {
			diagnostics.push({
				level: "error",
				plugin: candidate.name ?? candidate.root,
				message: `failed to load: ${(error as Error).message}`,
			});
			continue;
		}
		if (!loaded) continue;
		if (seen.has(loaded.name)) {
			diagnostics.push({
				level: "warn",
				plugin: loaded.id,
				message: `another plugin already uses the name "${loaded.name}"; ${loaded.root} was skipped`,
			});
			continue;
		}
		seen.add(loaded.name);
		plugins.push(loaded);
	}

	const collisions = findSkillCollisions(plugins.flatMap((plugin) => plugin.skills));
	return { plugins, diagnostics, collisions, available };
}

interface Candidate {
	root: string;
	name?: string;
	marketplace?: string;
}

function collectRoots(settings: PluginSettings, diagnostics: Diagnostic[], available: string[]): Candidate[] {
	const candidates: Candidate[] = settings.paths.map((root) => ({ root }));

	for (const marketplaceRoot of settings.marketplaces) {
		try {
			const marketplace = readMarketplace(marketplaceRoot);
			for (const entry of marketplace.plugins) {
				const id = `${entry.name}@${marketplace.name}`;
				// Adding a catalog is not installing from it, so an entry has to be selected.
				if (!isPluginEnabled(settings, id) && !isPluginEnabled(settings, entry.name)) {
					available.push(id);
					continue;
				}
				candidates.push({ root: entry.root, name: entry.name, marketplace: marketplace.name });
			}
			for (const entry of marketplace.unresolved) {
				diagnostics.push({
					level: "warn",
					plugin: entry.name,
					message: `not loaded from marketplace ${marketplace.name}: ${entry.reason}`,
				});
			}
		} catch (error) {
			const message = error instanceof MarketplaceError ? error.message : String(error);
			diagnostics.push({ level: "error", plugin: marketplaceRoot, message });
		}
	}
	return candidates;
}

function loadPlugin(
	candidate: Candidate,
	options: LoadOptions,
	diagnostics: Diagnostic[],
): LoadedPlugin | undefined {
	let manifest: ReturnType<typeof readManifest>;
	try {
		manifest = readManifest(candidate.root);
	} catch (error) {
		const message = error instanceof ManifestError ? error.message : String(error);
		diagnostics.push({ level: "error", plugin: candidate.name ?? candidate.root, message });
		return undefined;
	}

	// A marketplace entry's name is what users enable and disable the plugin by.
	const name = candidate.name ?? pluginNameFor(candidate.root, manifest);
	const id = candidate.marketplace ? `${name}@${candidate.marketplace}` : name;
	if (options.settings.disabledPlugins.includes(id)) return undefined;

	const vars: SubstitutionVars = {
		CLAUDE_PLUGIN_ROOT: candidate.root,
		CLAUDE_PLUGIN_DATA: resolve(options.dataRoot, id.replace(/[^\w-]+/g, "-")),
		CLAUDE_PROJECT_DIR: options.cwd,
	};

	const warn = (message: string) => diagnostics.push({ level: "warn", plugin: id, message });
	const refused: string[] = [];
	const escaped: string[] = [];

	const skills = discoverSkills(name, candidate.root, manifest);
	escaped.push(...skills.escaped);
	for (const warning of skills.warnings) warn(warning);

	const commands = discoverCommands(name, candidate.root, manifest);
	escaped.push(...commands.escaped);
	for (const warning of commands.warnings) warn(warning);

	const agents = options.settings.agents
		? discoverAgents(name, candidate.root, manifest, vars)
		: { agents: [], escaped: [], warnings: [] };
	escaped.push(...agents.escaped);
	for (const warning of agents.warnings) warn(warning);

	const trusted = isPluginTrusted(options.settings, id, options.settings.allowHooks);
	const hooks = discoverHooks(name, candidate.root, manifest, vars);
	escaped.push(...hooks.escaped);
	for (const warning of hooks.warnings) warn(warning);
	if (!trusted && hooks.hooks.length > 0) {
		refused.push(`${hooks.hooks.length} hook handler(s): not trusted to run shell commands`);
	}

	const mcp = discoverMcpServers(name, candidate.root, manifest, vars, options.env);
	escaped.push(...mcp.escaped);
	for (const warning of mcp.warnings) warn(warning);

	for (const path of escaped) {
		warn(`component path "${path}" escapes the plugin directory and was dropped`);
	}

	return {
		id,
		name,
		root: candidate.root,
		manifest,
		...(candidate.marketplace ? { marketplace: candidate.marketplace } : {}),
		trusted,
		skills: skills.skills,
		commands: commands.commands,
		agents: agents.agents,
		hooks: trusted ? hooks.hooks : [],
		mcpServers: mcp.servers,
		unsupportedHooks: hooks.unsupported,
		refused,
	};
}
