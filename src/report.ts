import type { SkillCollision } from "./skills.ts";
import type { Diagnostic, LoadedPlugin } from "./types.ts";

export interface ReportInput {
	plugins: readonly LoadedPlugin[];
	diagnostics: readonly Diagnostic[];
	collisions: readonly SkillCollision[];
	/** Servers skipped because pi-mcp-adapter is not loaded. */
	mcpUnavailable: readonly string[];
	/** Marketplace entries present on disk that no `enabledPlugins` entry selects. */
	available: readonly string[];
}

function counts(plugin: LoadedPlugin): string {
	const parts = [
		[plugin.skills.length, "skill"],
		[plugin.commands.length, "command"],
		[plugin.agents.length, "agent"],
		[plugin.hooks.length, "hook"],
		[plugin.mcpServers.length, "mcp server"],
	] as const;
	const listed = parts
		.filter(([count]) => count > 0)
		.map(([count, label]) => `${count} ${label}${count === 1 ? "" : "s"}`);
	return listed.length > 0 ? listed.join(", ") : "no supported components";
}

export function formatReport(input: ReportInput): string {
	const lines: string[] = [];

	if (input.plugins.length === 0) {
		lines.push("claude-plugins: no plugins loaded");
	} else {
		lines.push(`claude-plugins: loaded ${input.plugins.length} plugin(s)`);
		for (const plugin of input.plugins) {
			const origin = plugin.marketplace ? ` (from ${plugin.marketplace})` : "";
			lines.push(`  ${plugin.id}${origin}: ${counts(plugin)}`);
			for (const refused of plugin.refused) lines.push(`    refused: ${refused}`);
			for (const unsupported of plugin.unsupportedHooks) {
				lines.push(`    unsupported hook ${unsupported}`);
			}
		}
	}

	for (const plugin of input.plugins) {
		if (plugin.trusted) continue;
		if (plugin.commands.some((command) => /!`|```!/.test(command.body))) {
			lines.push(`  ${plugin.id}: shell expansion in commands is disabled`);
		}
	}

	if (input.available.length > 0) {
		lines.push(
			`  available but not enabled (add to claudePlugins.enabledPlugins): ${input.available.join(", ")}`,
		);
	}

	for (const collision of input.collisions) {
		lines.push(`  skill name "${collision.name}" is defined by ${collision.plugins.join(", ")}`);
	}
	if (input.mcpUnavailable.length > 0) {
		lines.push(`  MCP servers need pi-mcp-adapter and were skipped: ${input.mcpUnavailable.join(", ")}`);
	}
	for (const diagnostic of input.diagnostics) {
		lines.push(`  ${diagnostic.level}: ${diagnostic.plugin}: ${diagnostic.message}`);
	}

	for (const note of loaderLimitations(input.plugins)) {
		lines.push(`  unsupported: ${note}`);
	}

	return lines.join("\n");
}

/** Limits that a loaded plugin can hit and that the README's "Not supported" section names. */
function loaderLimitations(plugins: readonly LoadedPlugin[]): string[] {
	const events = new Set(plugins.flatMap((plugin) => plugin.hooks.map((hook) => hook.event)));
	const notes: string[] = [];
	if (events.has("Stop")) {
		notes.push(
			"Stop additionalContext does not continue the turn, and the continuation count does not reset when a tool is called",
		);
	}
	if (events.has("UserPromptSubmit")) {
		notes.push("UserPromptSubmit does not see plugin commands or the prompt they expand into");
	}
	if (events.has("SessionStart")) {
		notes.push(
			"CLAUDE_ENV_FILE is not set, so a SessionStart hook cannot export variables for later commands",
		);
	}
	if (events.has("PreCompact")) {
		notes.push(
			"PreCompact stdout is not applied as summary instructions; pi 0.84.4 cannot pass them to the default summarizer",
		);
	}
	if (plugins.some((plugin) => plugin.mcpServers.length > 0)) {
		notes.push(
			"MCP servers are registered as <plugin>__<server>, not plugin:<plugin>:<server>, and tools are not named mcp__plugin_",
		);
	}
	return notes;
}
