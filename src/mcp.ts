import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isInsidePlugin } from "./manifest.ts";
import { substituteDeep } from "./substitute.ts";
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
	const configs: McpConfig[] = [];

	const declared = manifest.mcpServers;
	if (declared !== undefined && !Array.isArray(declared) && typeof declared === "object") {
		configs.push(declared);
	} else {
		const entries = declared === undefined ? [".mcp.json"] : Array.isArray(declared) ? declared : [declared];
		for (const entry of entries) {
			if (typeof entry !== "string") continue;
			if (!isInsidePlugin(root, entry)) {
				escaped.push(entry);
				continue;
			}
			const path = resolve(root, entry);
			if (!existsSync(path)) continue;
			const parsed = readMcpFile(path);
			if (parsed) configs.push(parsed);
		}
	}

	const servers: PluginMcpServer[] = [];
	const warnings: string[] = [];

	for (const config of configs) {
		for (const [name, rawEntry] of Object.entries(config.mcpServers ?? {})) {
			if (!rawEntry || typeof rawEntry !== "object") continue;
			const unresolved: string[] = [];
			const entry = { ...rawEntry } as Record<string, unknown>;
			for (const field of EXPANDED_FIELDS) {
				if (entry[field] === undefined) continue;
				entry[field] = substituteDeep(entry[field], vars, { env, unresolved });
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

function readMcpFile(path: string): McpConfig | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return parsed as McpConfig;
		}
	} catch {
		return undefined;
	}
	return undefined;
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
