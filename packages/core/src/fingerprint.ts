import { createHash } from "node:crypto";
import type { JsonValue } from "./trace/store.ts";

/**
 * Compact fingerprint of an OpenAI-style chat request: per-message hashes plus hashes of the
 * tool list, so prefix stability can be measured from the trace without storing every
 * request's full context.
 */
export interface ChatRequestFingerprint {
	readonly [key: string]: JsonValue;
	readonly model: string | null;
	/** Hash of each message in order (12 hex chars of sha256 over canonical JSON). */
	readonly messageHashes: readonly string[];
	readonly toolsHash: string | null;
	/** Total characters across the canonical JSON of all messages: a cheap size proxy. */
	readonly messageChars: number;
	/** Every other top-level field (sampling, max tokens, template kwargs, ...), verbatim. */
	readonly params: { readonly [key: string]: JsonValue };
}

export function fingerprintChatRequest(body: JsonValue): ChatRequestFingerprint {
	const record = isRecord(body) ? body : {};
	const messages = Array.isArray(record["messages"]) ? record["messages"] : [];
	const canonicalMessages = messages.map((message) => canonicalJson(message));
	const params: Record<string, JsonValue> = {};
	for (const [key, value] of Object.entries(record)) {
		if (key !== "messages" && key !== "tools" && key !== "model") params[key] = value;
	}
	return {
		model: typeof record["model"] === "string" ? record["model"] : null,
		messageHashes: canonicalMessages.map(shortHash),
		toolsHash: record["tools"] === undefined ? null : shortHash(canonicalJson(record["tools"])),
		messageChars: canonicalMessages.reduce((sum, text) => sum + text.length, 0),
		params,
	};
}

/**
 * How many leading messages two consecutive requests share, and whether the shared part also has
 * identical tools and model. A stable prefix is what lets the engine's prefix cache hit.
 */
export function sharedPrefix(
	previous: ChatRequestFingerprint,
	next: ChatRequestFingerprint,
): { readonly messages: number; readonly toolsMatch: boolean; readonly fullPrefixKept: boolean } {
	let shared = 0;
	const limit = Math.min(previous.messageHashes.length, next.messageHashes.length);
	while (shared < limit && previous.messageHashes[shared] === next.messageHashes[shared]) shared += 1;
	const toolsMatch = previous.toolsHash === next.toolsHash && previous.model === next.model;
	return { messages: shared, toolsMatch, fullPrefixKept: toolsMatch && shared === previous.messageHashes.length };
}

/** JSON with object keys sorted, so semantically equal values hash equally. */
export function canonicalJson(value: JsonValue): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isRecord(value)) {
		const keys = Object.keys(value).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

function shortHash(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function isRecord(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
