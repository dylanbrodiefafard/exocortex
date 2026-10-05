import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classifyErrorLine,
	type ExoModule,
	loadPrompt,
	type ModuleContext,
	SIDECAR_MAX_TOKENS,
	type ToolResultDraft,
	type ToolRewrite,
} from "@exocortex/core";
import { Type } from "typebox";
import { NEVER_TRIMMED, parseSettings, type TrimmerSettings } from "./settings.ts";
import { prepareLines, renderSelection, type Trimmed, trimLines } from "./trim.ts";

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

/**
 * Trims long tool outputs before the main model sees them (brief §6.2, D-029: a rewrite of new
 * content, so the prompt cache is untouched). Deterministic first; optionally a sidecar picks
 * line ranges to keep, verbatim (research R2.2). The full output is always one read away.
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
			const lines = prepareLines(draft.current, settings);
			let result = trimToBudget(lines, settings);
			let how = "head/tail/errors";
			if (settings.sidecar && result.text.length > settings.sidecarAboveChars) {
				const selected = await selectWithSidecar(ctx, settings, draft, lines, goal, signal);
				if (selected) {
					result = selected;
					how = "sidecar selection";
				}
			}
			if (result.text.length >= draft.current.length) return undefined;
			const path = draft.fullOutputPath ?? saveFullOutput(settings, draft, ctx);
			trimmed += 1;
			charsSaved += draft.current.length - result.text.length;
			return { ...rewriteOf(result, how, path), ...(path ? { details: { fullOutputPath: path } } : {}) };
		},

		status() {
			return trimmed === 0
				? TRIMMER_ID
				: `${TRIMMER_ID} (${trimmed} trimmed, −${Math.round(charsSaved / 1000)}k chars)`;
		},
	};
}

/** The deterministic tier, with fewer error windows while the result is over `maxChars`. */
function trimToBudget(lines: readonly string[], settings: TrimmerSettings): Trimmed {
	let windows = settings.maxErrorWindows;
	let result = trimLines(lines, settings);
	while (result.text.length > settings.maxChars && windows > MIN_ERROR_WINDOWS) {
		windows = Math.max(MIN_ERROR_WINDOWS, Math.floor(windows / 2));
		result = trimLines(lines, { ...settings, maxErrorWindows: windows });
	}
	return result;
}

function rewriteOf(result: Trimmed, how: string, path: string | undefined): ToolRewrite {
	const where = path ? `; full output: ${path} (read it if you need the omitted lines)` : "";
	return {
		text: `${result.text}\n[exo trimmer: showing ${result.keptLines} of ${result.totalLines} lines${where}]`,
		note: `trimmed ${result.totalLines}→${result.keptLines} lines (${how})`,
	};
}

/** Asks a sidecar which line ranges matter; undefined (fall back to deterministic) on any failure. */
async function selectWithSidecar(
	ctx: ModuleContext,
	settings: TrimmerSettings,
	draft: ToolResultDraft,
	lines: readonly string[],
	goal: string,
	signal: AbortSignal,
): Promise<Trimmed | undefined> {
	const pool = ctx.pool();
	if (!pool) return undefined;
	const numbered = lines.map((line, i) => `${i + 1}: ${line.slice(0, settings.maxLineChars)}`).join("\n");
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
	const keep = keepFromRanges(result.value.ranges, lines, settings.sidecarMaxLines);
	if (!keep) return undefined;
	return renderSelection(lines, keep, settings.maxLineChars);
}

/**
 * Validates the sidecar's 1-based inclusive ranges and adds the always-kept lines (the tail and
 * the first toolchain-specific error), so a poor selection can never hide the exit status or the
 * root error. Undefined when the selection is empty or over budget.
 */
export function keepFromRanges(
	ranges: readonly (readonly number[])[],
	lines: readonly string[],
	maxLines: number,
): Set<number> | undefined {
	const keep = new Set<number>();
	for (const [first, last] of ranges) {
		if (first === undefined || last === undefined || first > last) continue;
		for (let n = Math.max(1, first); n <= Math.min(lines.length, last); n++) keep.add(n - 1);
	}
	if (keep.size === 0 || keep.size > maxLines) return undefined;
	for (let i = Math.max(0, lines.length - SIDECAR_TAIL_LINES); i < lines.length; i++) keep.add(i);
	const firstError = lines.findIndex((line) => classifyErrorLine(line) === "specific");
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
