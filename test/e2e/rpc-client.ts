import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { REPO_ROOT } from "../helpers.ts";
import { FAUX_MODEL, FAUX_PROVIDER } from "./faux-provider.ts";

export interface RpcEvent {
	type: string;
	[key: string]: unknown;
}

export interface StartOptions {
	pluginPaths: string[];
	allowHooks?: boolean;
	allowShell?: boolean;
	/** Persists the session there instead of `--no-session`; `resume` reopens that session file. */
	sessionDir?: string;
	resume?: string;
	settings?: Record<string, unknown>;
}

/**
 * Drives a real `pi --mode rpc` process over JSONL. The faux provider is installed through
 * `PI_CODING_AGENT_DIR` rather than `-e` so that the `pi` child an agent spawns loads it too.
 */
export class RpcSession {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly agentDir: string;
	readonly workDir: string;
	readonly events: RpcEvent[] = [];
	readonly stderr: string[] = [];
	private buffer = "";
	private waiters: Array<() => void> = [];
	private confirmAnswer: boolean | undefined;

	private constructor(child: ChildProcessWithoutNullStreams, agentDir: string, workDir: string) {
		this.child = child;
		this.agentDir = agentDir;
		this.workDir = workDir;

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.consume(chunk));
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => this.stderr.push(chunk));
	}

	static start(options: StartOptions): RpcSession {
		const agentDir = mkdtempSync(join(tmpdir(), "pcp-agent-"));
		// A resumed session must start in the directory it recorded.
		const workDir =
			options.sessionDir === undefined
				? mkdtempSync(join(tmpdir(), "pcp-work-"))
				: join(options.sessionDir, "work");
		mkdirSync(workDir, { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				defaultProvider: FAUX_PROVIDER,
				defaultModel: FAUX_MODEL,
				quietStartup: true,
				defaultProjectTrust: "never",
				extensions: [resolve(REPO_ROOT, "test/e2e/faux-provider.ts")],
				...options.settings,
			}),
		);

		const child = spawn(
			resolve(REPO_ROOT, "node_modules/.bin/pi"),
			[
				"--mode",
				"rpc",
				...(options.sessionDir === undefined
					? ["--no-session"]
					: [
							"--session-dir",
							options.sessionDir,
							...(options.resume === undefined ? [] : ["--session", options.resume]),
						]),
				"-e",
				resolve(REPO_ROOT, "src/index.ts"),
			],
			{
				cwd: workDir,
				stdio: ["pipe", "pipe", "pipe"],
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: agentDir,
					PI_OFFLINE: "1",
					PI_SKIP_VERSION_CHECK: "1",
					PI_CLAUDE_PLUGINS: options.pluginPaths.join(":"),
					PI_CLAUDE_PLUGINS_ALLOW_HOOKS: options.allowHooks ? "1" : "0",
					PI_CLAUDE_PLUGINS_ALLOW_SHELL: options.allowShell ? "1" : "0",
				},
			},
		) as ChildProcessWithoutNullStreams;

		return new RpcSession(child, agentDir, workDir);
	}

	// RPC mode is strict JSONL on LF; Node's readline would also split on U+2028/U+2029.
	private consume(chunk: string): void {
		this.buffer += chunk;
		let newline = this.buffer.indexOf("\n");
		while (newline !== -1) {
			const line = this.buffer.slice(0, newline).replace(/\r$/, "");
			this.buffer = this.buffer.slice(newline + 1);
			if (line.trim()) {
				try {
					const event = JSON.parse(line) as RpcEvent;
					this.events.push(event);
					this.answerDialog(event);
				} catch {
					// Non-protocol noise on stdout is not ours to interpret.
				}
			}
			newline = this.buffer.indexOf("\n");
		}
		for (const waiter of this.waiters.splice(0)) waiter();
	}

	send(command: Record<string, unknown>): void {
		this.child.stdin.write(`${JSON.stringify(command)}\n`);
	}

	/** Answers every extension confirm dialog with `confirmed`, as a client would. */
	autoAnswerConfirm(confirmed: boolean): void {
		this.confirmAnswer = confirmed;
	}

	async waitFor(
		predicate: (event: RpcEvent) => boolean,
		options: { from?: number; timeoutMs?: number } = {},
	): Promise<RpcEvent> {
		const from = options.from ?? 0;
		const deadline = Date.now() + (options.timeoutMs ?? 25_000);
		for (;;) {
			const found = this.events.slice(from).find(predicate);
			if (found) return found;
			if (Date.now() > deadline) {
				throw new Error(`timed out waiting for an event\nstderr:\n${this.stderr.join("")}`);
			}
			await new Promise<void>((resolvePromise) => {
				const timer = setTimeout(resolvePromise, 50);
				this.waiters.push(() => {
					clearTimeout(timer);
					resolvePromise();
				});
			});
		}
	}

	private answerDialog(event: RpcEvent): void {
		if (event.type !== "extension_ui_request" || event.method !== "confirm") return;
		if (this.confirmAnswer === undefined) return;
		this.send({ type: "extension_ui_response", id: event.id, confirmed: this.confirmAnswer });
	}

	/** Runs one prompt and resolves once the agent has settled. */
	async prompt(message: string, timeoutMs?: number): Promise<void> {
		const from = this.events.length;
		this.send({ type: "prompt", message });
		await this.waitFor((event) => event.type === "agent_settled", {
			from,
			...(timeoutMs === undefined ? {} : { timeoutMs }),
		});
	}

	assistantTexts(): string[] {
		return this.events
			.filter((event) => event.type === "message_end")
			.map((event) => event.message as { role?: string; content?: Array<{ type?: string; text?: string }> })
			.filter((message) => message?.role === "assistant")
			.flatMap((message) => message.content ?? [])
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text as string);
	}

	toolResults(toolName: string): RpcEvent[] {
		return this.events.filter((event) => event.type === "tool_execution_end" && event.toolName === toolName);
	}

	async stop(): Promise<void> {
		this.child.stdin.end();
		this.child.kill("SIGTERM");
		await new Promise<void>((resolvePromise) => {
			this.child.on("close", () => resolvePromise());
			setTimeout(resolvePromise, 2000);
		});
		rmSync(this.agentDir, { recursive: true, force: true });
		rmSync(this.workDir, { recursive: true, force: true });
	}
}
