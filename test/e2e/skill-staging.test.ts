import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RpcSession } from "./rpc-client.ts";

interface Command {
	name: string;
	sourceInfo?: { path?: string };
}

/** The `runner` skill's commands: other skills of the user's machine may be listed beside it. */
async function runnerSkills(session: RpcSession): Promise<Command[]> {
	session.send({ id: "cmds", type: "get_commands" });
	const response = await session.waitFor(
		(event) => event.type === "response" && event.command === "get_commands",
		{ timeoutMs: 40_000 },
	);
	const commands = (response.data as { commands: Command[] }).commands;
	return commands.filter((command) => command.name === "skill:runner");
}

function pluginWithPlaceholderSkill(): string {
	const root = mkdtempSync(join(tmpdir(), "pcp-plugin-"));
	mkdirSync(join(root, ".claude-plugin"));
	writeFileSync(join(root, ".claude-plugin/plugin.json"), JSON.stringify({ name: "stage-demo" }));
	mkdirSync(join(root, "skills/runner"), { recursive: true });
	writeFileSync(
		join(root, "skills/runner/SKILL.md"),
		"---\nname: runner\ndescription: Runs the bundled script.\n---\nRun ${CLAUDE_SKILL_DIR}/run.sh",
	);
	writeFileSync(join(root, "skills/runner/run.sh"), "#!/bin/sh\n");
	return root;
}

// A directory that cannot be emptied is not one for a user who bypasses permissions.
const unprivileged = process.getuid?.() !== 0;

describe("skills of a pi whose agent dir it cannot write", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
	});

	it.skipIf(!unprivileged)(
		"still lists them, expanded in the staging root, past a leftover it cannot remove",
		async () => {
			const plugin = pluginWithPlaceholderSkill();
			const staging = mkdtempSync(join(tmpdir(), "pcp-stage-"));
			let leftover = "";
			const session = RpcSession.start({
				pluginPaths: [plugin],
				env: { PI_CLAUDE_PLUGINS_STAGING: staging },
				prepareAgentDir: (agentDir) => {
					// What a per-process mirror of an earlier version leaves behind.
					leftover = join(agentDir, "claude-plugins/skills/315");
					mkdirSync(join(leftover, "stage-demo/runner"), { recursive: true });
					chmodSync(leftover, 0o500);
				},
			});
			cleanups.push(() => {
				rmSync(plugin, { recursive: true, force: true });
				rmSync(staging, { recursive: true, force: true });
			});
			try {
				const [skill, ...others] = await runnerSkills(session);

				expect(others).toEqual([]);
				expect(skill?.name).toBe("skill:runner");
				expect(skill?.sourceInfo?.path?.startsWith(staging)).toBe(true);
				expect(readFileSync(skill?.sourceInfo?.path ?? "", "utf8")).toContain(
					`Run ${plugin}/skills/runner/run.sh`,
				);
			} finally {
				chmodSync(leftover, 0o700);
				await session.stop();
			}
		},
		120_000,
	);

	it("lists a skill from the same path in two processes", async () => {
		const plugin = pluginWithPlaceholderSkill();
		const staging = mkdtempSync(join(tmpdir(), "pcp-stage-"));
		cleanups.push(() => {
			rmSync(plugin, { recursive: true, force: true });
			rmSync(staging, { recursive: true, force: true });
		});
		const paths: Array<string | undefined> = [];
		for (const _ of [0, 1]) {
			const session = RpcSession.start({
				pluginPaths: [plugin],
				env: { PI_CLAUDE_PLUGINS_STAGING: staging },
			});
			try {
				paths.push((await runnerSkills(session))[0]?.sourceInfo?.path);
			} finally {
				await session.stop();
			}
		}

		expect(paths[0]).toBeDefined();
		expect(paths[1]).toBe(paths[0]);
	}, 120_000);
});
