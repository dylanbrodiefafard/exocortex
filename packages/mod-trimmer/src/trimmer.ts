import { chmodSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExoModule, ModuleContext, ToolResultDraft } from "@exocortex/core";
import { printsRequestedContent } from "./command.ts";
import { NEVER_TRIMMED, parseSettings, type TrimmerSettings } from "./settings.ts";
import { allLines, type Prepared, prepareLines, renderSelection, selectLines, type TrimOptions } from "./trim.ts";

export const TRIMMER_ID = "trimmer";

/** The budget cuts below this many error blocks only after everything else: the first errors are the root causes. */
const MIN_ERROR_WINDOWS = 4;
/** The budget cuts the tail below this only after everything else: a run's result is in its last lines. */
const MIN_TAIL_LINES = 5;
/** Lines (not a failure's own) are cut to this before the last blocks and the tail are given up, and to the second as the last resort. */
const MIN_LINE_CHARS = 80;
const LAST_RESORT_LINE_CHARS = 20;
/** Saved outputs of sessions untouched for this long are removed when a trimmer starts (D-110). */
const SAVED_OUTPUT_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** What gets trimmed: the harness's saved full output when it can be read, else the result text. */
interface Source {
	readonly text: string;
	/** Added back after the trimmed text: the exit status, which the saved file does not hold. */
	readonly status: string;
	/** The text is the whole output, read from the harness's saved file: the start pi cut is in it. */
	readonly full: boolean;
}

/** Which lines to show, and how long a line may be: the budget may have lowered `maxLineChars`. */
interface Choice {
	readonly keep: ReadonlySet<number>;
	readonly maxLineChars: number;
	readonly how: string;
}

/** Save directories already pruned by this process. */
const pruned = new Set<string>();

/**
 * Shortens long tool outputs before the main model sees them (brief §6.2, D-029: a rewrite of new
 * content, so the prompt cache is untouched). Deterministic and verbatim: routine lines go first;
 * then head, tail and whole error blocks. The full output is always one read away, and markers
 * say which lines to read. The result is never longer than `maxChars` (D-083).
 *
 * It acts only where that clearly helps (D-110): when pi cut the output to its end, so the start
 * is recovered from pi's saved file; or when the output is very long and reads as a log. Output
 * the agent asked for, or that is not a log, is left alone.
 */
export function createTrimmer(raw: Readonly<Record<string, unknown>>, ctx: ModuleContext): ExoModule {
	const { settings, problems } = parseSettings(raw);
	for (const problem of problems) ctx.log(problem);
	const saveDir = sessionSaveDir(settings, ctx.sessionId);
	pruneOldSaveDirs(dirname(saveDir), saveDir, ctx);
	let trimmed = 0;
	let charsSaved = 0;

	return {
		id: TRIMMER_ID,

		async rewriteToolResult(draft, signal) {
			if (!mayTrim(draft, settings)) return undefined;
			const source = await sourceOf(draft, settings, ctx, signal);
			const prepared = prepareLines(source.text, settings);
			if (!source.full && (source.text.length <= settings.minChars || !looksLikeLog(draft, prepared))) {
				return undefined;
			}
			const savePath =
				draft.fullOutputPath ?? join(saveDir, `${draft.toolCallId.replace(/[^\w.-]/g, "_") || "output"}.log`);
			// What the status line and the footer take is not the output's to use.
			const around =
				source.status.length + footer(prepared.totalLines, prepared.totalLines, 0, savePath, true).length + 3;
			const budget = Math.max(0, settings.maxChars - around);
			const choice = choose(prepared, settings, budget);
			const render = (numbered: boolean) =>
				renderSelection(prepared, choice.keep, { maxLineChars: choice.maxLineChars, numbered });
			// Not shorter is no help, unless it shows the start pi cut.
			if (!source.full && render(true).text.length + source.status.length >= draft.current.length) return undefined;
			const path = draft.fullOutputPath ?? saveFullOutput(savePath, saveDir, draft, ctx);
			// Line numbers are the saved file's only when the text trimmed is that file.
			const numbered = path !== undefined && (source.full || draft.fullOutputPath === null);
			const result = render(numbered);
			const text = [
				result.text,
				...(source.status ? ["", source.status] : []),
				footer(result.keptLines, result.totalLines, prepared.routineLines, path, numbered),
			].join("\n");
			trimmed += 1;
			charsSaved += draft.current.length - text.length;
			return {
				// Only a `maxChars` smaller than the status and the footer themselves could need this.
				text: text.slice(0, settings.maxChars),
				note: `trimmed ${result.totalLines}→${result.keptLines} lines (${choice.how})`,
				...(path ? { details: { fullOutputPath: path } } : {}),
			};
		},

		status() {
			if (trimmed === 0) return TRIMMER_ID;
			const sign = charsSaved >= 0 ? "−" : "+";
			return `${TRIMMER_ID} (${trimmed} trimmed, ${sign}${Math.round(Math.abs(charsSaved) / 1000)}k chars)`;
		},
	};
}

