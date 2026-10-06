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
const STATE_VERSION = 1;

/**
 * Memory, Phase 5 v1 (brief §6.4 narrowed by research R5.1–R5.5): pitfall cards only. This file
 * composes the parts:
 * - `learn.ts`: a verified error→fix pair becomes a card (D-049, D-072), once `admission.ts` and
 *   the lesson sidecar have not refused it;
 * - `recall.ts`: a failing tool result gets the cards for its problem appended, and each card is
 *   credited by what its command did next;
 * - `preference-session.ts`: with `preferences` on (D-060, D-064), how the user likes work done
 *   is learned from their own messages and added to prompts that leave it unsaid;
 * - `interview.ts`: `/exo memory interview` asks a few questions to start from (D-066).
 *
 * What a task has been shown (cards, preferences) is saved with the harness session, so a module
 * rebuilt by `/exo` or a reload carries on where the last instance stopped (M9).
 */
export function createMemory(raw: Readonly<Record<string, unknown>>, ctx: ModuleContext): ExoModule {
	const { settings, problems } = parseSettings(raw);
	for (const problem of problems) ctx.log(problem);
	const saved = savedParts(ctx.savedState);
	let resolved: RepoScope | undefined;
	let ready = false;
	const deps: MemoryDeps = {
		ctx,
		settings,
		store: storeFor(settings.dbPath, ctx.log),
		scope: repoScope(ctx).catch(() => ({ id: `path:${ctx.cwd}`, known: false })),
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
	deps.scope.then((repo) => {
		resolved = repo;
		if (repo.known) return;
		ctx.log("git did not say which repo this is in time: nothing is learned or recalled in this session");
		ctx.record({ kind: "exo.memory", data: { action: "scope_unknown" } });
	}, ignore);

	return {
		id: MEMORY_ID,

		onUserTurn(turn) {
			if (turn.origin !== "user") return;
			recaller.finishTask();
			learner.reset();
			preferences.heard(turn);
		},

		contextForUserTurn: (turn, signal) => preferences.context(turn, signal),

		onCompacted: () => preferences.compacted(),

		command(args, dialog) {
			if (args.trim() === "interview") return interview(dialog, deps, preferences);
			return recaller.command(args) ?? preferences.command(args);
		},

		onToolResult(tool) {
			recaller.observe(tool);
			if (settings.learn) learner.observe(tool);
		},

		async rewriteToolResult(draft, signal) {
			return settings.inject ? recaller.rewrite(draft, signal) : undefined;
		},

		async onSettle(info) {
			if (info.outcome === "completed") recaller.finishTask();
			learner.settled();
			return preferences.settled(info);
		},

		status() {
			const live = store.cards().filter((c) => c.validTo === null).length;
			const known = settings.preferences ? ` · ${store.preferences().length} preferences` : "";
			const scope = resolved?.known === false ? " · repo unknown: not learning" : "";
			return `${MEMORY_ID} (${live} cards · ${learner.learned()} learned · ${recaller.recalled()} recalled${known}${scope})`;
		},

		/**
		 * The instance is going away: at a session's end, or replaced mid-task. Cards whose outcome is
		 * already settled are credited now, since no later hook may come; the rest stay in the saved
		 * state for the next instance. The store stays open: it is shared by the process.
		 */
		dispose() {
			recaller.finishTask(false);
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
