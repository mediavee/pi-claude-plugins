import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { discoverAgents } from "./agents.ts";
import { discoverCommands } from "./commands.ts";
import { isPluginTrusted } from "./config.ts";
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
}

export function loadPlugins(options: LoadOptions): LoadResult {
	const diagnostics: Diagnostic[] = [];
	const roots = collectRoots(options.settings, diagnostics);
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
		const loaded = loadPlugin(candidate, options, diagnostics);
		if (!loaded) continue;
		if (seen.has(loaded.name)) {
			diagnostics.push({
				level: "warn",
				plugin: loaded.name,
				message: `already loaded from another source; ${loaded.root} was skipped`,
			});
			continue;
		}
		seen.add(loaded.name);
		plugins.push(loaded);
	}

	const collisions = findSkillCollisions(plugins.flatMap((plugin) => plugin.skills));
	return { plugins, diagnostics, collisions };
}

interface Candidate {
	root: string;
	name?: string;
	marketplace?: string;
}

function collectRoots(settings: PluginSettings, diagnostics: Diagnostic[]): Candidate[] {
	const candidates: Candidate[] = settings.paths.map((root) => ({ root }));

	for (const marketplaceRoot of settings.marketplaces) {
		try {
			const marketplace = readMarketplace(marketplaceRoot);
			for (const entry of marketplace.plugins) {
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
	if (options.settings.disabledPlugins.includes(name)) return undefined;

	const vars: SubstitutionVars = {
		CLAUDE_PLUGIN_ROOT: candidate.root,
		CLAUDE_PLUGIN_DATA: resolve(options.dataRoot, name.replace(/[^\w-]+/g, "-")),
		CLAUDE_PROJECT_DIR: options.cwd,
	};

	const refused: string[] = [];
	const escaped: string[] = [];

	const skills = discoverSkills(name, candidate.root, manifest);
	escaped.push(...skills.escaped);

	const commands = discoverCommands(name, candidate.root, manifest);
	escaped.push(...commands.escaped);

	const agentsAllowed = options.settings.agents;
	const agents = agentsAllowed
		? discoverAgents(name, candidate.root, manifest, vars)
		: { agents: [], escaped: [], warnings: [] };
	escaped.push(...agents.escaped);
	for (const warning of agents.warnings) {
		diagnostics.push({ level: "warn", plugin: name, message: warning });
	}

	const hooksAllowed = isPluginTrusted(options.settings, name, options.settings.allowHooks);
	const hooks = discoverHooks(name, candidate.root, manifest, vars);
	escaped.push(...hooks.escaped);
	if (!hooksAllowed && hooks.hooks.length > 0) {
		refused.push(`${hooks.hooks.length} hook handler(s): not trusted to run shell commands`);
	}

	const mcp = discoverMcpServers(name, candidate.root, manifest, vars, options.env);
	escaped.push(...mcp.escaped);
	for (const warning of mcp.warnings) {
		diagnostics.push({ level: "warn", plugin: name, message: warning });
	}

	for (const path of escaped) {
		diagnostics.push({
			level: "warn",
			plugin: name,
			message: `component path "${path}" escapes the plugin directory and was dropped`,
		});
	}

	return {
		name,
		root: candidate.root,
		manifest,
		...(candidate.marketplace ? { marketplace: candidate.marketplace } : {}),
		skills: skills.skills,
		commands: commands.commands,
		agents: agents.agents,
		hooks: hooksAllowed ? hooks.hooks : [],
		mcpServers: mcp.servers,
		unsupportedHooks: hooks.unsupported,
		refused,
	};
}
