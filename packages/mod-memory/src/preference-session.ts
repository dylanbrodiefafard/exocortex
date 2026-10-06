import {
	cosineSimilarity,
	type JsonValue,
	loadPrompt,
	type SettleAction,
	type SettleInfo,
	SIDECAR_MAX_TOKENS,
	startAndEnd,
	type UserTurn,
	type UserTurnContext,
} from "@exocortex/core";
import { Type } from "typebox";
import { MEMORY_ID, type MemoryDeps } from "./deps.ts";
import {
	type ActivePreference,
	type Admitted,
	activePreferences,
	admitPreference,
	alreadySaid,
	type ProposedPreference,
	renderPreferences,
	withKind,
} from "./preferences.ts";
import { type RetiredBy, type SightingSource, type StoredPreference, TASK_KINDS } from "./store.ts";

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

const SELECT_PROMPT = loadPrompt(new URL("../prompts/preference-select.v2.md", import.meta.url));

const SelectionSchema = Type.Object({ apply: Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 10 }) });

/**
 * How much of a request the selection reads. A long one keeps its start and its end (D-089): the
 * selection leaves out what the request already says or makes an exception to, and "skip the tests
 * this time" is as likely to be its last line as its first.
 */
const SELECT_REQUEST_CHARS = 12_000;
/** Shorter messages ("yes", "continue", "thanks") cannot state a preference worth a sidecar call. */
const MIN_PREFERENCE_MESSAGE_CHARS = 20;
/** A long message keeps its start and its end (D-089): a standing rule often follows what was pasted. */
const PREFERENCE_MESSAGE_CHARS = 4_000;
/** Enough of the agent's last message to tell a correction of it from a new request (D-064). */
const PREFERENCE_CONTEXT_CHARS = 1_200;
/** Ends in a full stop inside the mark, so no sentence a quote is read in runs across the gap. */
const MESSAGE_CUT_MARK = "[… the middle of this message is not shown. …]";
const CONTEXT_CUT_MARK = "[… the start of the agent's message is not shown …]";
/**
 * Known preferences shown to the sidecar so it can say "same as" or "replaces": the latest ones.
 * Code still compares a proposed rule with every live preference (M7).
 */
const MAX_KNOWN_PREFERENCES = 30;
/** Retired preferences listed by `/exo memory preferences`, so a wrong retirement can be undone. */
const MAX_RETIRED_LISTED = 5;
const RETIRED_BY: Readonly<Record<RetiredBy, string>> = {
	user: "you",
	model: "the model",
	interview: "a later interview answer",
};
/** Prompts with fewer words are not tasks ("thanks", "go on"): nothing is added to them. */
const MIN_PROMPT_WORDS = 4;

/** One line of `/exo memory preferences`. */
function describe(p: StoredPreference, active: boolean): string {
	const sessions = new Set(p.sightings.map((s) => s.session)).size;
	const corrections = p.sightings.filter((s) => s.correction).length;
	const facts = [
		`said in ${sessions} session${sessions === 1 ? "" : "s"}`,
		...(corrections > 0 ? [`${corrections} as a correction`] : []),
		...(p.sightings.some((s) => s.source === "interview") ? ["from the interview"] : []),
		active ? "applies here" : "not yet established",
		`added ${p.injected}×`,
		...(p.repeated > 0 ? [`corrected again after being added ${p.repeated}×`] : []),
	];
	return `${p.id}. ${withKind(p)} (${facts.join("; ")})`;
}

/** The preference half of the module for one session (D-060, D-064). */
export interface PreferenceSession {
	/** The harness session: separate sessions are separate evidence for a preference. */
	readonly session: string;
	/** A message the user typed: read for preferences at the next settle. */
	heard(turn: UserTurn): void;
	/** The preferences this prompt leaves unsaid, for the context right after it. */
	context(turn: UserTurn, signal: AbortSignal): Promise<UserTurnContext | undefined>;
	/**
	 * The agent stopped: the background sidecar can read what the user said. Returns a notice when
	 * a sidecar's reading of an earlier message retired a preference (M6): the user did not ask for
	 * that in so many words, so they are told and shown how to undo it.
	 */
	settled(info: SettleInfo): SettleAction | undefined;
	/** Text added earlier may be gone from the context: everything may be added again. */
	compacted(): void;
	/** `/exo memory preferences` lists them; `forget <id>` retires one; `restore <id>` brings one back. */
	command(args: string): string | undefined;
	/** What must survive a rebuild of the module: the preferences already in the conversation (M9). */
	state(): JsonValue;
	/** Reads one message for preferences; returns how many it stated. */
	learn(message: string, before: string, source?: SightingSource): Promise<number>;
	/** Applies an admitted proposal to the store as delta ops (RETIRE, ADD, MERGE) and traces each. */
	apply(
		admitted: Admitted,
		repo: string,
		embedding: { readonly model: string; readonly vector: Float32Array | undefined } | undefined,
		source?: SightingSource,
	): void;
	/** RETIRE, traced with who asked for it. False when it was not live. */
	retire(id: number, by: RetiredBy): boolean;
}

