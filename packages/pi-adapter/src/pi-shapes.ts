import {
	type AgentBeforeSettleEvent,
	convertToLlm,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	serializeConversation,
	type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { type JsonValue, toJsonValue } from "@exocortex/core";

/**
 * Reading and building pi's data shapes: message content, tool results, session entries. Nothing
 * here keeps state or calls a module.
 */

/** Prefix of `customType` on every message and entry Exocortex writes (D-029). */
const EXO_CUSTOM_TYPE_PREFIX = "exo.";

type JsonObject = { readonly [key: string]: JsonValue };
type AgentMessages = SessionBeforeCompactEvent["preparation"]["messagesToSummarize"];

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `value` as a plain JSON object; `{}` when it is anything else. */
export function toObject(value: unknown): JsonObject {
	const json = toJsonValue(value);
	return isJsonObject(json) ? json : {};
}

function isJsonObject(value: JsonValue): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The text parts of a message's content, one per line. */
export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part: unknown) => isRecord(part) && part["type"] === "text")
		.map((part: { text?: unknown }) => String(part.text ?? ""))
		.join("\n");
}

/** Module id for messages Exocortex injected (`customType: "exo.<module>[.<detail>]"`). */
export function exoModuleOf(message: unknown): string | undefined {
	if (!isRecord(message)) return undefined;
	const { role, customType } = message;
	if (role !== "custom" || typeof customType !== "string" || !customType.startsWith(EXO_CUSTOM_TYPE_PREFIX)) {
		return undefined;
	}
	return customType.slice(EXO_CUSTOM_TYPE_PREFIX.length).split(".")[0] || undefined;
}

/**
 * The exit code a tool reported in `structuredContent`. Among pi's own tools only bash does, as
 * `exit_code`; `exitCode` is accepted for other extensions' tools (PI_API_NOTES §13).
 */
export function exitCodeOf(structured: unknown): number | null {
	if (!isRecord(structured)) return null;
	const code = structured["exit_code"] ?? structured["exitCode"];
	return typeof code === "number" ? code : null;
}

/** Text of the final assistant message at a settle (empty if none). */
export function lastAssistantText(event: AgentBeforeSettleEvent): string {
	const messages = event.context.llmMessages;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role === "assistant") return textOf(message.content);
	}
	return "";
}

export function sameText(a: string, b: string): boolean {
	return a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
}

export interface RewriteNote {
	readonly module: string;
	readonly note: string;
}

/** The pi `tool_result` patch for rewritten text: merged `details.exo`, structuredContent kept. */
export function rewrittenResult(event: ToolResultEvent, text: string, notes: readonly RewriteNote[]) {
	const details = isRecord(event.details) ? event.details : {};
	const exo = isRecord(details["exo"]) ? details["exo"] : {};
	return {
		content: [{ type: "text" as const, text }],
		details: { ...details, exo: { ...exo, rewrites: notes } },
		// Replacing content without structuredContent would drop it (PI_API_NOTES §4).
		...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
	};
}

/** Bash reports where it saved untruncated output in `details` and `structuredContent`. */
export function fullOutputPathOf(details: unknown, structured: unknown): string | null {
	const fromDetails = isRecord(details) ? details["fullOutputPath"] : undefined;
	const fromStructured = isRecord(structured) ? structured["full_output_path"] : undefined;
	const path = fromDetails ?? fromStructured;
	return typeof path === "string" && path !== "" ? path : null;
}

/** Bash ends a failing command's text with its exit status, after the output (PI_API_NOTES, `bash`). */
export function statusOf(text: string): string | null {
	return /\n\n(Command exited with code \d+)$/.exec(text)?.[1] ?? null;
}

/**
 * The span a compaction summarizes, as labelled text. Pi's own serialization sends custom messages
 * as the user's, so text Exocortex injected ("Not done yet: …") would be summarized as something
 * the user said. Those messages get their own label; everything else is serialized by pi.
 */
export function serializeSpan(span: AgentMessages): string {
	const parts: string[] = [];
	let run: AgentMessages = [];
	const flush = (): void => {
		if (run.length === 0) return;
		const text = serializeConversation(convertToLlm(run));
		if (text !== "") parts.push(text);
		run = [];
	};
	for (const message of span) {
		const module = exoModuleOf(message);
		if (module === undefined) {
			run.push(message);
			continue;
		}
		flush();
		const text = textOf((message as { content?: unknown }).content);
		if (text !== "") parts.push(`[Exocortex ${module}, not the user]: ${text}`);
	}
	flush();
	return parts.join("\n\n");
}

/**
 * What `module` returned as details with the latest compaction on the branch, or null when that
 * compaction was pi's own, another extension's or another module's.
 */
export function previousCompactionDetails(
	branchEntries: SessionBeforeCompactEvent["branchEntries"],
	module: string,
): JsonObject | null {
	for (let i = branchEntries.length - 1; i >= 0; i--) {
		const entry: unknown = branchEntries[i];
		if (!isRecord(entry) || entry["type"] !== "compaction") continue;
		const exo = isRecord(entry["details"]) ? entry["details"]["exo"] : undefined;
		return isRecord(exo) && exo["module"] === module ? toObject(exo) : null;
	}
	return null;
}

/**
 * The data of the last `custom` entry of each given type on the session's current branch. Entries
 * Exocortex wrote with `pi.appendEntry` are never sent to the model (PI_API_NOTES §8).
 */
export function lastCustomEntries(ctx: ExtensionContext, customTypes: ReadonlySet<string>): Map<string, unknown> {
	const found = new Map<string, unknown>();
	for (const entry of ctx.sessionManager.getBranch() as readonly unknown[]) {
		if (!isRecord(entry) || entry["type"] !== "custom") continue;
		const customType = entry["customType"];
		if (typeof customType === "string" && customTypes.has(customType)) found.set(customType, entry["data"]);
	}
	return found;
}

/** The run's abort signal, when pi has one (it does while the agent runs; PI_API_NOTES §5). */
export function signalOf(ctx: ExtensionContext): AbortSignal | undefined {
	try {
		return ctx.signal;
	} catch {
		return undefined;
	}
}

const ESCAPE = "\u001b";

/** Whether raw terminal input is the Escape key: the bare byte, or the kitty protocol's `CSI 27 u`. */
export function isEscapeKey(data: string): boolean {
	return data === ESCAPE || (data.startsWith(ESCAPE) && /^\[27(;\d+(:\d+)?)?u$/.test(data.slice(1)));
}
