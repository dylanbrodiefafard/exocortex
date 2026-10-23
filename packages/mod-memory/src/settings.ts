import { homedir } from "node:os";
import { join } from "node:path";
import { USER_ONLY } from "@exocortex/core";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const SettingsSchema = Type.Object(
	{
		/** Card store; one per machine, cards scoped by repo (D-018). Default ~/.exocortex/memory.db. The user's to set (D-087). */
		dbPath: Type.Optional(Type.String({ minLength: 1, ...USER_ONLY })),
		/**
		 * Learn cards from verified error→fix pairs in this session. A lesson sidecar judges each fix
		 * and words its card: without a sidecar engine nothing is learned.
		 */
		learn: Type.Boolean({ default: true }),
		/** Inject matching cards into failing tool results. */
		inject: Type.Boolean({ default: true }),
		maxCards: Type.Integer({ minimum: 1, maximum: 5, default: 2 }),
		/** Injection budget (~4 chars per token; brief §6.4 caps it near 400 tokens). */
		maxInjectChars: Type.Integer({ minimum: 200, default: 1_600 }),
		/**
		 * D-072: a card is the same problem as a failure when one of the failure's error lines has the
		 * card's key and the failure mentions at least this share of the names the card was learned
		 * with (tests, symbols, error codes). 0 matches on the key alone. A pass of a run narrowed to
		 * some tests covers a failure when it names this share of them (D-109).
		 */
		minDetail: Type.Number({ minimum: 0, maximum: 1, default: 0.6 }),
		/**
		 * A card for another kind of error is a similar one when its trigger and the error line share
		 * at least 3 keywords and this share of each other's keywords (the smaller of the two shares).
		 */
		minOverlap: Type.Number({ minimum: 0, maximum: 1, default: 0.6 }),
		/** Live cards kept per repo; beyond it the least useful (helped − hurt, then the oldest) retire. */
		maxCardsPerRepo: Type.Integer({ minimum: 1, default: 500 }),
		/**
		 * D-060: learn how the user likes work done from their own messages, and add the preferences a
		 * later prompt leaves unsaid. Off until it has been tried in daily use (D-052).
		 */
		preferences: Type.Boolean({ default: false }),
		/** At most this many preferences are added to one prompt, of those the selection sidecar picks. */
		maxPreferences: Type.Integer({ minimum: 1, maximum: 10, default: 5 }),
		maxPreferenceChars: Type.Integer({ minimum: 200, default: 900 }),
		/** A preference not stated as a standing rule applies once it was said in this many sessions. */
		preferenceMinSessions: Type.Integer({ minimum: 1, default: 2 }),
		/**
		 * The most the agent's start waits for the sidecar's pick of the preferences that fit a prompt
		 * and are not stated in it; once a few were timed, half again their 90th percentile, if less
		 * (D-098). Without a pick (no engine, a failure, a timeout) none are added (D-109).
		 */
		preferenceSelectTimeoutMs: Type.Integer({ minimum: 500, default: 4_000 }),
		/**
		 * With an embeddings server (D-062): a failing output whose error line is at least this similar
		 * (cosine) to a card's trigger recalls the card. Tune per embedding model.
		 */
		minSimilarity: Type.Number({ minimum: 0, maximum: 1, default: 0.85 }),
		/** Deadline for an embedding lookup on the hot path; past it, keywords decide, and the user is told. */
		embedTimeoutMs: Type.Integer({ minimum: 100, default: 1_500 }),
	},
	{ additionalProperties: true, retired: ["lessonThinking", "distill", "preferenceSelect"] },
);

export type MemorySettings = Static<typeof SettingsSchema> & { readonly dbPath: string };

/**
 * Module settings from config (unknown keys such as `enabled` are ignored). An invalid value falls
 * back to its own default and is reported; the valid ones beside it are kept. Above all `dbPath`:
 * a typo in another setting must not send the session to a different store.
 */
export function parseSettings(raw: Readonly<Record<string, unknown>>): {
	readonly settings: MemorySettings;
	readonly problems: readonly string[];
} {
	const given = Value.Default(SettingsSchema, { ...raw }) as Record<string, unknown>;
	const errors = Value.Check(SettingsSchema, given) ? [] : [...Value.Errors(SettingsSchema, given)];
	const kept = { ...raw };
	// An error's path starts with the setting it is in: `/maxCards`.
	for (const error of errors) delete kept[error.instancePath.split("/")[1] ?? ""];
	const repaired = Value.Default(SettingsSchema, kept);
	const settings = (Value.Check(SettingsSchema, repaired) ? repaired : Value.Default(SettingsSchema, {})) as Static<
		typeof SettingsSchema
	>;
	return {
		settings: { ...settings, dbPath: settings.dbPath ?? join(homedir(), ".exocortex", "memory.db") },
		problems: errors.map((e) => `memory ${e.instancePath || "/"}: ${e.message}`),
	};
}
