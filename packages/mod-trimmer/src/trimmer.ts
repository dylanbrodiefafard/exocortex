import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ExoModule,
	loadPrompt,
	type ModuleContext,
	SIDECAR_MAX_TOKENS,
	type ToolResultDraft,
} from "@exocortex/core";
import { Type } from "typebox";
import { printsRequestedContent } from "./command.ts";
import { NEVER_TRIMMED, parseSettings, type TrimmerSettings } from "./settings.ts";
import {
	allLines,
	type Line,
	type Prepared,
	prepareLines,
	renderSelection,
	selectLines,
	type Trimmed,
	type TrimOptions,
} from "./trim.ts";

export const TRIMMER_ID = "trimmer";

const SELECT_PROMPT = loadPrompt(new URL("../prompts/select-lines.v1.md", import.meta.url));

const SelectionSchema = Type.Object({
	ranges: Type.Array(Type.Array(Type.Integer(), { minItems: 2, maxItems: 2 }), { maxItems: 40 }),
});

const GOAL_CHARS = 1_000;
/** Lines always kept after a sidecar selection: the exit status and final summary live at the end. */
const SIDECAR_TAIL_LINES = 10;
/** The budget cuts below this many error blocks only after everything else: the first errors are the root causes. */
const MIN_ERROR_WINDOWS = 4;
/** The budget cuts the tail below this only after everything else: a run's result is in its last lines. */
const MIN_TAIL_LINES = 5;
/** Lines are cut to this before the last blocks and the tail are given up, and to the second as the last resort. */
const MIN_LINE_CHARS = 80;
const LAST_RESORT_LINE_CHARS = 20;
const CUT_MARKER = "\n[… cut here to fit maxChars …]";

/** What gets trimmed: the harness's saved full output when it can be read, else the result text. */
interface Source {
	readonly text: string;
	/** Added back after the trimmed text: the exit status, which the saved file does not hold. */
	readonly status: string;
	/** The harness's saved output could not be used, so line numbers would not match it. */
	readonly partial: boolean;
}

/** Which lines to show, and how long a line may be: the budget may have lowered `maxLineChars`. */
interface Choice {
	readonly keep: ReadonlySet<number>;
	readonly maxLineChars: number;
	readonly how: string;
}

/**
 * Session directories whose trimmer was disposed, removed when the process exits (D-083). Not in
 * `dispose` itself: that also runs when the session is reloaded or the module's settings change,
 * and the context still shows the model those paths.
 */
const retired = new Set<string>();
let exitHooked = false;

/** Removes the saved outputs of every session whose trimmer was disposed and not built again. */
export function removeRetiredSaveDirs(): void {
	for (const dir of retired) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Nothing to do about it at exit; the directory is in the temp dir or where the user put it.
		}
	}
	retired.clear();
}

/**
 * Trims long tool outputs before the main model sees them (brief §6.2, D-029: a rewrite of new
 * content, so the prompt cache is untouched). Routine lines go first; then, deterministically,
 * head, tail and whole error blocks; optionally a sidecar picks line ranges to keep, verbatim
 * (research R2.2). The full output is always one read away, and markers say which lines to read.
 * The result is never longer than `maxChars` (D-083).
 */
