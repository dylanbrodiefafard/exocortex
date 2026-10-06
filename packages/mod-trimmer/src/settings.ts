import { USER_ONLY } from "@exocortex/core";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

/** Tools whose output the agent is about to act on verbatim: never trimmed (brief §6.2). */
export const NEVER_TRIMMED: ReadonlySet<string> = new Set(["read", "edit", "write"]);

const VERBATIM_COMMANDS = [
	..."cat head tail sed awk less more bat nl cut sort uniq wc tr tac column fold".split(" "),
	..."grep egrep fgrep rg ag ack find fd ls tree stat file du".split(" "),
	..."jq yq xxd hexdump od strings nm objdump readelf diff cmp echo printf".split(" "),
	..."diff show log blame grep status ls-files cat-file reflog branch tag".split(" ").map((sub) => `git ${sub}`),
];

export const SettingsSchema = Type.Object(
	{
		/** Tools whose results may be trimmed (read/edit/write never are). */
		tools: Type.Array(Type.String({ minLength: 1 }), { default: ["bash"] }),
		/** Results at most this long are left alone (~4 chars per token). */
		minChars: Type.Integer({ minimum: 500, default: 8_000 }),
		headLines: Type.Integer({ minimum: 0, default: 40 }),
		tailLines: Type.Integer({ minimum: 0, default: 80 }),
		contextLines: Type.Integer({ minimum: 0, default: 3 }),
		/**
		 * An error's block (snippet, traceback, stacks, a failing test's output) is kept whole up to
		 * this many lines; a longer one keeps its start, its end and its key lines.
		 */
		maxBlockLines: Type.Integer({ minimum: 0, default: 30 }),
		/** Hide passing tests and compile progress first; if the rest fits `minChars`, all of it is shown. */
		hideRoutine: Type.Boolean({ default: true }),
		/**
		 * Bash commands whose output is content the agent asked for, not a log: left untrimmed when
		 * every printing part of the command line ends in one (`git` entries name a subcommand).
		 * After a command that is not listed, only one that selects counts (`| tail`, `| grep`,
		 * `| sed -n`): `cargo test | cat` is still a log.
		 */
		verbatimCommands: Type.Array(Type.String({ minLength: 1 }), { default: [...VERBATIM_COMMANDS] }),
		/**
		 * When the harness cut the output and saved all of it, trim from the saved file instead of
		 * the part the harness kept, unless the file is larger than this.
		 */
		maxFullOutputBytes: Type.Integer({ minimum: 0, default: 16 * 1024 * 1024 }),
		/**
		 * Error blocks shown with their lines, failures before lines that only mention one. Failures
		 * beyond it still show the line that names them (three times as many).
		 */
		maxErrorWindows: Type.Integer({ minimum: 0, default: 40 }),
		/** Runs of this many lines that differ only in numbers collapse; never errors or lines with a source position. */
		collapseRuns: Type.Integer({ minimum: 2, default: 3 }),
		maxLineChars: Type.Integer({ minimum: 80, default: 400 }),
		/**
		 * Ceiling for a trimmed result, footer included. Over it, the selection gives up in turn:
		 * error blocks (down to 4), head and tail lines, block lines, then line length (D-083).
		 */
		maxChars: Type.Integer({ minimum: 2_000, default: 24_000 }),
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
		/**
		 * Where full outputs are saved when the harness did not save one; default: OS temp dir. Each
		 * session gets its own `session-<id>` directory under it, removed when the process exits. The
		 * user's to set (D-087).
		 */
		saveDir: Type.Optional(Type.String({ minLength: 1, ...USER_ONLY })),
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
