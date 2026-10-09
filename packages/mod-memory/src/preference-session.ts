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
	activePreferences,
	admitRelation,
	admitStatement,
	alreadySaid,
	HOLDS,
	nearestPreferences,
	type ProposedPreference,
	type Refusal,
	type Relation,
	renderPreferences,
	type Statement,
	UNRELATED,
	withKind,
} from "./preferences.ts";
import { type RetiredBy, type SightingSource, type StoredPreference, TASK_KINDS } from "./store.ts";
import { fenced } from "./text.ts";

const PREFERENCES_PROMPT = loadPrompt(new URL("../prompts/preferences.v4.md", import.meta.url));

const PreferencesSchema = Type.Object({
	preferences: Type.Array(
		Type.Object({
			rule: Type.String({ maxLength: 300 }),
			quote: Type.String({ maxLength: 400 }),
			holds: Type.Union(HOLDS.map((holds) => Type.Literal(holds))),
			applies_to: Type.Union(TASK_KINDS.map((kind) => Type.Literal(kind))),
			correction: Type.Boolean(),
		}),
		// With one relation call each, a message stays within a module's default calls per turn.
		{ maxItems: 3 },
	),
});

const RELATE_PROMPT = loadPrompt(new URL("../prompts/preference-relate.v1.md", import.meta.url));

const RelationSchema = Type.Object({
	same: Type.Integer({ minimum: 0 }),
	contradicts: Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 5 }),
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
/**
 * A long message keeps its start and its end (D-089): a standing rule often follows what was
 * pasted. A quote is checked against what the sidecar read, so none can run across the gap.
 */
const PREFERENCE_MESSAGE_CHARS = 4_000;
/** Enough of the agent's last message to tell a correction of it from a new request (D-064). */
const PREFERENCE_CONTEXT_CHARS = 1_200;
const MESSAGE_CUT_MARK = "[… the middle of this message is not shown. …]";
const CONTEXT_CUT_MARK = "[… the start of the agent's message is not shown …]";
/**
 * Known preferences a stated rule is compared with in one call: every live one while they fit,
 * otherwise the nearest ones (`nearestPreferences`).
 */