export function createTrimmer(raw: Readonly<Record<string, unknown>>, ctx: ModuleContext): ExoModule {
	const { settings, problems } = parseSettings(raw);
	for (const problem of problems) ctx.log(problem);
	const saveDir = sessionSaveDir(settings, ctx.sessionId);
	// This session's trimmer is back (a reload, a settings change): its saved outputs stay.
	retired.delete(saveDir);
	let goal = "";
	let trimmed = 0;
	let charsSaved = 0;

	return {
		id: TRIMMER_ID,

		onUserTurn(turn) {
			if (turn.origin === "user") goal = turn.text.slice(0, GOAL_CHARS);
		},

		async rewriteToolResult(draft, signal) {
			if (NEVER_TRIMMED.has(draft.toolName) || !settings.tools.includes(draft.toolName)) return undefined;
			if (draft.current.length <= settings.minChars) return undefined;
			if (isRequestedContent(draft, settings)) return undefined;
			const source = await sourceOf(draft, settings, signal);
			const prepared = prepareLines(source.text, settings);
			const savePath =
				draft.fullOutputPath ?? join(saveDir, `${draft.toolCallId.replace(/[^\w.-]/g, "_") || "output"}.log`);
			// What the status line and the footer take is not the output's to use.
			const everything = { text: "", totalLines: prepared.totalLines, keptLines: prepared.totalLines };
			const around = source.status.length + footer(everything, prepared.routineLines, savePath, true).length + 3;
			const budget = Math.max(0, settings.maxChars - around);
			const choice = await choose(prepared, draft, budget, signal);
			const render = (numbered: boolean) =>
				renderSelection(prepared, choice.keep, { maxLineChars: choice.maxLineChars, numbered });
			if (render(true).text.length + source.status.length >= draft.current.length) return undefined;
			const path = draft.fullOutputPath ?? saveFullOutput(savePath, saveDir, draft, ctx);
			const numbered = path !== undefined && !source.partial;
			const result = render(numbered);
			const text = [
				cut(result.text, budget),
				...(source.status ? ["", source.status] : []),
				footer(result, prepared.routineLines, path, numbered),
			].join("\n");
			trimmed += 1;
			charsSaved += draft.current.length - text.length;
			return {
				// The last resort for a `maxChars` smaller than the status and the footer themselves.
				text: text.slice(0, settings.maxChars),
				note: `trimmed ${result.totalLines}→${result.keptLines} lines (${choice.how})`,
				...(path ? { details: { fullOutputPath: path } } : {}),
			};
		},

		status() {
			return trimmed === 0
				? TRIMMER_ID
				: `${TRIMMER_ID} (${trimmed} trimmed, −${Math.round(charsSaved / 1000)}k chars)`;
		},

		dispose() {
			// An earlier instance in this session may have been the one that saved.
			if (!existsSync(saveDir)) return;
			retired.add(saveDir);
			if (exitHooked) return;
			exitHooked = true;
			process.once("exit", removeRetiredSaveDirs);
		},
	};

	/** Everything that is not routine when that fits; else head, tail and errors, or the sidecar's pick. */
	async function choose(
		prepared: Prepared,
		draft: ToolResultDraft,
		budget: number,
		signal: AbortSignal,
	): Promise<Choice> {
		const fits = (keep: ReadonlySet<number>, maxLineChars: number) =>
			renderSelection(prepared, keep, { maxLineChars, numbered: true }).text.length <= budget;
		const { maxLineChars } = settings;
		const all = allLines(prepared.lines);
		// The markers for hidden lines count too: one per gap can outweigh the lines between them.
		if (lengthOf(prepared.lines, all) <= settings.minChars && fits(all, maxLineChars)) {
			return { keep: all, maxLineChars, how: "routine lines hidden" };
		}
		// What the deterministic tier would show with room for all of it decides whether to ask:
		// a selection the budget had to shrink is the one a better choice of lines helps most.
		if (settings.sidecar && lengthOf(prepared.lines, selectLines(prepared, settings)) > settings.sidecarAboveChars) {
			const selected = await selectWithSidecar(ctx, settings, draft, prepared, goal, signal);
			// A selection over the budget is no better than no selection (D-042).
			if (selected && fits(selected, maxLineChars)) return { keep: selected, maxLineChars, how: "sidecar selection" };
		}
		return { ...selectToBudget(prepared, settings, fits), how: "head/tail/errors" };
	}
}

function isRequestedContent(draft: ToolResultDraft, settings: TrimmerSettings): boolean {
	const command = draft.input["command"];
	return typeof command === "string" && printsRequestedContent(command, settings.verbatimCommands);
}

function footer(result: Trimmed, routineLines: number, path: string | undefined, numbered: boolean): string {
	const hidden = routineLines > 0 ? `; ${routineLines} routine lines hidden` : "";
	const how = `${numbered ? "the line numbers above are its lines: " : ""}grep it, or read a range with offset/limit`;
	const where = path ? `; full output: ${path} (${how})` : "";
	return `[exo trimmer: showing ${result.keptLines} of ${result.totalLines} lines${hidden}${where}]`;
}

