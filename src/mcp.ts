import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isInside } from "./manifest.ts";
import { substituteEnvDeep } from "./substitute.ts";
import type {
	McpConfig,
	McpServerEntry,
	PluginManifest,
	PluginMcpServer,
	SubstitutionVars,
} from "./types.ts";

export const MCP_RUNTIME_REGISTER_EVENT = "pi-mcp-adapter:runtime-register:v1";
const MCP_RUNTIME_REGISTER_VERSION = 1;

const EXPANDED_FIELDS = ["command", "args", "env", "cwd", "url", "headers"] as const;

export interface McpDiscovery {
	servers: PluginMcpServer[];
	escaped: string[];
	warnings: string[];
}

export function discoverMcpServers(
	plugin: string,
	root: string,
	manifest: PluginManifest,
	vars: SubstitutionVars,
	env: NodeJS.ProcessEnv = process.env,
): McpDiscovery {
	const escaped: string[] = [];
	const warnings: string[] = [];
	const configs: McpConfig[] = [];

	const declared = manifest.mcpServers;
	if (declared !== undefined && !Array.isArray(declared) && typeof declared === "object") {
		configs.push(asMcpConfig(declared as Record<string, unknown>));
	} else {
		const entries = declared === undefined ? [".mcp.json"] : Array.isArray(declared) ? declared : [declared];
		for (const entry of entries) {
			if (typeof entry !== "string") continue;
			if (!isInside(root, entry)) {
				escaped.push(entry);
				continue;
			}
			const path = resolve(root, entry);
			if (!existsSync(path)) continue;
			const parsed = readMcpFile(path);
			if (parsed.config) configs.push(parsed.config);
			if (parsed.error) warnings.push(`MCP config ${entry} was ignored: ${parsed.error}`);
		}
	}

	const servers: PluginMcpServer[] = [];

	for (const config of configs) {
		for (const [name, rawEntry] of Object.entries(config.mcpServers ?? {})) {
			if (!rawEntry || typeof rawEntry !== "object") continue;
			const unresolved: string[] = [];
			const entry = { ...rawEntry } as Record<string, unknown>;
			for (const field of EXPANDED_FIELDS) {
				if (entry[field] === undefined) continue;
				entry[field] = substituteEnvDeep(entry[field], vars, { env, unresolved });
			}
			if (unresolved.length > 0) {
				warnings.push(
					`MCP server ${name} references unset variables kept as literal text: ${[...new Set(unresolved)].join(", ")}`,
				);
			}
			servers.push({
				plugin,
				name: `${sanitize(plugin)}__${sanitize(name)}`,
				// Every ${VAR} is already resolved here; the adapter must not resolve them again.
				definition: { ...entry, literalEnv: true } as McpServerEntry,
			});
		}
	}

	return { servers, escaped, warnings };
}

function sanitize(name: string): string {
	return name.replace(/[^\w-]+/g, "_");
}

/**
 * A `.mcp.json` file wraps the server map in `{ "mcpServers": … }`; an inline manifest value is
 * the server map itself.
 */
function asMcpConfig(value: Record<string, unknown>): McpConfig {
	const nested = value.mcpServers;
	if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
		return value as McpConfig;
	}
	return { mcpServers: (value ?? {}) as NonNullable<McpConfig["mcpServers"]> };
}

function readMcpFile(path: string): { config?: McpConfig; error?: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return { error: (error as Error).message };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { error: "expected a JSON object" };
	}
	return { config: asMcpConfig(parsed as Record<string, unknown>) };
}

export interface McpRegistration {
	dispose(): Promise<void>;
}

interface RuntimeRegistrationRequest {
	version: number;
	name: string;
	definition: McpServerEntry;
	result?: { ok: true; registration: McpRegistration } | { ok: false; error: Error };
}

export interface EventBusLike {
	emit(event: string, payload: unknown): void;
}

export type McpRegisterOutcome =
	| { status: "registered"; registration: McpRegistration }
	| { status: "no-adapter" }
	| { status: "failed"; error: Error };

/**
 * pi-mcp-adapter answers on the shared bus by writing `result` on the request object
 * synchronously. An absent `result` means no adapter is listening.
 */
export function registerMcpServer(events: EventBusLike, server: PluginMcpServer): McpRegisterOutcome {
	const request: RuntimeRegistrationRequest = {
		version: MCP_RUNTIME_REGISTER_VERSION,
		name: server.name,
		definition: server.definition,
	};
	events.emit(MCP_RUNTIME_REGISTER_EVENT, request);
	if (!request.result) return { status: "no-adapter" };
	if (!request.result.ok) return { status: "failed", error: request.result.error };
	return { status: "registered", registration: request.result.registration };
}