/**
 * With `preferences` on (D-060) memory learns how the user likes work done, only from the user's
 * own messages, and adds the preferences that a later prompt leaves unsaid. That includes what
 * they expect of one kind of task, and what they had to correct the agent on (D-064).
 */
export function createPreferenceSession(
	{ ctx, settings, store, scope, resolvedScope, changed }: MemoryDeps,
	saved: unknown,
): PreferenceSession {
	/** The harness's id (M9): a module rebuilt mid-session is still the same session of evidence. */
	const session = ctx.sessionId;
	/** The user's own messages since the last settle, each with what the agent had said before it. */
	const unread: { readonly text: string; readonly before: string }[] = [];
	/** Preferences already in this session's context. Saved state is untrusted: only numbers are taken. */
	const shown = new Set<number>(Array.isArray(saved) ? saved.filter((id) => typeof id === "number") : []);
	/** Preferences a sidecar retired since the user was last told. */
	const retiredByModel: { readonly id: number; readonly rule: string }[] = [];
	let lastAssistantText = "";

	/**
	 * Reads one user message for preferences (D-060). The sidecar only proposes; code admits:
	 * - the quote must be the user's words, verbatim, and the rule may name nothing the message does not;
	 * - whether it is a standing rule is decided by the user's wording, not by the model;
	 * - "same as" and "replaces" must point at a preference the sidecar was shown;
	 * - it is a correction only if the agent had said something to correct (D-064).
	 *
	 * The interview's open answer comes through here too (D-066): the question asked for standing
	 * rules, so each one admitted is standing, and the user is waiting on the call.
	 */
	async function learn(message: string, before: string, source: SightingSource = "message"): Promise<number> {
		const repo = await scope;
		// A sighting says where a preference was stated: under a guessed repo name it would be wrong.
		if (!repo.known && source !== "interview") return 0;
		const all = store.preferences();
		const known = all.slice(-MAX_KNOWN_PREFERENCES);
		// A quote is checked against what the sidecar read, and its sentence stops at the mark.
		const text = startAndEnd(message, PREFERENCE_MESSAGE_CHARS, { mark: MESSAGE_CUT_MARK });
		const proposals = await propose(text, before, known, source);
		if (!proposals) return 0;
		const nearest = await nearestPreferences(
			proposals.map((p) => p.rule),
			all,
		);
		let stated = 0;
		for (const [index, item] of proposals.entries()) {
			const admitted = admitPreference(
				{ ...item, correction: item.correction && before.trim() !== "" },
				text,
				// Re-read each time: an earlier item of this message may have added or retired one.
				store.preferences(),
				known,
				ctx.cwd,
				nearest.similar[index],
			);
			const fromInterview = admitted.stated && source === "interview";
			apply(
				fromInterview ? { ...admitted, stated: { ...admitted.stated, standing: true } } : admitted,
				repo.id,
				nearest.vectors && { model: nearest.vectors.model, vector: nearest.vectors.byRule[index] },
				source,
			);
			if (admitted.stated) stated += 1;
		}
		return stated;
	}

	/** What the sidecar reads in one message; undefined when there is no sidecar or it failed. */
	async function propose(
		text: string,
		before: string,
		known: readonly StoredPreference[],
		source: SightingSource,
	): Promise<readonly ProposedPreference[] | undefined> {
		const result = await ctx.pool()?.run({
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
							before: endOf(before) || "(nothing)",
							message: text,
						}),
					},
				],
				maxTokens: SIDECAR_MAX_TOKENS,
				thinking: settings.thinking,
			},
		});
		if (result && !result.ok) ctx.log(`preferences ${result.outcome}: ${result.error}`);
		return result?.ok ? result.value.preferences : undefined;
	}

	function retire(id: number, by: RetiredBy): boolean {
		const rule = store.preferences().find((p) => p.id === id)?.rule;
		if (!store.retirePreference(id, by)) return false;
		if (shown.delete(id)) changed();
		if (by === "model") retiredByModel.push({ id, rule: rule ?? "" });
		ctx.record({ kind: "exo.memory", data: { action: "preference_retired", preference: id, by } });
		return true;
	}

	function apply(
		admitted: Admitted,
		repo: string,
		embedding: { readonly model: string; readonly vector: Float32Array | undefined } | undefined,
		source: SightingSource = "message",
	): void {
		if (admitted.retire !== undefined) retire(admitted.retire, source === "interview" ? "interview" : "model");
		if (admitted.stated) sight(admitted.stated, repo, embedding, source);
	}

	/** ADD or MERGE: the user stated a preference, a known one or a new rule. */
	function sight(
		stated: NonNullable<Admitted["stated"]>,
		repo: string,
		embedding: { readonly model: string; readonly vector: Float32Array | undefined } | undefined,
		source: SightingSource,
	): void {
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

	/** The sidecar's pick of the preferences that fit this prompt and are not stated in it; undefined when it fails. */
	async function select(
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
							request: startAndEnd(prompt, SELECT_REQUEST_CHARS),
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

	/** Live preferences with what is known of each, then the ones retired lately (M6). */
	function list(): string {
		const all = store.preferences();
		const retired = store.retiredPreferences(MAX_RETIRED_LISTED);
		const retiredLines =
			retired.length === 0
				? []
				: [
						"Retired lately (/exo memory restore <id> brings one back):",
						...retired.map((p) => `${p.id}. ${withKind(p)} (retired by ${RETIRED_BY[p.retiredBy]})`),
					];
		if (all.length === 0 && retired.length > 0) return ["No live preferences.", ...retiredLines].join("\n");
		if (all.length === 0) {
			return settings.preferences
				? "No preferences learned yet. /exo memory interview asks a few questions to start from."
				: "Preference learning is off (memory.preferences).";
		}
		const active = new Set(
			activePreferences(all, resolvedScope()?.id ?? "", settings.preferenceMinSessions).map((p) => p.id),
		);
		return [...all.map((p) => describe(p, active.has(p.id))), ...retiredLines].join("\n");
	}

	return {
		session,
		learn,
		apply,
		retire,

		heard(turn) {
			if (settings.preferences && turn.text.trim().length >= MIN_PREFERENCE_MESSAGE_CHARS) {
				unread.push({ text: turn.text, before: lastAssistantText });
			}
		},

		async context(turn, signal) {
			if (!settings.preferences || turn.origin !== "user") return undefined;
			if (turn.text.trim().split(/\s+/).length < MIN_PROMPT_WORDS) return undefined;
			const candidates = activePreferences(store.preferences(), (await scope).id, settings.preferenceMinSessions)
				.filter((p) => !shown.has(p.id))
				.slice(0, settings.maxPreferences);
			if (candidates.length === 0) return undefined;
			const unsaid =
				(settings.preferenceSelect ? await select(turn.text, candidates, signal) : undefined) ??
				candidates.filter((p) => !alreadySaid(turn.text, p.rule));
			const text = renderPreferences(unsaid, settings.maxPreferenceChars);
			if (text === "") return undefined;
			// Count only the ones that fit the budget.
			const added = unsaid.filter((p) => text.includes(`- ${withKind(p)}`));
			return {
				text,
				// Only once the note is in the prompt (D-078): a note that lost its time budget was
				// never shown, and is offered again.
				commit: () => {
					for (const p of added) shown.add(p.id);
					changed();
					store.markPreferencesInjected(added.map((p) => p.id));
					ctx.record({
						kind: "exo.memory",
						data: { action: "preferences_added", preferences: added.map((p) => p.id) },
					});
				},
			};
		},

		settled(info) {
			lastAssistantText = info.lastAssistantText;
			// The agent has stopped, so the background sidecar can run without competing with it.
			for (const message of unread.splice(0)) {
				learn(message.text, message.before).catch((error: unknown) =>
					ctx.log(`preference learning failed: ${String(error)}`),
				);
			}
			const retired = retiredByModel.splice(0);
			if (retired.length === 0) return undefined;
			const [only] = retired;
			const summary =
				retired.length === 1 && only
					? `memory retired a preference after your last message: "${only.rule}". /exo memory restore ${only.id} brings it back`
					: `memory retired ${retired.length} preferences after your last message: ${retired.map((r) => `"${r.rule}" (${r.id})`).join(", ")}. /exo memory restore <id> brings one back`;
			return { kind: "notify", level: "warning", summary };
		},

		compacted() {
			shown.clear();
			changed();
		},

		state: () => [...shown],

		command(args) {
			const [sub, arg] = args.trim().split(/\s+/);
			const id = Number.parseInt(arg ?? "", 10);
			if (sub === "forget") {
				if (!Number.isInteger(id)) return "Usage: /exo memory forget <id>";
				if (!retire(id, "user")) return `No preference ${id}.`;
				return `Forgot preference ${id}. It stays in this conversation if it was already added.`;
			}
			if (sub === "restore") {
				if (!Number.isInteger(id)) return "Usage: /exo memory restore <id>";
				if (!store.restorePreference(id)) return `No retired preference ${id}.`;
				ctx.record({ kind: "exo.memory", data: { action: "preference_restored", preference: id } });
				return `Restored preference ${id}.`;
			}
			return sub === "preferences" ? list() : undefined;
		},
	};
}

/** The end of the agent's last message, saying so when its start is left out (D-089). */
function endOf(before: string): string {
	return before.length > PREFERENCE_CONTEXT_CHARS
		? `${CONTEXT_CUT_MARK}\n${before.slice(-PREFERENCE_CONTEXT_CHARS)}`
		: before;
}