/** The text within `budget` characters, saying so when it had to be cut: the ceiling holds whatever the lines are. */
function cut(text: string, budget: number): string {
	if (text.length <= budget) return text;
	return `${text.slice(0, Math.max(0, budget - CUT_MARKER.length))}${CUT_MARKER}`;
}

/**
 * The harness keeps only the end of a very long output and saves the rest to a file. Trimming
 * what it kept would never show the first errors, so the saved file is read instead.
 */
async function sourceOf(draft: ToolResultDraft, settings: TrimmerSettings, signal: AbortSignal): Promise<Source> {
	if (draft.fullOutputPath === null) return { text: draft.current, status: "", partial: false };
	try {
		if ((await stat(draft.fullOutputPath)).size <= settings.maxFullOutputBytes) {
			const text = await readFile(draft.fullOutputPath, { encoding: "utf8", signal });
			return { text, status: draft.status ?? "", partial: false };
		}
	} catch {
		// Unreadable or cut off by the budget: fall through to what the harness kept.
	}
	return { text: draft.current, status: "", partial: true };
}

function lengthOf(lines: readonly Line[], keep: ReadonlySet<number>): number {
	let length = 0;
	for (const index of keep) length += (lines[index]?.text.length ?? 0) + 1;
	return length;
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
 * less head and tail, then shorter blocks (down to their key lines), then shorter lines. Only
 * then the floors themselves.
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

/** The deterministic tier, shrunk a step at a time until it fits; what is still over is cut by the caller. */
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
	return { keep, maxLineChars: options.maxLineChars };
}

/** Asks a sidecar which line ranges matter; undefined (fall back to deterministic) on any failure. */
async function selectWithSidecar(
	ctx: ModuleContext,
	settings: TrimmerSettings,
	draft: ToolResultDraft,
	prepared: Prepared,
	goal: string,
	signal: AbortSignal,
): Promise<Set<number> | undefined> {
	const pool = ctx.pool();
	if (!pool) return undefined;
	const { lines } = prepared;
	const numbered = lines.map((line, i) => `${i + 1}: ${line.text.slice(0, settings.maxLineChars)}`).join("\n");
	if (numbered.length > settings.sidecarMaxInputChars) return undefined;
	ctx.progress("Trimming noisy output…");
	const result = await pool.run({
		module: TRIMMER_ID,
		priority: "interactive",
		timeoutMs: settings.sidecarTimeoutMs,
		signal,
		schema: SelectionSchema,
		schemaName: "line_selection",
		request: {
			messages: [
				{
					role: "user",
					content: SELECT_PROMPT.render({
						goal: goal || "(unknown)",
						command: typeof draft.input["command"] === "string" ? draft.input["command"] : draft.toolName,
						exit_code: draft.exitCode === null ? "unknown" : String(draft.exitCode),
						line_count: String(lines.length),
						max_lines: String(settings.sidecarMaxLines),
						numbered,
					}),
				},
			],
			maxTokens: SIDECAR_MAX_TOKENS,
			thinking: settings.thinking,
		},
	});
	if (!result.ok) {
		ctx.log(`line selection ${result.outcome}: ${result.error}`);
		return undefined;
	}
	return keepFromRanges(result.value.ranges, prepared, settings.sidecarMaxLines);
}

/**
 * Validates the sidecar's 1-based inclusive ranges and adds the always-kept lines (the tail and
 * the key lines of the first top-ranked error block), so a poor selection can never hide the exit
 * status or the root error. Undefined when the selection is empty or over budget.
 */
export function keepFromRanges(
	ranges: readonly (readonly number[])[],
	prepared: Prepared,
	maxLines: number,
): Set<number> | undefined {
	const { lines, blocks } = prepared;
	const keep = new Set<number>();
	for (const [first, last] of ranges) {
		if (first === undefined || last === undefined || first > last) continue;
		for (let n = Math.max(1, first); n <= Math.min(lines.length, last); n++) keep.add(n - 1);
	}
	if (keep.size === 0 || keep.size > maxLines) return undefined;
	for (let i = Math.max(0, lines.length - SIDECAR_TAIL_LINES); i < lines.length; i++) keep.add(i);
	const top = blocks.reduce((rank, block) => Math.max(rank, block.rank), 2);
	for (const key of blocks.find((block) => block.rank === top)?.keys ?? []) keep.add(key);
	return keep;
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
