import { type CommandOutput, commandBase, shellCommands, verifyingRun } from "@exocortex/core";

/**
 * Which commands named in the user's request may be run (D-011, D-084).
 *
 * A sidecar reads the user's message and proposes the commands it says must pass. Each one is then
 * run with `bash -c` in the user's working tree, so what the sidecar proposes is only a proposal
 * (D-062: the model proposes, code checks). A proposed command is run only when ALL of these hold:
 *
 * 1. **The user typed the message.** Not an extension's prompt, not a suggestion sent back.
 * 2. **It is a whole code span of that message**: all of an inline `` `…` `` span, or all of a
 *    fenced block that holds a single line (a leading `$ ` prompt aside). Text outside code spans,
 *    part of a span, and a line of a longer block (a pasted log, a script) are not commands the
 *    user named.
 * 3. **The sidecar does not also list it as one the message says not to run** (D-091). Whether a
 *    sentence says no is a reading of the user's language, so the sidecar is asked outright. Code
 *    takes a command it names both ways as refused, and runs nothing when the sidecar's list names
 *    something that cannot be matched to a command (D-092, `standing`).
 * 4. **It is one plain command**: no `;`, `&`, `|`, `<`, `>`, `` ` ``, `$`, parentheses, braces,
 *    backslashes or newlines, anywhere in it, quoted or not.
 * 5. **It stays in the project and runs as the user**: no `sudo`, no word that is an absolute or
 *    home path or that climbs out with `..`.
 * 6. **It is a test or build run** as core reads command lines (`cargo test`, `pytest -q`,
 *    `npm run build`, `make check`, `./run_tests.sh`): what the agent itself runs many times in a
 *    task. `./deploy.sh`, `git push` and `python3 app.py` are never run from a request.
 *
 * Anything else the user wants run goes in the `checks` setting, which is theirs alone to write.
 */

export type CheckAcceptance = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const FENCE = /^([ \t]*)(```+|~~~+)[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*$/gm;
const INLINE = /`([^`\n]+)`/g;
const SHELL_SYNTAX = /[;&|<>`$(){}\\\n\r]/;
const OUTSIDE = /(^|=)[/~]|(^|[=/])\.\.(\/|$)/;

const unprompted = (text: string) => text.trim().replace(/^\$\s+/, "");

/** The code spans of a message, each without a shell prompt: inline spans, and fenced blocks that hold one line. */
function codeSpans(message: string): string[] {
	const spans: string[] = [];
	// Fences first, blanked out afterwards so their backticks and content are not read as inline spans.
	const prose = message.replace(FENCE, (block, _indent: string, _fence: string, body: string) => {
		const lines = body.split("\n").filter((line) => line.trim() !== "");
		if (lines.length === 1) spans.push(unprompted(lines[0] ?? ""));
		return " ".repeat(block.length);
	});
	for (const match of prose.matchAll(INLINE)) spans.push(unprompted(match[1] ?? ""));
	return spans;
}

/** Whether a message names a command: it is the whole of one of its code spans. */
export function namedInRequest(command: string, message: string): boolean {
	return codeSpans(message).includes(command.trim());
}

/** What a sidecar's "do not run" list (D-091) leaves of the commands that could be run. */
export interface Standing {
	/** The commands still to run. */
	readonly commands: readonly string[];
	/** An entry of the list that names no command code can identify, when that emptied `commands`. */
	readonly unidentified?: string;
}

/**
 * The commands of `commands` (those proposed from `message` and those in use from earlier
 * messages) that the sidecar's list leaves standing (D-092). Each entry is one of:
 * - **one of the commands**, exactly: that one is not run;
 * - **another command the user wrote out** in a code span of `message`: it refuses nothing here;
 * - **neither**: the sidecar's own wording for what the user refused ("npm run test" for
 *   `npm test`, "the test suite"). Which command it means cannot be told, so none is run. A check
 *   not run costs one piece of evidence; running what the user refused is the dearer mistake.
 */
export function standing(commands: readonly string[], refused: readonly string[], message: string): Standing {
	const entries = refused.map(unprompted).filter(Boolean);
	const known = new Set(commands.map((command) => command.trim()));
	const unidentified = entries.find((entry) => !known.has(entry) && !namedInRequest(entry, message));
	if (unidentified !== undefined) return { commands: [], unidentified };
	return { commands: commands.filter((command) => !entries.includes(command.trim())) };
}

/**
 * Whether a command by itself is one a request may have run: rules 4 to 6 above. Checked when a
 * command is accepted, when one comes back from saved state, and again just before it is run.
 */
export function plainTestOrBuild(command: string): CheckAcceptance {
	const syntax = SHELL_SYNTAX.exec(command);
	if (syntax)
		return {
			ok: false,
			reason: `it is more than one plain command (it has \`${syntax[0].trim() || "a line break"}\`)`,
		};
	const commands = shellCommands(command);
	if (commands?.length !== 1) return { ok: false, reason: "it is not one plain command" };
	const words = command.trim().split(/\s+/);
	if (/^(sudo|doas|su)$/.test(commandBase(words[0]))) return { ok: false, reason: "it runs as another user" };
	if (words.some((word) => OUTSIDE.test(word.replace(/^["']/, "")))) {
		return { ok: false, reason: "it names a path outside the project" };
	}
	const run = verifyingRun(command);
	if (!run || run.hidden) return { ok: false, reason: "it is not a test or build command" };
	return { ok: true };
}

/**
 * Whether a command the sidecar proposed from `message` may be run, as far as the command and the
 * message go (rules 2 and 4 to 6 above). The caller knows who sent the message and what the
 * sidecar read it as refusing ({@link standing}).
 */
export function acceptRequestCheck(command: string, message: string): CheckAcceptance {
	if (!namedInRequest(command, message)) return { ok: false, reason: "it is not a whole code span of the request" };
	return plainTestOrBuild(command);
}

/** How a check command ended: only a number says pass or fail (D-084). */
export function checkOutcome(output: CommandOutput): "passed" | "failed" | "inconclusive" {
	if (output.timedOut || output.exitCode === null) return "inconclusive";
	return output.exitCode === 0 ? "passed" : "failed";
}
