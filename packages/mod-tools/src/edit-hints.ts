import { readFileSync } from "node:fs";
import type { JsonValue } from "@exocortex/core";
import { nearestPaths, resolveToolPath, shownPath } from "./paths.ts";

/** Lines shown around the closest match, before and after. */
const CONTEXT_LINES = 2;
/** A window must match at least this well, line by line, to be shown as what was meant. */
const MIN_SIMILARITY = 0.5;
/** Larger files are searched only from lines that match exactly. */
const MAX_SCANNED_LINES = 5_000;
/** Lines of `oldText` compared; a longer one is placed by its start. */
const MAX_COMPARED_LINES = 40;
const MAX_OCCURRENCES_SHOWN = 5;
const MAX_LINE_CHARS = 240;
const MAX_SUGGESTED_PATHS = 5;

/** What went wrong with an edit, read from pi's error message (`edit-diff.js:184-204`, `edit.js:112`). */
type Failure =
	| { readonly kind: "not_found"; readonly index: number }
	| { readonly kind: "duplicate"; readonly index: number }
	| { readonly kind: "unchanged" }
	| { readonly kind: "missing_file" };

/** Reads which edit failed and how. Undefined for messages this module does not know. */
function failureOf(message: string): Failure | undefined {
	const notFound = /^Could not find (?:the exact text|edits\[(\d+)\]) in /m.exec(message);
	if (notFound) return { kind: "not_found", index: Number(notFound[1] ?? 0) };
	const duplicate = /^Found \d+ occurrences of (?:the text|edits\[(\d+)\]) in /m.exec(message);
	if (duplicate) return { kind: "duplicate", index: Number(duplicate[1] ?? 0) };
	if (/^No changes made to /m.test(message)) return { kind: "unchanged" };
	if (/^(?:Could not edit file: .*Error code: ENOENT|ENOENT: no such file)/m.test(message)) {
		return { kind: "missing_file" };
	}
	return undefined;
}

interface Replacement {
	readonly oldText: string;
	readonly newText: string;
}

/** The edits as pi reads them: an `edits` array (or one as a JSON string or a single object), or legacy `oldText`/`newText`. */
function replacementsOf(input: { readonly [key: string]: JsonValue }): Replacement[] {
	let edits: unknown = input["edits"];
	if (typeof edits === "string") {
		try {
			edits = JSON.parse(edits);
		} catch {
			edits = undefined;
		}
	}
	const list = Array.isArray(edits) ? [...edits] : isReplacement(edits) ? [edits] : [];
	const legacy = { oldText: input["oldText"], newText: input["newText"] };
	if (isReplacement(legacy)) list.push(legacy);
	return list.filter(isReplacement);
}

function isReplacement(value: unknown): value is Replacement {
	if (typeof value !== "object" || value === null) return false;
	const { oldText, newText } = value as Record<string, unknown>;
	return typeof oldText === "string" && typeof newText === "string";
}

/**
 * The hint for a failed edit or read, or undefined when there is nothing precise to say. Every
 * line it quotes is read from the file as it is now (D-094).
 */
export function editHint(
	toolName: string,
	input: { readonly [key: string]: JsonValue },
	message: string,
	cwd: string,
): string | undefined {
	const path = input["path"];
	if (typeof path !== "string" || path === "") return undefined;
	const failure = failureOf(message);
	if (!failure) return undefined;
	const absolute = resolveToolPath(path, cwd);
	if (failure.kind === "missing_file") return missingFileHint(absolute, cwd);
	if (toolName !== "edit") return undefined;
	let content: string;
	try {
		content = normalizeToLF(stripBom(readFileSync(absolute, "utf8")));
	} catch {
		return undefined;
	}
	const shown = shownPath(absolute, cwd);
	const edits = replacementsOf(input);
	if (failure.kind === "unchanged") return unchangedHint(edits);
	const edit = edits[failure.index];
	if (!edit) return undefined;
	const label = edits.length > 1 ? `edits[${failure.index}].oldText` : "oldText";
	return failure.kind === "duplicate"
		? duplicateHint(edit, content, shown, label)
		: notFoundHint(edit, content, shown, label);
}

