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
		/** Full-text matches need this share of the error's keywords in the card's trigger. */
		minOverlap: Type.Number({ minimum: 0, maximum: 1, default: 0.6 }),
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
