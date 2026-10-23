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
		/**
		 * A result pi did not cut is trimmed only when it is longer than this (~4 chars per token)
		 * and reads as a log: it failed, or has errors or routine lines (D-110). Pi cuts what is
		 * longer than 50 KB or 2,000 lines to its end; that is always trimmed, from pi's saved copy,
		 * so the start of the output is not lost.
		 */
		minChars: Type.Integer({ minimum: 500, default: 40_000 }),
		headLines: Type.Integer({ minimum: 0, default: 100 }),
		tailLines: Type.Integer({ minimum: 0, default: 200 }),
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
		/**
		 * Runs of this many lines that differ only in numbers collapse to their first and last
		 * line; never errors or lines with a source position.
		 */
		collapseRuns: Type.Integer({ minimum: 2, default: 8 }),
		/** Longer lines are cut, except the lines of a failure, which are always shown whole. */
		maxLineChars: Type.Integer({ minimum: 80, default: 2_000 }),
		/**
		 * Ceiling for a trimmed result, footer included. Over it, the selection gives up in turn:
		 * error blocks (down to 4), head and tail lines, block lines, then line length (D-083);
		 * last, whole lines from the middle, marked with their line numbers (D-110).
		 */
		maxChars: Type.Integer({ minimum: 2_000, default: 40_000 }),
		/**
		 * Where full outputs are saved when the harness did not save one; default: OS temp dir. Each
		 * session gets its own `session-<id>` directory under it, kept so a resumed session can still
		 * read them; directories untouched for 7 days are removed when Exocortex starts (D-110). The
		 * user's to set (D-087).
		 */
		saveDir: Type.Optional(Type.String({ minLength: 1, ...USER_ONLY })),
	},
	{
		additionalProperties: true,
		// The sidecar line selection (D-110): no benefit measured, and a strong model reads the output itself.
		retired: ["sidecar", "sidecarAboveChars", "sidecarMaxInputChars", "sidecarMaxLines", "sidecarTimeoutMs"],
	},
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
