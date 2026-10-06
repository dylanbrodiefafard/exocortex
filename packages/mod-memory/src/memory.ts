import { randomUUID } from "node:crypto";
import {
	cosineSimilarity,
	type Dialog,
	type ExoModule,
	errorSignature,
	firstErrorLine,
	loadPrompt,
	type ModuleContext,
	SIDECAR_MAX_TOKENS,
	type ToolOutcome,
	ungroundedReferences,
} from "@exocortex/core";
import { Type } from "typebox";
import { detailShare, FAILURE_DETAIL_LINES, failureDetail } from "./detail.ts";
import { commandKey, createEpisodeTracker, editsOf, type FixEpisode } from "./episodes.ts";
import { INTERVIEW, type InterviewOption, type InterviewQuestion, runInterview } from "./interview.ts";
import {
	type ActivePreference,
	type Admitted,
	activePreferences,
	admitPreference,
	alreadySaid,
	renderPreferences,
	sameRule,
	withKind,
} from "./preferences.ts";
import { type MemorySettings, parseSettings } from "./settings.ts";
import {
	type Card,
	type MemoryStore,
	openMemoryStore,
	type SightingSource,
	type StoredPreference,
	TASK_KINDS,
} from "./store.ts";

export const MEMORY_ID = "memory";

const LESSON_PROMPT = loadPrompt(new URL("../prompts/lesson.v2.md", import.meta.url));

const LessonSchema = Type.Object({
	lesson: Type.String({ maxLength: 800 }),
	applies_when: Type.String({ maxLength: 200 }),
});

const PREFERENCES_PROMPT = loadPrompt(new URL("../prompts/preferences.v3.md", import.meta.url));

const PreferencesSchema = Type.Object({
	preferences: Type.Array(
		Type.Object({
			rule: Type.String({ maxLength: 300 }),
			quote: Type.String({ maxLength: 400 }),
			standing: Type.Boolean(),
			applies_to: Type.Union(TASK_KINDS.map((kind) => Type.Literal(kind))),
			correction: Type.Boolean(),
			same_as: Type.Integer({ minimum: 0 }),
			replaces: Type.Integer({ minimum: 0 }),
		}),
		{ maxItems: 4 },
	),
});

/** The sidecar read the fix and found nothing worth remembering: no card, not even a deterministic one. */
const NOT_REUSABLE = "";
const SELECT_PROMPT = loadPrompt(new URL("../prompts/preference-select.v2.md", import.meta.url));

const SelectionSchema = Type.Object({ apply: Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 10 }) });

const LESSON_CHARS = 400;
const SELECT_REQUEST_CHARS = 3_000;
/** Cards embedded per background backfill (cards learned before an embeddings server was configured). */
const BACKFILL_BATCH = 64;
/** Shorter messages ("yes", "continue", "thanks") cannot state a preference worth a sidecar call. */
const MIN_PREFERENCE_MESSAGE_CHARS = 20;
const PREFERENCE_MESSAGE_CHARS = 4_000;
/** Enough of the agent's last message to tell a correction of it from a new request (D-064). */
const PREFERENCE_CONTEXT_CHARS = 1_200;
/** Known preferences shown to the sidecar so it can say "same as" or "replaces". */
const MAX_KNOWN_PREFERENCES = 30;
/** Prompts with fewer words are not tasks ("thanks", "go on"): nothing is added to them. */
const MIN_PROMPT_WORDS = 4;
const INTERVIEW_QUOTE_CHARS = 300;
const GIT_TIMEOUT_MS = 5_000;
/** Edited files named on a card. */
const MAX_CARD_FILES = 6;

/** Stores stay open for the process: modules are rebuilt on `/exo` toggles. */
const stores = new Map<string, MemoryStore>();

/** How a recalled card relates to the failure it is shown for. */
type Match = "same" | "similar" | "elsewhere";

interface Recalled {
	readonly card: Card;
	readonly match: Match;
}

