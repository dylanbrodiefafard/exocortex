import { classifyErrorLine, cleanTerminalOutput, isRoutineLine } from "@exocortex/core";

export interface TrimOptions {
	readonly headLines: number;
	readonly tailLines: number;
	/** Lines kept before each error line, and at least this many after it. */
	readonly contextLines: number;
	/** An error's block (the indented or continuing lines under it) is kept up to this many lines. */
	readonly maxBlockLines: number;
	/** At most this many error windows; the earliest (root causes) are favored over the last. */
	readonly maxErrorWindows: number;
	/** Longer lines are cut (minified output, base64 blobs). */
	readonly maxLineChars: number;
}

export interface PrepareOptions {
	/** Runs of at least this many similar lines collapse to one line plus a count. */
	readonly collapseRuns: number;
	/** Hide routine lines (passing tests, compile progress) before anything else. */
	readonly hideRoutine: boolean;
}

/** A line of output the trimmer may show, with where it sits in the full output (1-based, inclusive). */
export interface Line {
	readonly text: string;
	readonly first: number;
	/** Differs from `first` only for the marker that stands for a collapsed run. */
	readonly last: number;
}

export interface Prepared {
	/** Cleaned lines without the routine ones, similar runs collapsed: what both tiers select from. */
	readonly lines: readonly Line[];
	/** Lines in the full output. */
	readonly totalLines: number;
	/** Routine lines hidden. */
	readonly routineLines: number;
}

export interface Trimmed {
	readonly text: string;
	readonly totalLines: number;
	/** Lines shown (excluding omission markers). */
	readonly keptLines: number;
}

/** The last lines are never hidden as routine: the final status of a run is often an "ok". */
const ROUTINE_TAIL_GUARD = 5;

/**
 * Cleans the output and removes what a reader would skip: routine lines (as RTK's and tokf's
 * per-command filters do) and all but the first of a run of similar lines.
 */
export function prepareLines(text: string, options: PrepareOptions): Prepared {
	const raw = cleanTerminalOutput(text).split("\n");
	while (raw.length > 0 && raw.at(-1)?.trim() === "") raw.pop();
	const lines: Line[] = [];
	raw.forEach((line, index) => {
		const routine =
			options.hideRoutine &&
			index < raw.length - ROUTINE_TAIL_GUARD &&
			isRoutineLine(line) &&
			classifyErrorLine(line) !== "specific";
		if (!routine) lines.push({ text: line, first: index + 1, last: index + 1 });
	});
	return {
		lines: collapseRuns(lines, options.collapseRuns),
		totalLines: raw.length,
		routineLines: raw.length - lines.length,
	};
}

/**
 * Deterministic tier (brief §6.2; research R2.1): keeps the head, the tail and every error with
 * its block, verbatim, and marks what was omitted. Never paraphrases.
 */
export function selectLines(lines: readonly Line[], options: TrimOptions): Set<number> {
	const keep = new Set<number>();
	const add = (from: number, to: number) => {
		for (let i = Math.max(0, from); i <= Math.min(lines.length - 1, to); i++) keep.add(i);
	};
	add(0, options.headLines - 1);
	add(lines.length - options.tailLines, lines.length - 1);
	for (const index of errorWindows(lines, options.maxErrorWindows)) {
		add(index - options.contextLines, blockEnd(lines, index, options));
	}
	return keep;
}

/** Every prepared line: what is shown when hiding routine lines was enough. */
export function allLines(lines: readonly Line[]): Set<number> {
	return new Set(lines.keys());
}

/**
 * Renders the kept lines in order, with one marker per gap. With `numbered`, markers give the
 * omitted line numbers in the full output, so the agent can read exactly that range.
 */
export function renderSelection(
	prepared: Prepared,
	keep: ReadonlySet<number>,
	options: { readonly maxLineChars: number; readonly numbered: boolean },
): Trimmed {
	const out: string[] = [];
	let next = 1;
	const gap = (upTo: number) => {
		if (upTo >= next) out.push(omission(next, upTo, options.numbered));
	};
	prepared.lines.forEach((line, index) => {
		if (!keep.has(index)) return;
		gap(line.first - 1);
		out.push(
			line.text.length > options.maxLineChars
				? `${line.text.slice(0, options.maxLineChars)}…[+${line.text.length - options.maxLineChars} chars]`
				: line.text,
		);
		next = line.last + 1;
	});
	gap(prepared.totalLines);
	return { text: out.join("\n"), totalLines: prepared.totalLines, keptLines: keep.size };
}

function omission(first: number, last: number, numbered: boolean): string {
	const count = last - first + 1;
	if (!numbered) return `[… ${count} line${count === 1 ? "" : "s"} omitted …]`;
	return count === 1 ? `[… line ${first} omitted …]` : `[… lines ${first}–${last} omitted …]`;
}

/** Lines that continue the diagnostic above them even though they are not indented. */
const BLOCK_CONTINUATION =
	/^(Traceback \(most recent call last\):|[-=]{5,}$|E {3}|\S+:\d+(:\d+)?: note: |\S+: In (function|member function|instantiation|constructor|destructor|lambda) |In file included from )/;

/**
 * The last line of the block an error line opens: the indented or continuing lines under it
 * (a rustc snippet, a traceback, gcc's notes, TAP diagnostics), as RTK's block filters keep a
 * failure whole. At least `contextLines` after the error, at most `maxBlockLines`.
 */
function blockEnd(lines: readonly Line[], index: number, options: TrimOptions): number {
	const limit = Math.min(lines.length - 1, index + options.maxBlockLines);
	let end = index;
	while (end < limit) {
		const text = lines[end + 1]?.text ?? "";
		if (text.trim() === "" || !(/^\s/.test(text) || BLOCK_CONTINUATION.test(text))) break;
		end++;
	}
	return Math.max(end, Math.min(lines.length - 1, index + options.contextLines));
}

/** Error line indices, capped: three quarters from the start (root causes), the rest from the end (summaries). */
function errorWindows(lines: readonly Line[], max: number): number[] {
	const specific: number[] = [];
	const generic: number[] = [];
	lines.forEach((line, index) => {
		const kind = classifyErrorLine(line.text);
		if (kind === "specific") specific.push(index);
		else if (kind === "generic") generic.push(index);
	});
	const all = specific.length >= max ? specific : [...specific, ...generic].sort((a, b) => a - b);
	if (all.length <= max) return all;
	const fromStart = Math.ceil((max * 3) / 4);
	return [...all.slice(0, fromStart), ...all.slice(all.length - (max - fromStart))];
}

/** Collapses runs of lines that differ only in numbers (progress, timestamps, repeated warnings). */
function collapseRuns(lines: readonly Line[], minRun: number): Line[] {
	const out: Line[] = [];
	let i = 0;
	while (i < lines.length) {
		const start = lines[i] as Line;
		const shape = shapeOf(start.text);
		let j = i + 1;
		while (j < lines.length && shapeOf(lines[j]?.text ?? "") === shape) j++;
		const run = j - i;
		if (run >= minRun && shape.trim() !== "") {
			out.push(start, {
				text: `[… ${run - 1} more similar line${run - 1 === 1 ? "" : "s"} …]`,
				first: start.last + 1,
				last: (lines[j - 1] as Line).last,
			});
		} else {
			out.push(...lines.slice(i, j));
		}
		i = j;
	}
	return out;
}

function shapeOf(line: string): string {
	return line.replace(/\d+(\.\d+)?/g, "N");
}
