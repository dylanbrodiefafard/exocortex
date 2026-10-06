import { homedir } from "node:os";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const SettingsSchema = Type.Object(
	{
		/** Card store; one per machine, cards scoped by repo (D-018). Default ~/.exocortex/memory.db. */
		dbPath: Type.Optional(Type.String({ minLength: 1 })),
		/** Learn cards from verified error→fix pairs in this session. */
		learn: Type.Boolean({ default: true }),
		/** Inject matching cards into failing tool results. */
		inject: Type.Boolean({ default: true }),
		/** Have a background sidecar phrase each new card's lesson (else a deterministic summary of the fix). */
		distill: Type.Boolean({ default: true }),
		distillTimeoutMs: Type.Integer({ minimum: 1_000, default: 30_000 }),
		thinking: Type.Boolean({ default: false }),
		maxCards: Type.Integer({ minimum: 1, maximum: 5, default: 2 }),
		/** Injection budget (~4 chars per token; brief §6.4 caps it near 400 tokens). */
		maxInjectChars: Type.Integer({ minimum: 200, default: 1_600 }),
		/**
		 * D-072: a card is the same problem as a failure when the failure mentions at least this share
		 * of the names the card was learned with (tests, symbols, error codes). 0 matches on the
		 * signature alone, as before D-072.
		 */
		minDetail: Type.Number({ minimum: 0, maximum: 1, default: 0.6 }),
		/** Full-text matches need this share of the error's keywords in the card's trigger. */
		minOverlap: Type.Number({ minimum: 0, maximum: 1, default: 0.6 }),
		/**
		 * D-060: learn how the user likes work done from their own messages, and add the preferences a
		 * later prompt leaves unsaid. Off until it has been tried in daily use (D-052).
		 */
		preferences: Type.Boolean({ default: false }),
		/** At most this many preferences are added to one prompt. */
		maxPreferences: Type.Integer({ minimum: 1, maximum: 10, default: 5 }),
		maxPreferenceChars: Type.Integer({ minimum: 200, default: 900 }),
		/** A preference not stated as a standing rule applies once it was said in this many sessions. */
		preferenceMinSessions: Type.Integer({ minimum: 1, default: 2 }),
		preferenceTimeoutMs: Type.Integer({ minimum: 1_000, default: 30_000 }),
		/**
		 * Have a sidecar pick which preferences fit a prompt and are not already stated in it, before
		 * the agent starts. Off, or when the sidecar fails: all of them, minus keyword matches.
		 */
		preferenceSelect: Type.Boolean({ default: true }),
		preferenceSelectTimeoutMs: Type.Integer({ minimum: 500, default: 4_000 }),
		/**
		 * With an embeddings server (D-062): a failing output whose error line is at least this similar
		 * (cosine) to a card's trigger recalls the card, and a new preference at least
		 * `preferenceSimilarity` similar to a known one is the same preference. Tune per embedding model.
		 */
		minSimilarity: Type.Number({ minimum: 0, maximum: 1, default: 0.85 }),
		preferenceSimilarity: Type.Number({ minimum: 0, maximum: 1, default: 0.8 }),
		/** Deadline for an embedding lookup on the hot path; past it, keywords decide. */
		embedTimeoutMs: Type.Integer({ minimum: 100, default: 1_500 }),
	},
	{ additionalProperties: true },
);

export type MemorySettings = Static<typeof SettingsSchema> & { readonly dbPath: string };

/** Module settings from config (unknown keys such as `enabled` are ignored); invalid values fall back to defaults. */
export function parseSettings(raw: Readonly<Record<string, unknown>>): {
	readonly settings: MemorySettings;
	readonly problems: readonly string[];
} {
	const withDefaults = Value.Default(SettingsSchema, { ...raw });
	const ok = Value.Check(SettingsSchema, withDefaults);
	const settings = (ok ? withDefaults : Value.Default(SettingsSchema, {})) as Static<typeof SettingsSchema>;
	const problems = ok
		? []
		: [...Value.Errors(SettingsSchema, withDefaults)].map((e) => `memory ${e.instancePath || "/"}: ${e.message}`);
	return { settings: { ...settings, dbPath: settings.dbPath ?? join(homedir(), ".exocortex", "memory.db") }, problems };
}
