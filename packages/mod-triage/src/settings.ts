import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const SettingsSchema = Type.Object(
	{
		/** A first error further down than this many lines is surfaced at the top of the result. */
		buriedAfterLines: Type.Integer({ minimum: 0, default: 20 }),
		/** From this many repeats of one failure, the notice turns into a loop warning (research R3.4). */
		loopThreshold: Type.Integer({ minimum: 2, default: 3 }),
		/** Ask a sidecar for a short diagnosis on repeated failures (research R3.1: never on the first). */
		sidecar: Type.Boolean({ default: true }),
		maxHintsPerSignature: Type.Integer({ minimum: 0, default: 2 }),
		/** The hint holds the agent loop: keep the deadline short. */
		hintTimeoutMs: Type.Integer({ minimum: 500, default: 8_000 }),
		thinking: Type.Boolean({ default: false }),
		/**
		 * Phase 6 (D-015, research R6.1): at the loop threshold, this many isolated sidecars each propose
		 * a cause from a different angle; distinct, grounded ones are listed. 0 = off.
		 */
		hypotheses: Type.Integer({ minimum: 0, maximum: 5, default: 0 }),
		hypothesisTimeoutMs: Type.Integer({ minimum: 500, default: 10_000 }),
		/** Commands whose exit code 1 means "no match" or "differs", not failure. */
		benignCommands: Type.Array(Type.String({ minLength: 1 }), {
			default: ["grep", "egrep", "fgrep", "rg", "ag", "diff", "cmp", "test", "[", "which", "pgrep", "git diff"],
		}),
	},
	{ additionalProperties: true },
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
