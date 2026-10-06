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
 * 3. **The sentence leading up to it does not say no**: "don't run", "never", "without running",
 *    "instead of". Any occurrence that does refuses the command; a wrong refusal costs one check,
 *    a wrong acceptance runs what the user said not to.
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

interface Span {
	/** The span's text, without a shell prompt. */
	readonly text: string;
	/** The text of the sentence up to the span. */
	readonly lead: string;
}

const FENCE = /^([ \t]*)(```+|~~~+)[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*$/gm;
const INLINE = /`([^`\n]+)`/g;
const NEGATION =
	/\b(do not|don['’]?t|does not|doesn['’]?t|did not|didn['’]?t|never|not|no|without|avoid|skip|stop|instead of|rather than|must not|should not|shouldn['’]?t|cannot|can['’]?t|won['’]?t)\b/i;
const SHELL_SYNTAX = /[;&|<>`$(){}\\\n\r]/;
const OUTSIDE = /(^|=)[/~]|(^|[=/])\.\.(\/|$)/;

/** Where a sentence ends: `.`, `!`, `?` or `;` before a space, a blank line, the start of a list item, or "but". */
const BOUNDARY = /[.!?;]\s+|\n\s*\n|\n\s*(?:[-*•]|\d+[.)])\s+|\bbut\b/gi;

/** The sentence a position is in, up to that position. A colon does not end it: "Do not run: `x`". */
function sentenceBefore(text: string, at: number): string {
	const before = text.slice(0, at);
	const boundary = Math.max(0, ...[...before.matchAll(BOUNDARY)].map((m) => m.index + m[0].length));
	return before.slice(boundary);
}

const unprompted = (text: string) => text.trim().replace(/^\$\s+/, "");

/** The code spans of a message: inline spans, and fenced blocks that hold one line. */
function codeSpans(message: string): Span[] {
	const spans: Span[] = [];
	// Fences first, blanked out afterwards so their backticks and content are not read as inline spans.
	const prose = message.replace(FENCE, (block, _indent: string, _fence: string, body: string, at: number) => {
		const lines = body.split("\n").filter((line) => line.trim() !== "");
		if (lines.length === 1) spans.push({ text: unprompted(lines[0] ?? ""), lead: lastSentence(message.slice(0, at)) });
		return " ".repeat(block.length);
	});
	for (const match of prose.matchAll(INLINE)) {
		spans.push({ text: unprompted(match[1] ?? ""), lead: sentenceBefore(prose, match.index) });
	}
	return spans;
}

/** What introduces a fenced block: the last sentence before it ("Do not run this:"). */
function lastSentence(before: string): string {
	const trimmed = before.trimEnd();
	return sentenceBefore(trimmed.replace(/[.!?;:]+$/, ""), trimmed.length);
}

/** How a message names a command: as a code span, as one it says not to run, or not at all. */
export function namedInRequest(command: string, message: string): "named" | "negated" | "absent" {
	const spans = codeSpans(message).filter((span) => span.text === command.trim());
	if (spans.length === 0) return "absent";
	return spans.some((span) => NEGATION.test(span.lead)) ? "negated" : "named";
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
 * Whether a command the sidecar proposed from `message` may be run (rules 2 to 6 above; the
 * caller knows who sent the message).
 */
export function acceptRequestCheck(command: string, message: string): CheckAcceptance {
	const named = namedInRequest(command, message);
	if (named === "absent") return { ok: false, reason: "it is not a whole code span of the request" };
	if (named === "negated") return { ok: false, reason: "the request says not to run it" };
	return plainTestOrBuild(command);
}

/** How a check command ended: only a number says pass or fail (D-084). */
export function checkOutcome(output: CommandOutput): "passed" | "failed" | "inconclusive" {
	if (output.timedOut || output.exitCode === null) return "inconclusive";
	return output.exitCode === 0 ? "passed" : "failed";
}
