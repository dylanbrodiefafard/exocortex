import type { JsonValue } from "./trace/store.ts";

export interface ToJsonOptions {
	/** Base64 payloads longer than this (image/audio `data` fields) are replaced by their length. */
	readonly maxBinaryChars?: number;
}

const DEFAULT_MAX_BINARY_CHARS = 512;
const BINARY_KEYS = new Set(["data", "image_url", "b64_json"]);

/**
 * Converts an arbitrary harness value into plain JSON for the trace: drops `undefined`,
 * functions and symbols, converts bigints to strings, breaks cycles, and replaces large inline
 * binary payloads with `{ omitted: "binary", chars }`. Never throws.
 */
export function toJsonValue(value: unknown, options: ToJsonOptions = {}): JsonValue {
	const maxBinaryChars = options.maxBinaryChars ?? DEFAULT_MAX_BINARY_CHARS;
	const seen = new WeakSet<object>();

	function convert(input: unknown, key: string | undefined): JsonValue | undefined {
		switch (typeof input) {
			case "string":
				return key !== undefined && BINARY_KEYS.has(key) && input.length > maxBinaryChars
					? { omitted: "binary", chars: input.length }
					: input;
			case "number":
				return Number.isFinite(input) ? input : String(input);
			case "boolean":
				return input;
			case "bigint":
				return input.toString();
			case "object":
				return input === null ? null : convertObject(input);
			default:
				return undefined;
		}
	}

	function convertObject(input: object): JsonValue {
		if (seen.has(input)) return "[circular]";
		seen.add(input);
		try {
			if (Array.isArray(input)) return input.map((item) => convert(item, undefined) ?? null);
			if (input instanceof Date) return input.toISOString();
			if (input instanceof Uint8Array) return { omitted: "binary", chars: input.byteLength };
			const out: Record<string, JsonValue> = {};
			for (const [k, v] of Object.entries(input)) {
				const converted = convert(v, k);
				if (converted !== undefined) out[k] = converted;
			}
			return out;
		} finally {
			seen.delete(input);
		}
	}

	return convert(value, undefined) ?? null;
}
