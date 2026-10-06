import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const SettingsSchema = Type.Object(
	{
		/** `suggest`: pre-fill the user's next message (D-010). `auto`: continue on its own (opt-in). */
		mode: Type.Union([Type.Literal("suggest"), Type.Literal("auto")], { default: "suggest" }),
		/** Continuations (accepted suggestions or auto) per task before the supervisor stays quiet. */
		maxContinuations: Type.Integer({ minimum: 0, default: 3 }),
		/** Check commands to run as evidence at settle, e.g. ["npm test"] (D-011). */
		checks: Type.Array(Type.String({ minLength: 1 }), { default: [] }),
		/** Also run check commands quoted verbatim in the user's request (D-011). */
		runPromptChecks: Type.Boolean({ default: true }),
		checkTimeoutMs: Type.Integer({ minimum: 1000, default: 120_000 }),
		ledgerTimeoutMs: Type.Integer({ minimum: 1000, default: 30_000 }),
		verdictTimeoutMs: Type.Integer({ minimum: 1000, default: 60_000 }),
		/** Sidecar thinking (Qwen `enable_thinking`). Off by default: short JSON tasks (D-008). */
		thinking: Type.Boolean({ default: false }),
		/**
		 * Evidence budget for the verdict prompt, in characters (~4 per token). The verdict runs while
		 * the main agent is idle, so its prefill delays nothing but the verdict (D-071).
		 */
		maxEvidenceChars: Type.Integer({ minimum: 1000, default: 40_000 }),
		// Research options (docs/RESEARCH.md §1), all off by default so each can be A/B'd (D-046).
		/** R1.1: a failing check means `incomplete` with no LLM call; no change at all means `uncertain`. */
		preVerdict: Type.Boolean({ default: false }),
		/** R1.2 #4–#7: add test-tampering, stub, unsupported-claim and narrow-test warnings to the evidence. */
		warningSignals: Type.Boolean({ default: false }),
		/** R1.4: judge each checklist item with a quoted evidence line, and derive the verdict in code. */
		verdictStyle: Type.Union([Type.Literal("holistic"), Type.Literal("per-criterion")], { default: "holistic" }),
		/** R1.3: show the verdict the final message's tail (`tail`) or only its extracted, unverified claims. */
		finalMessage: Type.Union([Type.Literal("tail"), Type.Literal("claims")], { default: "tail" }),
		/** R1.5: re-ask this many times in total when the verdict is `complete`; any dissent → `uncertain`. */
		completeVotes: Type.Integer({ minimum: 1, maximum: 5, default: 1 }),
		/**
		 * D-071: when the verdict is `uncertain`, ask the agent once per task to check the items the
		 * evidence does not show, instead of staying quiet.
		 */
		verifyUncertain: Type.Boolean({ default: false }),
	},
	{ additionalProperties: true },
);

export type SupervisorSettings = Static<typeof SettingsSchema>;

/** Module settings from config (unknown keys such as `enabled` are ignored); invalid values fall back to defaults. */
export function parseSettings(raw: Readonly<Record<string, unknown>>): {
	readonly settings: SupervisorSettings;
	readonly problems: readonly string[];
} {
	const withDefaults = Value.Default(SettingsSchema, { ...raw });
	if (Value.Check(SettingsSchema, withDefaults)) return { settings: withDefaults, problems: [] };
	const problems = [...Value.Errors(SettingsSchema, withDefaults)].map(
		(e) => `supervisor ${e.instancePath || "/"}: ${e.message}`,
	);
	return { settings: Value.Default(SettingsSchema, {}) as SupervisorSettings, problems };
}