function missingFileHint(absolute: string, cwd: string): string | undefined {
	const near = nearestPaths(absolute, cwd, MAX_SUGGESTED_PATHS);
	if (near.length === 0) return undefined;
	return `${shownPath(absolute, cwd)} does not exist. Existing files with a similar path:\n${near.map((p) => `- ${p}`).join("\n")}`;
}

function unchangedHint(edits: readonly Replacement[]): string | undefined {
	const same = edits.findIndex((e) => e.oldText === e.newText);
	if (same !== -1) return `${edits.length > 1 ? `edits[${same}]` : "The edit"} has the same oldText and newText.`;
	return undefined;
}

function duplicateHint(edit: Replacement, content: string, shown: string, label: string): string | undefined {
	const lines = content.split("\n");
	const starts = occurrenceLines(content, edit.oldText);
	if (starts.length < 2) return undefined;
	const listed = starts.slice(0, MAX_OCCURRENCES_SHOWN).map((start) => {
		const from = Math.max(0, start - 1);
		const to = Math.min(lines.length, start + lineCount(edit.oldText) + 1);
		return `Lines ${from + 1}-${to} of ${shown}:\n${quote(lines.slice(from, to))}`;
	});
	const more = starts.length > MAX_OCCURRENCES_SHOWN ? `\n(${starts.length - MAX_OCCURRENCES_SHOWN} more)` : "";
	return `${label} matches ${starts.length} places, starting at lines ${starts.map((s) => s + 1).join(", ")}. Include a neighbouring line that differs, so it matches one place:\n\n${listed.join("\n\n")}${more}`;
}

function notFoundHint(edit: Replacement, content: string, shown: string, label: string): string | undefined {
	const lines = content.split("\n");
	// The change is already there: an edit made twice.
	if (edit.newText.trim() !== "") {
		const at = occurrenceLines(content, edit.newText);
		if (at.length === 1 && at[0] !== undefined) {
			const start = at[0];
			return `newText is already in ${shown} at line ${start + 1}: this change may have been made already. Lines ${start + 1}-${start + lineCount(edit.newText)}:\n${quote(lines.slice(start, start + lineCount(edit.newText)))}`;
		}
	}
	// Line numbers copied from a numbered read.
	const unnumbered = withoutLineNumbers(edit.oldText);
	if (unnumbered !== undefined) {
		const at = occurrenceLines(content, unnumbered);
		const found = at.length === 1 && at[0] !== undefined ? ` Without them it matches line ${at[0] + 1}.` : "";
		return `${label} starts its lines with line numbers, which are not part of the file.${found} Leave the numbers out.`;
	}
	const match = closestWindow(lines, edit.oldText.split("\n"));
	if (!match) return undefined;
	const from = Math.max(0, match.start - CONTEXT_LINES);
	const to = Math.min(lines.length, match.start + match.length + CONTEXT_LINES);
	const what = match.whitespaceOnly
		? `${label} matches lines ${match.start + 1}-${match.start + match.length} of ${shown} except for indentation or spacing`
		: `The closest text to ${label} in ${shown} is at lines ${match.start + 1}-${match.start + match.length}`;
	return `${what}. Lines ${from + 1}-${to} as they are now, verbatim:\n${quote(lines.slice(from, to))}`;
}

/** 0-based line numbers where `text` starts, matched as pi matches it (exact, else normalized). */
function occurrenceLines(content: string, text: string): number[] {
	if (text === "") return [];
	const exact = indicesOf(content, text);
	const [haystack, needle, indices] =
		exact.length > 0
			? [content, text, exact]
			: [
					normalizeLoosely(content),
					normalizeLoosely(text),
					indicesOf(normalizeLoosely(content), normalizeLoosely(text)),
				];
	if (needle === "") return [];
	return indices.map((index) => lineAt(haystack, index));
}

function indicesOf(haystack: string, needle: string): number[] {
	const found: number[] = [];
	let at = haystack.indexOf(needle);
	while (at !== -1) {
		found.push(at);
		at = haystack.indexOf(needle, at + Math.max(1, needle.length));
	}
	return found;
}

