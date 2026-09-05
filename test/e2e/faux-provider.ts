import {
	type Context,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Message,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const FAUX_PROVIDER = "faux";
export const FAUX_MODEL = "faux-model";

function textOf(message: Message | undefined): string {
	if (message?.role !== "user") return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** Everything the user contributed since the last assistant reply, hook-injected context included. */
function currentTurnText(context: Context): string {
	const lastAssistant = context.messages.findLastIndex((message) => message.role === "assistant");
	return context.messages
		.slice(lastAssistant + 1)
		.map(textOf)
		.filter((text) => text.length > 0)
		.join("\n");
}

/**
 * Scripted replies keyed off the conversation, so the same extension drives both the RPC parent
 * and the `pi` child an agent spawns. A trailing tool result always ends the turn, which keeps
 * the script from re-issuing a tool call it already made.
 */
function reply(context: Context) {
	const last = context.messages.at(-1);
	if (last?.role === "toolResult") {
		return fauxAssistantMessage(`observed:${last.toolName}`);
	}

	const prompt = currentTurnText(context);
	if (prompt.includes("Task:")) {
		return fauxAssistantMessage(prompt.slice(prompt.indexOf("Task:")).trim());
	}
	if (prompt.includes("read the env file")) {
		return fauxAssistantMessage([fauxToolCall("bash", { command: "cat .env" })]);
	}
	if (prompt.includes("check the git log")) {
		return fauxAssistantMessage([fauxToolCall("bash", { command: "git log --oneline -1" })]);
	}
	if (prompt.includes("list the files")) {
		return fauxAssistantMessage([fauxToolCall("bash", { command: "ls -1" })]);
	}
	if (prompt.includes("run the echo agent")) {
		return fauxAssistantMessage([
			fauxToolCall("claude_plugin_agent", { agent: "demo-plugin:echo", task: "ping" }),
		]);
	}
	return fauxAssistantMessage(`echo:${prompt}`);
}

export default function fauxProviderExtension(pi: ExtensionAPI): void {
	const faux = fauxProvider({
		provider: FAUX_PROVIDER,
		models: [{ id: FAUX_MODEL, name: "Faux model", contextWindow: 200_000, maxTokens: 8192 }],
	});
	// Each reply re-queues itself, so the script is driven by the conversation, not by a fixed list.
	const respond = (context: Context) => {
		faux.appendResponses([respond]);
		return reply(context);
	};
	faux.setResponses([respond]);
	pi.registerProvider(faux.provider);
}
