import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const SettingsSchema = Type.Object(
	{
		/** The user waits on compaction, so it runs at critical priority within this deadline. */
		timeoutMs: Type.Integer({ minimum: 1_000, default: 90_000 }),
		/** Conversation characters sent to the sidecar (the most recent ones; ~4 chars per token). */
		maxConversationChars: Type.Integer({ minimum: 2_000, default: 60_000 }),
		maxSummaryTokens: Type.Integer({ minimum: 200, default: 1_200 }),
		thinking: Type.Boolean({ default: false }),
		/**
		 * Without a sidecar summary: `harness` leaves compaction to the harness's default; `deterministic`
		 * still writes the summary from tracked facts alone.
		 */
		fallback: Type.Union([Type.Literal("harness"), Type.Literal("deterministic")], { default: "harness" }),
		/** Per-message cap for verbatim user requests. */
		maxUserMessageChars: Type.Integer({ minimum: 200, default: 2_000 }),
	},
	{ additionalProperties: true },
);

export type CompactionSettings = Static<typeof SettingsSchema>;

/** Module settings from config (unknown keys such as `enabled` are ignored); invalid values fall back to defaults. */
export function parseSettings(raw: Readonly<Record<string, unknown>>): {
	readonly settings: CompactionSettings;
	readonly problems: readonly string[];
} {
	const withDefaults = Value.Default(SettingsSchema, { ...raw });
	if (Value.Check(SettingsSchema, withDefaults)) return { settings: withDefaults, problems: [] };
	const problems = [...Value.Errors(SettingsSchema, withDefaults)].map(
		(e) => `compaction ${e.instancePath || "/"}: ${e.message}`,
	);
	return { settings: Value.Default(SettingsSchema, {}) as CompactionSettings, problems };
}