function lineAt(text: string, index: number): number {
	let line = 0;
	for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line += 1;
	return line;
}

function lineCount(text: string): number {
	return text.split("\n").length;
}

/** `oldText` with a `cat -n` or `12:`/`12|` prefix on every non-empty line, without it; else undefined. */
export function withoutLineNumbers(text: string): string | undefined {
	const lines = text.split("\n");
	const numbered = /^\s*\d+(?:\t|[:|│] ?)/;
	const nonEmpty = lines.filter((line) => line.trim() !== "");
	if (nonEmpty.length === 0 || !nonEmpty.every((line) => numbered.test(line))) return undefined;
	return lines.map((line) => line.replace(numbered, "")).join("\n");
}

interface Window {
	readonly start: number;
	readonly length: number;
	/** The lines are the same once leading and trailing spaces are ignored. */
	readonly whitespaceOnly: boolean;
}

/**
 * The run of file lines most like `wanted`, compared line by line on trimmed text (equal lines
 * score 1, others by shared character pairs). Candidates start where some wanted line appears
 * exactly; with none, a file small enough is scanned at every line.
 */
export function closestWindow(fileLines: readonly string[], wantedLines: readonly string[]): Window | undefined {
	const wanted = trimBlankEnds(wantedLines).slice(0, MAX_COMPARED_LINES);
	const trimmedWanted = wanted.map((line) => line.trim());
	if (trimmedWanted.every((line) => line === "")) return undefined;
	const trimmedFile = fileLines.map((line) => line.trim());
	const starts = new Set<number>();
	trimmedWanted.forEach((line, offset) => {
		if (line.length < 4) return;
		trimmedFile.forEach((fileLine, index) => {
			if (fileLine === line && index - offset >= 0) starts.add(index - offset);
		});
	});
	if (starts.size === 0 && fileLines.length <= MAX_SCANNED_LINES) {
		for (let i = 0; i < fileLines.length; i++) starts.add(i);
	}
	let best: { start: number; score: number } | undefined;
	for (const start of starts) {
		let score = 0;
		for (let k = 0; k < trimmedWanted.length; k++) {
			score += similarity(trimmedFile[start + k] ?? "", trimmedWanted[k] ?? "");
		}
		score /= trimmedWanted.length;
		if (!best || score > best.score) best = { start, score };
	}
	if (!best || best.score < MIN_SIMILARITY) return undefined;
	const length = Math.min(wanted.length, fileLines.length - best.start);
	return { start: best.start, length, whitespaceOnly: best.score === 1 };
}

function trimBlankEnds(lines: readonly string[]): string[] {
	let from = 0;
	let to = lines.length;
	while (from < to && lines[from]?.trim() === "") from++;
	while (to > from && lines[to - 1]?.trim() === "") to--;
	return lines.slice(from, to);
}

/** Dice coefficient over character pairs: 1 for equal strings, 0 for nothing shared. */
export function similarity(a: string, b: string): number {
	if (a === b) return 1;
	if (a.length < 2 || b.length < 2) return 0;
	const pairs = new Map<string, number>();
	for (let i = 0; i < a.length - 1; i++) {
		const pair = a.slice(i, i + 2);
		pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
	}
	let shared = 0;
	for (let i = 0; i < b.length - 1; i++) {
		const pair = b.slice(i, i + 2);
		const count = pairs.get(pair) ?? 0;
		if (count > 0) {
			pairs.set(pair, count - 1);
			shared += 1;
		}
	}
	return (2 * shared) / (a.length - 1 + (b.length - 1));
}

/** Lines quoted as they are, each cut to a readable length. */
function quote(lines: readonly string[]): string {
	return lines.map((line) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line)).join("\n");
}

function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function normalizeToLF(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

/** Pi's fuzzy normalization (`edit-diff.js:31-50`): what pi matched on when the exact text was not there. */
function normalizeLoosely(text: string): string {
	return text
		.normalize("NFKC")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/[‘’‚‛]/g, "'")
		.replace(/[“”„‟]/g, '"')
		.replace(/[‐‑‒–—―−]/g, "-")
		.replace(/[  -   　]/g, " ");
}
