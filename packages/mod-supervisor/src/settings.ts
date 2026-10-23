import { USER_ONLY } from "@exocortex/core";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const SettingsSchema = Type.Object(
	{
		/** `suggest`: pre-fill the user's next message (D-010). `auto`: continue on its own (opt-in). */
		mode: Type.Union([Type.Literal("suggest"), Type.Literal("auto")], { default: "suggest" }),
		/**
		 * Auto mode: continuations per task. At the limit the supervisor still judges the work and
		 * says what it found, but leaves the follow-up to the user (D-107). Suggestions are not
		 * counted: the user sends each one.
		 */
		maxContinuations: Type.Integer({ minimum: 0, default: 3 }),
		/** Check commands to run as evidence at settle, e.g. ["npm test"] (D-011). The user's to set: they are run (D-087). */
		checks: Type.Array(Type.String({ minLength: 1 }), { default: [], ...USER_ONLY }),
		/** Also run the test and build commands the user's request names in a code span (D-011; the rule is in `checks.ts`, D-084). */
		runPromptChecks: Type.Boolean({ default: true }),
		/**
		 * A limit on each check command. Unset (the default): none. The checks run in the background
		 * once the agent stops, and Escape or a new message stops them (D-098).
		 */
		checkTimeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
		/**
		 * D-071: when the verdict is `uncertain`, ask the agent once per task to check the items the
		 * evidence does not show, instead of only saying so (on by default since D-107).
		 */
		verifyUncertain: Type.Boolean({ default: true }),
		/**
		 * D-097: once the verdict is `complete` or `uncertain` and the task changed files, review the
		 * changes for bugs and follow up with the findings that survive a check of their own (once per
		 * task; on by default since D-107). It runs in the background with no time limit; Escape or a
		 * new message stops it. `/exo review` runs it at any time.
		 */
		review: Type.Boolean({ default: true }),
		/**
		 * Independent passes over the changes, each reading the files in another order. A bug fewer than
		 * two passes report is dropped (Cursor's Bugbot); SWR-Bench found little gain past five.
		 */
		reviewPasses: Type.Integer({ minimum: 1, maximum: 8, default: 5 }),
		/** Findings followed up at most, most severe first. */
		reviewMaxFindings: Type.Integer({ minimum: 1, maximum: 10, default: 3 }),
	},
	{
		additionalProperties: true,
		// D-106, D-107: read without these, with a notice. The evidence and review budgets now come from the context window.
		retired: [
			"reviewThinking",
			"preVerdict",
			"warningSignals",
			"verdictStyle",
			"finalMessage",
			"completeVotes",
			"maxEvidenceChars",
			"reviewMaxChars",
		],
	},
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
