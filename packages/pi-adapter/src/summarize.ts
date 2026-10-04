import type { DebugFields, DebugValue } from "@exocortex/core";

/**
 * Generic one-line summary of a pi event for debug output: scalar fields verbatim, arrays as
 * lengths, and a few well-known nested shapes (messages, provider payloads) reduced to their
 * salient parts. Never throws, never mutates.
 */
export function summarizePiEvent(event: unknown): DebugFields {
	if (!isRecord(event)) return {};
	const fields: Record<string, DebugValue> = {};
	for (const [key, value] of Object.entries(event)) {
		if (key === "type") continue;
		Object.assign(fields, summarizeField(key, value));
	}
	return fields;
}

function summarizeField(key: string, value: unknown): Record<string, DebugValue> {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return { [key]: value };
	}
	if (Array.isArray(value)) return { [`${key}.length`]: value.length };
	if (!isRecord(value)) return {};
	if (key === "message") return summarizeMessage(value);
	if (key === "payload") return summarizePayload(value);
	if (key === "model" && typeof value["id"] === "string") return { model: value["id"] };
	return {};
}

function summarizeMessage(message: Record<string, unknown>): Record<string, DebugValue> {
	const usage = isRecord(message["usage"]) ? message["usage"] : {};
	return {
		role: stringOr(message["role"]),
		customType: stringOr(message["customType"]),
		toolName: stringOr(message["toolName"]),
		stopReason: stringOr(message["stopReason"]),
		"usage.input": numberOr(usage["input"]),
		"usage.cacheRead": numberOr(usage["cacheRead"]),
		"usage.output": numberOr(usage["output"]),
	};
}

function summarizePayload(payload: Record<string, unknown>): Record<string, DebugValue> {
	return {
		"payload.model": stringOr(payload["model"]),
		"payload.messages": Array.isArray(payload["messages"]) ? payload["messages"].length : undefined,
		"payload.tools": Array.isArray(payload["tools"]) ? payload["tools"].length : undefined,
		"payload.stream": typeof payload["stream"] === "boolean" ? payload["stream"] : undefined,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOr(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function numberOr(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}
