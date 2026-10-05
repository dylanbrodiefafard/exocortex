import { createHash } from "node:crypto";
import { cleanTerminalOutput } from "./output.ts";

/**
 * Deterministic detection of an agent going round in circles (D-069): the same tool call with the
 * same result, or a short cycle of such calls, repeated. One definition serves triage's notices
 * and the eval's stuck-loop metric.
 */

/** The longest cycle looked for: `edit, test, revert, test` is 4. */
export const MAX_LOOP_PERIOD = 5;

/** Parts of an output that differ between two runs of the same thing: durations, clock times, dates, addresses. */
const VOLATILE: readonly [RegExp, string][] = [
	[/\b\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?\b/g, "<date>"],
	[/\b\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\b/g, "<time>"],
	[/\b\d+(\.\d+)?\s?(ns|µs|us|ms|s|sec|secs|seconds?|m|min|mins|minutes?)\b/g, "<duration>"],
	[/\b0x[0-9a-f]+\b/gi, "<hex>"],
];

/**
 * Identifies one tool call together with what it returned. Two calls share a key only when the
 * tool, its exact input and its output are the same, so a repeat means nothing changed. Counts
 * are kept: "3 failed" and "2 failed" are different results.
 */
export function callKey(toolName: string, input: unknown, output: string): string {
	let result = cleanTerminalOutput(output);
	for (const [pattern, placeholder] of VOLATILE) result = result.replace(pattern, placeholder);
	return createHash("sha256")
		.update(`${toolName}\n${canonical(input)}\n${result.trim()}`)
		.digest("hex")
		.slice(0, 32);
}

/** A trailing loop: the last `period` calls, repeated `repeats` times in a row up to now. */
export interface Loop {
	readonly period: number;
	readonly repeats: number;
}

/**
 * The loop the history ends in, if its last `period` keys (for the shortest such period) have
 * come at least `minRepeats` times in a row.
 */
export function trailingLoop(keys: readonly string[], minRepeats: number): Loop | undefined {
	for (let period = 1; period <= MAX_LOOP_PERIOD; period++) {
		let repeats = 1;
		while (
			(repeats + 1) * period <= keys.length &&
			sameSpan(keys, keys.length - period, keys.length - (repeats + 1) * period, period)
		) {
			repeats += 1;
		}
		if (repeats >= minRepeats) return { period, repeats };
	}
	return undefined;
}

/** How many keys of history {@link trailingLoop} can need: older ones may be dropped. */
export function loopHistoryLength(maxRepeats: number): number {
	return MAX_LOOP_PERIOD * (maxRepeats + 1);
}

function sameSpan(keys: readonly string[], a: number, b: number, length: number): boolean {
	for (let i = 0; i < length; i++) if (keys[a + i] !== keys[b + i]) return false;
	return true;
}

/** JSON with object keys sorted, so the same input always serializes the same way. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}