/** Everything that is not routine when that fits; else head, tail and errors, shrunk to the budget. */
function choose(prepared: Prepared, settings: TrimmerSettings, budget: number): Choice {
	const fits = (keep: ReadonlySet<number>, maxLineChars: number) =>
		renderSelection(prepared, keep, { maxLineChars, numbered: true }).text.length <= budget;
	const all = allLines(prepared.lines);
	// The markers for hidden lines count too: one per gap can outweigh the lines between them.
	if (fits(all, settings.maxLineChars)) {
		const how = prepared.routineLines > 0 ? "routine lines hidden" : "all lines";
		return { keep: all, maxLineChars: settings.maxLineChars, how };
	}
	return { ...selectToBudget(prepared, settings, fits), how: "head/tail/errors" };
}

/**
 * A log is what the trimmer is for (D-110): a run that failed, or output with errors or routine
 * lines (passing tests, compile progress) in it. Program output or data the agent asked a script
 * for is none of these, and is left as it is.
 */
function looksLikeLog(draft: ToolResultDraft, prepared: Prepared): boolean {
	if (draft.isError || (draft.exitCode !== null && draft.exitCode !== 0)) return true;
	return prepared.routineLines > 0 || prepared.blocks.length > 0;
}

/** A tool it may trim, output the agent did not ask for, and either cut by pi or long enough to look at. */
function mayTrim(draft: ToolResultDraft, settings: TrimmerSettings): boolean {
	if (NEVER_TRIMMED.has(draft.toolName) || !settings.tools.includes(draft.toolName)) return false;
	const command = draft.input["command"];
	if (typeof command === "string" && printsRequestedContent(command, settings.verbatimCommands)) return false;
	return draft.fullOutputPath !== null || draft.current.length > settings.minChars;
}

function footer(
	kept: number,
	total: number,
	routineLines: number,
	path: string | undefined,
	numbered: boolean,
): string {
	const hidden = routineLines > 0 ? `; ${routineLines} routine lines hidden` : "";
	const how = `${numbered ? "the line numbers above are its lines: " : ""}grep it, or read a range with offset/limit`;
	const where = path ? `; full output: ${path} (${how})` : "";
	return `[exo trimmer: showing ${kept} of ${total} lines${hidden}${where}]`;
}

/**
 * The harness keeps only the end of a very long output and saves the rest to a file. Trimming
 * what it kept would never show the first errors, so the saved file is read instead.
 */
async function sourceOf(
	draft: ToolResultDraft,
	settings: TrimmerSettings,
	ctx: ModuleContext,
	signal: AbortSignal,
): Promise<Source> {
	const kept: Source = { text: draft.current, status: "", full: false };
	if (draft.fullOutputPath === null) return kept;
	try {
		const { size } = await stat(draft.fullOutputPath);
		if (size > settings.maxFullOutputBytes) {
			ctx.log(
				`pi's saved output ${draft.fullOutputPath} has ${size} bytes, over maxFullOutputBytes: trimmed what pi kept`,
			);
			return kept;
		}
		const text = await readFile(draft.fullOutputPath, { encoding: "utf8", signal });
		return { text, status: draft.status ?? "", full: true };
	} catch (error) {
		if (!signal.aborted) ctx.log(`could not read pi's saved output ${draft.fullOutputPath}: ${String(error)}`);
		return kept;
	}
}

type Shrink = (options: { -readonly [K in keyof TrimOptions]: TrimOptions[K] }) => boolean;

const halve =
	(
		key: "maxErrorWindows" | "tailLines" | "headLines" | "maxBlockLines" | "contextLines" | "maxLineChars",
		floor: number,
	): Shrink =>
	(options) => {
		if (options[key] <= floor) return false;
		options[key] = Math.max(floor, Math.floor(options[key] / 2));
		return true;
	};

/**
 * What the selection gives up, in order, while it is over `maxChars` (D-083). Positions go
 * before content: fewer whole blocks (the failures left out keep the line that names them), then
 * less head and tail, then shorter blocks (down to their key lines), then shorter lines (never a
 * failure's own). Only then the floors themselves.
 */
