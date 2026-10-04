import { classifyErrorLine, cleanTerminalOutput } from "@exocortex/core";

export interface TrimOptions {
	readonly headLines: number;
	readonly tailLines: number;
	/** Lines kept around each error line. */
	readonly contextLines: number;
	/** At most this many error windows; the earliest (root causes) are favored over the last. */
	readonly maxErrorWindows: number;
	/** Runs of at least this many similar lines collapse to one line plus a count. */
	readonly collapseRuns: number;
	/** Longer lines are cut (minified output, base64 blobs). */
	readonly maxLineChars: number;
}

export interface Trimmed {
	readonly text: string;
	/** Lines in the cleaned output, before selection. */
	readonly totalLines: number;
	/** Lines shown (excluding omission markers). */
	readonly keptLines: number;
}

/** Cleaned, collapsed lines: the unit both trimming tiers select from. */
export function prepareLines(text: string, options: Pick<TrimOptions, "collapseRuns">): string[] {
	const lines = cleanTerminalOutput(text).split("\n");
	while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
	return collapseRuns(lines, options.collapseRuns);
}

/**
 * Deterministic tier (brief §6.2; research R2.1): keeps the head, the tail and every error line
 * with context, verbatim, and marks what was omitted. Never paraphrases.
 */
export function trimLines(lines: readonly string[], options: TrimOptions): Trimmed {
	const keep = new Set<number>();
	const add = (from: number, to: number) => {
		for (let i = Math.max(0, from); i <= Math.min(lines.length - 1, to); i++) keep.add(i);
	};
	add(0, options.headLines - 1);
	add(lines.length - options.tailLines, lines.length - 1);
	for (const index of errorWindows(lines, options.maxErrorWindows)) {
		add(index - options.contextLines, index + options.contextLines);
	}
	return renderSelection(lines, keep, options.maxLineChars);
}

/** Renders the kept lines in order, with one marker per omitted gap. */
export function renderSelection(lines: readonly string[], keep: ReadonlySet<number>, maxLineChars: number): Trimmed {
	const out: string[] = [];
	let gap = 0;
	const flushGap = () => {
		if (gap > 0) out.push(`[… ${gap} line${gap === 1 ? "" : "s"} omitted …]`);
		gap = 0;
	};
	lines.forEach((line, index) => {
		if (!keep.has(index)) {
			gap += 1;
			return;
		}
		flushGap();
		out.push(
			line.length > maxLineChars ? `${line.slice(0, maxLineChars)}…[+${line.length - maxLineChars} chars]` : line,
		);
	});
	flushGap();
	return { text: out.join("\n"), totalLines: lines.length, keptLines: keep.size };
}

/** Error line indices, capped: three quarters from the start (root causes), the rest from the end (summaries). */
function errorWindows(lines: readonly string[], max: number): number[] {
	const specific: number[] = [];
	const generic: number[] = [];
	lines.forEach((line, index) => {
		const kind = classifyErrorLine(line);
		if (kind === "specific") specific.push(index);
		else if (kind === "generic") generic.push(index);
	});
	const all = specific.length >= max ? specific : [...specific, ...generic].sort((a, b) => a - b);
	if (all.length <= max) return all;
	const fromStart = Math.ceil((max * 3) / 4);
	return [...all.slice(0, fromStart), ...all.slice(all.length - (max - fromStart))];
}

/** Collapses runs of lines that differ only in numbers (progress, timestamps, repeated warnings). */
function collapseRuns(lines: readonly string[], minRun: number): string[] {
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const shape = shapeOf(lines[i] ?? "");
		let j = i + 1;
		while (j < lines.length && shapeOf(lines[j] ?? "") === shape) j++;
		const run = j - i;
		if (run >= minRun && shape.trim() !== "") {
			out.push(lines[i] ?? "", `[… ${run - 1} more similar line${run - 1 === 1 ? "" : "s"} …]`);
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
