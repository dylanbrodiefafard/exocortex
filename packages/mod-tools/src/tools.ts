import type { ExoModule, ModuleContext, ToolOutcome, ToolResultDraft, ToolRewrite } from "@exocortex/core";
import { printsOnly } from "./commands.ts";
import {
	CHECK_TAIL_CHARS,
	type Check,
	checkFor,
	type Diagnostic,
	mentionsFile,
	newDiagnostics,
	readCheck,
} from "./diagnostics.ts";
import { editHint } from "./edit-hints.ts";
import { inputPath, resolveToolPath, shownPath } from "./paths.ts";
import { readView } from "./read-view.ts";
import { parseSettings } from "./settings.ts";

export const TOOLS_ID = "tools";

/** Tools that change files and whose result this module checks. */
const FILE_TOOLS = new Set(["edit", "write"]);
/** Tools that change nothing: a project-wide check's last result still holds after them. */
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const HEADER = "[exo tools]";
/** Durations kept per check, for its hold. */
const MAX_SAMPLES = 20;
/** A check's hold is set from its own runs once it has run this often; until then it is `checkHoldMs`. */
const HOLD_MIN_SAMPLES = 3;
/** Half again the 90th percentile of the check's runs: a typical run is never cut short. */
const HOLD_FACTOR = 1.5;
const HOLD_FLOOR_MS = 250;

/** A check's last result, and the count of unchecked changes then: a result holds while that count is unchanged. */
interface Known {
	readonly diagnostics: readonly Diagnostic[];
	readonly generation: number;
}

/** What an edit's check found that the model has not been shown. */
interface Report {
	readonly added: readonly Diagnostic[];
	/** There was an earlier result to compare with; without one, errors are those of the edited file. */
	readonly compared: boolean;
	/** Edits since that earlier result, this one included. */
	readonly edits: number;
}

/**
 * Makes pi's own tools give the model more to work with, without adding a tool (D-094). Each part
 * rewrites only the result that just came in (D-029):
 * - a failed edit gets what the file holds where the edit was aimed, quoted from the file;
 * - a text read gets line numbers, and a read that pi's size limit stopped gets an outline of the
 *   rest of the file;
 * - an edit or write gets the errors a check finds that were not there before the change (D-110):
 *   compared with the check's last result, which an earlier edit's check or a background run
 *   leaves; with none, the errors that name the edited file. Nothing is checked before an edit.
 */
