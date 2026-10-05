import { randomUUID } from "node:crypto";
import {
	cosineSimilarity,
	type ExoModule,
	errorSignature,
	firstErrorLine,
	loadPrompt,
	type ModuleContext,
	type ToolOutcome,
	ungroundedReferences,
} from "@exocortex/core";
import { Type } from "typebox";
import { createEpisodeTracker, type FixEpisode } from "./episodes.ts";
import {
	type ActivePreference,
	type Admitted,
	activePreferences,
	admitPreference,
	alreadySaid,
	renderPreferences,
	withKind,
} from "./preferences.ts";
import { type MemorySettings, parseSettings } from "./settings.ts";
import { type Card, type MemoryStore, openMemoryStore, type StoredPreference, TASK_KINDS } from "./store.ts";

export const MEMORY_ID = "memory";

const LESSON_PROMPT = loadPrompt(new URL("../prompts/lesson.v1.md", import.meta.url));

const LessonSchema = Type.Object({
	lesson: Type.String({ maxLength: 600 }),
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

const LESSON_CHARS = 300;
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
const GIT_TIMEOUT_MS = 5_000;

/** Stores stay open for the process: modules are rebuilt on `/exo` toggles. */
const stores = new Map<string, MemoryStore>();

interface TaskState {
	/** Card id → the signature it was injected for. */
	readonly injected: Map<number, string>;
	readonly hurt: Set<number>;
	readonly credited: Set<number>;
}

/**
 * Memory, Phase 5 v1 (brief §6.4 narrowed by research R5.1–R5.5): pitfall cards only.
 * - Learn: a verified error→fix pair (same command fails, files change, it passes) becomes a card,
 *   phrased by a background sidecar (grounded) or summarized deterministically.
 * - Recall: a failing tool result whose signature (or error keywords) matches a card gets the
 *   lesson appended, within ~400 tokens. No LLM on the hot path.
 * - Utility: a card is credited `helped` when its error does not recur in the task, `hurt` when it
 *   does; cards that hurt more than they help retire. Cards are superseded, never deleted.
 *
 * With `preferences` on (D-060) it also learns how the user likes work done, only from the user's
 * own messages, and adds the preferences that a later prompt leaves unsaid. That includes what
 * they expect of one kind of task, and what they had to correct the agent on (D-064).
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

	function finishTask(): void {
		for (const id of task.injected.keys()) {
			if (task.credited.has(id) || task.hurt.has(id)) continue;
			store.credit(id, "helped");
			task.credited.add(id);
		}
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

		command(args) {
			return preferenceCommand(args);
		},

		onToolResult(tool) {
			const signature = failureSignature(tool);
			if (signature) {
				for (const [id, injectedFor] of task.injected) {
					if (injectedFor === signature && !task.hurt.has(id)) {
						task.hurt.add(id);
						store.credit(id, "hurt");
					}
				}
			}
			const episode = settings.learn ? tracker.observe(tool) : undefined;
			if (episode) {
				learn(episode).catch((error: unknown) => ctx.log(`learning failed: ${String(error)}`));
			}
		},

		async rewriteToolResult(draft, signal) {
			const signature = failureSignature(draft);
			if (!settings.inject || !signature) return undefined;
			const cards = (await recallCards(await scope, signature, draft.output, signal)).filter(
				(c) => !task.injected.has(c.id),
			);
			if (cards.length === 0) return undefined;
			for (const card of cards) {
				task.injected.set(card.id, signature);
				store.markInjected(card.id);
			}
			recalled += cards.length;
			ctx.record({ kind: "exo.memory", data: { action: "recalled", cards: cards.map((c) => c.id), signature } });
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
	 */
	async function learnPreferences(message: string, before: string): Promise<void> {
		const pool = ctx.pool();
		if (!pool) return;
		const repo = await scope;
		const known = store.preferences().slice(-MAX_KNOWN_PREFERENCES);
		const text = message.slice(0, PREFERENCE_MESSAGE_CHARS);
		const result = await pool.run({
			module: MEMORY_ID,
			priority: "background",
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
				maxTokens: 400,
				thinking: settings.thinking,
			},
		});
		if (!result.ok) {
			ctx.log(`preferences ${result.outcome}: ${result.error}`);
			return;
		}
		const nearest = await nearestPreferences(
			result.value.preferences.map((p) => p.rule),
			known,
		);
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
			applyAdmitted(
				admitted,
				repo,
				nearest.vectors && { model: nearest.vectors.model, vector: nearest.vectors.byRule[index] },
			);
		}
	}

	/** Applies an admitted proposal to the store as delta ops (RETIRE, ADD, MERGE) and traces each. */
	function applyAdmitted(
		admitted: Admitted,
		repo: string,
		embedding: { readonly model: string; readonly vector: Float32Array | undefined } | undefined,
	): void {
		if (admitted.retire !== undefined && store.retirePreference(admitted.retire)) {
			shown.delete(admitted.retire);
			ctx.record({ kind: "exo.memory", data: { action: "preference_retired", preference: admitted.retire } });
		}
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
		});
		ctx.record({
			kind: "exo.memory",
			data: {
				action: isNew ? "preference_learned" : "preference_seen",
				preference: id,
				rule: stated.rule,
				...(stated.correction ? { correction: true } : {}),
			},
		});
		// The agent had it in this conversation and the user still had to say it: adding it did not work.
		if (known && stated.correction && shown.has(id)) {
			store.markPreferenceRepeated(id);
			ctx.record({ kind: "exo.memory", data: { action: "preference_repeated", preference: id } });
		}
	}

	/** `/exo memory preferences` lists them; `/exo memory forget <id>` retires one. */
	function preferenceCommand(args: string): string | undefined {
		const [sub, arg] = args.trim().split(/\s+/);
		if (sub === "forget") {
			const id = Number.parseInt(arg ?? "", 10);
			if (!Number.isInteger(id)) return "Usage: /exo memory forget <id>";
			if (!store.retirePreference(id)) return `No preference ${id}.`;
			shown.delete(id);
			ctx.record({ kind: "exo.memory", data: { action: "preference_retired", preference: id, by: "user" } });
			return `Forgot preference ${id}. It stays in this conversation if it was already added.`;
		}
		if (sub !== "preferences") return undefined;
		const all = store.preferences();
		if (all.length === 0) {
			return settings.preferences ? "No preferences learned yet." : "Preference learning is off (memory.preferences).";
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
					state,
					`added ${p.injected}×`,
					...(p.repeated > 0 ? [`corrected again after being added ${p.repeated}×`] : []),
				];
				return `${p.id}. ${withKind(p)} (${facts.join("; ")})`;
			})
			.join("\n");
	}

	async function learn(episode: FixEpisode): Promise<void> {
		const repo = await scope;
		const existing = store.bySignature(repo, episode.signature).find((c) => c.scope === repo);
		const evidence = evidenceOf(episode);
		if (existing) {
			store.upsert({
				scope: repo,
				signature: episode.signature,
				trigger: episode.errorLine,
				lesson: existing.lesson,
				evidence,
			});
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
		const { id } = store.upsert({
			scope: repo,
			signature: episode.signature,
			trigger: episode.errorLine,
			lesson,
			evidence,
		});
		learned += 1;
		ctx.record({ kind: "exo.memory", data: { action: "learned", card: id, signature: episode.signature, lesson } });
		await embedCards([{ id, trigger: episode.errorLine }]);
	}

	/**
	 * Exact signature first. Otherwise cards whose trigger shares most of the error's keywords, plus,
	 * with an embeddings server, cards whose trigger means the same in other words (D-062).
	 */
	async function recallCards(repo: string, signature: string, output: string, signal: AbortSignal): Promise<Card[]> {
		const byKeywords = recall(store, repo, signature, output, settings);
		if (byKeywords.some((c) => c.signature === signature)) return byKeywords;
		const bySimilarity = await similarCards(repo, output, signal);
		const merged = new Map([...byKeywords, ...bySimilarity].map((c) => [c.id, c]));
		return rank([...merged.values()]).slice(0, settings.maxCards);
	}

	async function similarCards(repo: string, output: string, signal: AbortSignal): Promise<Card[]> {
		const embedder = ctx.embedder();
		const line = firstErrorLine(output)?.line;
		if (!embedder || !line) return [];
		const live = store.cards(repo).filter((c) => c.validTo === null);
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
				maxTokens: 60,
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
						content: LESSON_PROMPT.render({
							command: episode.command,
							excerpt: episode.excerpt,
							edits: renderEdits(episode),
						}),
					},
				],
				maxTokens: 300,
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
		const evidence = `${episode.command}\n${episode.excerpt}\n${renderEdits(episode)}`;
		if (ungroundedReferences(lesson, evidence, ctx.cwd).length > 0) return undefined;
		const when = result.value.applies_when.trim();
		return clip(when ? `${lesson} (when: ${when})` : lesson, LESSON_CHARS + 120);
	}
}

