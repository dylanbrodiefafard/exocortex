import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	cosineSimilarity,
	fileEdits,
	type JsonValue,
	type ModuleContext,
	outcomeOf,
	type ToolOutcome,
	type ToolResultDraft,
	type ToolRewrite,
} from "@exocortex/core";
import { deadEndsIn } from "./dead-ends.ts";
import type { MemoryDeps } from "./deps.ts";
import { anchorOf, cardDetail, type Failure, failureOf, identity, lineOf, problemKey } from "./detail.ts";
import { repoPath } from "./paths.ts";
import { type Problem, problemIn } from "./problem.ts";
import { covers, runOf } from "./runs.ts";
import type { RepoScope } from "./scope.ts";
import type { MemorySettings } from "./settings.ts";
import type { Card, MemoryStore } from "./store.ts";
import { clip, inert, oneLine } from "./text.ts";

/** Cards embedded per background backfill (cards learned before an embeddings server was configured). */
const BACKFILL_BATCH = 64;
/**
 * A shown card's outcome is settled once this many test or build runs of other runners have gone
 * by without its own: the agent has moved on from the failure it was shown for.
 */
const SETTLE_RUNS = 8;
/** Edited files remembered per shown card: enough to see whether the agent went where the card pointed. */
const MAX_EDITED_FILES = 24;
/** Cards listed by `/exo memory cards`. */
const MAX_LISTED_CARDS = 40;

/** How a recalled card relates to the failure it is shown for. */
type Match = "same" | "similar" | "elsewhere";
const MATCHES: readonly Match[] = ["same", "similar", "elsewhere"];

interface Recalled {
	readonly card: Card;
	readonly match: Match;
}

/** A card shown in this session, and what the run it was shown for did afterwards. */
interface Shown {
	readonly card: Card;
	readonly match: Match;
	/** Names this showing for its credit: a showing is credited once (`store.credit`). */
	readonly key: string;
	/** The problem whose return counts against the card: its own, or for a similar card the failure's. */
	readonly problem: Problem;
	/** The run it was shown for (D-109): a pass of the same runner that covers the problem settles it. */
	readonly runner: string | undefined;
	readonly filters: readonly string[];
	/** What the failure it was shown for is named by, where the card's problem is in it. */
	readonly named: readonly string[];
	/** Files of the repo edited since the card was shown. */
	readonly edited: Set<string>;
	/** Times the card's problem came back after it was shown. */
	recurred: number;
	/** Test or build runs of other runners since its own last ran. */
	idle: number;
	passed: boolean;
	/** At the pass, the agent had edited a file the card names: the pass can be put down to the card. */
	followed: boolean;
}

export interface Recaller {
	/** The cards for a failing result, each at most once per session (until compaction). Counted as shown when committed. */
	rewrite(draft: ToolResultDraft, signal: AbortSignal): Promise<ToolRewrite | undefined>;
	/**
	 * What each card shown sees next: edits, its problem again, its run passing, or other runs going
	 * by. Returns the cards this result showed to have helped: a fix learned from it is theirs.
	 */
	observe(tool: ToolOutcome): readonly number[];
	/**
	 * The instance is going away: every card still waiting for an outcome is credited with what
	 * is known. A showing is credited once, so an instance rebuilt from the saved state cannot
	 * credit it again.
	 */
	dispose(): void;
	/** Text added earlier may be gone from the context: every card may be shown again. */
	compacted(): void;
	/** `/exo memory cards` lists this repo's cards; `/exo memory forget card <id>` retires one. */
	command(args: string): string | undefined | Promise<string>;
	/** What must survive a rebuild of the module: the cards shown so far (M9). */
	state(): JsonValue;
	/** Cards shown by this instance. */
	recalled(): number;
}

/**
 * Recall and credit (D-049, D-072, D-109).
 * - A failing tool result with a card's key on any of its failure lines, and enough of its names,
 *   gets the lesson appended, within ~400 tokens, worded as a past fix to check. No LLM on the
 *   hot path.
 * - A card is credited `helped` when a run of the runner it was shown for went on to pass, covering
 *   the problem, after edits to a file the card names (M4); a pass without them is `withheld`
 *   (the agent fixed it another way). One whose problem came back and whose run never passed is
 *   `hurt` once that is settled: the agent ran other tests for a while, or the session ended.
 *   Cards that hurt more than they help retire.
 */