export function createTools(raw: Readonly<Record<string, unknown>>, ctx: ModuleContext): ExoModule {
	const { settings, problems } = parseSettings(raw);
	for (const problem of problems) ctx.log(problem);
	/** Each check's last result, by the command line run. */
	const known = new Map<string, Known>();
	/** Edits to a check's files since its last result, by command. */
	const unchecked = new Map<string, number>();
	/** Errors already shown, by command, while the check still reports them. */
	const shown = new Map<string, Map<string, number>>();
	/** Checks whose program is not installed: not tried again this session. */
	const unavailable = new Set<string>();
	/** Checks whose failures could not be read, already said once. */
	const unread = new Set<string>();
	/** How long each check took, by its setting or template: what an edit's result waits for. */
	const durations = new Map<string, number[]>();
	/**
	 * Shell commands that may change files, started and not yet finished. No check starts while
	 * one runs: it would compete with the agent's own build (cargo's build-directory lock).
	 */
	let commandsRunning = 0;
	/** Outlines already shown, by file and content: a second read of the same file needs none. */
	const outlined = new Set<string>();
	/** Changes made by something other than a checked edit (a shell command): every result goes stale. */
	let generation = 0;
	/** Checks still running (after an edit, or a project-wide check's baseline), by command. */
	const pending = new Map<string, AbortController>();
	/**
	 * Stops checks whose result would be stale. Not logged: it is routine, and the next check
	 * covers what the stopped one would have found.
	 */
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

	/** The check's errors; undefined when it was stopped, or said why it could not be read. */
	async function run(check: Check, signal: AbortSignal): Promise<readonly Diagnostic[] | undefined> {
		// Not timed: it ends, or is stopped as stale (D-098).
		const result = await ctx.runCommand(check.command, {
			timeoutMs: NO_TIME_LIMIT_MS,
			tailChars: CHECK_TAIL_CHARS,
			signal,
		});
		if (signal.aborted) return undefined;
		const reading = readCheck(result, check);
		if (reading.kind === "not_installed") {
			unavailable.add(check.source);
			ctx.log(`not installed, not tried again: ${check.label}`);
			return undefined;
		}
		if (reading.kind === "unreadable") {
			ctx.log(`dropped the check ${check.label}: ${reading.why}`);
			return undefined;
		}
		const samples = durations.get(check.source) ?? [];
		samples.push(result.durationMs);
		durations.set(check.source, samples.slice(-MAX_SAMPLES));
		if (reading.guessed && !unread.has(check.source)) {
			unread.add(check.source);
			ctx.log(`${check.label} failed but no errors could be read from it: its position lines or last lines are shown`);
		}
		return reading.diagnostics;
	}

	/**
	 * How long an edit's result waits for its check (D-110): `checkHoldMs` until the check has run a
	 * few times, then half again its 90th percentile, up to `checkHoldMs`. A check that typically
	 * takes longer than that is not waited for at all: its errors go as late help.
	 */
	function holdFor(check: Check): number {
		const samples = [...(durations.get(check.source) ?? [])].sort((a, b) => a - b);
		if (samples.length < HOLD_MIN_SAMPLES) return settings.checkHoldMs;
		const at = (q: number) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))] ?? 0;
		if (at(0.5) > settings.checkHoldMs) return 0;
		return Math.min(settings.checkHoldMs, Math.max(HOLD_FLOOR_MS, Math.round(at(0.9) * HOLD_FACTOR)));
	}

	/**
	 * A project-wide check's result for the files as they are now, run in the background so the
	 * next edit has something to compare with. Started when the agent reads a file the check
	 * covers, unless a result that still holds or a run is there, or a shell command is running.
	 * At most one per state of the files: a change outside an edit starts none (D-110).
	 */
	function startBaseline(check: Check): void {
		if (commandsRunning > 0 || pending.has(check.command)) return;
		if (known.get(check.command)?.generation === generation) return;
		const stop = new AbortController();
		pending.set(check.command, stop);
		const startedAt = generation;
		run(check, stop.signal)
			.then((diagnostics) => {
				if (stop.signal.aborted) return;
				pending.delete(check.command);
				if (diagnostics) remember(check.command, diagnostics, startedAt);
			})
			.catch((error: unknown) => {
				pending.delete(check.command);
				ctx.log(`background check ${check.label} failed: ${String(error)}`);
			});
	}

	function remember(command: string, diagnostics: readonly Diagnostic[], at: number): void {
		known.set(command, { diagnostics, generation: at });
		unchecked.delete(command);
		// An error that went away and comes back is new again.
		const seen = shown.get(command);
		if (!seen) return;
		const present = new Set(diagnostics.map((d) => d.key));
		for (const key of seen.keys()) if (!present.has(key)) seen.delete(key);
	}

	/** Errors in `after` the model has not been shown, counting duplicates. */
	function unshown(command: string, after: readonly Diagnostic[]): Diagnostic[] {
		const seen = shown.get(command);
		return seen ? newDiagnostics(expand(seen), after) : [...after];
	}

	function markShown(command: string, added: readonly Diagnostic[]): void {
		const seen = shown.get(command) ?? new Map<string, number>();
		for (const d of added) seen.set(d.key, (seen.get(d.key) ?? 0) + 1);
		shown.set(command, seen);
		counts.errors += added.length;
	}

	/** What an edit's check found that is new: against the last result that holds, else what names the file. */
	function reportOf(
		check: Check,
		absolute: string,
		baseline: Known | undefined,
		edits: number,
		after: readonly Diagnostic[],
	): Report {
		if (baseline) return { added: newDiagnostics(baseline.diagnostics, after), compared: true, edits };
		const perFile = isPerFile(check);
		const about = perFile ? after : after.filter((d) => mentionsFile(d.text, absolute, ctx.cwd));
		const added = unshown(check.command, about);
		return { added, compared: false, edits };
	}

	/**
	 * After an edit: the errors the check finds now that were not there before (D-110). The result
	 * waits for the check as long as this check usually takes (up to `checkHoldMs`) or the host's
	 * signal. A check still running then is not stopped: what it finds reaches the model as late
	 * help (D-098), unless a newer edit, a shell command that changes files or the user's next
	 * message makes it stale first.
	 */
	async function checkAfter(draft: ToolResultDraft, signal: AbortSignal): Promise<ToolRewrite | undefined> {
		const path = inputPath(draft.input);
		const found = path === undefined ? undefined : checkOf(path);
		if (!found) return undefined;
		const { check, absolute } = found;
		// An earlier edit's late check is superseded: this one compares with the same result it would have.
		stopPending(check.command);
		const last = known.get(check.command);
		const baseline = last?.generation === generation ? last : undefined;
		const edits = Math.max(1, unchecked.get(check.command) ?? 1);
		const stop = new AbortController();
		pending.set(check.command, stop);
		const startedAt = generation;
		const finished = (async () => {
			const after = await run(check, stop.signal);
			if (stop.signal.aborted) return undefined;
			if (pending.get(check.command) === stop) pending.delete(check.command);
			if (!after) {
				known.delete(check.command);
				return undefined;
			}
			remember(check.command, after, startedAt);
			return reportOf(check, absolute, baseline, edits, after);
		})();
		const hold = holdFor(check);
		const held = hold > 0 ? await within(finished, hold, signal) : { done: false as const };
		const where = shownPath(absolute, ctx.cwd);
		if (held.done) {
			const report = held.value;
			if (!report || report.added.length === 0) return undefined;
			return {
				text: `${draft.current}\n\n${HEADER} ${check.label} reports ${describe(report, where, "this change")}:\n${diagnosticLines(report.added, check)}`,
				note: `${report.added.length} ${report.compared ? "new " : ""}error(s) from ${check.label}`,
				details: { check: check.command, newErrors: report.added.length },
				commit: () => markShown(check.command, report.added),
			};
		}
		finished
			.then((report) => {
				if (!report || report.added.length === 0 || stop.signal.aborted) return;
				const text = `${HEADER} ${check.label} reports ${describe(report, where, `your edit to ${where}`)}:\n${diagnosticLines(report.added, check)}`;
				// Help for a run that ended is stale: deliverLate sends nothing then.
				if (ctx.deliverLate(text)) markShown(check.command, report.added);
			})
			.catch((error: unknown) => ctx.log(`late check failed: ${String(error)}`));
		return undefined;
	}

	function diagnosticLines(added: readonly Diagnostic[], check: Check): string {
		const out: string[] = [];
		let shownErrors = 0;
		for (const d of added) {
			const lines = d.text.split("\n");
			if (out.length + lines.length > settings.maxDiagnosticLines) {
				// The first error is shown whatever its length, up to the cap.
				if (shownErrors === 0) {
					out.push(...lines.slice(0, settings.maxDiagnosticLines));
					shownErrors = 1;
				}
				break;
			}
			out.push(...lines);
			shownErrors += 1;
		}
		const more = added.length - shownErrors;
		const marker =
			more > 0 ? `\n[… ${more} more error${more === 1 ? "" : "s"}; run \`${check.command}\` to see all]` : "";
		return `${out.join("\n")}${marker}`;
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
			outlined,
		});
		if (!view || view.text === draft.current) return undefined;
		return {
			text: view.text,
			note: [view.numbered ? "numbered" : "", view.outlined > 0 ? `outline of ${view.outlined}` : ""]
				.filter(Boolean)
				.join(", "),
			commit: () => {
				counts.reads += 1;
				if (view.outlineKey === undefined) return;
				counts.outlines += 1;
				outlined.add(view.outlineKey);
			},
		};
	}

	/**
	 * What a finished tool call means for the checks: a read of a file a project-wide check covers
	 * starts its baseline; a checked edit is counted; anything else that may change files makes
	 * every result stale.
	 */
	function observe(tool: ToolOutcome): void {
		const path = inputPath(tool.input);
		const found = path === undefined ? undefined : checkOf(path);
		if (tool.toolName === "read") {
			if (found && !tool.isError && !isPerFile(found.check)) startBaseline(found.check);
			return;
		}
		if (!mayChangeFiles(tool)) return;
		if (tool.toolName === "bash") commandsRunning = Math.max(0, commandsRunning - 1);
		if (FILE_TOOLS.has(tool.toolName) && found) {
			unchecked.set(found.check.command, (unchecked.get(found.check.command) ?? 0) + 1);
			return;
		}
		// A shell command or a file no check covers (a build file) may change what any check
		// reports: every result is stale, and so is a check that ran meanwhile.
		generation += 1;
		stopPending();
	}

	return {
		id: TOOLS_ID,

		async beforeToolCall(call) {
			if (!settings.diagnostics) return;
			try {
				if (call.toolName === "bash" && !printsOnly(String(call.input["command"] ?? ""))) {
					// Its result would be stale once the command ends, and it would compete with the
					// command for the build (cargo's lock, the CPU): stop it before the command starts.
					commandsRunning += 1;
					stopPending();
					return;
				}
				if (!FILE_TOOLS.has(call.toolName)) return;
				const path = inputPath(call.input);
				const found = path === undefined ? undefined : checkOf(path);
				// A check still running would read the files mid-change; the edit's own check covers what it would find.
				if (found) stopPending(found.check.command);
			} catch (error) {
				ctx.log(`before ${call.toolName}: ${String(error)}`);
			}
		},

		onUserTurn(turn) {
			// The user spoke: a late check's errors belong to the turn before.
			if (turn.origin !== "user") return;
			stopPending();
			// A command whose result never came (an abort) holds nothing any more.
			commandsRunning = 0;
		},

		onSettled() {
			commandsRunning = 0;
		},

		dispose() {
			stopPending();
		},

		onToolResult(tool) {
			if (!settings.diagnostics) return;
			try {
				observe(tool);
			} catch (error) {
				ctx.log(`after ${tool.toolName}: ${String(error)}`);
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

/** A failed edit changed nothing; nor did a tool that only reads, or a shell command that only prints. */
function mayChangeFiles(tool: ToolOutcome): boolean {
	if (READ_ONLY_TOOLS.has(tool.toolName)) return false;
	if (FILE_TOOLS.has(tool.toolName)) return !tool.isError;
	return tool.toolName !== "bash" || !printsOnly(String(tool.input["command"] ?? ""));
}

/** The longest a timer runs: a check after an edit is not timed (D-098). */
const NO_TIME_LIMIT_MS = 2 ** 31 - 1;

/** "a new error after this change", "3 errors in src/a.rs", … */
function describe(report: Report, file: string, change: string): string {
	const n = report.added.length;
	if (!report.compared) {
		const errors = n === 1 ? "an error" : `${n} errors`;
		return `${errors} in ${file} (it had not run before, so some may predate ${change})`;
	}
	const errors = n === 1 ? "a new error" : `${n} new errors`;
	const others = report.edits - 1;
	return others > 0
		? `${errors} after ${change} and ${others} earlier edit${others === 1 ? "" : "s"}`
		: `${errors} after ${change}`;
}

/** Diagnostics standing for a count of each key, for comparing against. */
function expand(counts: ReadonlyMap<string, number>): Diagnostic[] {
	return [...counts].flatMap(([key, n]) => Array.from({ length: n }, () => ({ key, text: "" })));
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
