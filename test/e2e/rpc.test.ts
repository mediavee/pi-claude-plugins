import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_PLUGIN } from "../helpers.ts";
import { RpcSession } from "./rpc-client.ts";

describe("pi --mode rpc with the demo plugin", () => {
	let session: RpcSession;

	beforeAll(async () => {
		session = RpcSession.start({ pluginPaths: [FIXTURE_PLUGIN], allowHooks: true });
		session.send({ id: "ready", type: "get_state" });
		await session.waitFor((event) => event.type === "response" && event.id === "ready", {
			timeoutMs: 40_000,
		});
	}, 60_000);

	afterAll(async () => {
		await session?.stop();
	});

	it("reports what it loaded on stderr", () => {
		const log = session.stderr.join("");
		expect(log).toContain("loaded 1 plugin(s)");
		expect(log).toContain("demo-plugin");
	});

	it("exposes plugin commands and skills to the RPC client", async () => {
		session.send({ id: "cmds", type: "get_commands" });
		const response = await session.waitFor(
			(event) => event.type === "response" && event.command === "get_commands",
		);
		const serialised = JSON.stringify(response);
		expect(serialised).toContain("demo-plugin:review");
		expect(serialised).toContain("demo-plugin:status");
		expect(serialised).toContain("skill:demo-greeting");
	});

	it("expands a plugin command into the prompt the model receives", async () => {
		await session.prompt("/demo-plugin:review src/index.ts security");
		const texts = session.assistantTexts().join("\n");
		expect(texts).toContain("Review src/index.ts with a focus on security.");
		expect(texts).toContain(`Plugin root: ${FIXTURE_PLUGIN}`);
		expect(texts).toContain("First argument: src/index.ts");
	});

	it("lets a PreToolUse hook block a tool call", async () => {
		await session.prompt("read the env file");
		const results = session.toolResults("bash");
		expect(results).toHaveLength(1);
		expect(results[0]?.isError).toBe(true);
		expect(JSON.stringify(results[0]?.result)).toContain("reading .env is not allowed by demo-plugin");
	});

	it("runs a plugin agent in a child pi process", async () => {
		await session.prompt("run the echo agent", 90_000);
		const results = session.toolResults("claude_plugin_agent");
		expect(results).toHaveLength(1);
		expect(results[0]?.isError).toBe(false);
		expect(results[0]?.result).toMatchObject({
			content: [{ type: "text", text: "Task: ping" }],
			details: { agent: "echo", plugin: "demo-plugin" },
		});
	}, 120_000);
});
