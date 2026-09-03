export interface PluginAuthor {
	name?: string;
	email?: string;
	url?: string;
}

export interface PluginManifest {
	name?: string;
	displayName?: string;
	version?: string;
	description?: string;
	author?: PluginAuthor | string;
	homepage?: string;
	repository?: string;
	license?: string;
	keywords?: string[];
	skills?: string | string[];
	commands?: string | string[];
	agents?: string | string[];
	hooks?: string | string[] | HooksConfig;
	mcpServers?: string | string[] | McpConfig;
}

export interface Diagnostic {
	level: "warn" | "error";
	plugin: string;
	message: string;
}

export interface DiscoveredPlugin {
	name: string;
	root: string;
	manifest: PluginManifest;
	/** Marketplace the plugin was resolved through, when it did not come from a plain path. */
	marketplace?: string;
}

export interface SkillSource {
	plugin: string;
	/** Directory holding SKILL.md, or a SKILL.md file path for single-skill plugins. */
	path: string;
	/** Frontmatter name, falling back to the directory name. */
	name: string;
}

export interface PluginCommand {
	plugin: string;
	/** Name without the plugin prefix. */
	name: string;
	path: string;
	description?: string;
	argumentHint?: string;
	/** Named positional arguments from the `arguments` frontmatter key. */
	argumentNames: string[];
	body: string;
}

export interface PluginAgent {
	plugin: string;
	name: string;
	path: string;
	description: string;
	systemPrompt: string;
	model?: string;
	/** pi tool names, already mapped from the Claude names in frontmatter. */
	tools?: string[];
}

export type HookEventName =
	| "PreToolUse"
	| "PostToolUse"
	| "UserPromptSubmit"
	| "Stop"
	| "SessionStart"
	| "PreCompact";

export interface HookHandler {
	type: string;
	command?: string;
	args?: string[];
	timeout?: number;
	shell?: string;
}

export interface HookMatcherGroup {
	matcher?: string;
	hooks: HookHandler[];
}

export interface HooksConfig {
	hooks?: Partial<Record<string, HookMatcherGroup[]>>;
}

export interface PluginHook {
	plugin: string;
	root: string;
	event: HookEventName;
	matcher?: string;
	handler: HookHandler;
}

export interface McpServerEntry {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	type?: string;
	[key: string]: unknown;
}

export interface McpConfig {
	mcpServers?: Record<string, McpServerEntry>;
}

export interface PluginMcpServer {
	plugin: string;
	/** Registration name handed to pi-mcp-adapter, already prefixed. */
	name: string;
	definition: McpServerEntry;
}

export interface LoadedPlugin extends DiscoveredPlugin {
	skills: SkillSource[];
	commands: PluginCommand[];
	agents: PluginAgent[];
	hooks: PluginHook[];
	mcpServers: PluginMcpServer[];
	/** Hook events and handler types present in the plugin but not mappable to pi. */
	unsupportedHooks: string[];
	/** Components dropped for lack of a trust grant. */
	refused: string[];
}

export interface PluginSettings {
	paths: string[];
	marketplaces: string[];
	allowShellCommands: boolean;
	allowHooks: boolean;
	trustedPlugins: string[];
	disabledPlugins: string[];
	agents: boolean;
}

export interface SubstitutionVars {
	CLAUDE_PLUGIN_ROOT: string;
	CLAUDE_PLUGIN_DATA: string;
	CLAUDE_PROJECT_DIR: string;
	CLAUDE_SKILL_DIR?: string;
	CLAUDE_SESSION_ID?: string;
}