const MAX_RELATED_PREFERENCES = 30;
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
	/**
	 * The user stated a preference: writes it to the store as delta ops (ADD or MERGE, then RETIRE
	 * for what it contradicts) and traces each.
	 */
	stated(statement: Statement, relation: Relation, repo: string, source?: SightingSource): void;
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
	 * Reads one user message for preferences (D-060, D-090), in two sidecar steps with a gate in
	 * code after each:
	 * 1. what the message states (`propose`), admitted when the quote is the user's words and the
	 *    rule names nothing the message does not (`admitStatement`);
	 * 2. how each statement stands with the known preferences (`relate`), where a number counts
	 *    only when it points at a preference that was shown (`admitRelation`).
	 *
	 * It is a correction only if the agent had said something to correct (D-064). The interview's
	 * open answer comes through here too (D-066): the question asked for standing rules, so each
	 * one admitted is standing, and the user is waiting on the calls.
	 */
	async function learn(message: string, before: string, source: SightingSource = "message"): Promise<number> {
		const repo = await scope;
		// A sighting says where a preference was stated: under a guessed repo name it would be wrong.
		if (!repo.known && source !== "interview") return 0;
		const text = startAndEnd(message, PREFERENCE_MESSAGE_CHARS, { mark: MESSAGE_CUT_MARK });
		const proposals = await propose(text, before, source);
		if (!proposals) return 0;
		let count = 0;
		for (const item of proposals) {
			const admitted = admitStatement({ ...item, correction: item.correction && before.trim() !== "" }, text, ctx.cwd);
			if ("refused" in admitted) {
				skipped(admitted.refused);
				continue;
			}
			const statement = source === "interview" ? { ...admitted.statement, standing: true } : admitted.statement;
			// Read again for each: an earlier statement of this message may have added or retired one.
			const relation = await relate(statement, store.preferences(), source);
			if (!relation) {
				skipped("relation_unknown");
				continue;
			}
			stated(statement, relation, repo.id, source);
			count += 1;
		}
		return count;
	}

	/**
	 * A proposal that states nothing, traced with the reason so that the gates can be measured.
	 * `relation_unknown`: the relation sidecar did not answer. A rule stored without knowing what it
	 * repeats or contradicts could stand beside its opposite, so it waits until the user says it again.
	 */
	function skipped(reason: Refusal | "relation_unknown"): void {
		ctx.record({ kind: "exo.memory", data: { action: "preference_skipped", reason } });
	}

	const priorityOf = (source: SightingSource) => (source === "interview" ? "interactive" : "background");

	/** What the sidecar reads in one message; undefined when there is no sidecar or it failed. */
	async function propose(
		text: string,
		before: string,
		source: SightingSource,
	): Promise<readonly ProposedPreference[] | undefined> {
		const result = await ctx.pool()?.run({
			module: MEMORY_ID,
			priority: priorityOf(source),
			timeoutMs: settings.preferenceTimeoutMs,
			schema: PreferencesSchema,
			schemaName: "preferences",
			request: {
				messages: [
					{
						role: "user",
						content: PREFERENCES_PROMPT.render({ before: endOf(before) || "(nothing)", message: text }),
					},
				],
				maxTokens: SIDECAR_MAX_TOKENS,
				thinking: settings.thinking,
			},
		});
		if (result && !result.ok) ctx.log(`preferences ${result.outcome}: ${result.error}`);
		return result?.ok ? result.value.preferences : undefined;
	}

	/**
	 * How a statement stands with the live preferences, as a sidecar reads it; undefined when it
	 * did not answer. With nothing known there is nothing to ask.
	 */
	async function relate(
		statement: Statement,
		live: readonly StoredPreference[],
		source: SightingSource,
	): Promise<Relation | undefined> {
		if (live.length === 0) return UNRELATED;
		const similarity = live.length > MAX_RELATED_PREFERENCES ? await similarityTo(statement.rule, live) : undefined;
		const shown = nearestPreferences(statement.rule, live, MAX_RELATED_PREFERENCES, similarity);
		const result = await ctx.pool()?.run({
			module: MEMORY_ID,
			priority: priorityOf(source),
			timeoutMs: settings.preferenceTimeoutMs,
			schema: RelationSchema,
			schemaName: "preference_relation",
			request: {
				messages: [
					{
						role: "user",
						content: RELATE_PROMPT.render({
							quote: fenced(statement.quote),
							rule: statement.rule,
							// A sidecar is told what it is not shown (D-089).
							known_heading:
								shown.length === live.length
									? "Known preferences:"
									: `Known preferences (the ${shown.length} nearest to the stated rule, of ${live.length}):`,
							known: shown.map((p, i) => `${i + 1}. ${withKind(p)}`).join("\n"),
						}),
					},
				],
				maxTokens: SIDECAR_MAX_TOKENS,
				thinking: settings.thinking,
			},
		});
		if (result && !result.ok) ctx.log(`preference relation ${result.outcome}: ${result.error}`);
		return result?.ok ? admitRelation(result.value, shown) : undefined;
	}

	/**
	 * How near each live preference is to a rule, by the embeddings server (D-062); undefined
	 * without one. Preferences not yet embedded with this model are embedded in the same call.
	 */
	async function similarityTo(
		rule: string,
		live: readonly StoredPreference[],
	): Promise<((preference: StoredPreference) => number | undefined) | undefined> {
		const embedder = ctx.embedder();
		if (!embedder) return undefined;
		const stored = store.vectors("preference", embedder.model);
		const unembedded = live.filter((p) => !stored.has(p.id));
		const vectors = await embedder.embed([rule, ...unembedded.map((p) => p.rule)]);
		const query = vectors?.[0];
		if (!vectors || !query) return undefined;
		unembedded.forEach((p, i) => {
			const vector = vectors[i + 1];
			if (!vector) return;
			stored.set(p.id, vector);
			store.setVector("preference", p.id, embedder.model, vector);
		});
		return (preference) => {
			const vector = stored.get(preference.id);
			return vector && cosineSimilarity(query, vector);
		};
	}

	function retire(id: number, by: RetiredBy): boolean {
		const rule = store.preferences().find((p) => p.id === id)?.rule;
		if (!store.retirePreference(id, by)) return false;
		if (shown.delete(id)) changed();
		if (by === "model") retiredByModel.push({ id, rule: rule ?? "" });
		ctx.record({ kind: "exo.memory", data: { action: "preference_retired", preference: id, by } });
		return true;
	}

	/**
	 * ADD or MERGE, then RETIRE what the statement contradicts (D-090). A contradicted preference
	 * goes only once the stated one applies here (`activePreferences`): one task's instruction does
	 * not undo a preference, and the same instruction in a second session does. Until then the
	 * conflict is traced, and the next time the user says it the question is asked again.
	 */
	function stated(statement: Statement, relation: Relation, repo: string, source: SightingSource = "message"): void {
		const known = relation.same;
		const id = known?.id ?? store.addPreference(statement.rule, statement.kind);
		// Said for a second kind of task: it is not about one kind.
		if (known && known.taskKind !== "any" && known.taskKind !== statement.kind) store.widenPreference(id);
		store.addSighting(id, {
			scope: repo,
			session,
			standing: statement.standing,
			correction: statement.correction,
			quote: statement.quote,
			source,
		});
		ctx.record({
			kind: "exo.memory",
			data: {
				action: known ? "preference_seen" : "preference_learned",
				preference: id,
				rule: known?.rule ?? statement.rule,
				...(statement.correction ? { correction: true } : {}),
				...(source === "interview" ? { source } : {}),
			},
		});
		// The agent had it in this conversation and the user still had to say it: adding it did not work.
		if (known && statement.correction && shown.has(id)) {
			store.markPreferenceRepeated(id);
			ctx.record({ kind: "exo.memory", data: { action: "preference_repeated", preference: id } });
		}
		replace(
			id,
			relation.contradicts.filter((p) => p.id !== id),
			repo,
			source,
		);
	}

	/** RETIRE what preference `id` contradicts, once `id` applies in `repo`; until then the conflict is traced. */
	function replace(id: number, against: readonly StoredPreference[], repo: string, source: SightingSource): void {
		if (against.length === 0) return;
		const applies = activePreferences(store.preferences(), repo, settings.preferenceMinSessions).some(
			(p) => p.id === id,
		);
		for (const contradicted of against) {
			if (applies) retire(contradicted.id, source === "interview" ? "interview" : "model");
			else {
				ctx.record({
					kind: "exo.memory",
					data: { action: "preference_conflict", preference: id, with: contradicted.id },
				});
			}
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
		stated,
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
