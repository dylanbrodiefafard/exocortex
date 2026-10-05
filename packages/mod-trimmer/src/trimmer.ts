import { mkdirSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classifyErrorLine,
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
} from "./trim.ts";

export const TRIMMER_ID = "trimmer";

const SELECT_PROMPT = loadPrompt(new URL("../prompts/select-lines.v1.md", import.meta.url));

const SelectionSchema = Type.Object({
	ranges: Type.Array(Type.Array(Type.Integer(), { minItems: 2, maxItems: 2 }), { maxItems: 40 }),
});

const GOAL_CHARS = 1_000;
/** Lines always kept after a sidecar selection: the exit status and final summary live at the end. */
const SIDECAR_TAIL_LINES = 10;
/** The budget never cuts below this many error windows: the first errors are the root causes. */
const MIN_ERROR_WINDOWS = 4;

/** What gets trimmed: the harness's saved full output when it can be read, else the result text. */
interface Source {
	readonly text: string;
	/** Added back after the trimmed text: the exit status, which the saved file does not hold. */
	readonly status: string;
	/** The harness's saved output could not be used, so line numbers would not match it. */
	readonly partial: boolean;
}

/**
 * Trims long tool outputs before the main model sees them (brief §6.2, D-029: a rewrite of new
 * content, so the prompt cache is untouched). Routine lines go first; then, deterministically,
 * head, tail and whole error blocks; optionally a sidecar picks line ranges to keep, verbatim
 * (research R2.2). The full output is always one read away, and markers say which lines to read.
 */
export function createTrimmer(raw: Readonly<Record<string, unknown>>, ctx: ModuleContext): ExoModule {
	const { settings, problems } = parseSettings(raw);
	for (const problem of problems) ctx.log(problem);
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
			const { keep, how } = await choose(prepared, draft, signal);
			const render = (numbered: boolean) =>
				renderSelection(prepared, keep, { maxLineChars: settings.maxLineChars, numbered });
			if (render(true).text.length + source.status.length >= draft.current.length) return undefined;
			const path = draft.fullOutputPath ?? saveFullOutput(settings, draft, ctx);
			const numbered = path !== undefined && !source.partial;
			const result = render(numbered);
			const text = [
				result.text,
				...(source.status ? ["", source.status] : []),
				footer(result, prepared.routineLines, path, numbered),
			].join("\n");
			trimmed += 1;
			charsSaved += draft.current.length - text.length;
			return {
				text,
				note: `trimmed ${result.totalLines}→${result.keptLines} lines (${how})`,
				...(path ? { details: { fullOutputPath: path } } : {}),
			};
		},

		status() {
			return trimmed === 0
				? TRIMMER_ID
				: `${TRIMMER_ID} (${trimmed} trimmed, −${Math.round(charsSaved / 1000)}k chars)`;
		},
	};

	/** Everything that is not routine when that fits; else head, tail and errors, or the sidecar's pick. */
	async function choose(prepared: Prepared, draft: ToolResultDraft, signal: AbortSignal) {
		const all = allLines(prepared.lines);
		if (lengthOf(prepared.lines, all) <= settings.minChars) return { keep: all, how: "routine lines hidden" };
		const keep = selectToBudget(prepared, settings);
		if (settings.sidecar && lengthOf(prepared.lines, keep) > settings.sidecarAboveChars) {
			const selected = await selectWithSidecar(ctx, settings, draft, prepared.lines, goal, signal);
			if (selected) return { keep: selected, how: "sidecar selection" };
		}
		return { keep, how: "head/tail/errors" };
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

/** The deterministic tier, with fewer error windows while the selection is over `maxChars`. */
function selectToBudget(prepared: Prepared, settings: TrimmerSettings): Set<number> {
	const fits = (keep: ReadonlySet<number>) =>
		renderSelection(prepared, keep, { maxLineChars: settings.maxLineChars, numbered: true }).text.length <=
		settings.maxChars;
	let windows = settings.maxErrorWindows;
	let keep = selectLines(prepared.lines, settings);
	while (!fits(keep) && windows > MIN_ERROR_WINDOWS) {
		windows = Math.max(MIN_ERROR_WINDOWS, Math.floor(windows / 2));
		keep = selectLines(prepared.lines, { ...settings, maxErrorWindows: windows });
	}
	return keep;
}

/** Asks a sidecar which line ranges matter; undefined (fall back to deterministic) on any failure. */
async function selectWithSidecar(
	ctx: ModuleContext,
	settings: TrimmerSettings,
	draft: ToolResultDraft,
	lines: readonly Line[],
	goal: string,
	signal: AbortSignal,
): Promise<Set<number> | undefined> {
	const pool = ctx.pool();
	if (!pool) return undefined;
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
	return keepFromRanges(result.value.ranges, lines, settings.sidecarMaxLines);
}

/**
 * Validates the sidecar's 1-based inclusive ranges and adds the always-kept lines (the tail and
 * the first toolchain-specific error), so a poor selection can never hide the exit status or the
 * root error. Undefined when the selection is empty or over budget.
 */
export function keepFromRanges(
	ranges: readonly (readonly number[])[],
	lines: readonly Line[],
	maxLines: number,
): Set<number> | undefined {
	const keep = new Set<number>();
	for (const [first, last] of ranges) {
		if (first === undefined || last === undefined || first > last) continue;
		for (let n = Math.max(1, first); n <= Math.min(lines.length, last); n++) keep.add(n - 1);
	}
	if (keep.size === 0 || keep.size > maxLines) return undefined;
	for (let i = Math.max(0, lines.length - SIDECAR_TAIL_LINES); i < lines.length; i++) keep.add(i);
	const firstError = lines.findIndex((line) => classifyErrorLine(line.text) === "specific");
	if (firstError !== -1) keep.add(firstError);
	return keep;
}

function saveFullOutput(settings: TrimmerSettings, draft: ToolResultDraft, ctx: ModuleContext): string | undefined {
	try {
		const dir = settings.saveDir ?? join(tmpdir(), "exocortex-trimmer");
		mkdirSync(dir, { recursive: true });
		const path = join(dir, `${draft.toolCallId.replace(/[^\w.-]/g, "_") || "output"}.log`);
		writeFileSync(path, draft.current);
		return path;
	} catch (error) {
		ctx.log(`could not save full output: ${String(error)}`);
		return undefined;
	}
}