export function createRecaller({ ctx, settings, store, scope, changed }: MemoryDeps, saved: unknown): Recaller {
	const injected = new Map<number, Shown>();
	/** Cards shown and settled in this session: not shown again until the context is compacted. */
	const done = new Set<number>();
	let recalled = 0;
	/** Cards the result being observed showed to have helped. */
	let helpedNow: number[] = [];
	try {
		restore(saved);
	} catch (error) {
		ctx.log(`saved state not restored: ${String(error)}`);
	}

	/** Saved state is untrusted (another version may have written it): anything unexpected is skipped. */
	function restore(value: unknown): void {
		if (!isRecord(value)) return;
		for (const id of asArray(value["done"])) {
			if (typeof id === "number") done.add(id);
		}
		for (const item of asArray(value["cards"])) {
			const shown = isRecord(item) ? restoreShown(item) : undefined;
			if (shown) injected.set(shown.card.id, shown);
		}
	}

	function restoreShown(item: Record<string, unknown>): Shown | undefined {
		const { id, key, signature, detail, runner, filters, named, match, recurred, idle, edited } = item;
		if (typeof id !== "number" || typeof signature !== "string" || typeof key !== "string") return undefined;
		const card = store.card(id);
		if (!card || card.validTo !== null) return undefined;
		const strings = (value: unknown) => asArray(value).filter((x) => typeof x === "string");
		return {
			card,
			key,
			problem: { signature, detail: strings(detail) },
			match: MATCHES.find((m) => m === match) ?? "same",
			runner: typeof runner === "string" ? runner : undefined,
			filters: strings(filters),
			named: strings(named),
			edited: new Set(strings(edited)),
			recurred: typeof recurred === "number" ? recurred : 0,
			idle: typeof idle === "number" ? idle : 0,
			passed: item["passed"] === true,
			followed: item["followed"] === true,
		};
	}

	/**
	 * The same problem first. Otherwise cards whose trigger shares most of the error's keywords, plus,
	 * with an embeddings server, cards whose trigger means the same in other words (D-062).
	 */
	async function recallCards(repo: string, failure: Failure, output: string, signal: AbortSignal) {
		const byKeywords = recall(store, repo, failure, output, settings);
		if (byKeywords.some((r) => r.match !== "similar")) return byKeywords;
		const bySimilarity = (await similarCards(repo, failure.keys, output, signal)).map((card) => ({
			card,
			match: "similar" as const,
		}));
		const merged = new Map([...byKeywords, ...bySimilarity].map((r) => [r.card.id, r]));
		return rank([...merged.values()]).slice(0, settings.maxCards);
	}

	async function similarCards(
		repo: string,
		own: ReadonlySet<string>,
		output: string,
		signal: AbortSignal,
	): Promise<Card[]> {
		const embedder = ctx.embedder();
		const line = anchorOf(output)?.line;
		if (!embedder || !line) return [];
		const live = store.cards(repo).filter((c) => c.validTo === null && !own.has(c.signature));
		const vectors = store.vectors("card", embedder.model, repo);
		const missing = live.filter((c) => !vectors.has(c.id)).slice(0, BACKFILL_BATCH);
		// Not awaited: the agent is waiting on this result. They are there for the next failure.
		if (missing.length > 0)
			embedCards(ctx, store, missing).catch((error: unknown) => ctx.log(`embedding failed: ${String(error)}`));
		const known = live.filter((c) => vectors.has(c.id));
		if (known.length === 0) return [];
		const started = Date.now();
		const [query] = (await embedder.embed([line], { timeoutMs: settings.embedTimeoutMs, signal })) ?? [];
		if (!query) {
			// The embedder reports why; this says what it cost: the lookup by meaning was skipped.
			if (!signal.aborted && Date.now() - started >= settings.embedTimeoutMs) {
				ctx.log(`embedding lookup took over ${settings.embedTimeoutMs} ms: similar cards were found by keywords only`);
			}
			return [];
		}
		return known.filter((c) => cosineSimilarity(query, vectors.get(c.id) as Float32Array) >= settings.minSimilarity);
	}

	/**
	 * A card of this repo whose files are all gone points at code that is no longer there: it is
	 * not shown, but kept, since a branch switch can bring the files back. Another repo's card names
	 * no files here.
	 */
	function stale({ card, match }: Recalled): boolean {
		if (match === "elsewhere" || card.files.length === 0) return false;
		if (card.files.some((file) => existsNear(ctx.cwd, file))) return false;
		ctx.record({ kind: "exo.memory", data: { action: "skipped_stale", card: card.id } });
		return true;
	}

	/** Whether the pass came after the agent went where the card pointed. */
	function follows(shown: Shown): boolean {
		// Another repo's files are not this repo's: any edit before the pass counts.
		if (shown.match === "elsewhere") return shown.edited.size > 0;
		return shown.card.files.some((file) => shown.edited.has(file));
	}

	/** Files edited since each card was shown. True when something new was noted. */
	function noteEdits(paths: readonly string[]): boolean {
		let added = false;
		for (const path of paths.flatMap((p) => repoPath(ctx.cwd, p) ?? [])) {
			for (const shown of injected.values()) {
				if (shown.edited.has(path) || shown.edited.size >= MAX_EDITED_FILES) continue;
				shown.edited.add(path);
				added = true;
			}
		}
		return added;
	}

	/**
	 * A command's result: a shown card's problem again, its run passing, or a run of other tests
	 * going by. True when anything was noted.
	 */
	function noteRun(tool: ToolOutcome): boolean {
		const line = tool.input["command"];
		if (typeof line !== "string") return false;
		const run = runOf(line, ctx.cwd);
		const outcome = outcomeOf(tool);
		const failed = outcome === "failed" && failureOf(tool.toolName, tool.output);
		const text = `${line}\n${tool.output}`;
		let seen = false;
		for (const shown of injected.values()) {
			const own = run !== undefined && run.runner === shown.runner;
			if (failed && problemIn(shown.problem, failed, settings.minDetail)) {
				shown.recurred += 1;
				seen = true;
			} else if (
				own &&
				outcome === "passed" &&
				covers({ ...shown, runner: run.runner }, run, text, settings.minDetail)
			) {
				shown.passed = true;
				shown.followed = follows(shown);
				if (shown.followed) helpedNow.push(shown.card.id);
				seen = true;
			}
			seen = idled(shown, own, run?.verifying === true) || seen;
		}
		return seen;
	}

	/** A run of the shown card's runner resets its count of other runs; another test or build run adds to it. */
	function idled(shown: Shown, own: boolean, verifying: boolean): boolean {
		if (own) shown.idle = 0;
		else if (verifying) shown.idle += 1;
		return !own && verifying;
	}

	/** What a shown card is credited with; "keep" while it may still go either way (D-109 order). */
	function verdict(shown: Shown, final: boolean): "hurt" | "helped" | "withheld" | "none" | "keep" {
		if (shown.passed) return shown.followed ? "helped" : "withheld";
		if (!final && shown.idle < SETTLE_RUNS) return "keep";
		return shown.recurred > 0 ? "hurt" : "none";
	}

	/** Credits the shown cards whose outcome is known, or all of them when `final`. */
	function settle(final: boolean): void {
		try {
			for (const [id, shown] of [...injected]) credit(id, shown, final);
			store.retireUnhelpful();
		} catch (error) {
			// What could not be credited is let go, not carried over.
			ctx.log(`credit failed: ${String(error)}`);
			for (const id of injected.keys()) done.add(id);
			injected.clear();
		} finally {
			changed();
		}
	}

	/** Credits one shown card and lets it go, unless it is too early to say. */
	function credit(id: number, shown: Shown, final: boolean): void {
		const outcome = verdict(shown, final);
		if (outcome === "keep") return;
		injected.delete(id);
		done.add(id);
		if (outcome === "withheld") ctx.record({ kind: "exo.memory", data: { action: "credit_withheld", card: id } });
		if (outcome !== "hurt" && outcome !== "helped") return;
		// A showing an earlier instance already credited is not counted twice.
		if (store.credit(id, outcome, shown.key)) {
			ctx.record({ kind: "exo.memory", data: { action: "credited", card: id, outcome } });
		}
	}

	function listCards(repo: RepoScope): string {
		const live = store.cards(repo.id).filter((c) => c.validTo === null);
		if (live.length === 0) return "No cards for this repo yet.";
		const lines = live.slice(-MAX_LISTED_CARDS).map((c) => {
			const files = c.files.map(inert).join(", ") || "none";
			const counts = `seen ${c.seen}×, shown ${c.injected}×, helped ${c.helped}×, hurt ${c.hurt}×`;
			return `${c.id}. ${inert(c.lesson)} (for: ${oneLine(inert(c.trigger), 120)}; files: ${files}; ${counts})`;
		});
		const more = live.length > lines.length ? [`(${live.length - lines.length} older cards not listed)`] : [];
		return [...more, ...lines, "/exo memory forget card <id> removes one."].join("\n");
	}

	/** The problem a showing watches for: the card's own, or for a card of another kind of error, the failure's. */
	function problemOf({ card, match }: Recalled, draft: ToolResultDraft): Problem {
		if (match !== "similar") return card;
		const anchor = anchorOf(draft.output);
		return anchor
			? { signature: problemKey(draft.toolName, anchor.line), detail: cardDetail(draft.output, anchor.index) }
			: card;
	}

	/** What the failure a card is shown for is named by, at the line its problem is on. */
	function namedIn({ card, match }: Recalled, draft: ToolResultDraft): string[] {
		const at = match === "similar" ? anchorOf(draft.output) : lineOf(draft.toolName, draft.output, card.signature);
		return at ? identity(draft.output, at.index) : [];
	}

	return {
		async rewrite(draft, signal) {
			const line = draft.input["command"];
			if (outcomeOf(draft) !== "failed" || typeof line !== "string") return undefined;
			const repo = await scope();
			if (!repo.known) return undefined;
			const failure = failureOf(draft.toolName, draft.output);
			const cards = (await recallCards(repo.id, failure, draft.output, signal)).filter(
				(r) => !injected.has(r.card.id) && !done.has(r.card.id) && !stale(r),
			);
			if (cards.length === 0) return undefined;
			return {
				text: `${draft.current}\n${renderCards(cards, settings.maxInjectChars)}`,
				note: `recalled ${cards.length} card(s)`,
				// Only once the note is in the result the agent reads (D-078): a rewrite that lost its
				// time budget showed nothing, and must not be credited for what the agent did next.
				commit: () => {
					try {
						const run = runOf(line, ctx.cwd);
						const at = Date.now();
						for (const recalledCard of cards) {
							const { card, match } = recalledCard;
							injected.set(card.id, {
								card,
								match,
								key: `${ctx.sessionId}:${at}:${card.id}`,
								problem: problemOf(recalledCard, draft),
								runner: run?.runner,
								filters: run?.filters ?? [],
								named: namedIn(recalledCard, draft),
								edited: new Set(),
								recurred: 0,
								idle: 0,
								passed: false,
								followed: false,
							});
							store.markInjected(card.id);
						}
						recalled += cards.length;
						ctx.record({
							kind: "exo.memory",
							data: {
								action: "recalled",
								cards: cards.map((r) => r.card.id),
								matches: cards.map((r) => r.match),
								signature: cards[0]?.card.signature ?? null,
							},
						});
						changed();
					} catch (error) {
						ctx.log(`recall not recorded: ${String(error)}`);
					}
				},
			};
		},

		observe(tool) {
			if (injected.size === 0) return [];
			helpedNow = [];
			const edits = fileEdits(tool, 0);
			if (!(edits ? noteEdits(edits.map((edit) => edit.path)) : noteRun(tool))) return [];
			if ([...injected.values()].some((shown) => verdict(shown, false) !== "keep")) settle(false);
			else changed();
			return helpedNow;
		},

		dispose: () => settle(true),

		compacted() {
			if (done.size === 0) return;
			done.clear();
			changed();
		},

		command(args) {
			const [sub, kind, arg] = args.trim().split(/\s+/);
			if (sub === "forget" && kind === "card") {
				const id = Number.parseInt(arg ?? "", 10);
				if (!Number.isInteger(id)) return "Usage: /exo memory forget card <id>";
				if (!store.retire(id)) return `No card ${id}.`;
				if (injected.delete(id)) changed();
				ctx.record({ kind: "exo.memory", data: { action: "card_retired", card: id, by: "user" } });
				return `Forgot card ${id}.`;
			}
			return sub === "cards" ? scope().then(listCards) : undefined;
		},

		state() {
			return {
				cards: [...injected.values()].map((shown) => ({
					id: shown.card.id,
					key: shown.key,
					signature: shown.problem.signature,
					detail: [...shown.problem.detail],
					runner: shown.runner ?? null,
					filters: [...shown.filters],
					named: [...shown.named],
					match: shown.match,
					recurred: shown.recurred,
					idle: shown.idle,
					passed: shown.passed,
					followed: shown.followed,
					edited: [...shown.edited],
				})),
				done: [...done],
			};
		},

		recalled: () => recalled,
	};
}

