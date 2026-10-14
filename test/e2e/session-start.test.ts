import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_PLUGIN } from "../helpers.ts";
import { RpcSession } from "./rpc-client.ts";

interface Entry {
	type: string;
	customType?: string;
}

function sessionFile(sessionDir: string): string {
	const files = readdirSync(sessionDir, { recursive: true, encoding: "utf8" }).filter((name) =>
		name.endsWith(".jsonl"),
	);
	expect(files).toHaveLength(1);
	return join(sessionDir, files[0] as string);
}

function entries(sessionDir: string): Entry[] {
	return readFileSync(sessionFile(sessionDir), "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as Entry);
}

const isPluginContext = (entry: Entry) =>
	entry.type === "custom_message" && entry.customType === "claude-plugins";

describe("SessionStart context of the demo plugin", () => {
	let sessionDir: string;

	afterEach(() => {
		rmSync(sessionDir, { recursive: true, force: true });
	});

	it("is not added again when the session is resumed", async () => {
		sessionDir = mkdtempSync(join(tmpdir(), "pcp-sessions-"));
		for (const round of [0, 1, 2]) {
			const session = RpcSession.start({
				pluginPaths: [FIXTURE_PLUGIN],
				allowHooks: true,
				sessionDir,
				...(round === 0 ? {} : { resume: sessionFile(sessionDir) }),
			});
			await session.prompt("hello", 40_000);
			await session.stop();
		}

		expect(entries(sessionDir).filter(isPluginContext)).toHaveLength(1);
	}, 120_000);

	it("comes back after a compaction summarised it away", async () => {
		sessionDir = mkdtempSync(join(tmpdir(), "pcp-sessions-"));
		const session = RpcSession.start({
			pluginPaths: [FIXTURE_PLUGIN],
			allowHooks: true,
			sessionDir,
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		try {
			await session.prompt("first", 40_000);
			await session.prompt("second", 40_000);
			session.send({ id: "compact", type: "compact" });
			await session.waitFor((event) => event.type === "response" && event.id === "compact", {
				timeoutMs: 40_000,
			});
			await session.prompt("after the compaction", 40_000);
		} finally {
			await session.stop();
		}

		const journal = entries(sessionDir);
		const compaction = journal.findIndex((entry) => entry.type === "compaction");
		expect(compaction).toBeGreaterThan(-1);
		expect(journal.slice(compaction).some(isPluginContext)).toBe(true);
	}, 120_000);
});
