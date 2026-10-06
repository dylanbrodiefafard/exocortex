import type { JsonValue } from "./trace/store.ts";

export interface ToJsonOptions {
	/** Base64 payloads longer than this (image/audio `data` fields) are replaced by their length. */
	readonly maxBinaryChars?: number;
}

const DEFAULT_MAX_BINARY_CHARS = 512;
const BINARY_KEYS = new Set(["data", "image_url", "b64_json"]);
/** Nesting deeper than this is cut, so no input can overflow the stack. */
const MAX_DEPTH = 200;

/**
 * Converts an arbitrary harness value into plain JSON for the trace. Never throws.
 *
 * - Dropped: `undefined`, functions and symbols (as array items they become `null`).
 * - Bigints and non-finite numbers become strings; dates become ISO strings.
 * - An `Error` becomes `{ name, message, stack, … }` with its own properties and `cause`.
 * - A `Map` becomes an array of `[key, value]` pairs, a `Set` an array.
 * - Binary data (array buffers and every view on one) and large inline base64 payloads become
 *   `{ omitted: "binary", chars }`.
 * - A cycle becomes `"[circular]"`; a property whose getter throws becomes `"[unreadable]"`.
 */
export function toJsonValue(value: unknown, options: ToJsonOptions = {}): JsonValue {
	const maxBinaryChars = options.maxBinaryChars ?? DEFAULT_MAX_BINARY_CHARS;
	const seen = new WeakSet<object>();
	let depth = 0;

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
				return input === null ? null : guarded(input);
			default:
				return undefined;
		}
	}

	function guarded(input: object): JsonValue {
		if (seen.has(input)) return "[circular]";
		if (depth >= MAX_DEPTH) return "[too deep]";
		seen.add(input);
		depth += 1;
		try {
			return convertObject(input);
		} catch {
			// A proxy or exotic object that cannot even be inspected.
			return "[unreadable]";
		} finally {
			depth -= 1;
			seen.delete(input);
		}
	}

	const item = (input: unknown): JsonValue => convert(input, undefined) ?? null;

	/** Built-in containers and values that are not read property by property. */
	function convertBuiltin(input: object): JsonValue | undefined {
		if (Array.isArray(input)) return Array.from(input, item);
		if (input instanceof Date) return Number.isNaN(input.getTime()) ? "Invalid Date" : input.toISOString();
		if (ArrayBuffer.isView(input) || input instanceof ArrayBuffer || input instanceof SharedArrayBuffer) {
			return { omitted: "binary", chars: input.byteLength };
		}
		if (input instanceof Map) return Array.from(input, ([k, v]) => [item(k), item(v)]);
		if (input instanceof Set) return Array.from(input, item);
		return undefined;
	}

	function convertObject(input: object): JsonValue {
		const builtin = convertBuiltin(input);
		if (builtin !== undefined) return builtin;
		const out: Record<string, JsonValue> = {};
		// An Error's own fields are not enumerable, so they are read by name.
		const keys = input instanceof Error ? ["name", "message", "stack", "cause"] : [];
		for (const k of new Set([...keys, ...Object.keys(input)])) {
			let converted: JsonValue | undefined;
			try {
				converted = convert((input as Record<string, unknown>)[k], k);
			} catch {
				converted = "[unreadable]";
			}
			if (converted !== undefined) out[k] = converted;
		}
		return out;
	}

	try {
		return convert(value, undefined) ?? null;
	} catch {
		return "[unreadable]";
	}
}
