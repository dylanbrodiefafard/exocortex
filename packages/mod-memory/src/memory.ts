import type { ExoModule, ModuleContext } from "@exocortex/core";
import { MEMORY_ID, type MemoryDeps } from "./deps.ts";
import { interview } from "./interview.ts";
import { createLearner } from "./learn.ts";
import { createPreferenceSession } from "./preference-session.ts";
import { createRecaller } from "./recall.ts";
import { type RepoScope, repoScope } from "./scope.ts";
import { parseSettings } from "./settings.ts";
import { type MemoryStore, openMemoryStore } from "./store.ts";

/** Stores stay open for the process: modules are rebuilt on `/exo` toggles. */
const stores = new Map<string, MemoryStore>();

/** The shape of what is saved with the session (M9); a different version is not read. */
/** 2 (D-109): card ids started again with the store's schema 2, so an older state's ids are not these cards. */
const STATE_VERSION = 2;

/**
 * Memory, Phase 5 v1 (brief §6.4 narrowed by research R5.1–R5.5): pitfall cards only. This file
 * composes the parts:
 * - `learn.ts`: a verified error→fix pair becomes a card (D-049, D-072), once `admission.ts` and
 *   the lesson sidecar have not refused it;
 * - `recall.ts`: a failing tool result gets the cards for its problem appended, and each card is
 *   credited by what its run did next;
 * - `preference-session.ts`: with `preferences` on (D-060, D-064), how the user likes work done
 *   is learned from their own messages and added to prompts that leave it unsaid;
 * - `interview.ts`: `/exo memory interview` asks a few questions to start from (D-066).
 *
 * What a session has been shown (cards, preferences) is saved with the harness session, so a module
 * rebuilt by `/exo` or a reload carries on where the last instance stopped (M9). The user's
 * messages end nothing (D-109): a fix, or a card's outcome, can span a question to the user.
 */
export function createMemory(raw: Readonly<Record<string, unknown>>, ctx: ModuleContext): ExoModule {
	const { settings, problems } = parseSettings(raw);
	for (const problem of problems) ctx.log(problem);
	const saved = savedParts(ctx.savedState);
	let resolved: RepoScope | undefined;
	let ready = false;
	const unknown = (): RepoScope => ({ id: `path:${ctx.cwd}`, known: false });
	let scope = repoScope(ctx).catch(unknown);
	scope.then((repo) => {
		resolved = repo;
		if (repo.known) return;
		ctx.log("git did not say which repo this is in time: nothing is learned or recalled until it does");
		ctx.record({ kind: "exo.memory", data: { action: "scope_unknown" } });
	}, ignore);
	/**
	 * Asks git again, at the user's next message (D-098), one lookup at a time. Readers keep the
	 * answer they have, unknown, until git names the repo: a git that hangs does not hold the hot path.
	 */
	let retrying = false;
	const retry = (): void => {
		if (retrying) return;
		retrying = true;
		repoScope(ctx)
			.catch(unknown)
			.then((repo) => {
				if (!repo.known) return;
				resolved = repo;
				scope = Promise.resolve(repo);
			}, ignore)
			.finally(() => {
				retrying = false;
			});
	};
	const deps: MemoryDeps = {
		ctx,
		settings,
		store: storeFor(settings.dbPath, ctx.log),
		scope: () => scope,
		resolvedScope: () => resolved,
		changed: () => {
			if (ready) ctx.saveState({ v: STATE_VERSION, cards: recaller.state(), preferences: preferences.state() });
		},
	};
	const { store } = deps;
	const learner = createLearner(deps);
	const recaller = createRecaller(deps, saved.cards);
	const preferences = createPreferenceSession(deps, saved.preferences);
	ready = true;

	return {
		id: MEMORY_ID,

		onUserTurn(turn) {
			if (resolved?.known === false) retry();
			if (turn.origin === "user") preferences.heard(turn);
		},

		contextForUserTurn: (turn, signal) => preferences.context(turn, signal),

		onCompacted() {
			recaller.compacted();
			preferences.compacted();
		},

		command(args, dialog) {
			if (args.trim() === "interview") return interview(dialog, deps, preferences);
			return recaller.command(args) ?? preferences.command(args);
		},

		onToolResult(tool) {
			// Before the learner: a fix this result completes is the fix of any card it shows helped.
			const helped = recaller.observe(tool);
			if (settings.learn) learner.observe(tool, helped);
		},

		async rewriteToolResult(draft, signal) {
			return settings.inject ? recaller.rewrite(draft, signal) : undefined;
		},

		/** The agent stopped (whatever other modules then do): the background sidecar can read and write. */
		onSettled(info) {
			learner.settled();
			preferences.settled(info);
		},

		async onSettle() {
			return preferences.notice();
		},

		status() {
			const live = store.cards().filter((c) => c.validTo === null).length;
			const known = settings.preferences ? ` · ${store.preferences().length} preferences` : "";
			const scope = resolved?.known === false ? " · repo unknown: not learning" : "";
			return `${MEMORY_ID} (${live} cards · ${learner.learned()} learned · ${recaller.recalled()} recalled${known}${scope})`;
		},

		/**
		 * The instance is going away: at a session's end, or replaced. Every card shown is credited
		 * with what is known, since no later hook may come; a showing is credited once, so an
		 * instance rebuilt from the saved state cannot count it twice. The store stays open: it is
		 * shared by the process.
		 */
		dispose() {
			recaller.dispose();
		},
	};
}

/** The scope never rejects (see `createMemory`); this only says so to the reader and the linter. */
function ignore(): void {}

/** The parts' saved states, when the session holds one this version wrote. */
function savedParts(state: unknown): { readonly cards: unknown; readonly preferences: unknown } {
	const none = { cards: undefined, preferences: undefined };
	if (typeof state !== "object" || state === null || Array.isArray(state)) return none;
	const { v, cards, preferences } = state as Record<string, unknown>;
	return v === STATE_VERSION ? { cards, preferences } : none;
}

function storeFor(path: string, report: (message: string) => void): MemoryStore {
	const existing = stores.get(path);
	if (existing) return existing;
	const store = openMemoryStore(path, Date.now, report);
	stores.set(path, store);
	return store;
}
