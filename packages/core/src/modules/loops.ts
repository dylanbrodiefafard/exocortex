import { createHash } from "node:crypto";
import { cleanTerminalOutput, lineVerdicts } from "./output.ts";
import type { ToolOutcome } from "./types.ts";

/**
 * Deterministic detection of an agent going round in circles (D-069): the same tool call with the
 * same result, or a short cycle of such calls, repeated. One definition serves triage's notices
 * and the eval's stuck-loop metric.
 */

/** The longest cycle looked for: `edit, test, revert, test` is 4. */
export const MAX_LOOP_PERIOD = 5;

type Rule = readonly [RegExp, string];

const DATE = String.raw`\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?`;
const TIME = String.raw`\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?`;
const DURATION = String.raw`\d+(?:\.\d+)?\s?(?:ns|µs|us|ms|s|sec|secs|seconds?|m|min|mins|minutes?)`;

/**
 * What names one run and not the thing run: temporary directories, generated ids, the port the
 * system picked, addresses. These differ between two runs of the same thing wherever they stand,
 * inside a quoted value too (`No such file: '/tmp/pytest-of-u/pytest-12/a.txt'`).
 */
const RUN_IDS: readonly Rule[] = [
	[/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>"],
	[/(?<![\w.-])(?:\/private)?(?:\/var\/folders\/[^\s/]+\/[^\s/]+\/T|\/var\/tmp|\/tmp)\/[^\s:'"`,;)\]]+/g, "<tmp>"],
	[/\b(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[::1?\]):\d{2,5}\b/g, "$1:<port>"],
	[/\b0x[0-9a-f]+\b/gi, "<hex>"],
];

/**
 * When a run happened and how long it took, wherever it is printed. A clock time is not the
 * `12:34` of `a.c:12:34`, which is a place in a file.
 */
const CLOCK: readonly Rule[] = [
	[new RegExp(String.raw`\b${DATE}\b`, "g"), "<date>"],
	[new RegExp(String.raw`(?<![\w.)\]]:)(?<![:\d])\b${TIME}\b(?!:\d)`, "g"), "<time>"],
	[new RegExp(String.raw`\b${DURATION}\b`, "g"), "<duration>"],
];

/**
 * The same, only where a toolchain prints them and never where a test's values stand
 * (`Easter(1981) = 1981-04-26, want 1981-04-19`, `expected 5 ms, got 6 ms`): a timestamp that
 * starts the line or sits in brackets, and a duration in parentheses, after `in`/`took`/`time`,
 * or closing Go's and CTest's result lines.
 */
const SUMMARY_CLOCK: readonly Rule[] = [
	[new RegExp(String.raw`^\[?(?:${DATE}|${TIME})\]?(?=\s|$)`), "<time>"],
	[new RegExp(String.raw`([[(])(?:${DATE}|${TIME})([\])])`, "g"), "$1<time>$2"],
	[new RegExp(String.raw`\((?:${DURATION})( total)?\)`, "g"), "(<duration>$1)"],
	[new RegExp(String.raw`\b(in|took|elapsed|duration|time):?(\s+)${DURATION}(?![\w.])`, "gi"), "$1$2<duration>"],
	[new RegExp(String.raw`^((?:ok|FAIL)\s+\S+\s+)${DURATION}$`), "$1<duration>"],
	[new RegExp(String.raw`((?:Passed|Failed|Exception|Timeout|Not Run)\s+)${DURATION}$`), "$1<duration>"],
];

/** A quoted value on one line: what is inside is what the program said, not when it said it. */
const QUOTED = /(["'`])(?:(?!\1).)*\1/g;

function apply(rules: readonly Rule[], text: string): string {
	return rules.reduce((result, [pattern, to]) => result.replace(pattern, to), text);
}

/** Applies `rules` to the text outside quotes; quoted values are kept as they are. */
function outsideQuotes(rules: readonly Rule[], text: string): string {
	let result = "";
	let from = 0;
	for (const match of text.matchAll(QUOTED)) {
		result += apply(rules, text.slice(from, match.index)) + match[0];
		from = match.index + match[0].length;
	}
	return result + apply(rules, text.slice(from));
}

/**
 * Identifies one tool call together with what it returned. Two calls share a key only when the
 * tool, its exact input and its output are the same, so a repeat means nothing changed. Counts
 * and positions are kept: "3 failed" and "2 failed", `a.c:12:34` and `a.c:13:35` are different
 * results. Times, durations and dates outside quotes, temporary paths, ports and addresses are not.
 */
export function callKey(toolName: string, input: unknown, output: string): string {
	const result = outsideQuotes(CLOCK, apply(RUN_IDS, cleanTerminalOutput(output)));
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
const POSITIONS: readonly Rule[] = [
	[/(?<=[A-Za-z_)\]]):\d+(:\d+)?\b/g, ":<n>"],
	[/\(\d+,\d+\)/g, "(<n>)"],
	[/\bline \d+\b/g, "line <n>"],
	[/^(thread '.*') \(\d+\)/, "$1"],
];
/** rustc reports where an error is on the line after it: `  --> src/lib.rs:42:9`. */
const RUSTC_ERROR = /^(error|warning)(\[\w+\])?: /;
const RUSTC_PLACE = /^\s*--> (.+?)(:\d+)*$/;
/** How far under a rustc error its place is looked for. */
const RUSTC_PLACE_WITHIN = 3;

/**
 * The errors a failing output reports (D-073): its error lines, sorted, without what changes when
 * nothing was fixed (line and column numbers, run times, temporary paths, ports, addresses,
 * thread ids). Names and values stay, and so do duplicates: one failing test fewer, a different
 * message, another value in the same assertion or one of two identical errors gone is a different
 * list. A rustc error carries the file it points at, so the same error in another file is another
 * error (D-077). Lines a toolchain prints for a failure are used when there are any.
 */
export function failureLines(output: string): string[] {
	const lines = cleanTerminalOutput(output).split("\n");
	const kinds = lineVerdicts(lines).map((verdict) => (verdict === "mention" ? "generic" : verdict && "specific"));
	const wanted = kinds.includes("specific") ? "specific" : kinds.includes("generic") ? "generic" : undefined;
	const errors = wanted
		? lines.flatMap((_, index) => (kinds[index] === wanted ? [withPlace(lines, index)] : []))
		: lines.filter((line) => line.trim() !== "").slice(-FALLBACK_LINES);
	return errors
		.slice(0, MAX_FAILURE_LINES)
		.map((line) => outsideQuotes(SUMMARY_CLOCK, apply(POSITIONS, apply(RUN_IDS, line.trim()))))
		.sort();
}

/** The line, and for a rustc error the file named under it. */
function withPlace(lines: readonly string[], index: number): string {
	const line = lines[index] ?? "";
	if (!RUSTC_ERROR.test(line)) return line;
	for (const below of lines.slice(index + 1, index + 1 + RUSTC_PLACE_WITHIN)) {
		const place = RUSTC_PLACE.exec(below);
		if (place) return `${line} --> ${place[1]}`;
		if (RUSTC_ERROR.test(below)) break;
	}
	return line;
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
