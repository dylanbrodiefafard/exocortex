import { classifyErrorLine, cleanTerminalOutput, isRoutineLine } from "@exocortex/core";
import { type Block, findBlocks } from "./blocks.ts";

export interface TrimOptions {
	readonly headLines: number;
	readonly tailLines: number;
	/** Lines kept before each error block, and at least this many after its first line. */
	readonly contextLines: number;
	/** An error's block is kept whole up to this many lines after its first; a longer one keeps its start, its end and its key lines. */
	readonly maxBlockLines: number;
	/** At most this many error blocks; the highest-ranked first, then the earliest (root causes) over the last. */
	readonly maxErrorWindows: number;
	/** Longer lines are cut (minified output, base64 blobs). */
	readonly maxLineChars: number;
	/** Failures beyond `maxErrorWindows` still show the line that names them. Default: true. */
	readonly headerLines?: boolean;
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
	/** Set on the marker that stands for a collapsed run: how many lines it replaces. */
	readonly similar?: number;
}

export interface Prepared {
	/** Cleaned lines without the routine ones, similar runs collapsed: what both tiers select from. */
	readonly lines: readonly Line[];
	/** Lines in the full output. */
	readonly totalLines: number;
	/** Routine lines hidden. */
	readonly routineLines: number;
	/** The error blocks among `lines` (indices into it), in order. */
	readonly blocks: readonly Block[];
}

export interface Trimmed {
	readonly text: string;
	readonly totalLines: number;
	/** Lines shown (excluding omission markers). */
	readonly keptLines: number;
}

/** The last lines are never hidden as routine: the final status of a run is often an "ok". */
const ROUTINE_TAIL_GUARD = 5;
/** For each failure shown whole, this many more may show the one line that names them. */
const HEADER_LINES_PER_WINDOW = 3;

/**
 * A position in a source file: `src/lib.rs:42`, `x.ts(12,5)`, `File "x.py", line 3`. Two lines
 * that differ only in such a number are two places, not one line repeated (D-083).
 */
const LOCATION = /[\w)\]-]\.[A-Za-z]\w{0,7}(:\d+|\(\d+[,)])|", line \d+/;

/**
 * Cleans the output and removes what a reader would skip: routine lines (as RTK's and tokf's
 * per-command filters do) and all but the first of a run of similar lines. Neither touches a
 * failure: the lines of a failure's block, a line the error grammar recognises and a line with a
 * source position are never hidden or collapsed (D-083).
 */
export function prepareLines(text: string, options: PrepareOptions): Prepared {
	const raw = cleanTerminalOutput(text).split("\n");
	while (raw.length > 0 && raw.at(-1)?.trim() === "") raw.pop();
	const found = findBlocks(raw);
	const inFailure = new Uint8Array(raw.length);
	for (const block of found) if (block.rank >= 3) inFailure.fill(1, block.start, block.end + 1);
	const shown: Line[] = [];
	const distinct: boolean[] = [];
	raw.forEach((line, index) => {
		const kind = classifyErrorLine(line);
		const routine =
			options.hideRoutine &&
			index < raw.length - ROUTINE_TAIL_GUARD &&
			inFailure[index] !== 1 &&
			isRoutineLine(line) &&
			kind !== "specific";
		if (routine) return;
		shown.push({ text: line, first: index + 1, last: index + 1 });
		distinct.push(inFailure[index] === 1 || kind !== undefined || LOCATION.test(line));
	});
	const lines = collapseRuns(shown, distinct, options.collapseRuns);
	return {
		lines,
		totalLines: raw.length,
		routineLines: raw.length - shown.length,
		blocks: placeBlocks(found, lines, raw.length),
	};
}

/** Blocks found in the full output, as indices into the lines left after hiding and collapsing. */
function placeBlocks(found: readonly Block[], lines: readonly Line[], rawLength: number): Block[] {
	const at = new Int32Array(rawLength).fill(-1);
	lines.forEach((line, index) => {
		at.fill(index, line.first - 1, line.last);
	});
	const placed = (raw: number) => at[raw] ?? -1;
	const blocks: Block[] = [];
	for (const block of found) {
		let start = block.start;
		let end = block.end;
		while (start <= end && placed(start) < 0) start++;
		while (end >= start && placed(end) < 0) end--;
		if (start > end) continue;
		const keys = [...new Set(block.keys.map(placed).filter((index) => index >= 0))];
		const header = placed(block.header);
		blocks.push({
			start: placed(start),
			end: placed(end),
			rank: block.rank,
			header: header < 0 ? placed(start) : header,
			keys,
		});
	}
	return blocks;
}

