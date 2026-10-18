import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const SettingsSchema = Type.Object(
	{
		/**
		 * The sidecar gets the whole span being summarized. This only guards a sidecar whose context
		 * window is smaller than the main model's: past it, the oldest characters are left out (~4 per token).
		 */
		maxConversationChars: Type.Integer({ minimum: 2_000, default: 400_000 }),
		/** The summary is cut off past this, so leave room for every section of the template. */
		maxSummaryTokens: Type.Integer({ minimum: 200, default: 4_096 }),
		thinking: Type.Boolean({ default: false }),
		/**
		 * Write the summary as a continuation of the main agent's context when the engine can serve
		 * that from its cache (D-093). The transcript prompt is used when it cannot, and after a
		 * fork that fails.
		 */
		fork: Type.Boolean({ default: true }),
		/**
		 * D-098: once the context passes `earlySummaryAt` of the point where pi compacts, write the
		 * summary in the background while the agent is idle, from a fork. At compaction only what
		 * came after it is added, so the user waits for a short update instead of the whole summary.
		 * Off until A/B'd (D-046): it is the summary the agent continues from.
		 */
		earlySummary: Type.Boolean({ default: false }),
		earlySummaryAt: Type.Number({ minimum: 0.1, maximum: 0.95, default: 0.7 }),
		/**
		 * Without a sidecar summary: `harness` leaves compaction to the harness's default; `deterministic`
		 * still writes the summary from tracked facts alone.
		 */
		fallback: Type.Union([Type.Literal("harness"), Type.Literal("deterministic")], { default: "harness" }),
		/** Per-message cap for verbatim user requests. */
		maxUserMessageChars: Type.Integer({ minimum: 200, default: 2_000 }),
		/**
		 * Budget for the whole requests section. Over it, the first and the newest request stay whole
		 * and those between are cut to their first line; over it still, the oldest of those are left
		 * out and counted (D-085).
		 */
		maxRequestsChars: Type.Integer({ minimum: 1_000, default: 12_000 }),
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