/** A card shown in this task, and what the command it was shown for did afterwards. */
interface Shown {
	readonly card: Card;
	readonly signature: string;
	readonly command: string | undefined;
	/** Times the card's problem came back after it was shown. */
	recurred: number;
	passed: boolean;
}

interface TaskState {
	readonly injected: Map<number, Shown>;
}

/** A card's problem coming back this often after the card was shown means the card did not fix it. */
const HURT_RECURRENCES = 2;

/**
 * Memory, Phase 5 v1 (brief §6.4 narrowed by research R5.1–R5.5): pitfall cards only.
 * - Learn: a verified error→fix pair (same command fails, files change, it passes) becomes a card,
 *   phrased by a background sidecar (grounded) or summarized deterministically.
 * - A card is one problem (D-072): the error's signature says what kind of failure it was, the
 *   names in it (tests, symbols, error codes) say which. Fixing a different problem of the same
 *   kind adds a card; it does not merge into the first.
 * - Recall: a failing tool result with a card's signature and enough of its names gets the lesson
 *   appended, within ~400 tokens, worded as a past fix to check. No LLM on the hot path.
 * - Utility: a card is credited `helped` when the command it was shown for went on to pass, `hurt`
 *   when its problem kept coming back; cards that hurt more than they help retire. Cards are
 *   superseded, never deleted.
 *
 * With `preferences` on (D-060) it also learns how the user likes work done, only from the user's
 * own messages, and adds the preferences that a later prompt leaves unsaid. That includes what
 * they expect of one kind of task, and what they had to correct the agent on (D-064).
 * `/exo memory interview` asks the user a few questions to start from (D-066).
 */
