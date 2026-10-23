import type { CompactionRequest, ExoModule, JsonValue, ModuleContext, SettleInfo } from "@exocortex/core";
import {
	boundRequests,
	type CommandRecord,
	commandRecord,
	FACTS_VERSION,
	factsJson,
	MAX_PATHS,
	mergeCommands,
	mergePaths,
	parseFacts,
	type StoredFacts,
	strings,
} from "./facts.ts";
import { type EarlySummary, type Narrative, UNVERIFIED_NOTE, writeEarlySummary, writeNarrative } from "./narrative.ts";
import { type FactsView, factsFromSummary, MAX_MODIFIED_FILES, renderSummary, type Shown } from "./render.ts";
import { type CompactionSettings, parseSettings } from "./settings.ts";
import {
	type Baseline,
	parseBaseline,
	readBaseline,
	readWorkspace,
	type Workspace,
	workspacePath,
} from "./workspace.ts";

export const COMPACTION_ID = "compaction";

/** Texts an extension sent as the user that are remembered, to leave them out of the requests. */
const MAX_EXTENSION_TEXTS = 50;
/** An early summary is written again once the context grew by this share of where pi compacts (D-098). */
const EARLY_REFRESH_SHARE = 0.1;
/** A longer one is not remembered, and so is listed with the requests. */
const MAX_EXTENSION_TEXT_CHARS = 20_000;
const BEFORE_SESSION = "with changes from before this session";

/**
 * Compaction summaries in two parts (D-067, amends D-044):
 * - a sidecar writes the handover in opencode's structure (objective, important details, work
 *   state, next move, relevant files), merging the previous summary into it on later compactions;
 * - tracked facts follow verbatim, because summarizers lose them (research R4.1): the user's
 *   requests, files changed, and which commands last failed or passed.
 *
 * The facts outlive the instance and the compaction (D-085). Each summary's facts are kept with
 * its compaction as `details.exo.facts` and are the start of the next one's; what was tracked
 * since is in the module's saved state, so a reload or a rebuilt module loses nothing.
 */
