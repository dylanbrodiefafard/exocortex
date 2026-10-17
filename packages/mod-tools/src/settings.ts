import { USER_ONLY } from "@exocortex/core";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const CheckSchema = Type.Object({
	/**
	 * Which edited files the check is for: `*.rs` matches by file name; a pattern with a `/`
	 * (`src/**\/*.rs`) matches the path from the workspace root.
	 */
	files: Type.String({ minLength: 1 }),
	/**
	 * Run in the workspace with bash. `{file}` becomes the edited file's path, quoted. A command
	 * without it checks the whole project: only errors that were not there before the edit are shown.
	 */
	command: Type.String({ minLength: 1 }),
});

export const SettingsSchema = Type.Object(
	{
		/** When an edit fails, show what the file holds where the edit was aimed (D-094). */
		editHints: Type.Boolean({ default: true }),
		/** Number the lines of `read` results, `cat -n` style. */
		readLineNumbers: Type.Boolean({ default: true }),
		/** When `read` stops before the end of a file, list the declarations in the rest of it. */
		outline: Type.Boolean({ default: true }),
		outlineMaxEntries: Type.Integer({ minimum: 1, default: 60 }),
		/** After an edit or write, check the file and show the errors the change introduced. */
		diagnostics: Type.Boolean({ default: true }),
		/** Syntax checks that need no setup: Python, Go, shell, JavaScript. Checks in `checks` come first. */
		builtinChecks: Type.Boolean({ default: true }),
		/** Your own checks, tried in order before the built-in ones. They run commands, so only your own config sets them. */
		checks: Type.Array(CheckSchema, { default: [], ...USER_ONLY }),
		/** A check that takes longer is stopped and shows nothing. */
		checkTimeoutMs: Type.Integer({ minimum: 200, default: 4_000 }),
		/** Lines of new errors shown after an edit. */
		maxDiagnosticLines: Type.Integer({ minimum: 1, default: 20 }),
	},
	{ additionalProperties: true },
);

export type ToolsSettings = Static<typeof SettingsSchema>;
export type CheckSetting = Static<typeof CheckSchema>;

/** Module settings from config (unknown keys such as `enabled` are ignored); invalid values fall back to defaults. */
export function parseSettings(raw: Readonly<Record<string, unknown>>): {
	readonly settings: ToolsSettings;
	readonly problems: readonly string[];
} {
	const withDefaults = Value.Default(SettingsSchema, { ...raw });
	if (Value.Check(SettingsSchema, withDefaults)) return { settings: withDefaults, problems: [] };
	const problems = [...Value.Errors(SettingsSchema, withDefaults)].map(
		(e) => `tools ${e.instancePath || "/"}: ${e.message}`,
	);
	return { settings: Value.Default(SettingsSchema, {}) as ToolsSettings, problems };
}