/** Exact signature first; otherwise cards whose trigger shares most of this error's keywords. */
export function recall(
	store: MemoryStore,
	scope: string,
	signature: string,
	output: string,
	settings: Pick<MemorySettings, "maxCards" | "minOverlap">,
): Card[] {
	const exact = store.bySignature(scope, signature);
	if (exact.length > 0) return rank(exact).slice(0, settings.maxCards);
	const line = firstErrorLine(output)?.line;
	if (!line) return [];
	return rank(
		store
			.search(scope, line, settings.maxCards * 2)
			.filter((m) => m.overlap >= settings.minOverlap)
			.map((m) => m.card),
	).slice(0, settings.maxCards);
}

/** Proven cards first: helped − hurt, then how often the lesson was seen. */
function rank(cards: readonly Card[]): Card[] {
	return [...cards].sort((a, b) => b.helped - b.hurt - (a.helped - a.hurt) || b.seen - a.seen);
}

export function renderCards(cards: readonly Card[], maxChars: number): string {
	const lines = cards.map((c) => `- ${c.lesson}${c.seen > 1 ? ` (seen ${c.seen}×)` : ""}`);
	const text = `[exo memory: this error was fixed before in this repo]\n${lines.join("\n")}`;
	return clip(text, maxChars);
}

export function deterministicLesson(episode: FixEpisode): string {
	const paths = [...new Set(episode.edits.map((e) => e.path))];
	const first = episode.edits[0];
	const change = first ? `: \`${oneLine(first.before)}\` → \`${oneLine(first.after)}\`` : "";
	return clip(`Fixed before by editing ${paths.join(", ")}${change}`, LESSON_CHARS);
}

function failureSignature(tool: ToolOutcome): string | undefined {
	const failed = tool.isError || (tool.exitCode !== null && tool.exitCode !== 0);
	if (!failed || typeof tool.input["command"] !== "string") return undefined;
	return errorSignature(tool.toolName, tool.exitCode, tool.output);
}

function evidenceOf(episode: FixEpisode): string {
	return JSON.stringify({ command: episode.command, error: episode.errorLine, edits: episode.edits.slice(0, 3) });
}

function renderEdits(episode: FixEpisode): string {
	return episode.edits.map((e) => `${e.path}:\n- ${e.before}\n+ ${e.after}`).join("\n\n");
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
	return { injected: new Map(), hurt: new Set(), credited: new Set() };
}

function oneLine(text: string): string {
	return clip(text.replace(/\s+/g, " ").trim(), 80);
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
