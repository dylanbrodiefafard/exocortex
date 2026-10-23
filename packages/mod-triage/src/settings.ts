import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const SettingsSchema = Type.Object(
	{
		/**
		 * From this many sightings of one failure, the result says the approach is not working
		 * (research R3.4); from twice as many, it asks for a hand-over to the user. One failure is one
		 * set of reported errors (D-073): a run with fewer or other errors is new.
		 */
		loopThreshold: Type.Integer({ minimum: 2, default: 3 }),
		/**
		 * Also notice loops without an error (D-069): the same call with the same result, or a short
		 * cycle of calls, `loopThreshold` times in a row. Twice that, the notice asks for a hand-over.
		 */
		loops: Type.Boolean({ default: true }),
		/**
		 * Count a test or build run that failed behind a pipe (`cargo test 2>&1 | tail -30` exits 0) as
		 * a failure when its output shows it failed (D-073).
		 */
		maskedFailures: Type.Boolean({ default: true }),
		/**
		 * Ask a sidecar for a diagnosis when a failure repeats or a run stops converging (D-108). It is
		 * asked of a fork of the agent's own context when the engine forks for free (D-093), else of a
		 * prompt with the evidence. It never holds the agent: the hint arrives as late help (D-098).
		 */
		sidecar: Type.Boolean({ default: true }),
		/** Diagnoses asked per failure; a call that ends without an answer is not counted. */
		maxHintsPerSignature: Type.Integer({ minimum: 0, default: 2 }),
	},
	{
		additionalProperties: true,
		// D-108: hints never hold the agent, no first-error banner, no hypotheses, a fork whenever there
		// is one, and core's list of benign exits.
		retired: ["buriedAfterLines", "hintTimeoutMs", "forkHints", "hypotheses", "hypothesisTimeoutMs", "benignCommands"],
	},
);

export type TriageSettings = Static<typeof SettingsSchema>;

/** Module settings from config (unknown keys such as `enabled` are ignored); invalid values fall back to defaults. */
export function parseSettings(raw: Readonly<Record<string, unknown>>): {
	readonly settings: TriageSettings;
	readonly problems: readonly string[];
} {
	const withDefaults = Value.Default(SettingsSchema, { ...raw });
	if (Value.Check(SettingsSchema, withDefaults)) return { settings: withDefaults, problems: [] };
	const problems = [...Value.Errors(SettingsSchema, withDefaults)].map(
		(e) => `triage ${e.instancePath || "/"}: ${e.message}`,
	);
	return { settings: Value.Default(SettingsSchema, {}) as TriageSettings, problems };
}
