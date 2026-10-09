import { USER_ONLY } from "@exocortex/core";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const SettingsSchema = Type.Object(
	{
		/** `suggest`: pre-fill the user's next message (D-010). `auto`: continue on its own (opt-in). */
		mode: Type.Union([Type.Literal("suggest"), Type.Literal("auto")], { default: "suggest" }),
		/** Continuations (accepted suggestions or auto) per task before the supervisor stays quiet. */
		maxContinuations: Type.Integer({ minimum: 0, default: 3 }),
		/** Check commands to run as evidence at settle, e.g. ["npm test"] (D-011). The user's to set: they are run (D-087). */
		checks: Type.Array(Type.String({ minLength: 1 }), { default: [], ...USER_ONLY }),
		/** Also run the test and build commands the user's request names in a code span (D-011; the rule is in `checks.ts`, D-084). */
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
		/**
		 * R1.1: a failing check means `incomplete` and no change at all means `uncertain`, without a
		 * verdict call. After a failing check a small sidecar call still reads whether the agent is
		 * waiting on the user (D-091).
		 */
		preVerdict: Type.Boolean({ default: false }),
		/**
		 * R1.2 #4–#7: add test-tampering, stub, unsupported-claim and narrow-test warnings to the
		 * evidence. The claims are read from the agent's final message by a sidecar (D-091).
		 */
		warningSignals: Type.Boolean({ default: false }),
		/** R1.4: judge each checklist item with a quoted evidence line, and derive the verdict in code. */
		verdictStyle: Type.Union([Type.Literal("holistic"), Type.Literal("per-criterion")], { default: "holistic" }),
		/**
		 * What the verdict reads of the agent's final message. `message`: the message itself, the start
		 * and end of a very long one (D-089). `claims` (R1.3): only its unverified claims, as a sidecar read them (D-091).
		 */
		finalMessage: Type.Union([Type.Literal("message"), Type.Literal("claims")], { default: "message" }),
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