function asArray(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function embedCards(
	ctx: ModuleContext,
	store: MemoryStore,
	cards: readonly { readonly id: number; readonly trigger: string }[],
): Promise<void> {
	const embedder = ctx.embedder();
	if (!embedder || cards.length === 0) return;
	const vectors = await embedder.embed(cards.map((c) => c.trigger));
	vectors?.forEach((vector, i) => {
		const card = cards[i];
		if (card) store.setVector("card", card.id, embedder.model, vector);
	});
}

/**
 * Cards for the failure in `output`, in this order (D-072, D-109):
 * 1. the same problem in this repo: a card whose key is on any of the failure's lines, and at
 *    least `minDetail` of whose names the failure mentions;
 * 2. the same problem fixed in 2+ other repos (D-018 promotion), without their file names (M8);
 * 3. cards of this repo for another kind of error whose trigger shares most of the failure's
 *    first line's keywords. A card with one of these keys that failed the name check is a
 *    different problem, not a similar one.
 */
export function recall(
	store: MemoryStore,
	scope: string,
	failure: Failure,
	output: string,
	settings: Pick<MemorySettings, "maxCards" | "minOverlap" | "minDetail">,
): Recalled[] {
	const own = failure.keys;
	const sameProblem = store.bySignatures([...own]).filter((c) => problemIn(c, failure, settings.minDetail));
	const local = sameProblem.filter((c) => c.scope === scope);
	if (local.length > 0) return top(local, "same", settings.maxCards);
	const elsewhere = sameProblem.filter((c) => c.scope !== scope).map((c) => ({ ...c, files: [] }));
	if (new Set(elsewhere.map((c) => c.scope)).size >= 2) return top(elsewhere, "elsewhere", settings.maxCards);
	const line = anchorOf(output)?.line;
	if (!line) return [];
	const similar = store
		.search(scope, line, settings.maxCards * 2)
		.filter((m) => m.overlap >= settings.minOverlap && !own.has(m.card.signature))
		.map((m) => m.card);
	return top(similar, "similar", settings.maxCards);
}

function top(cards: readonly Card[], match: Match, max: number): Recalled[] {
	return rank(cards.map((card) => ({ card, match }))).slice(0, max);
}

/** Proven cards first: helped − hurt, then how often the lesson was seen. */
function rank(recalled: readonly Recalled[]): Recalled[] {
	return [...recalled].sort(({ card: a }, { card: b }) => b.helped - b.hurt - (a.helped - a.hurt) || b.seen - a.seen);
}

const MATCH_LABEL: Readonly<Record<Match, string>> = {
	same: "this error, this repo",
	similar: "a similar error, this repo",
	elsewhere: "this error, other repos",
};

const CARDS_HEADER =
	"[exo memory: notes from earlier fixes, each written after a failing command passed. The code may have changed since: check a note against the current code before relying on it.]";

/**
 * What the agent reads. It says what a card is (a change after which a failing command passed)
 * and that the code may have moved on, and each card says how it matched and which files the fix
 * touched, so the agent can check it instead of taking it on trust (D-072). A lesson and its file
 * names are one line of plain text, whatever was stored (M8).
 */
function renderCards(cards: readonly Recalled[], maxChars: number): string {
	const lines = cards.map(({ card, match }) => {
		const files = card.files.length > 0 ? `; the fix edited ${card.files.map(inert).join(", ")}` : "";
		// Another repo's files mean nothing here.
		const deadEnds = match === "elsewhere" ? [] : deadEndsIn(card);
		const tried =
			deadEnds.length > 0 ? `; the error came back after the edits to ${deadEnds.map(inert).join(", ")}` : "";
		return `- (${MATCH_LABEL[match]}${files}${tried}) ${inert(card.lesson)}${card.seen > 1 ? ` (seen ${card.seen}×)` : ""}`;
	});
	return clip(`${CARDS_HEADER}\n${lines.join("\n")}`, maxChars);
}

/**
 * Whether a card's repo-relative file exists under `cwd` or a directory above it: a session started
 * in a subdirectory of the repo still finds files learned from its root. Erring toward "exists"
 * only keeps a card that may be stale.
 */
function existsNear(cwd: string, file: string): boolean {
	for (let dir = cwd; ; dir = dirname(dir)) {
		try {
			if (existsSync(join(dir, file))) return true;
		} catch {
			return true;
		}
		if (dirname(dir) === dir) return false;
	}
}
