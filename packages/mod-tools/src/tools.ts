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
	/** Checks after an edit still running once the edit's result went back (D-098), by command. */
	const pending = new Map<string, AbortController>();
	/** Stops late checks: their result would be about files that changed since, or a turn that ended. */
	const stopPending = (command?: string) => {
		for (const [key, stop] of pending) {
			if (command !== undefined && key !== command) continue;
			stop.abort();
			pending.delete(key);
		}
	};
	const counts = { hints: 0, reads: 0, outlines: 0, errors: 0 };

	function checkOf(path: string): { readonly check: Check; readonly absolute: string } | undefined {
		const absolute = resolveToolPath(path, ctx.cwd);
		const check = checkFor(absolute, ctx.cwd, settings.checks, settings.builtinChecks, unavailable);
		return check && { check, absolute };
	}

	async function run(check: Check, signal: AbortSignal, timeoutMs: number): Promise<readonly Diagnostic[] | undefined> {
		const result = await ctx.runCommand(check.command, {
			timeoutMs,
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
		// A late check of an earlier edit would now read the files mid-change.
		stopPending(check.command);
		const hash = contentHash(absolute);
		if (holds(known.get(check.command), hash, check.command)) return;
		known.delete(check.command);
		unchecked.delete(check.command);
		const perFile = isPerFile(check);
		// A file about to be created has no errors of its own yet.
		const diagnostics = hash === "missing" && perFile ? [] : await run(check, signal, settings.checkHoldMs);
		if (diagnostics && !signal.aborted) known.set(check.command, { diagnostics, hash, generation, perFile });
	}

	/**
	 * After an edit: the errors the check finds now that were not there before it. The result waits
	 * up to `checkHoldMs` or the host's signal. A check still running then is not stopped: what it
	 * finds reaches the model as late help (D-098), unless a newer change, a shell command or the
	 * user's next message makes it stale first.
	 */
	async function checkAfter(draft: ToolResultDraft, signal: AbortSignal): Promise<ToolRewrite | undefined> {
		const path = inputPath(draft.input);
		const found = path === undefined ? undefined : checkOf(path);
		if (!found) return undefined;
		const { check, absolute } = found;
		const before = known.get(check.command);
		// Only this change since the result before it: anything more and the difference is not this change's.
		const comparable = before !== undefined && (unchecked.get(check.command) ?? 0) <= 1;
		stopPending(check.command);
		const stop = new AbortController();
		pending.set(check.command, stop);
		// The file as the check reads it: taken now, since a shell command may change it while a late check runs.
		const hash = contentHash(absolute);
		const finished = (async () => {
			// Not timed: it ends, or is stopped as stale (D-098).
			const after = await run(check, stop.signal, NO_TIME_LIMIT_MS);
			if (stop.signal.aborted) return undefined;
			if (pending.get(check.command) === stop) pending.delete(check.command);
			unchecked.delete(check.command);
			if (!after) {
				known.delete(check.command);
				return undefined;
			}
			known.set(check.command, {
				diagnostics: after,
				hash,
				generation,
				perFile: before?.perFile ?? isPerFile(check),
			});
			return comparable ? newDiagnostics(before.diagnostics, after) : [];
		})();
		const held = await within(finished, settings.checkHoldMs, signal);
		if (held.done) {
			const added = held.value ?? [];
			if (added.length === 0) return undefined;
			return {
				text: `${draft.current}\n\n${HEADER} ${check.label} reports ${errorsText(added)} after this change:\n${diagnosticLines(added)}`,
				note: `${added.length} new error(s) from ${check.label}`,
				details: { check: check.command, newErrors: added.length },
				commit: () => {
					counts.errors += added.length;
				},
			};
		}
		finished
			.then((added) => {
				if (!added || added.length === 0 || stop.signal.aborted) return;
				const text = `${HEADER} ${check.label} reports ${errorsText(added)} after your edit to ${path}:\n${diagnosticLines(added)}`;
				if (ctx.deliverLate(text)) counts.errors += added.length;
			})
			.catch((error: unknown) => ctx.log(`late check failed: ${String(error)}`));
		return undefined;
	}

	function diagnosticLines(added: readonly Diagnostic[]): string {
		const lines = added.flatMap((d) => d.text.split("\n"));
		const shown = lines.slice(0, settings.maxDiagnosticLines);
		const more = lines.length > shown.length ? `\n[… ${lines.length - shown.length} more lines]` : "";
		return `${shown.join("\n")}${more}`;
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

		onUserTurn(turn) {
			// The user spoke: a late check's errors belong to the turn before.
			if (turn.origin === "user") stopPending();
		},

		dispose() {
			stopPending();
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
			if (!tool.isError || !FILE_TOOLS.has(tool.toolName)) {
				generation += 1;
				// What a late check finds would mix this command's changes into "after your edit".
				stopPending();
			}
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

/** The longest a timer runs: a check after an edit is not timed (D-098). */
const NO_TIME_LIMIT_MS = 2 ** 31 - 1;

function errorsText(added: readonly Diagnostic[]): string {
	return added.length === 1 ? "a new error" : `${added.length} new errors`;
}

/** `work`'s value if it is done within `ms` and before `signal` aborts; it keeps running either way. */
async function within<T>(
	work: Promise<T>,
	ms: number,
	signal: AbortSignal,
): Promise<{ readonly done: true; readonly value: T } | { readonly done: false }> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const held = new Promise<{ readonly done: false }>((resolve) => {
		timer = setTimeout(() => resolve({ done: false }), ms);
		if (signal.aborted) resolve({ done: false });
		else signal.addEventListener("abort", () => resolve({ done: false }), { once: true });
	});
	try {
		return await Promise.race([work.then((value) => ({ done: true as const, value })), held]);
	} finally {
		clearTimeout(timer);
	}
}

/** A check that names the file checks only it; one without `{file}` checks the whole project. */
function isPerFile(check: Check): boolean {
	return check.builtin || check.source.includes("{file}");
}
