import type { CompactionRequest, ExoModule, JsonValue, ModuleContext } from "@exocortex/core";
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
import { type Narrative, UNVERIFIED_NOTE, writeNarrative } from "./narrative.ts";
import { type FactsView, factsFromSummary, MAX_FILES, renderSummary, type Shown } from "./render.ts";
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

	return {
		id: COMPACTION_ID,

		onUserTurn(turn) {
			// What an extension sent is not the user's request. An accepted suggestion is part of the
			// task's history: it lists what was still missing.
			if (turn.origin === "extension" && turn.text.length <= MAX_EXTENSION_TEXT_CHARS) {
				extensionTexts = [...extensionTexts, turn.text].slice(-MAX_EXTENSION_TEXTS);
			}
			// Once per prompt: what the last run tracked is kept before the next one starts.
			save();
		},

		onToolResult(tool) {
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

			const narrative = await writeNarrative(ctx, settings, request, signal);
			if (!narrative && settings.fallback === "harness") return undefined;
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
				},
			});
			return {
				summary: renderSummary(view, narrativeSections(narrative), settings),
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
			// The harness compacted, with this module's summary or its own: either way the span's
			// requests are no longer in the context.
			if (!pending) return;
			settled = pending;
			pending = undefined;
			save();
		},

		dispose() {
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
	const listed = modified.slice(-MAX_FILES);
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