const SHRINKS: readonly Shrink[] = [
	halve("maxErrorWindows", MIN_ERROR_WINDOWS),
	(options) => {
		const tail = halve("tailLines", MIN_TAIL_LINES)(options);
		return halve("headLines", 0)(options) || tail;
	},
	halve("maxBlockLines", 0),
	halve("contextLines", 0),
	(options) => {
		const had = options.headerLines !== false;
		options.headerLines = false;
		return had;
	},
	halve("maxLineChars", MIN_LINE_CHARS),
	halve("maxErrorWindows", 1),
	halve("tailLines", 0),
	halve("maxLineChars", LAST_RESORT_LINE_CHARS),
];

/**
 * The deterministic selection, shrunk a step at a time until it fits. If even the least is over
 * (a failure's lines are never cut short), whole lines go from the middle, keeping the first and
 * the last ones, and the markers number what went (D-110).
 */
function selectToBudget(
	prepared: Prepared,
	settings: TrimmerSettings,
	fits: (keep: ReadonlySet<number>, maxLineChars: number) => boolean,
): { keep: Set<number>; maxLineChars: number } {
	const options = {
		headLines: settings.headLines,
		tailLines: settings.tailLines,
		contextLines: settings.contextLines,
		maxBlockLines: settings.maxBlockLines,
		maxErrorWindows: settings.maxErrorWindows,
		maxLineChars: settings.maxLineChars,
		headerLines: true,
	};
	let keep = selectLines(prepared, options);
	for (const shrink of SHRINKS) {
		while (!fits(keep, options.maxLineChars) && shrink(options)) keep = selectLines(prepared, options);
	}
	if (!fits(keep, options.maxLineChars)) keep = withoutMiddle(keep, (k) => fits(k, options.maxLineChars));
	return { keep, maxLineChars: options.maxLineChars };
}

/** The fewest lines taken from the middle of `keep` (a third of what stays before, the rest after) for it to fit. */
function withoutMiddle(keep: ReadonlySet<number>, fits: (keep: ReadonlySet<number>) => boolean): Set<number> {
	const sorted = [...keep].sort((a, b) => a - b);
	const dropping = (count: number) => {
		const before = Math.floor((sorted.length - count) / 3);
		return new Set([...sorted.slice(0, before), ...sorted.slice(before + count)]);
	};
	let low = 1;
	let high = sorted.length;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		if (fits(dropping(mid))) high = mid;
		else low = mid + 1;
	}
	return dropping(high);
}

/**
 * Where this session's full outputs are saved: its own directory under `saveDir` (default: the
 * OS temp dir). Tool-call ids repeat across sessions, so one shared directory let one session
 * overwrite the file another's context points at.
 */
function sessionSaveDir(settings: TrimmerSettings, sessionId: string): string {
	const name = sessionId.replace(/[^\w.-]/g, "_").replace(/^\.+/, "") || "unknown";
	return join(settings.saveDir ?? join(tmpdir(), "exocortex-trimmer"), `session-${name}`);
}

/**
 * Removes the saved outputs of sessions untouched for {@link SAVED_OUTPUT_DAYS} days, once per
 * process and save directory (D-110). They are not removed when a session ends: a resumed
 * session's context still names them.
 */
function pruneOldSaveDirs(root: string, own: string, ctx: ModuleContext): void {
	if (pruned.has(root)) return;
	pruned.add(root);
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		// Nothing saved there yet.
		return;
	}
	const before = Date.now() - SAVED_OUTPUT_DAYS * DAY_MS;
	for (const name of names) {
		const dir = join(root, name);
		if (!name.startsWith("session-") || dir === own) continue;
		try {
			if (statSync(dir).mtimeMs < before) rmSync(dir, { recursive: true, force: true });
		} catch (error) {
			ctx.log(`could not remove old saved outputs ${dir}: ${String(error)}`);
		}
	}
}

function saveFullOutput(path: string, dir: string, draft: ToolResultDraft, ctx: ModuleContext): string | undefined {
	try {
		// A tool's output can hold what the user would not share: only they may read the copy.
		mkdirSync(dir, { recursive: true });
		chmodSync(dir, 0o700);
		writeFileSync(path, draft.current, { mode: 0o600 });
		return path;
	} catch (error) {
		ctx.log(`could not save full output: ${String(error)}`);
		return undefined;
	}
}
