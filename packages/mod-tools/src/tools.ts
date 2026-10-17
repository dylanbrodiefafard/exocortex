import type { ExoModule, ModuleContext, ToolCall, ToolResultDraft, ToolRewrite } from "@exocortex/core";
import {
	CHECK_TAIL_CHARS,
	type Check,
	checkFor,
	contentHash,
	type Diagnostic,
	newDiagnostics,
	readCheck,
} from "./diagnostics.ts";
import { editHint } from "./edit-hints.ts";
import { inputPath, resolveToolPath } from "./paths.ts";
import { readView } from "./read-view.ts";
import { parseSettings } from "./settings.ts";

export const TOOLS_ID = "tools";

/** Tools that change files and whose result this module checks. */
const FILE_TOOLS = new Set(["edit", "write"]);
/** Tools that change nothing: a project-wide check's last result still holds after them. */
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const HEADER = "[exo tools]";

/** A check's last known result. */
interface Known {
	readonly diagnostics: readonly Diagnostic[];
	/** The checked file's content hash then: a per-file result holds while it is unchanged. */
	readonly hash: string;
	/** The count of unchecked changes then: a project-wide result holds while it is unchanged. */
	readonly generation: number;
	/** The check names a file: only that file's content decides its result. */
	readonly perFile: boolean;
}

/**
 * Makes pi's own tools give the model more to work with, without adding a tool (D-094). Each part
 * rewrites only the result that just came in (D-029):
 * - a failed edit gets what the file holds where the edit was aimed, quoted from the file;
 * - a text read gets line numbers, and an outline of the part of the file it did not show;
 * - an edit or write gets the errors a check finds that were not there before the change.
 */
