import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const SettingsSchema = Type.Object(
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
		/** Evidence budget for the verdict prompt, in characters (~4 per token; D-024 keeps it small). */
		maxEvidenceChars: Type.Integer({ minimum: 1000, default: 8_000 }),
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
