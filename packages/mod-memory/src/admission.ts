import { isTestPath } from "@exocortex/core";
import { type Edit, editsOf, type FixEpisode } from "./episodes.ts";

/**
 * Why an episode is not a fix worth a card, or undefined when nothing says so (M1). A command
 * that failed, then passed after edits, proves only that it passes now. These are the ways it
 * can pass without the edits having fixed anything, as far as code can see them:
 * - `shell_change`: a shell command changed files in between (a checkout, a stash, an install, a
 *   formatter): the pass may be its doing;
 * - `only_tests`: nothing but tests was edited, so the test was changed to agree with the code;
 * - `weakens_test`: an edit skipped a test or took assertions out.
 *
 * What code cannot see (a flaky test, an edit beside the real cause) is left to the lesson
 * sidecar's gate, and to a wrong card being credited `hurt` or superseded later.
 */
export type Refusal = "shell_change" | "only_tests" | "weakens_test";

export function refusalOf(episode: FixEpisode): Refusal | undefined {
	if (episode.changedBy !== undefined) return "shell_change";
	const edits = editsOf(episode);
	if (edits.every((edit) => isTestPath(edit.path))) return "only_tests";
	return edits.some(weakens) ? "weakens_test" : undefined;
}

/** Markers that make a runner skip a test or accept its failure, in the languages the evals use and JS. */
const SKIP_MARKER =
	/#\[ignore\b|#\[cfg\(any\(\)\)\]|@(pytest\.mark\.)?(skip|skipif|xfail)\b|@unittest\.(skip\w*|expectedFailure)\b|\bpytest\.(skip|xfail)\(|\bt\.Skip(f|Now)?\(|\b(it|test|describe|suite)\.(skip|todo|failing)\b|\bx(it|describe|test)\(|\bDISABLED_\w|\bGTEST_SKIP\b|\bself\.skipTest\(/g;
/** A check a test makes: `assert…`, `expect(`, GoogleTest's macros, Go's `t.Error`/`t.Fatal`, testify. */
const ASSERTION =
	/\bassert\w*!?\s*\(|\bassert\s|\bexpect\s*\(|\b(EXPECT|ASSERT)_\w+\s*\(|\bt\.(Error|Fatal|Fail)\w*\(|\b(require|assert)\.\w+\(|\bself\.assert\w+\(/g;

const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

function weakens(edit: Edit): boolean {
	if (count(edit.after, SKIP_MARKER) > count(edit.before, SKIP_MARKER)) return true;
	return count(edit.after, ASSERTION) < count(edit.before, ASSERTION);
}