export function createMemory(raw: Readonly<Record<string, unknown>>, ctx: ModuleContext): ExoModule {
	const { settings, problems } = parseSettings(raw);
	for (const problem of problems) ctx.log(problem);
	const store = storeFor(settings.dbPath);
	const scope = repoScope(ctx);
	let knownScope: string | undefined;
	scope
		.then((value) => {
			knownScope = value;
		})
		.catch(() => undefined);
	const tracker = createEpisodeTracker();
	let task = newTask();
	let learned = 0;
	let recalled = 0;
	/** Separate sessions are separate evidence for a preference. */
	const session = randomUUID();
	/** The user's own messages since the last settle, each with what the agent had said before it. */
	const unread: { readonly text: string; readonly before: string }[] = [];
	/** Preferences already in this session's context. */
	const shown = new Set<number>();
	let lastAssistantText = "";

	/**
	 * Credits each card shown in the task by what the command did next (D-072), then forgets them.
	 * - `hurt`: the card's problem came back twice or more, or came back and the command never passed.
	 * - `helped`: the command passed.
	 * - Neither: the agent never ran the command again, so nothing shows what the card did.
	 */
	function finishTask(): void {
		for (const [id, shown] of task.injected) {
			const outcome =
				shown.recurred >= HURT_RECURRENCES || (shown.recurred > 0 && !shown.passed)
					? "hurt"
					: shown.passed
						? "helped"
						: undefined;
			if (!outcome) continue;
			store.credit(id, outcome);
			ctx.record({ kind: "exo.memory", data: { action: "credited", card: id, outcome } });
		}
		task.injected.clear();
		store.retireUnhelpful();
	}

	return {
		id: MEMORY_ID,

		onUserTurn(turn) {
			if (turn.origin !== "user") return;
			finishTask();
			task = newTask();
			tracker.reset();
			if (settings.preferences && turn.text.trim().length >= MIN_PREFERENCE_MESSAGE_CHARS) {
				unread.push({ text: turn.text, before: lastAssistantText });
			}
		},

		async contextForUserTurn(turn, signal) {
			if (!settings.preferences || turn.origin !== "user") return undefined;
			if (turn.text.trim().split(/\s+/).length < MIN_PROMPT_WORDS) return undefined;
			const candidates = activePreferences(store.preferences(), await scope, settings.preferenceMinSessions)
				.filter((p) => !shown.has(p.id))
				.slice(0, settings.maxPreferences);
			if (candidates.length === 0) return undefined;
			const unsaid =
				(settings.preferenceSelect ? await selectPreferences(turn.text, candidates, signal) : undefined) ??
				candidates.filter((p) => !alreadySaid(turn.text, p.rule));
			const text = renderPreferences(unsaid, settings.maxPreferenceChars);
			if (text === "") return undefined;
			// Count only the ones that fit the budget.
			const added = unsaid.filter((p) => text.includes(`- ${withKind(p)}`));
			for (const p of added) shown.add(p.id);
			store.markPreferencesInjected(added.map((p) => p.id));
			ctx.record({ kind: "exo.memory", data: { action: "preferences_added", preferences: added.map((p) => p.id) } });
			return text;
		},

		onCompacted() {
			shown.clear();
		},

		command(args, dialog) {
			if (args.trim() === "interview") return interview(dialog);
			return preferenceCommand(args);
		},

		onToolResult(tool) {
			observeShown(tool);
			for (const episode of settings.learn ? tracker.observe(tool) : []) {
				learn(episode).catch((error: unknown) => ctx.log(`learning failed: ${String(error)}`));
			}
		},

		async rewriteToolResult(draft, signal) {
			const signature = failureSignature(draft);
			if (!settings.inject || !signature) return undefined;
			const cards = (await recallCards(await scope, signature, draft.output, signal)).filter(
				(r) => !task.injected.has(r.card.id),
			);
			if (cards.length === 0) return undefined;
			for (const { card } of cards) {
				task.injected.set(card.id, { card, signature, command: commandKey(draft), recurred: 0, passed: false });
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
			return {
				text: `${draft.current}\n${renderCards(cards, settings.maxInjectChars)}`,
				note: `recalled ${cards.length} card(s)`,
			};
		},

		async onSettle(info) {
			if (info.outcome === "completed") finishTask();
			lastAssistantText = info.lastAssistantText;
			// The agent has stopped, so the background sidecar can run without competing with it.
			for (const message of unread.splice(0)) {
				learnPreferences(message.text, message.before).catch((error: unknown) =>
					ctx.log(`preference learning failed: ${String(error)}`),
				);
			}
			return undefined;
		},

		status() {
			const preferences = settings.preferences ? ` · ${store.preferences().length} preferences` : "";
			return `${MEMORY_ID} (${store.cards().filter((c) => c.validTo === null).length} cards · ${learned} learned · ${recalled} recalled${preferences})`;
		},
	};

	/**
	 * Reads one user message for preferences (D-060). The sidecar only proposes; code admits:
	 * - the quote must be the user's words, verbatim, and the rule may name nothing the message does not;
	 * - whether it is a standing rule is decided by the user's wording, not by the model;
	 * - "same as" and "replaces" must point at a preference the sidecar was shown;
	 * - it is a correction only if the agent had said something to correct (D-064).
	 *
	 * The interview's open answer comes through here too (D-066): the question asked for standing
	 * rules, so each one admitted is standing, and the user is waiting on the call. Returns how
	 * many preferences the message stated.
	 */
	async function learnPreferences(
		message: string,
		before: string,
		source: SightingSource = "message",
	): Promise<number> {
		const pool = ctx.pool();
		if (!pool) return 0;
		const repo = await scope;
		const known = store.preferences().slice(-MAX_KNOWN_PREFERENCES);
		const text = message.slice(0, PREFERENCE_MESSAGE_CHARS);
		const result = await pool.run({
			module: MEMORY_ID,
			priority: source === "interview" ? "interactive" : "background",
			timeoutMs: settings.preferenceTimeoutMs,
			schema: PreferencesSchema,
			schemaName: "preferences",
			request: {
				messages: [
					{
						role: "user",
						content: PREFERENCES_PROMPT.render({
							known: known.map((p, i) => `${i + 1}. ${p.rule}`).join("\n") || "(none)",
							before: before.slice(-PREFERENCE_CONTEXT_CHARS) || "(nothing)",
							message: text,
						}),
					},
				],
				maxTokens: SIDECAR_MAX_TOKENS,
				thinking: settings.thinking,
			},
		});
		if (!result.ok) {
			ctx.log(`preferences ${result.outcome}: ${result.error}`);
			return 0;
		}
		const nearest = await nearestPreferences(
			result.value.preferences.map((p) => p.rule),
			known,
		);
		let stated = 0;
		for (const [index, item] of result.value.preferences.entries()) {
			// Re-read each time: an earlier item of this message may have added or retired one.
			const live = new Set(store.preferences().map((p) => p.id));
			const admitted = admitPreference(
				{ ...item, correction: item.correction && before.trim() !== "" },
				text,
				known.filter((p) => live.has(p.id)),
				known,
				ctx.cwd,
				nearest.similar[index],
			);
			const fromInterview = admitted.stated && source === "interview";
			applyAdmitted(
				fromInterview ? { ...admitted, stated: { ...admitted.stated, standing: true } } : admitted,
				repo,
				nearest.vectors && { model: nearest.vectors.model, vector: nearest.vectors.byRule[index] },
				source,
			);
			if (admitted.stated) stated += 1;
		}
		return stated;
	}

	/** RETIRE, traced with who asked for it when it was not the user's message. False when it was not live. */
	function retire(id: number, by?: "user" | "interview"): boolean {
		if (!store.retirePreference(id)) return false;
		shown.delete(id);
		ctx.record({ kind: "exo.memory", data: { action: "preference_retired", preference: id, ...(by ? { by } : {}) } });
		return true;
	}

	/** Applies an admitted proposal to the store as delta ops (RETIRE, ADD, MERGE) and traces each. */
	function applyAdmitted(
		admitted: Admitted,
		repo: string,
		embedding: { readonly model: string; readonly vector: Float32Array | undefined } | undefined,
		source: SightingSource = "message",
	): void {
		if (admitted.retire !== undefined) retire(admitted.retire);
		const stated = admitted.stated;
		if (!stated) return;
		const known = store.preferences().find((p) => p.id === stated.existing);
		const isNew = known === undefined;
		const id = known?.id ?? store.addPreference(stated.rule, stated.kind);
		if (isNew && embedding?.vector) store.setVector("preference", id, embedding.model, embedding.vector);
		// Said for a second kind of task: it is not about one kind.
		if (known && known.taskKind !== "any" && known.taskKind !== stated.kind) store.widenPreference(id);
		store.addSighting(id, {
			scope: repo,
			session,
			standing: stated.standing,
			correction: stated.correction,
			quote: stated.quote,
			source,
		});
		ctx.record({
			kind: "exo.memory",
			data: {
				action: isNew ? "preference_learned" : "preference_seen",
				preference: id,
				rule: stated.rule,
				...(stated.correction ? { correction: true } : {}),
				...(source === "interview" ? { source } : {}),
			},
		});
		// The agent had it in this conversation and the user still had to say it: adding it did not work.
		if (known && stated.correction && shown.has(id)) {
			store.markPreferenceRepeated(id);
			ctx.record({ kind: "exo.memory", data: { action: "preference_repeated", preference: id } });
		}
	}

	/**
	 * `/exo memory interview` (D-066): asks the questions, then stores each answer as a preference
	 * that applies in every repo. Only ever started by the user.
	 */
	async function interview(dialog: Dialog | undefined): Promise<string> {
		if (!settings.preferences) return "Preference learning is off (memory.preferences): turn it on first.";
		if (!dialog) return "The interview needs an interactive session.";
		const result = await runInterview(dialog, INTERVIEW);
		const repo = await scope;
		const before = new Set(store.preferences().map((p) => p.id));
		for (const { question, option } of result.answers) applyAnswer(question, option, repo);
		let unread = false;
		if (result.more !== "") {
			if (ctx.pool()) {
				dialog.notify("Reading your last answer…");
				await learnPreferences(result.more, "", "interview");
			} else unread = true;
		}
		const after = store.preferences();
		const added = after.filter((p) => !before.has(p.id)).length;
		const retired = [...before].filter((id) => !after.some((p) => p.id === id)).length;
		ctx.record({
			kind: "exo.memory",
			data: { action: "interview", answered: result.answers.length, added, retired, cancelled: result.cancelled },
		});
		const saved = after.filter((p) => p.sightings.some((s) => s.source === "interview" && s.session === session));
		return [
			result.cancelled ? "Interview stopped early; the answers so far are kept." : "Interview finished.",
			saved.length === 0
				? "No preferences were saved."
				: `Preferences saved: ${saved.length} (${added} new). They apply in every repo, starting with your next prompt.`,
			...(unread ? ["Your last answer was not read: that needs a sidecar engine."] : []),
			"/exo memory preferences lists them; /exo memory forget <id> removes one.",
		].join(" ");
	}

	/**
	 * Stores one interview answer. The latest answer to a question is the answer: whatever another
	 * option of the same question stored earlier is retired, also when the user now has no preference.
	 */
	function applyAnswer(question: InterviewQuestion, option: InterviewOption, repo: string): void {
		const others = new Set(question.options.filter((o) => o !== option).map((o) => o.rule));
		for (const earlier of store.preferences().filter((p) => others.has(p.rule))) retire(earlier.id, "interview");
		if (option.rule === undefined) return;
		const live = store.preferences();
		const existing = live.find((p) => p.rule === option.rule) ?? sameRule(option.rule, live);
		applyAdmitted(
			{
				stated: {
					existing: existing?.id,
					rule: existing?.rule ?? option.rule,
					standing: true,
					kind: option.kind ?? "any",
					correction: false,
					quote: `${question.ask} → ${option.label}`.slice(0, INTERVIEW_QUOTE_CHARS),
				},
			},
			repo,
			undefined,
			"interview",
		);
	}

	/** `/exo memory preferences` lists them; `/exo memory forget <id>` retires one. */
	function preferenceCommand(args: string): string | undefined {
		const [sub, arg] = args.trim().split(/\s+/);
		if (sub === "forget") {
			const id = Number.parseInt(arg ?? "", 10);
			if (!Number.isInteger(id)) return "Usage: /exo memory forget <id>";
			if (!retire(id, "user")) return `No preference ${id}.`;
			return `Forgot preference ${id}. It stays in this conversation if it was already added.`;
		}
		if (sub !== "preferences") return undefined;
		const all = store.preferences();
		if (all.length === 0) {
			return settings.preferences
				? "No preferences learned yet. /exo memory interview asks a few questions to start from."
				: "Preference learning is off (memory.preferences).";
		}
		const active = new Set(activePreferences(all, knownScope ?? "", settings.preferenceMinSessions).map((p) => p.id));
		return all
			.map((p) => {
				const sessions = new Set(p.sightings.map((s) => s.session)).size;
				const state = active.has(p.id) ? "applies here" : "not yet established";
				const corrections = p.sightings.filter((s) => s.correction).length;
				const facts = [
					`said in ${sessions} session${sessions === 1 ? "" : "s"}`,
					...(corrections > 0 ? [`${corrections} as a correction`] : []),
					...(p.sightings.some((s) => s.source === "interview") ? ["from the interview"] : []),
					state,
					`added ${p.injected}×`,
					...(p.repeated > 0 ? [`corrected again after being added ${p.repeated}×`] : []),
				];
				return `${p.id}. ${withKind(p)} (${facts.join("; ")})`;
			})
			.join("\n");
	}

	/** What each card shown in this task sees next: its problem again, or its command passing. */
	function observeShown(tool: ToolOutcome): void {
		if (task.injected.size === 0) return;
		const signature = failureSignature(tool);
		const command = commandKey(tool);
		const names = signature ? new Set(failureDetail(tool.output, FAILURE_DETAIL_LINES)) : undefined;
		for (const shown of task.injected.values()) {
			if (names) {
				const same = shown.signature === signature && detailShare(shown.card.detail, names) >= settings.minDetail;
				if (same) shown.recurred += 1;
			} else if (command !== undefined && command === shown.command && tool.exitCode === 0 && !tool.isError) {
				shown.passed = true;
			}
		}
	}

	async function learn(episode: FixEpisode): Promise<void> {
		const repo = await scope;
		// The same kind of failure naming the same things is the same problem, fixed again.
		const names = new Set(episode.detail);
		const existing = store
			.bySignature(episode.signature)
			.find(
				(c) =>
					c.scope === repo &&
					detailShare(c.detail, names) >= settings.minDetail &&
					detailShare(episode.detail, new Set(c.detail)) >= settings.minDetail,
			);
		const evidence = evidenceOf(episode);
		if (existing) {
			store.merge(existing.id, evidence);
			ctx.record({ kind: "exo.memory", data: { action: "merged", card: existing.id } });
			return;
		}
		const distilled = settings.distill ? await distill(episode) : undefined;
		if (distilled === NOT_REUSABLE) {
			ctx.record({
				kind: "exo.memory",
				data: { action: "skipped", reason: "not_reusable", signature: episode.signature },
			});
			return;
		}
		const lesson = distilled ?? deterministicLesson(episode);
		const id = store.add({
			scope: repo,
			signature: episode.signature,
			detail: episode.detail,
			files: [...new Set(editsOf(episode).map((e) => e.path))].slice(0, MAX_CARD_FILES),
			trigger: episode.errorLine,
			lesson,
			evidence,
		});
		learned += 1;
		ctx.record({ kind: "exo.memory", data: { action: "learned", card: id, signature: episode.signature, lesson } });
		await embedCards([{ id, trigger: episode.errorLine }]);
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
		const vectors = store.vectors("card", embedder.model);
		const missing = live.filter((c) => !vectors.has(c.id)).slice(0, BACKFILL_BATCH);
		// Not awaited: the agent is waiting on this result. They are there for the next failure.
		if (missing.length > 0)
			embedCards(missing).catch((error: unknown) => ctx.log(`embedding failed: ${String(error)}`));
		const known = live.filter((c) => vectors.has(c.id));
		if (known.length === 0) return [];
		const [query] = (await embedder.embed([line], { timeoutMs: settings.embedTimeoutMs, signal })) ?? [];
		if (!query) return [];
		return known.filter((c) => cosineSimilarity(query, vectors.get(c.id) as Float32Array) >= settings.minSimilarity);
	}

	async function embedCards(cards: readonly { readonly id: number; readonly trigger: string }[]): Promise<void> {
		const embedder = ctx.embedder();
		if (!embedder || cards.length === 0) return;
		const vectors = await embedder.embed(cards.map((c) => c.trigger));
		vectors?.forEach((vector, i) => {
			const card = cards[i];
			if (card) store.setVector("card", card.id, embedder.model, vector);
		});
	}

	/** The sidecar's pick of the preferences that fit this prompt and are not stated in it; undefined when it fails. */
	async function selectPreferences(
		prompt: string,
		candidates: readonly ActivePreference[],
		signal: AbortSignal,
	): Promise<ActivePreference[] | undefined> {
		const pool = ctx.pool();
		if (!pool) return undefined;
		ctx.progress("Recalling your preferences…");
		const result = await pool.run({
			module: MEMORY_ID,
			priority: "interactive",
			timeoutMs: settings.preferenceSelectTimeoutMs,
			signal,
			schema: SelectionSchema,
			schemaName: "preference_selection",
			request: {
				messages: [
					{
						role: "user",
						content: SELECT_PROMPT.render({
							preferences: candidates.map((p, i) => `${i + 1}. ${withKind(p)}`).join("\n"),
							request: prompt.slice(0, SELECT_REQUEST_CHARS),
						}),
					},
				],
				maxTokens: SIDECAR_MAX_TOKENS,
				thinking: settings.thinking,
			},
		});
		if (!result.ok) {
			ctx.log(`preference selection ${result.outcome}: ${result.error}`);
			return undefined;
		}
		const picked = new Set(result.value.apply);
		return candidates.filter((_, i) => picked.has(i + 1));
	}

	/**
	 * For each proposed rule, the known preference nearest in meaning, if an embeddings server finds
	 * one at least `preferenceSimilarity` similar (D-062). Also returns the rules' own vectors, to
	 * store with the ones that turn out to be new.
	 */
	async function nearestPreferences(rules: readonly string[], known: readonly StoredPreference[]) {
		const embedder = ctx.embedder();
		const none = { similar: rules.map(() => undefined as StoredPreference | undefined), vectors: undefined };
		if (!embedder || rules.every((r) => r.trim() === "")) return none;
		const stored = store.vectors("preference", embedder.model);
		const unembedded = known.filter((p) => !stored.has(p.id));
		const vectors = await embedder.embed([...rules.map((r) => r.trim() || "-"), ...unembedded.map((p) => p.rule)]);
		if (!vectors) return none;
		unembedded.forEach((p, i) => {
			const vector = vectors[rules.length + i];
			if (!vector) return;
			stored.set(p.id, vector);
			store.setVector("preference", p.id, embedder.model, vector);
		});
		const similar = rules.map((rule, i) => {
			const query = vectors[i];
			if (!query || rule.trim() === "") return undefined;
			let best: { preference: StoredPreference; score: number } | undefined;
			for (const preference of known) {
				const vector = stored.get(preference.id);
				const score = vector ? cosineSimilarity(query, vector) : 0;
				if (score >= settings.preferenceSimilarity && score > (best?.score ?? 0)) best = { preference, score };
			}
			return best?.preference;
		});
		return { similar, vectors: { model: embedder.model, byRule: vectors.slice(0, rules.length) } };
	}

	/** The lesson, {@link NOT_REUSABLE}, or undefined when the sidecar gave nothing usable. */
	async function distill(episode: FixEpisode): Promise<string | undefined> {
		const pool = ctx.pool();
		if (!pool) return undefined;
		const result = await pool.run({
			module: MEMORY_ID,
			priority: "background",
			timeoutMs: settings.distillTimeoutMs,
			schema: LessonSchema,
			schemaName: "lesson",
			request: {
				messages: [
					{
						role: "user",
						content: LESSON_PROMPT.render({ command: episode.command, route: renderRoute(episode) }),
					},
				],
				maxTokens: SIDECAR_MAX_TOKENS,
				thinking: settings.thinking,
			},
		});
		if (!result.ok) {
			ctx.log(`lesson ${result.outcome}: ${result.error}`);
			return undefined;
		}
		const lesson = result.value.lesson.trim();
		// The prompt asks for "" when the fix teaches nothing reusable (a typo, a one-off).
		if (lesson === "") return NOT_REUSABLE;
		const evidence = `${episode.command}\n${renderRoute(episode)}`;
		if (ungroundedReferences(lesson, evidence, ctx.cwd).length > 0) return undefined;
		const when = result.value.applies_when.trim();
		return clip(when ? `${lesson} (when: ${when})` : lesson, LESSON_CHARS + 120);
	}
}

/**
 * Cards for the failure in `output`, in this order (D-072):
 * 1. the same problem in this repo: the signature, and at least `minDetail` of the card's names;
 * 2. the same problem fixed in 2+ other repos (D-018 promotion);
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
	const sameProblem = store.bySignature(signature).filter((c) => detailShare(c.detail, names) >= settings.minDetail);
	const local = sameProblem.filter((c) => c.scope === scope);
	if (local.length > 0) return top(local, "same", settings.maxCards);
	const elsewhere = sameProblem.filter((c) => c.scope !== scope);
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
 * touched, so the agent can check it instead of taking it on trust (D-072).
 */
export function renderCards(cards: readonly Recalled[], maxChars: number): string {
	const lines = cards.map(({ card, match }) => {
		const files = card.files.length > 0 ? `; the fix edited ${card.files.join(", ")}` : "";
		return `- (${MATCH_LABEL[match]}${files}) ${card.lesson}${card.seen > 1 ? ` (seen ${card.seen}×)` : ""}`;
	});
	return clip(`${CARDS_HEADER}\n${lines.join("\n")}`, maxChars);
}

export function deterministicLesson(episode: FixEpisode): string {
	const edits = editsOf(episode);
	const paths = [...new Set(edits.map((e) => e.path))];
	// The last edit is the one in place when the command passed.
	const last = edits.at(-1);
	const change = last ? `: \`${oneLine(last.before)}\` → \`${oneLine(last.after)}\`` : "";
	return clip(`Fixed before by editing ${paths.join(", ")}${change}`, LESSON_CHARS);
}

function failureSignature(tool: ToolOutcome): string | undefined {
	const failed = tool.isError || (tool.exitCode !== null && tool.exitCode !== 0);
	if (!failed || typeof tool.input["command"] !== "string") return undefined;
	return errorSignature(tool.toolName, tool.exitCode, tool.output);
}

function evidenceOf(episode: FixEpisode): string {
	return JSON.stringify({ command: episode.command, error: episode.errorLine, edits: editsOf(episode).slice(-3) });
}

/** The route from the error to the pass, as the lesson sidecar reads it. */
function renderRoute(episode: FixEpisode): string {
	const parts = episode.steps.map((step, i) => {
		const edits = step.edits.map((e) => `${e.path}:\n- ${e.before}\n+ ${e.after}`).join("\n\n");
		const retries =
			step.retries > 0
				? `\n(The command failed with this same error ${step.retries} more time(s) during these edits.)`
				: "";
		const heading = i === 0 ? "The command failed:" : "The command then failed with a different error:";
		return `${i + 1}. ${heading}\n<<<\n${step.excerpt}\n>>>\nEdits made next:\n<<<\n${edits}\n>>>${retries}`;
	});
	return `${parts.join("\n\n")}\n\n${episode.steps.length + 1}. The command passed.`;
}

/** Repo identity (D-018): the origin remote, else the root commit's tree (stable across copies), else the path. */
async function repoScope(ctx: ModuleContext): Promise<string> {
	const run = async (command: string) => {
		const out = await ctx.runCommand(command, { timeoutMs: GIT_TIMEOUT_MS }).catch(() => undefined);
		return out?.exitCode === 0 ? out.outputTail.trim() : "";
	};
	const remote = await run("git remote get-url origin 2>/dev/null");
	if (remote) return `remote:${remote}`;
	const tree = await run('git rev-parse "$(git rev-list --max-parents=0 HEAD | tail -n 1)^{tree}" 2>/dev/null');
	if (tree) return `tree:${tree}`;
	return `path:${ctx.cwd}`;
}

function storeFor(path: string): MemoryStore {
	const existing = stores.get(path);
	if (existing) return existing;
	const store = openMemoryStore(path);
	stores.set(path, store);
	return store;
}

function newTask(): TaskState {
	return { injected: new Map() };
}

function oneLine(text: string): string {
	return clip(text.replace(/\s+/g, " ").trim(), 80);
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
