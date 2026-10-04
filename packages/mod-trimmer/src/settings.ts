import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

/** Tools whose output the agent is about to act on verbatim: never trimmed (brief §6.2). */
export const NEVER_TRIMMED: ReadonlySet<string> = new Set(["read", "edit", "write"]);

const SettingsSchema = Type.Object(
	{
		/** Tools whose results may be trimmed (read/edit/write never are). */
		tools: Type.Array(Type.String({ minLength: 1 }), { default: ["bash"] }),
		/** Results at most this long are left alone (~4 chars per token). */
		minChars: Type.Integer({ minimum: 500, default: 8_000 }),
		headLines: Type.Integer({ minimum: 0, default: 40 }),
		tailLines: Type.Integer({ minimum: 0, default: 80 }),
		contextLines: Type.Integer({ minimum: 0, default: 3 }),
		maxErrorWindows: Type.Integer({ minimum: 0, default: 40 }),
		collapseRuns: Type.Integer({ minimum: 2, default: 3 }),
		maxLineChars: Type.Integer({ minimum: 80, default: 400 }),
		/** Sidecar line selection when the deterministic tier still leaves this much (research R2.2). */
		sidecar: Type.Boolean({ default: false }),
		sidecarAboveChars: Type.Integer({ minimum: 500, default: 8_000 }),
		/** Outputs longer than this (after cleanup) skip the sidecar: too slow to prefill on the hot path. */
		sidecarMaxInputChars: Type.Integer({ minimum: 1_000, default: 60_000 }),
		/** Cap on lines the sidecar may keep. */
		sidecarMaxLines: Type.Integer({ minimum: 10, default: 150 }),
		/** The sidecar holds the agent loop, so the deadline is short; the deterministic result is the fallback. */
		sidecarTimeoutMs: Type.Integer({ minimum: 500, default: 6_000 }),
		thinking: Type.Boolean({ default: false }),
		/** Where full outputs are saved when the harness did not save one; default: OS temp dir. */
		saveDir: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: true },
);

export type TrimmerSettings = Static<typeof SettingsSchema>;

/** Module settings from config (unknown keys such as `enabled` are ignored); invalid values fall back to defaults. */
export function parseSettings(raw: Readonly<Record<string, unknown>>): {
	readonly settings: TrimmerSettings;
	readonly problems: readonly string[];
} {
	const withDefaults = Value.Default(SettingsSchema, { ...raw });
	if (Value.Check(SettingsSchema, withDefaults)) return { settings: withDefaults, problems: [] };
	const problems = [...Value.Errors(SettingsSchema, withDefaults)].map(
		(e) => `trimmer ${e.instancePath || "/"}: ${e.message}`,
	);
	return { settings: Value.Default(SettingsSchema, {}) as TrimmerSettings, problems };
}
