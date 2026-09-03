import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, resolve } from "node:path";
import type { PluginSettings } from "./types.ts";

export const SETTINGS_KEY = "claudePlugins";

const DEFAULTS: PluginSettings = {
	paths: [],
	marketplaces: [],
	allowShellCommands: false,
	allowHooks: false,
	trustedPlugins: [],
	disabledPlugins: [],
	agents: true,
};

export interface ResolveSettingsOptions {
	cwd: string;
	agentDir: string;
	projectTrusted: boolean;
	env?: NodeJS.ProcessEnv;
}

export function expandHome(path: string, home = homedir()): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return resolve(home, path.slice(2));
	return path;
}

function resolveAgainst(baseDir: string, path: string): string {
	const expanded = expandHome(path);
	return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

function readJson(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// A settings file pi itself failed to parse is not ours to report.
	}
	return undefined;
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter((item): item is string => typeof item === "string");
}

function boolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function envFlag(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
	if (normalized === "0" || normalized === "false" || normalized === "no") return false;
	return undefined;
}

function envPaths(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(delimiter)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
		.map((entry) => expandHome(entry));
}

function applyScope(target: PluginSettings, raw: Record<string, unknown> | undefined, baseDir: string): void {
	const section = raw?.[SETTINGS_KEY];
	if (typeof section !== "object" || section === null || Array.isArray(section)) return;
	const config = section as Record<string, unknown>;

	for (const path of stringArray(config.paths) ?? []) {
		const resolved = resolveAgainst(baseDir, path);
		if (!target.paths.includes(resolved)) target.paths.push(resolved);
	}
	for (const path of stringArray(config.marketplaces) ?? []) {
		const resolved = resolveAgainst(baseDir, path);
		if (!target.marketplaces.includes(resolved)) target.marketplaces.push(resolved);
	}
	target.allowShellCommands = boolean(config.allowShellCommands) ?? target.allowShellCommands;
	target.allowHooks = boolean(config.allowHooks) ?? target.allowHooks;
	target.agents = boolean(config.agents) ?? target.agents;
	for (const name of stringArray(config.trustedPlugins) ?? []) {
		if (!target.trustedPlugins.includes(name)) target.trustedPlugins.push(name);
	}
	for (const name of stringArray(config.disabledPlugins) ?? []) {
		if (!target.disabledPlugins.includes(name)) target.disabledPlugins.push(name);
	}
}

/**
 * pi 0.84.4 gives extensions no settings accessor and types `Settings` without an index
 * signature, so the two settings files are read directly. Project settings are only consulted
 * once pi has decided the project is trusted.
 */
export function resolveSettings(options: ResolveSettingsOptions): PluginSettings {
	const env = options.env ?? process.env;
	const settings: PluginSettings = {
		...DEFAULTS,
		paths: [],
		marketplaces: [],
		trustedPlugins: [],
		disabledPlugins: [],
	};

	applyScope(settings, readJson(resolve(options.agentDir, "settings.json")), options.agentDir);
	if (options.projectTrusted) {
		const projectDir = resolve(options.cwd, ".pi");
		applyScope(settings, readJson(resolve(projectDir, "settings.json")), projectDir);
	}

	for (const path of envPaths(env.PI_CLAUDE_PLUGINS)) {
		const resolved = resolve(options.cwd, path);
		if (!settings.paths.includes(resolved)) settings.paths.push(resolved);
	}
	for (const path of envPaths(env.PI_CLAUDE_PLUGINS_MARKETPLACES)) {
		const resolved = resolve(options.cwd, path);
		if (!settings.marketplaces.includes(resolved)) settings.marketplaces.push(resolved);
	}
	settings.allowHooks = envFlag(env.PI_CLAUDE_PLUGINS_ALLOW_HOOKS) ?? settings.allowHooks;
	settings.allowShellCommands = envFlag(env.PI_CLAUDE_PLUGINS_ALLOW_SHELL) ?? settings.allowShellCommands;

	return settings;
}

export function isPluginTrusted(settings: PluginSettings, plugin: string, global: boolean): boolean {
	return global || settings.trustedPlugins.includes(plugin);
}