export function createTools(raw: Readonly<Record<string, unknown>>, ctx: ModuleContext): ExoModule {
	const { settings, problems } = parseSettings(raw);
	for (const problem of problems) ctx.log(problem);
	/** Each check's last result, by the command line run. */
	const known = new Map<string, Known>();
	/** Changes to a check's files since its last result whose own check has not run yet. */
	const unchecked = new Map<string, number>();
	/** Checks whose program is not installed: not tried again this session. */
	const unavailable = new Set<string>();
	/** Changes made by something other than an edit or write (a shell command): project-wide results go stale. */
	let generation = 0;
	const counts = { hints: 0, reads: 0, outlines: 0, errors: 0 };

	function checkOf(path: string): { readonly check: Check; readonly absolute: string } | undefined {
		const absolute = resolveToolPath(path, ctx.cwd);
		const check = checkFor(absolute, ctx.cwd, settings.checks, settings.builtinChecks, unavailable);
		return check && { check, absolute };
	}

	async function run(check: Check, signal: AbortSignal): Promise<readonly Diagnostic[] | undefined> {
		const result = await ctx.runCommand(check.command, {
			timeoutMs: settings.checkTimeoutMs,
			tailChars: CHECK_TAIL_CHARS,
			signal,
		});
		const read = readCheck(result, check);
		if (read === "not_installed") {
			unavailable.add(check.source);
			ctx.log(`not installed, not tried again: ${check.label}`);
			return undefined;
		}
		return read;
	}

	function holds(entry: Known | undefined, hash: string, key: string): boolean {
		if (!entry || (unchecked.get(key) ?? 0) > 0) return false;
		return entry.perFile ? entry.hash === hash : entry.generation === generation;
	}

	/** Before an edit: the check's result for the file as it is, unless the last one still holds. */
	async function lookBefore(call: ToolCall, signal: AbortSignal): Promise<void> {
		const path = inputPath(call.input);
		const found = path === undefined ? undefined : checkOf(path);
		if (!found) return;
		const { check, absolute } = found;
		const hash = contentHash(absolute);
		if (holds(known.get(check.command), hash, check.command)) return;
		known.delete(check.command);
		unchecked.delete(check.command);
		const perFile = isPerFile(check);
		// A file about to be created has no errors of its own yet.
		const diagnostics = hash === "missing" && perFile ? [] : await run(check, signal);
		if (diagnostics && !signal.aborted) known.set(check.command, { diagnostics, hash, generation, perFile });
	}

	/** After an edit: the errors the check finds now that were not there before it. */
	async function checkAfter(draft: ToolResultDraft, signal: AbortSignal): Promise<ToolRewrite | undefined> {
		const path = inputPath(draft.input);
		const found = path === undefined ? undefined : checkOf(path);
		if (!found) return undefined;
		const { check, absolute } = found;
		const before = known.get(check.command);
		// Only this change since the result before it: anything more and the difference is not this change's.
		const comparable = before !== undefined && (unchecked.get(check.command) ?? 0) <= 1;
		const after = await run(check, signal);
		if (signal.aborted) return undefined;
		unchecked.delete(check.command);
		if (!after) {
			known.delete(check.command);
			return undefined;
		}
		known.set(check.command, {
			diagnostics: after,
			hash: contentHash(absolute),
			generation,
			perFile: before?.perFile ?? isPerFile(check),
		});
		const added = comparable ? newDiagnostics(before.diagnostics, after) : [];
		if (added.length === 0) return undefined;
		const lines = added.flatMap((d) => d.text.split("\n"));
		const shown = lines.slice(0, settings.maxDiagnosticLines);
		const more = lines.length > shown.length ? `\n[… ${lines.length - shown.length} more lines]` : "";
		const errors = added.length === 1 ? "a new error" : `${added.length} new errors`;
		return {
			text: `${draft.current}\n\n${HEADER} ${check.label} reports ${errors} after this change:\n${shown.join("\n")}${more}`,
			note: `${added.length} new error(s) from ${check.label}`,
			details: { check: check.command, newErrors: added.length },
			commit: () => {
				counts.errors += added.length;
			},
		};
	}

	function hintFor(draft: ToolResultDraft): ToolRewrite | undefined {
		const hint = editHint(draft.toolName, draft.input, draft.output, ctx.cwd);
		if (!hint) return undefined;
		return {
			text: `${draft.current}\n\n${HEADER} ${hint}`,
			note: "edit hint",
			commit: () => {
				counts.hints += 1;
			},
		};
	}

	function readFor(draft: ToolResultDraft): ToolRewrite | undefined {
		const view = readView(draft.input, draft.current, ctx.cwd, {
			numbers: settings.readLineNumbers,
			outline: settings.outline,
			outlineMaxEntries: settings.outlineMaxEntries,
		});
		if (!view || view.text === draft.current) return undefined;
		return {
			text: view.text,
			note: [view.numbered ? "numbered" : "", view.outlined > 0 ? `outline of ${view.outlined}` : ""]
				.filter(Boolean)
				.join(", "),
			commit: () => {
				counts.reads += 1;
				if (view.outlined > 0) counts.outlines += 1;
			},
		};
	}

	return {
		id: TOOLS_ID,

		async beforeToolCall(call, signal) {
			if (!settings.diagnostics || !FILE_TOOLS.has(call.toolName)) return;
			try {
				await lookBefore(call, signal);
			} catch (error) {
				ctx.log(`check before ${call.toolName} failed: ${String(error)}`);
			}
		},

		onToolResult(tool) {
			if (READ_ONLY_TOOLS.has(tool.toolName)) return;
			if (FILE_TOOLS.has(tool.toolName) && !tool.isError) {
				const path = inputPath(tool.input);
				const found = path === undefined ? undefined : checkOf(path);
				if (found) {
					unchecked.set(found.check.command, (unchecked.get(found.check.command) ?? 0) + 1);
					return;
				}
			}
			// A shell command, a failed edit or a file no check covers: project-wide results may no longer hold.
			if (!tool.isError || !FILE_TOOLS.has(tool.toolName)) generation += 1;
		},

		async rewriteToolResult(draft, signal) {
			if (draft.isError)
				return FILE_TOOLS.has(draft.toolName) || draft.toolName === "read" ? hintIfOn(draft) : undefined;
			if (draft.toolName === "read") return readFor(draft);
			if (FILE_TOOLS.has(draft.toolName) && settings.diagnostics) return checkAfter(draft, signal);
			return undefined;
		},

		status() {
			const { hints, reads, outlines, errors } = counts;
			return `${TOOLS_ID}: ${hints} edit hint(s), ${reads} numbered read(s), ${outlines} outline(s), ${errors} new error(s) shown`;
		},
	};

	function hintIfOn(draft: ToolResultDraft): ToolRewrite | undefined {
		return settings.editHints ? hintFor(draft) : undefined;
	}
}

/** A check that names the file checks only it; one without `{file}` checks the whole project. */
function isPerFile(check: Check): boolean {
	return check.builtin || check.source.includes("{file}");
}