/**
 * Deterministic tier (brief §6.2; research R2.1): keeps the head, the tail and the error blocks,
 * verbatim, and marks what was omitted. Never paraphrases.
 *
 * Blocks are chosen by rank before position (D-083): a failing test outranks any number of lines
 * that only mention an error. A block longer than `maxBlockLines` keeps its start, its end and
 * its key lines, so a long traceback still ends in its exception.
 */
export function selectLines(prepared: Prepared, options: TrimOptions): Set<number> {
	const { lines, blocks } = prepared;
	const keep = new Set<number>();
	const add = (from: number, to: number) => {
		for (let i = Math.max(0, from); i <= Math.min(lines.length - 1, to); i++) keep.add(i);
	};
	add(0, options.headLines - 1);
	add(lines.length - options.tailLines, lines.length - 1);
	const { shown, named } = chooseBlocks(blocks, options.maxErrorWindows, options.headerLines ?? true);
	for (const block of shown) {
		add(block.start - options.contextLines, block.start + options.contextLines);
		if (block.end - block.start <= options.maxBlockLines) add(block.start, block.end);
		else {
			const fromEnd = Math.floor(options.maxBlockLines / 3);
			add(block.start, block.start + options.maxBlockLines - fromEnd);
			add(block.end - fromEnd + 1, block.end);
		}
		for (const key of block.keys) keep.add(key);
	}
	for (const block of named) keep.add(block.header);
	return keep;
}

/**
 * Up to `max` blocks, a rank at a time from the top. The rank that does not fit is split: three
 * quarters from the start (root causes), the rest from the end (summaries). Failures left out
 * are returned as `named`, to show the one line that says which test or error they were.
 */
function chooseBlocks(blocks: readonly Block[], max: number, headerLines: boolean): { shown: Block[]; named: Block[] } {
	const shown: Block[] = [];
	for (const rank of [4, 3, 2, 1] as const) {
		const tier = blocks.filter((block) => block.rank === rank);
		const room = max - shown.length;
		if (tier.length <= room) {
			shown.push(...tier);
			continue;
		}
		const [picked, left] = spread(tier, room);
		shown.push(...picked);
		const named = rank === 4 && headerLines ? spread(left, max * HEADER_LINES_PER_WINDOW)[0] : [];
		return { shown, named };
	}
	return { shown, named: [] };
}

/** `count` of the list, three quarters from its start and the rest from its end; and what is left. */
function spread<T>(list: readonly T[], count: number): [T[], T[]] {
	if (count <= 0) return [[], [...list]];
	if (list.length <= count) return [[...list], []];
	const fromStart = Math.ceil((count * 3) / 4);
	const fromEnd = list.length - (count - fromStart);
	return [[...list.slice(0, fromStart), ...list.slice(fromEnd)], list.slice(fromStart, fromEnd)];
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
		if (line.similar !== undefined) out.push(options.numbered ? similarLines(line, line.similar) : line.text);
		else if (line.text.length > options.maxLineChars) {
			out.push(`${line.text.slice(0, options.maxLineChars)}…[+${line.text.length - options.maxLineChars} chars]`);
		} else out.push(line.text);
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

/** The marker for a collapsed run, saying which lines of the full output it stands for. */
function similarLines(line: Line, count: number): string {
	const where = line.first === line.last ? `line ${line.first}` : `lines ${line.first}–${line.last}`;
	return `[… ${where}: ${count} more similar …]`;
}

/**
 * Collapses runs of lines that differ only in numbers (progress, timestamps, repeated warnings).
 * A `distinct` line is never part of a run: its number is a position or it is an error (R1).
 */
function collapseRuns(lines: readonly Line[], distinct: readonly boolean[], minRun: number): Line[] {
	const out: Line[] = [];
	let i = 0;
	while (i < lines.length) {
		const start = lines[i] as Line;
		const shape = distinct[i] ? undefined : shapeOf(start.text);
		let j = i + 1;
		while (shape !== undefined && j < lines.length && !distinct[j] && shapeOf(lines[j]?.text ?? "") === shape) j++;
		const run = j - i;
		if (run >= minRun && shape !== undefined && shape.trim() !== "") {
			out.push(start, {
				text: `[… ${run - 1} more similar line${run - 1 === 1 ? "" : "s"} …]`,
				first: start.last + 1,
				last: (lines[j - 1] as Line).last,
				similar: run - 1,
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
