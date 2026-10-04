import { isTestPath, type ToolOutcome } from "@exocortex/core";

/**
 * Deterministic warning signs for the verdict (research R1.2 #4–#7): things a same-model judge
 * misses or is talked out of by a confident final message. Pure functions over the diff, the
 * agent's commands and its final message.
 */

const SKIP_MARKER =
	/@pytest\.mark\.(skip|xfail)|pytest\.skip\(|@unittest\.skip|#\[ignore\]|\bt\.Skip(Now|f)?\(|\b(it|describe|test)\.(skip|todo)\(|\bx(it|describe)\(|GTEST_SKIP|\bDISABLED_\w+/;
const ASSERTION =
	/\bassert(_eq|_ne)?!?\s*[(\w]|\bexpect\(|\b(EXPECT|ASSERT)_[A-Z_]+\(|\bt\.(Error|Errorf|Fatal|Fatalf)\(|\bself\.assert\w*\(|\bpanic!\(/;
const STUB_MARKER =
	/\b(TODO|FIXME|XXX)\b|unimplemented!\(|todo!\(|raise NotImplementedError|panic\("(not implemented|TODO|unimplemented)|throw new Error\("(not implemented|TODO)/i;
const TEST_COMMAND =
	/\b(pytest|unittest|cargo test|go test|ctest|make (test|check)|npm (run )?test|npx vitest|jest|tox)\b/;
const BUILD_COMMAND =
	/\b(cargo (build|check)|go (build|vet)|make\b|cmake --build|g\+\+|clang\+\+|gcc|tsc|npm run build|python3? -m (py_compile|compileall))/;
const NARROW_TEST = /\s-k\s|\s-run[\s=]|\s--test\s+\S|::\w|\bcargo test\s+[a-z_][\w:]*|\s--gtest_filter=|\s-t\s+\S/;

export interface DiffFile {
	readonly path: string;
	readonly deleted: boolean;
	readonly added: readonly string[];
	readonly removed: readonly string[];
}

/** Splits a unified `git diff` into per-file added and removed lines. */
export function parseDiff(diff: string): DiffFile[] {
	const files: { path: string; deleted: boolean; added: string[]; removed: string[] }[] = [];
	let current: (typeof files)[number] | undefined;
	for (const line of diff.split("\n")) {
		const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
		if (header) {
			current = { path: header[2] ?? header[1] ?? "", deleted: false, added: [], removed: [] };
			files.push(current);
			continue;
		}
		if (!current) continue;
		if (line.startsWith("deleted file mode")) current.deleted = true;
		else if (line.startsWith("+") && !line.startsWith("+++")) current.added.push(line.slice(1));
		else if (line.startsWith("-") && !line.startsWith("---")) current.removed.push(line.slice(1));
	}
	return files;
}

/** Tests deleted, skipped or with assertions removed (ImpossibleBench-style shortcuts). */
export function tamperSignals(files: readonly DiffFile[]): string[] {
	const signals: string[] = [];
	for (const file of files.filter((f) => isTestPath(f.path))) {
		if (file.deleted) {
			signals.push(`test file deleted: ${file.path}`);
			continue;
		}
		const skips = file.added.filter((l) => SKIP_MARKER.test(l)).length;
		if (skips > 0) signals.push(`${skips} skip/ignore marker(s) added in ${file.path}`);
		const lost =
			file.removed.filter((l) => ASSERTION.test(l)).length - file.added.filter((l) => ASSERTION.test(l)).length;
		if (lost > 0) signals.push(`${lost} assertion(s) removed from ${file.path}`);
	}
	return signals;
}

/** Placeholder code added outside tests (TODO, unimplemented!(), NotImplementedError, …). */
export function stubSignals(files: readonly DiffFile[]): string[] {
	const signals: string[] = [];
	for (const file of files.filter((f) => !isTestPath(f.path))) {
		const stubs = file.added.filter((l) => STUB_MARKER.test(l));
		if (stubs.length > 0)
			signals.push(`${stubs.length} stub marker(s) added in ${file.path}: ${stubs[0]?.trim().slice(0, 100)}`);
	}
	return signals;
}

export type ClaimKind = "tests_pass" | "builds" | "done";

export interface Claim {
	readonly kind: ClaimKind;
	readonly sentence: string;
}

const CLAIM_PATTERNS: readonly [ClaimKind, RegExp][] = [
	[
		"tests_pass",
		/\b(all )?(the )?tests? (now )?(pass|passes|passed|passing|are green|succeed)\b|\btests? (are )?(all )?green\b/i,
	],
	[
		"builds",
		/\b(builds?|compiles?|compiled) (successfully|cleanly|without (errors|warnings))\b|\bbuild (passes|succeeds|is green)\b/i,
	],
	[
		"done",
		/\b(task is|everything is|all|i('ve| have)) (now )?(done|complete|completed|finished|implemented)\b|\bfully (implemented|working)\b/i,
	],
];

/** Success claims in the agent's final message, one per kind, with the sentence they appear in. */
export function extractClaims(finalMessage: string): Claim[] {
	const sentences = finalMessage
		.replace(/```[\s\S]*?```/g, " ")
		.split(/(?<=[.!?])\s+|\n+/)
		.map((s) => s.trim())
		.filter(Boolean);
	const claims: Claim[] = [];
	for (const [kind, pattern] of CLAIM_PATTERNS) {
		const sentence = sentences.find((s) => pattern.test(s));
		if (sentence) claims.push({ kind, sentence: sentence.slice(0, 200) });
	}
	return claims;
}

/** Claims with no successful matching command after the agent's last file write. */
export function unsupportedClaims(claims: readonly Claim[], tools: readonly ToolOutcome[]): Claim[] {
	const lastWrite = lastIndex(tools, (t) => /edit|write|create|patch/i.test(t.toolName) && !t.isError);
	const after = tools.slice(lastWrite + 1);
	const succeeded = (pattern: RegExp) =>
		after.some((t) => !t.isError && t.exitCode === 0 && pattern.test(String(t.input["command"] ?? "")));
	return claims.filter((c) => {
		if (c.kind === "tests_pass") return !succeeded(TEST_COMMAND);
		if (c.kind === "builds") return !succeeded(BUILD_COMMAND) && !succeeded(TEST_COMMAND);
		return false;
	});
}

/** The last test command ran only a subset of the tests (`-k`, `-run`, a single test id). */
export function narrowTestSignal(tools: readonly ToolOutcome[]): string | undefined {
	const tests = tools.filter((t) => TEST_COMMAND.test(String(t.input["command"] ?? "")));
	const last = tests.at(-1);
	if (!last) return undefined;
	const command = ` ${String(last.input["command"])}`;
	return NARROW_TEST.test(command)
		? `the last test run covered only a subset: ${command.trim().slice(0, 160)}`
		: undefined;
}

/** Whether the agent changed nothing it could be judged on: no diff, no untracked files, no writes. */
export function madeNoChanges(
	diff: string | undefined,
	untracked: readonly string[],
	tools: readonly ToolOutcome[],
): boolean {
	const wrote = tools.some((t) => /edit|write|create|patch/i.test(t.toolName) && !t.isError);
	return diff !== undefined && diff.trim() === "" && untracked.length === 0 && !wrote;
}

function lastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
	for (let i = items.length - 1; i >= 0; i--) if (predicate(items[i] as T)) return i;
	return -1;
}
