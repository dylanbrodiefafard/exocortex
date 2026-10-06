import { createHash } from "node:crypto";
import { classifyErrorLine, cleanTerminalOutput } from "./output.ts";
import type { ToolOutcome } from "./types.ts";

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

/** Error lines read for a failure's identity: a longer failure is known by its first ones. */
const MAX_FAILURE_LINES = 400;
/** Without a recognizable error line, the end of the output stands for the failure. */
const FALLBACK_LINES = 40;
/** What moves when a file is edited above the error, or between two runs of the same thing. */
const POSITIONS: readonly [RegExp, string][] = [
	[/(?<=[A-Za-z_)\]]):\d+(:\d+)?\b/g, ":<n>"],
	[/\bline \d+\b/g, "line <n>"],
	[/^(thread '.*') \(\d+\)/, "$1"],
];

/**
 * The errors a failing output reports (D-073): its error lines, sorted, without what changes when
 * nothing was fixed (line and column numbers, durations, addresses, thread ids). Names and values
 * stay, and so do duplicates: one failing test fewer, a different message or one of two identical
 * errors gone is a different list. Toolchain-specific error lines are used when there are any.
 */
export function failureLines(output: string): string[] {
	const lines = cleanTerminalOutput(output).split("\n");
	const kinds = lines.map((line) => classifyErrorLine(line) ?? classifyErrorLine(line.trim()));
	const wanted = kinds.includes("specific") ? "specific" : kinds.includes("generic") ? "generic" : undefined;
	const errors = wanted
		? lines.filter((_, index) => kinds[index] === wanted).slice(0, MAX_FAILURE_LINES)
		: lines.filter((line) => line.trim() !== "").slice(-FALLBACK_LINES);
	return errors
		.map((line) => [...POSITIONS, ...VOLATILE].reduce((text, [pattern, to]) => text.replace(pattern, to), line.trim()))
		.sort();
}

/**
 * Identifies what a failing call reported, whatever was run to get it. Two failures share a key
 * only when they report the same errors ({@link failureLines}), so a repeat means the changes
 * made in between did not move the failure, and a failure with fewer or other errors is a new
 * one. A failure that printed nothing is known by its call.
 */
export function failureKey(tool: Pick<ToolOutcome, "toolName" | "input" | "output">): string {
	const lines = failureLines(tool.output);
	return createHash("sha256")
		.update(`${tool.toolName}\n${lines.length > 0 ? lines.join("\n") : canonical(tool.input)}`)
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
