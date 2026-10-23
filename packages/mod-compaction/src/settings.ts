import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const SettingsSchema = Type.Object(
	{
		/**
		 * The handover's limit. A reply cut off at it is asked for again once at twice the limit, and
		 * is never used cut off (D-111). Pi's own summary may run to 80% of `reserveTokens`, ~13k.
		 */
		maxSummaryTokens: Type.Integer({ minimum: 200, default: 12_288 }),
		/**
		 * Write the summary as a continuation of the main agent's context when the engine can serve
		 * that from its cache (D-093). The transcript prompt is used when it cannot, and after a
		 * fork that fails.
		 */
		fork: Type.Boolean({ default: true }),
		/**
		 * D-098: once the context passes `earlySummaryAt` of the point where pi compacts, write the
		 * summary in the background, from a fork, whenever the agent stops. At compaction only what
		 * came after it is added, so the user waits for a short update instead of the whole summary.
		 * On by default since D-111: it runs only while the agent is idle and costs a cached-prefix fork.
		 */
		earlySummary: Type.Boolean({ default: true }),
		earlySummaryAt: Type.Number({ minimum: 0.1, maximum: 0.95, default: 0.7 }),
		/** Per-message cap for verbatim user requests. */
		maxUserMessageChars: Type.Integer({ minimum: 200, default: 8_000 }),
		/**
		 * Budget for the whole requests section. Over it, the first and the newest request stay whole
		 * and those between are cut to their first line; over it still, the oldest of those are left
		 * out and counted (D-085).
		 */
		maxRequestsChars: Type.Integer({ minimum: 1_000, default: 40_000 }),
	},
	// D-111: the transcript is cut only past the context window, and a failed summary is followed by
	// pi's own with the facts after it, whatever the setting said.
	{ additionalProperties: true, retired: ["maxConversationChars", "fallback"] },
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