export function createCompaction(raw: Readonly<Record<string, unknown>>, ctx: ModuleContext): ExoModule {
	const { settings, problems } = parseSettings(raw);
	for (const problem of problems) ctx.log(problem);
	const saved = isRecord(ctx.savedState) ? ctx.savedState : {};
	const seed = parseFacts(saved);

	/** Orders this module's records. An instance that starts without saved state starts it at 0 (see `absorb`). */
	let clock = seed?.clock ?? 0;
	let commands: readonly CommandRecord[] = seed?.commands ?? [];
	let modified: readonly string[] = seed?.filesModified ?? [];
	let read: readonly string[] = seed?.filesRead ?? [];
	let lastEditAt = seed?.lastEditAt ?? 0;
	/**
	 * Whether the stamps above are on the same clock as the facts kept with the session's
	 * compactions: true once this instance, or one it has its state from, has taken those in.
	 */
	let anchored = seed !== undefined && saved["anchored"] === true;
	/**
	 * The requests summarized away as of the last compaction, and how many of them are no longer
	 * kept. Used when that compaction was the harness's own and so carries no facts.
	 */
	let settled = boundRequests(seed?.requests ?? [], seed?.requestsOmitted ?? 0);
	/** The same as of a compaction this module was asked about and has not seen happen yet. */
	let pending: typeof settled | undefined;
	let extensionTexts = strings(saved["extensionTexts"], MAX_EXTENSION_TEXT_CHARS, MAX_EXTENSION_TEXTS);
	let compactions = 0;

	const state = (baseline: Baseline | undefined): JsonValue => ({
		...factsJson({
			v: FACTS_VERSION,
			...settled,
			filesModified: modified,
			filesRead: read,
			commands,
			lastEditAt,
			clock,
		}),
		anchored,
		extensionTexts,
		baseline: baseline ?? null,
	});
	/**
	 * The tree's dirty paths when the session started (undefined inside: not known). Read once, by
	 * the session's first instance, and kept in the state from then on: a rebuilt module must not
	 * take the tree as it is now for the start.
	 */
	let start: { readonly baseline: Baseline | undefined } | undefined =
		"baseline" in saved ? { baseline: parseBaseline(saved["baseline"]) } : undefined;
	/** Saves at once, so that it also works in `dispose`. Until the start is known there is nothing worth keeping. */
	const save = (): void => {
		if (start) ctx.saveState(state(start.baseline));
	};
	/** Never rejects: nothing else may be waiting for it, and an unhandled rejection ends the harness. */
	const started: Promise<void> = start
		? Promise.resolve()
		: readBaseline(ctx)
				.then((found) => {
					start = { baseline: found };
					save();
				})
				.catch(() => {
					start ??= { baseline: undefined };
				});

	/**
	 * Takes in the facts kept with the previous compaction. An instance that started without saved
	 * state stamped its records from 0, though all of them are newer than those facts: its stamps
	 * are moved past theirs first.
	 */
	const absorb = (previous: StoredFacts): void => {
		if (!anchored) {
			const shift = previous.clock;
			commands = commands.map((c) => ({ ...c, at: c.at + shift }));
			if (lastEditAt > 0) lastEditAt += shift;
			clock += shift;
			anchored = true;
		}
		commands = mergeCommands(previous.commands, commands);
		modified = mergePaths(previous.filesModified, modified);
		read = mergePaths(previous.filesRead, read);
		lastEditAt = Math.max(lastEditAt, previous.lastEditAt);
		clock = Math.max(clock, previous.clock);
	};

	/** The summary written before compaction was due (D-098), and whether one is being written. */
	let early: EarlySummary | undefined;
	let writingEarly = false;
	/**
	 * Stops the early summary being written (D-111). It is a long call that holds the engine's one
	 * fork: it ends when the agent starts again (a message, or a tool result of a run a module
	 * continued), when compaction comes (which needs the fork), and with this instance.
	 */
	let earlyStop: AbortController | undefined;
	const stopEarly = (): void => {
		earlyStop?.abort();
		earlyStop = undefined;
	};
	/**
	 * Why early summaries were not written, each said once per instance: the early summary is
	 * tried at every stop past the threshold, and an engine that cannot fork would say so each time.
	 */
	const earlyProblems = new Set<string>();
	const logEarly = (problem: string, message: string): void => {
		if (earlyProblems.has(problem)) return;
		earlyProblems.add(problem);
		ctx.log(message);
	};
	/** Compactions seen: an early summary begun before one is of a context that is gone. */
	let compactionsSeen = 0;

	/**
	 * Writes the summary early once the context is past `earlySummaryAt` of where pi compacts, and
	 * again each time it grows by a tenth of that since the last one. It runs from a fork, at
	 * background priority, while the agent is idle; nothing waits for it.
	 */
	const writeEarly = (context: SettleInfo["context"]): void => {
		if (!settings.earlySummary || !settings.fork || !context || writingEarly) return;
		const { tokens, compactAt } = context;
		if (tokens < settings.earlySummaryAt * compactAt) return;
		if (early && tokens - early.tokens < EARLY_REFRESH_SHARE * compactAt) return;
		writingEarly = true;
		const at = Date.now();
		const asOf = compactionsSeen;
		const stop = new AbortController();
		earlyStop = stop;
		// Being stopped is not a problem worth telling.
		const log = (problem: string, message: string): void => {
			if (!stop.signal.aborted) logEarly(problem, message);
		};
		ctx
			.forkPrefix()
			.then((fork) => {
				if (stop.signal.aborted) return undefined;
				// Said, since nothing else shows it: the agent's last reply failed, or a request is running.
				if (!fork) log("no fork", "early summary not written: no fork of the agent's context");
				return fork ? writeEarlySummary(ctx, settings, fork, stop.signal, log) : undefined;
			})
			.then((written) => {
				if (!written || stop.signal.aborted || asOf !== compactionsSeen) return;
				early = { ...written, at, tokens };
				ctx.record({ kind: "exo.compaction", data: { action: "early_summary", tokens, compactAt } });
			})
			.catch((error: unknown) => logEarly("threw", `early summary failed: ${String(error)}`))
			.finally(() => {
				writingEarly = false;
				if (earlyStop === stop) earlyStop = undefined;
			});
	};

	return {
		id: COMPACTION_ID,

		onSettled(info) {
			writeEarly(info.context);
		},

		onUserTurn(turn) {
			stopEarly();
			// What an extension sent is not the user's request. An accepted suggestion is part of the
			// task's history: it lists what was still missing.
			if (turn.origin === "extension" && turn.text.length <= MAX_EXTENSION_TEXT_CHARS) {
				extensionTexts = [...extensionTexts, turn.text].slice(-MAX_EXTENSION_TEXTS);
			}
			// Once per prompt: what the last run tracked is kept before the next one starts.
			save();
		},

		onToolResult(tool) {
			stopEarly();
			const record = commandRecord(tool, clock + 1);
			const path = tool.input["path"];
			if (record) {
				clock += 1;
				commands = mergeCommands(commands, [record]);
			} else if (tool.isError || typeof path !== "string" || path === "") {
				return;
			} else if (tool.toolName === "edit" || tool.toolName === "write") {
				clock += 1;
				lastEditAt = clock;
				modified = mergePaths(modified, [workspacePath(path, ctx.cwd)]);
			} else if (tool.toolName === "read") {
				read = mergePaths(read, [workspacePath(path, ctx.cwd)]);
			}
		},

		async compact(request, signal) {
			// Compaction needs the fork, and one being written early is of a context about to go.
			stopEarly();
			// The summary does not depend on the workspace: it is written while git is read.
			const writing = writeNarrative(ctx, settings, request, signal, early).catch((error: unknown) => {
				ctx.log(`summary failed: ${String(error)}`);
				return undefined;
			});
			const [workspace] = await Promise.all([readWorkspace(ctx), started]);
			const previous = previousFacts(request);
			if (previous) absorb(previous);
			anchored = true;

			// The requests are those of earlier compactions and then this span's: pi hands over each
			// message once, so nothing is matched or deduplicated by its text.
			const before = previous ?? (request.previousSummary === null ? { requests: [], requestsOmitted: 0 } : settled);
			const requests = boundRequests(
				[...before.requests, ...spanRequests(request.userMessages, extensionTexts, settings)],
				before.requestsOmitted,
			);
			pending = requests;

			const files = filesOf(request, { modified, read }, start?.baseline, workspace, ctx.cwd);
			modified = files.modified;
			read = files.read;
			const facts: StoredFacts = {
				v: FACTS_VERSION,
				...requests,
				filesModified: modified,
				filesRead: read,
				commands,
				lastEditAt,
				clock,
			};
			const view: FactsView = { ...requests, modified: files.shown, read, commands, lastEditAt };

			const narrative = await writing;
			ctx.record({
				kind: "exo.compaction",
				data: {
					reason: request.reason,
					tokensBefore: request.tokensBefore,
					narrative: narrative !== undefined,
					updated: narrative?.updated ?? false,
					userMessages: requests.requests.length + requests.requestsOmitted,
					commands: commands.filter((c) => c.outcome !== "unlisted").length,
					unverified: narrative?.unverified.length ?? 0,
					...(narrative && narrative.unverified.length > 0 ? { unverifiedNames: [...narrative.unverified] } : {}),
					early: narrative?.early ?? "none",
				},
			});
			return {
				summary: renderSummary(view, narrativeSections(narrative), settings),
				// Without a handover the facts follow the harness's own summary (D-111).
				...(narrative ? {} : { part: "facts" as const }),
				details: { facts: factsJson(facts) },
				commit: () => {
					compactions += 1;
					settled = requests;
					pending = undefined;
					save();
				},
			};
		},

		onCompacted() {
			// An early summary was of the context before this compaction, as is one still being written.
			early = undefined;
			compactionsSeen += 1;
			// The harness compacted, with this module's summary or its own: either way the span's
			// requests are no longer in the context.
			if (!pending) return;
			settled = pending;
			pending = undefined;
			save();
		},

		dispose() {
			stopEarly();
			save();
		},

		status() {
			return compactions === 0 ? COMPACTION_ID : `${COMPACTION_ID} (${compactions} summaries)`;
		},
	};
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The facts of everything before this span: those kept with the previous compaction, or, when it
 * carries none that can be used, the facts sections of its summary. Undefined when the previous
 * summary is not this module's (or there is none).
 */
function previousFacts(request: CompactionRequest): StoredFacts | undefined {
	return parseFacts(request.previousDetails?.["facts"]) ?? factsFromSummary(request.previousSummary ?? "");
}

/** The span's user messages as requests: each cut to the per-message cap, without what an extension sent. */
function spanRequests(
	messages: readonly string[],
	extensionTexts: readonly string[],
	settings: CompactionSettings,
): string[] {
	const fromExtension = [...extensionTexts];
	return messages
		.filter((message) => {
			const at = fromExtension.indexOf(message);
			if (at !== -1) fromExtension.splice(at, 1);
			return at === -1 && message.trim() !== "";
		})
		.map((message) =>
			message.length > settings.maxUserMessageChars
				? `${message.slice(0, settings.maxUserMessageChars)}… [truncated]`
				: message,
		);
}

/**
 * The files of the session so far (D-085), each under one spelling.
 * - Modified: what the tools and the harness named, and what git shows changed since the session
 *   started. A path that was dirty before the session and has not changed since is not the
 *   session's. Without the tree's state at the start, git only describes the files already known.
 * - Read: the rest of what was read.
 */
function filesOf(
	request: CompactionRequest,
	tracked: { readonly modified: readonly string[]; readonly read: readonly string[] },
	start: Baseline | undefined,
	workspace: Workspace | undefined,
	cwd: string,
): { readonly modified: string[]; readonly read: string[]; readonly shown: Shown } {
	const spell = (path: string) => workspacePath(path, cwd, workspace?.up ?? 0);
	const named = mergePaths(tracked.modified.map(spell), request.filesModified.map(spell));
	const changes = workspace?.changes ?? new Map();
	const found = start
		? [...changes].filter(([path, change]) => start[path] !== change.print).map(([path]) => path)
		: [];
	// A renamed file is listed under its new name.
	const renamedAway = new Set(
		[...changes.values()].flatMap((change) => (change.from === undefined ? [] : [change.from])),
	);
	const all = [...found.filter((path) => !named.includes(path)), ...named].filter(
		(path) => !renamedAway.has(path) || changes.has(path),
	);
	// The files the tools changed are last, so they are the ones kept when either list is cut.
	const modified = all.slice(-MAX_PATHS);
	const line = (path: string): string => {
		const change = changes.get(path);
		if (!change) return path;
		const notes = [
			...(change.state === "renamed" ? [`renamed from ${change.from ?? "another path"}`] : []),
			...(change.state === "modified" || change.state === "renamed" ? [] : [change.state]),
			...(change.stat === undefined || change.state === "deleted" ? [] : [change.stat]),
			...(start?.[path] === undefined ? [] : [BEFORE_SESSION]),
		];
		return notes.length === 0 ? path : `${path} (${notes.join(", ")})`;
	};
	const listed = modified.slice(-MAX_MODIFIED_FILES);
	const read = mergePaths(tracked.read.map(spell), request.filesRead.map(spell)).filter(
		(path) => !modified.includes(path),
	);
	return { modified, read, shown: { lines: listed.sort().map(line), more: all.length - listed.length } };
}

/** The handover's sections of the summary: its text, and the note on its marks when it has any. */
function narrativeSections(narrative: Narrative | undefined): string[] {
	if (!narrative) return [];
	return narrative.unverified.length > 0 ? [narrative.text, UNVERIFIED_NOTE] : [narrative.text];
}
