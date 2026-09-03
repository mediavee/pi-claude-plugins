import type { SkillCollision } from "./skills.ts";
import type { Diagnostic, LoadedPlugin } from "./types.ts";

export interface ReportInput {
	plugins: readonly LoadedPlugin[];
	diagnostics: readonly Diagnostic[];
	collisions: readonly SkillCollision[];
	/** Servers skipped because pi-mcp-adapter is not loaded. */
	mcpUnavailable: readonly string[];
	shellAllowed: boolean;
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
			lines.push(`  ${plugin.name}${origin}: ${counts(plugin)}`);
			for (const refused of plugin.refused) lines.push(`    refused: ${refused}`);
			for (const unsupported of plugin.unsupportedHooks) {
				lines.push(`    unsupported hook ${unsupported}`);
			}
		}
	}

	if (!input.shellAllowed) {
		const withShell = input.plugins.filter((plugin) =>
			plugin.commands.some((command) => /!`|```!/.test(command.body)),
		);
		for (const plugin of withShell) {
			lines.push(`  ${plugin.name}: shell expansion in commands is disabled`);
		}
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

	return lines.join("\n");
}
