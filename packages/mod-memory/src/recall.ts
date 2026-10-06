import {
	cosineSimilarity,
	errorSignature,
	fileEdits,
	firstErrorLine,
	type JsonValue,
	type ModuleContext,
	outcomeOf,
	type ToolOutcome,
	type ToolResultDraft,
	type ToolRewrite,
} from "@exocortex/core";
import type { MemoryDeps } from "./deps.ts";
import { FAILURE_DETAIL_LINES, failureDetail } from "./detail.ts";
import { commandKey } from "./episodes.ts";
import { repoPath } from "./paths.ts";
import { problemIn } from "./problem.ts";
import type { RepoScope } from "./scope.ts";
import type { MemorySettings } from "./settings.ts";
import type { Card, MemoryStore } from "./store.ts";
import { clip, inert, oneLine } from "./text.ts";

/** Cards embedded per background backfill (cards learned before an embeddings server was configured). */
const BACKFILL_BATCH = 64;
/** A card's problem coming back this often after the card was shown means the card did not fix it. */
const HURT_RECURRENCES = 2;
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

/** A card shown in this task, and what the command it was shown for did afterwards. */
interface Shown {
	readonly card: Card;
	readonly match: Match;
	readonly signature: string;
	readonly command: string | undefined;
	/** Files of the repo edited since the card was shown. */
	readonly edited: Set<string>;
	/** Times the card's problem came back after it was shown. */
	recurred: number;
	passed: boolean;
	/** At the pass, the agent had edited a file the card names: the pass can be put down to the card. */
	followed: boolean;
}

export interface Recaller {
	/** The cards for a failing result, each at most once per task. Counted as shown when committed. */
	rewrite(draft: ToolResultDraft, signal: AbortSignal): Promise<ToolRewrite | undefined>;
	/** What each card shown in this task sees next: edits, its problem again, or its command passing. */
	observe(tool: ToolOutcome): void;
	/**
	 * Credits each card shown in the task by what its command did next, then forgets them. With
	 * `final` false (the instance is going away mid-task) only what is already settled is credited:
	 * the rest stays in {@link Recaller.state} for the next instance.
	 */
	finishTask(final?: boolean): void;
	/** `/exo memory cards` lists this repo's cards; `/exo memory forget card <id>` retires one. */
	command(args: string): string | undefined | Promise<string>;
	/** What must survive a rebuild of the module: the cards shown in the task so far (M9). */
	state(): JsonValue;
	/** Cards shown by this instance. */
	recalled(): number;
}

/**
 * Recall and credit (D-049, D-072).
 * - A failing tool result with a card's signature and enough of its names gets the lesson
 *   appended, within ~400 tokens, worded as a past fix to check. No LLM on the hot path.
 * - A card is credited `helped` when the command it was shown for went on to pass after edits to
 *   a file the card names (M4), `hurt` when its problem kept coming back; cards that hurt more
 *   than they help retire. A pass that came without touching the card's files credits nothing:
 *   the agent fixed it another way, or nothing was fixed.
 */
export function createRecaller({ ctx, settings, store, scope, changed }: MemoryDeps, saved: unknown): Recaller {
	const injected = new Map<number, Shown>();
	/** Cards shown and already credited in this task: not shown again before the next one. */
	const done = new Set<number>();
	let recalled = 0;
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
		const { id, signature, command, match, recurred, edited } = item;
		if (typeof id !== "number" || typeof signature !== "string") return undefined;
		const card = store.card(id);
		if (!card || card.validTo !== null) return undefined;
		return {
			card,
			signature,
			match: MATCHES.find((m) => m === match) ?? "same",
			command: typeof command === "string" ? command : undefined,
			edited: new Set(asArray(edited).filter((path) => typeof path === "string")),
			recurred: typeof recurred === "number" ? recurred : 0,
			passed: item["passed"] === true,
			followed: item["followed"] === true,
		};
	}

	/**
	 * The same problem first. Otherwise cards whose trigger shares most of the error's keywords, plus,
	 * with an embeddings server, cards whose trigger means the same in other words (D-062).
	 */
	async function recallCards(
		repo: string,
		signature: string,
		output: string,
		signal: AbortSignal,
	): Promise<Recalled[]> {
		const byKeywords = recall(store, repo, signature, output, settings);
		if (byKeywords.some((r) => r.match !== "similar")) return byKeywords;
		const bySimilarity = (await similarCards(repo, signature, output, signal)).map((card) => ({
			card,
			match: "similar" as const,
		}));
		const merged = new Map([...byKeywords, ...bySimilarity].map((r) => [r.card.id, r]));
		return rank([...merged.values()]).slice(0, settings.maxCards);
	}

	async function similarCards(repo: string, signature: string, output: string, signal: AbortSignal): Promise<Card[]> {
		const embedder = ctx.embedder();
		const line = firstErrorLine(output)?.line;
		if (!embedder || !line) return [];
		const live = store.cards(repo).filter((c) => c.validTo === null && c.signature !== signature);
		const vectors = store.vectors("card", embedder.model, repo);
		const missing = live.filter((c) => !vectors.has(c.id)).slice(0, BACKFILL_BATCH);
		// Not awaited: the agent is waiting on this result. They are there for the next failure.
		if (missing.length > 0)
			embedCards(ctx, store, missing).catch((error: unknown) => ctx.log(`embedding failed: ${String(error)}`));
		const known = live.filter((c) => vectors.has(c.id));
		if (known.length === 0) return [];
		const [query] = (await embedder.embed([line], { timeoutMs: settings.embedTimeoutMs, signal })) ?? [];
		if (!query) return [];
		return known.filter((c) => cosineSimilarity(query, vectors.get(c.id) as Float32Array) >= settings.minSimilarity);
	}

	/** Whether the pass came after the agent went where the card pointed. */
	function follows(shown: Shown): boolean {
		// Another repo's files are not this repo's: any edit before the pass counts.
		if (shown.match === "elsewhere") return shown.edited.size > 0;
		// A card that names no files (learned before D-072) has nothing to check the pass against.
		return shown.card.files.length === 0 || shown.card.files.some((file) => shown.edited.has(file));
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

	/** A command's result: a shown card's problem again, or its command passing. True when either was seen. */
	function noteRun(tool: ToolOutcome): boolean {
		const signature = failureSignature(tool);
		const names = signature ? new Set(failureDetail(tool.output, FAILURE_DETAIL_LINES)) : undefined;
		const passed = !names && outcomeOf(tool) === "passed" ? commandKey(tool) : undefined;
		let seen = false;
		for (const shown of injected.values()) {
			// The failure the card was shown for, which for a similar error is not the card's own kind.
			const problem = { signature: shown.signature, detail: shown.card.detail };
			if (names && problemIn(problem, signature, names, settings.minDetail)) {
				shown.recurred += 1;
				seen = true;
			} else if (passed !== undefined && passed === shown.command && !shown.passed) {
				shown.passed = true;
				shown.followed = follows(shown);
				seen = true;
			}
		}
		return seen;
	}

	/** What a card shown in the task is credited with; "keep" when it is too early to say. */
	function verdict(shown: Shown, final: boolean): "hurt" | "helped" | "withheld" | "none" | "keep" {
		if (shown.recurred >= HURT_RECURRENCES) return "hurt";
		if (shown.passed) return shown.followed ? "helped" : "withheld";
		// Mid-task, a card whose command has not passed yet may still go either way.
		if (!final) return "keep";
		return shown.recurred > 0 ? "hurt" : "none";
	}

	/** Credits one shown card and lets it go, unless it is too early to say. */
	function credit(id: number, shown: Shown, final: boolean): void {
		const outcome = verdict(shown, final);
		if (outcome === "keep") return;
		injected.delete(id);
		if (!final) done.add(id);
		if (outcome === "withheld") ctx.record({ kind: "exo.memory", data: { action: "credit_withheld", card: id } });
		if (outcome !== "hurt" && outcome !== "helped") return;
		store.credit(id, outcome);
		ctx.record({ kind: "exo.memory", data: { action: "credited", card: id, outcome } });
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

	return {
		async rewrite(draft, signal) {
			const signature = failureSignature(draft);
			const repo = await scope;
			if (!signature || !repo.known) return undefined;
			const cards = (await recallCards(repo.id, signature, draft.output, signal)).filter(
				(r) => !injected.has(r.card.id) && !done.has(r.card.id),
			);
			if (cards.length === 0) return undefined;
			return {
				text: `${draft.current}\n${renderCards(cards, settings.maxInjectChars)}`,
				note: `recalled ${cards.length} card(s)`,
				// Only once the note is in the result the agent reads (D-078): a rewrite that lost its
				// time budget showed nothing, and must not be credited for what the agent did next.
				commit: () => {
					try {
						for (const { card, match } of cards) {
							injected.set(card.id, {
								card,
								match,
								signature,
								command: commandKey(draft),
								edited: new Set(),
								recurred: 0,
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
								signature,
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
			if (injected.size === 0) return;
			const edits = fileEdits(tool, 0);
			if (edits ? noteEdits(edits.map((edit) => edit.path)) : noteRun(tool)) changed();
		},

		/**
		 * (D-072, M4)
		 * - `hurt`: the card's problem came back twice or more, or came back and the command never passed.
		 * - `helped`: the command passed after edits to a file the card names.
		 * - Neither: the agent never ran the command again, or it passed without the card's files
		 *   being touched, so nothing shows what the card did.
		 */
		finishTask(final = true) {
			try {
				for (const [id, shown] of [...injected]) credit(id, shown, final);
				store.retireUnhelpful();
			} catch (error) {
				// The task ends all the same: what could not be credited is let go, not carried over.
				ctx.log(`credit failed: ${String(error)}`);
				if (!final) for (const id of injected.keys()) done.add(id);
				injected.clear();
			} finally {
				if (final) done.clear();
				changed();
			}
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
			return sub === "cards" ? scope.then(listCards) : undefined;
		},

		state() {
			return {
				cards: [...injected.values()].map((shown) => ({
					id: shown.card.id,
					signature: shown.signature,
					command: shown.command ?? null,
					match: shown.match,
					recurred: shown.recurred,
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
 * Cards for the failure in `output`, in this order (D-072):
 * 1. the same problem in this repo: the signature, and at least `minDetail` of the card's names;
 * 2. the same problem fixed in 2+ other repos (D-018 promotion). Only lessons a sidecar wrote,
 *    and without their file names (M8): a deterministic lesson quotes the other repo's code;
 * 3. cards of this repo for another kind of error whose trigger shares most of this error's
 *    keywords. A card with this signature that failed the name check is a different problem,
 *    not a similar one.
 */
export function recall(
	store: MemoryStore,
	scope: string,
	signature: string,
	output: string,
	settings: Pick<MemorySettings, "maxCards" | "minOverlap" | "minDetail">,
): Recalled[] {
	const names = new Set(failureDetail(output, FAILURE_DETAIL_LINES));
	const sameProblem = store.bySignature(signature).filter((c) => problemIn(c, signature, names, settings.minDetail));
	const local = sameProblem.filter((c) => c.scope === scope);
	if (local.length > 0) return top(local, "same", settings.maxCards);
	const elsewhere = sameProblem.filter((c) => c.scope !== scope && c.distilled).map((c) => ({ ...c, files: [] }));
	if (new Set(elsewhere.map((c) => c.scope)).size >= 2) return top(elsewhere, "elsewhere", settings.maxCards);
	const line = firstErrorLine(output)?.line;
	if (!line) return [];
	const similar = store
		.search(scope, line, settings.maxCards * 2)
		.filter((m) => m.overlap >= settings.minOverlap && m.card.signature !== signature)
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
		return `- (${MATCH_LABEL[match]}${files}) ${inert(card.lesson)}${card.seen > 1 ? ` (seen ${card.seen}×)` : ""}`;
	});
	return clip(`${CARDS_HEADER}\n${lines.join("\n")}`, maxChars);
}

function failureSignature(tool: ToolOutcome): string | undefined {
	if (outcomeOf(tool) !== "failed" || typeof tool.input["command"] !== "string") return undefined;
	return errorSignature(tool.toolName, tool.exitCode, tool.output);
}
