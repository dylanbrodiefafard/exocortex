import { Type } from "typebox";
import { SIDECAR_MAX_TOKENS, type SidecarPool } from "../inference/pool.ts";
import { cleanTerminalOutput, lineVerdicts } from "./output.ts";
import { loadPrompt } from "./prompts.ts";
import { commandBase, shellCommands } from "./shell.ts";
import type { ToolOutcome } from "./types.ts";

/**
 * Recognizing a run of the tests or the build in a shell command line, and reading how one ended
 * when its exit code was not the line's. Shared by the supervisor's evidence (D-071), triage and
 * the eval (D-073), compaction (D-074) and memory (D-075). The line is parsed, not searched
 * (D-077): quotes, `;`, `||`, newlines, subshells and wrappers are read as the shell reads them.
 */

export interface VerifyingRun {
	readonly kind: "test" | "build";
	/** The run itself: without a leading `cd … &&`, environment, wrappers, redirection or what it is piped into. */
	readonly bare: string;
	/**
	 * The line's exit code does not say how every run on it ended: one is piped into another command
	 * without `pipefail`, followed by `;` or `||`, in the background, or a condition.
	 */
	readonly hidden: boolean;
	/** The line without what the run is piped into: one name for `cargo test` however its output was cut. */
	readonly unpiped: string;
}

export interface RunOptions {
	/** Commands to count as test runs besides the known runners (a project's own check commands). */
	readonly tests?: readonly string[];
}

/**
 * The test or build run on a command line, if it has one: its last test run, else its last build.
 * Every command the line runs is looked at, past `cd`, wrappers, subshells and `bash -c`.
 */
export function verifyingRun(commandLine: string, options: RunOptions = {}): VerifyingRun | undefined {
	const commands = shellCommands(commandLine);
	if (!commands) return undefined;
	const named = (options.tests ?? []).flatMap((test) => {
		const parsed = shellCommands(test);
		return parsed?.length === 1 && parsed[0] ? [parsed[0].words] : [];
	});
	const runs = commands.flatMap((command) => {
		const isNamed = named.some((words) => words.every((word, index) => command.words[index] === word));
		const kind = isNamed ? "test" : runnerKind(command.words);
		return kind ? [{ kind, command }] : [];
	});
	const run = runs.findLast((r) => r.kind === "test") ?? runs.at(-1);
	if (!run) return undefined;
	return {
		kind: run.kind,
		bare: run.command.words.join(" "),
		hidden: runs.some((r) => !r.command.exitShown),
		unpiped: run.command.unpiped,
	};
}

type RunKind = VerifyingRun["kind"];

/** Names of make targets, package scripts and recipes that run the tests or the build. */
const TEST_NAME = /^(test|tests|check|unittest|unit|spec|e2e|ci|verify)([-_:.].*)?$/;
const BUILD_NAME = /^(all|build|compile|typecheck|type-check|tsc|lint)([-_:.].*)?$/;
/** A script named for what it does: `./run_tests.sh`, `scripts/test`, `tests/test_parser.py`, `./build.sh`. */
const TEST_SCRIPT = /(^|[-_.])(tests?|check)([-_.]|$)/;
const BUILD_SCRIPT = /^build([-_.]|$)/;
const TEST_BINARIES: ReadonlySet<string> = new Set([
	"pytest",
	"py.test",
	"tox",
	"nox",
	"ctest",
	"gotestsum",
	"vitest",
	"jest",
	"mocha",
]);
const BUILD_BINARIES: ReadonlySet<string> = new Set(["tsc", "tsgo"]);
const PYTHON_TEST_MODULES: ReadonlySet<string> = new Set(["pytest", "unittest", "tox", "nox", "nose2"]);
const PYTHON_BUILD_MODULES: ReadonlySet<string> = new Set(["compileall", "py_compile", "build", "mypy"]);
const SHELL = /^(ba|z|da|k)?sh$/;

/** Options that take their value as the next word, so the value is not read as a subcommand or target. */
const CARGO_VALUES = ["--color", "--config", "-Z", "-C", "--manifest-path"];
const GO_VALUES = ["-C"];
const MAKE_VALUES = ["-C", "-f", "-I", "-o", "-W", "--directory", "--file"];
const PYTHON_VALUES = ["-W", "-X"];
const NODE_VALUES = ["--prefix", "-w", "--workspace", "-C", "--dir", "--filter", "-F", "--cwd"];
const JUST_VALUES = ["-f", "--justfile", "-d", "--working-directory", "-t", "--taskfile"];

/**
 * A command's arguments that are not options, assignments or bare numbers: `-j 8` and `VERBOSE=1`
 * are left out (a number is an option's count, never a subcommand or a target).
 */
function positionals(args: readonly string[], values: readonly string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";
		if (arg === "--") break;
		if (values.includes(arg)) i++;
		else if (!/^[-+]|^\w+=|^\d+$/.test(arg)) out.push(arg);
	}
	return out;
}

/** Whether a command, past its wrappers, runs the tests or the build. */
function runnerKind(words: readonly string[]): RunKind | undefined {
	const [first = "", ...args] = words;
	const name = commandBase(first);
	if (TEST_BINARIES.has(name)) return "test";
	if (BUILD_BINARIES.has(name)) return "build";
	const tool = TOOLS.get(name);
	if (tool) return tool(args, name);
	if (/^(python|pypy)[\d.]*$/.test(name)) return pythonKind(args);
	// `bash scripts/test.sh`: the script decides, as when it is run by its path.
	if (SHELL.test(name)) return scriptKind(positionals(args, [])[0], true);
	return scriptKind(first, false);
}

type Tool = (args: readonly string[], name: string) => RunKind | undefined;

const cargoKind: Tool = (args) => {
	const [sub = "", next] = positionals(args, CARGO_VALUES);
	if (sub === "nextest") return next === "run" || next === "r" ? "test" : undefined;
	if (sub === "test" || sub === "t") return args.includes("--no-run") ? "build" : "test";
	return /^(build|b|check|c|clippy)$/.test(sub) ? "build" : undefined;
};

const goKind: Tool = (args) => {
	const sub = positionals(args, GO_VALUES)[0];
	return sub === "test" ? "test" : sub === "build" || sub === "vet" ? "build" : undefined;
};

/** `make` alone builds; a target named for the tests runs them; `make clean` does neither. */
const makeKind: Tool = (args) => {
	const targets = positionals(args, MAKE_VALUES);
	if (targets.some((target) => TEST_NAME.test(target))) return "test";
	return targets.length === 0 || targets.some((target) => BUILD_NAME.test(target)) ? "build" : undefined;
};

const cmakeKind: Tool = (args) => {
	if (!args.includes("--build")) return undefined;
	const at = args.findIndex((arg) => arg === "--target" || arg === "-t");
	return at !== -1 && TEST_NAME.test(args[at + 1] ?? "") ? "test" : "build";
};

const packageScriptKind: Tool = (args, name) => {
	const [sub, script] = positionals(args, NODE_VALUES);
	if (sub === "run" || sub === "run-script") return namedKind(script);
	if (sub === "test" || sub === "t" || sub === "tst") return "test";
	// `yarn build`, `pnpm check`: these run a script by its name alone; npm does not.
	return name === "npm" ? undefined : namedKind(sub);
};

const recipeKind: Tool = (args) => namedKind(positionals(args, JUST_VALUES)[0]);

const TOOLS: ReadonlyMap<string, Tool> = new Map<string, Tool>([
	["cargo", cargoKind],
	["go", goKind],
	["make", makeKind],
	["gmake", makeKind],
	["ninja", makeKind],
	["cmake", cmakeKind],
	["npm", packageScriptKind],
	["pnpm", packageScriptKind],
	["yarn", packageScriptKind],
	["bun", packageScriptKind],
	["just", recipeKind],
	["task", recipeKind],
	["node", (args) => (args.includes("--test") ? "test" : undefined)],
	["deno", (args) => (args[0] === "test" ? "test" : undefined)],
]);

/** `python -m pytest`, `python3.11 -W error -m unittest`, or a test file run as a script. */
function pythonKind(args: readonly string[]): RunKind | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";
		if (arg === "-m") {
			const module = args[i + 1] ?? "";
			return PYTHON_TEST_MODULES.has(module) ? "test" : PYTHON_BUILD_MODULES.has(module) ? "build" : undefined;
		}
		if (arg === "-c") return undefined;
		if (PYTHON_VALUES.includes(arg)) i++;
		else if (!arg.startsWith("-")) return scriptKind(arg, true);
	}
	return undefined;
}

function namedKind(name: string | undefined): RunKind | undefined {
	if (name === undefined) return undefined;
	return TEST_NAME.test(name) ? "test" : BUILD_NAME.test(name) ? "build" : undefined;
}

/** A script run by its path (`./run_tests.sh`), or handed to an interpreter (`bash scripts/test.sh`). */
function scriptKind(path: string | undefined, interpreted: boolean): RunKind | undefined {
	if (path === undefined || !(interpreted || path.includes("/"))) return undefined;
	// `/usr/bin/test -f x` is the shell's `test`.
	if (/^(\/usr)?\/bin\//.test(path)) return undefined;
	const base = commandBase(path).replace(/\.\w+$/, "");
	return TEST_SCRIPT.test(base) ? "test" : BUILD_SCRIPT.test(base) ? "build" : undefined;
}

/** What a run's output shows of how it ended, when its exit code does not say. */
export type RunVerdict = "passed" | "failed" | "unknown";

/** What a passing test run prints last, per runner (D-016's toolchains, CTest, GoogleTest, nextest). */
const PASS_SUMMARY: readonly RegExp[] = [
	/^test result: ok\./,
	/^Summary \[.*\] \d+ tests? run: \d+ passed(?!.*\b(failed|timed out)\b)/,
	/^ok\s+\S+\s+(\d|\(cached\))/,
	/^PASS$/,
	/^OK( \(.*\))?$/,
	/^=* ?\d+ passed\b(?!.*\b(failed|errors?)\b)/,
	/^100% tests passed/,
	/^\[\s+PASSED\s+\] \d+ tests?\./,
	/^All tests passed\b/,
];

/** The run whose exit code the line's does not show, if the call is one: it "succeeded" with another command's status. */
export function hiddenRun(tool: Pick<ToolOutcome, "input" | "isError" | "exitCode">): VerifyingRun | undefined {
	const command = tool.input["command"];
	if (tool.isError || (tool.exitCode ?? 0) !== 0 || typeof command !== "string") return undefined;
	const run = verifyingRun(command);
	return run?.hidden ? run : undefined;
}

/**
 * Reads the output of a run whose exit code was hidden (D-075), as the agent itself has to:
 * `cargo test 2>&1 | tail -30` exits with `tail`'s status. Undefined when the exit code is the
 * run's own.
 * - `failed`: the output has a line a runner or compiler prints only when it fails. A warning or
 *   a line that only mentions an error is not enough, since the exit code is all that says
 *   otherwise. A traceback or a panic counts unless the runner's pass summary comes after it: a
 *   passing test may log the exception it handled (D-077).
 * - `passed`: a test run, with its runner's pass summary and no such line.
 * - `unknown`: neither. A build prints nothing on success, and `| grep` or `| head` may leave the
 *   result out.
 */
export function readHiddenRun(
	tool: Pick<ToolOutcome, "input" | "isError" | "exitCode" | "output">,
): RunVerdict | undefined {
	const run = hiddenRun(tool);
	if (!run) return undefined;
	const lines = cleanTerminalOutput(tool.output).split("\n");
	const verdicts = lineVerdicts(lines);
	if (verdicts.includes("failed")) return "failed";
	const lastPass = lines.findLastIndex((line) => PASS_SUMMARY.some((pattern) => pattern.test(line.trim())));
	if (verdicts.some((verdict, index) => verdict === "error" && index > lastPass)) return "failed";
	return run.kind === "test" && lastPass !== -1 ? "passed" : "unknown";
}

/**
 * How a call ended, for modules that act on pass and fail: its exit code, or for a run whose exit
 * code was hidden, what its output shows. The harness adapter fills `hidden` (it may have asked a
 * sidecar); without it the output is read here. A command that is not a known run and is piped
 * into another is `unknown` (D-077): its exit code was the other command's, and nothing here can
 * read its output.
 */
export function outcomeOf(tool: Pick<ToolOutcome, "input" | "isError" | "exitCode" | "output" | "hidden">): RunVerdict {
	if (tool.isError || (tool.exitCode ?? 0) !== 0) return "failed";
	const read = tool.hidden ?? readHiddenRun(tool);
	if (read) return read;
	const command = tool.input["command"];
	if (typeof command !== "string" || verifyingRun(command)) return "passed";
	const commands = shellCommands(command);
	return (commands ? commands.some((c) => c.piped) : command.includes("|")) ? "unknown" : "passed";
}

/** A test or build run that failed behind a pipe (D-073): its exit code says success, its output does not. */
export function maskedFailure(
	tool: Pick<ToolOutcome, "input" | "isError" | "exitCode" | "output" | "hidden">,
): boolean {
	return hiddenRun(tool) !== undefined && outcomeOf(tool) === "failed";
}

/** Commands whose exit code 1 means "no match" or "differs", not failure (D-043's list). */
export const BENIGN_EXIT_COMMANDS: readonly string[] = [
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"ag",
	"diff",
	"cmp",
	"test",
	"[",
	"which",
	"pgrep",
	"git diff",
];

/**
 * Whether a call's exit code 1 is an answer and not a failure (D-043, D-077): the command that set
 * the line's exit code is one of `benign` (`grep` finding nothing). That command is the last one
 * the line runs, past `cd … &&`, pipes, environment and wrappers.
 */
export function isBenignExit(
	command: string,
	exitCode: number | null,
	benign: readonly string[] = BENIGN_EXIT_COMMANDS,
): boolean {
	if (exitCode !== 1) return false;
	const last = shellCommands(command)?.at(-1);
	if (!last) return false;
	const words = [commandBase(last.words[0]), ...last.words.slice(1)].join(" ");
	return benign.some((name) => words === name || words.startsWith(`${name} `));
}

const VERDICT_PROMPT = loadPrompt(new URL("../../prompts/run-verdict.v1.md", import.meta.url));
const VerdictSchema = Type.Object({
	verdict: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("unknown")]),
	evidence: Type.String({ maxLength: 400 }),
});
/** The agent piped the output to keep it short; a longer one is read from its end, where results are. */
const MAX_OUTPUT_CHARS = 12_000;
/** A quoted line this short must be a whole line of the output: "OK" is inside many words. */
const MIN_PARTIAL_QUOTE = 8;

export interface HiddenRunReading {
	readonly verdict: RunVerdict;
	/** `output`: read by {@link readHiddenRun}. `sidecar`: a model read it and its quote was found. */
	readonly source: "output" | "sidecar";
	/** The line of the output the sidecar quoted as showing the verdict. */
	readonly evidence?: string;
}

/**
 * {@link readHiddenRun}, and for a test run it cannot read, a sidecar's reading (D-075): runners
 * and summaries the grammar does not know. The model proposes and code checks (D-062): its answer
 * counts only with a line quoted from the output, and "passed" never against a line that mentions
 * a failure. Anything else, a failed call included, is `unknown`. Never rejects.
 */
export async function judgeHiddenRun(
	tool: Pick<ToolOutcome, "input" | "isError" | "exitCode" | "output">,
	sidecar: { readonly pool: SidecarPool | undefined; readonly module: string; readonly timeoutMs: number },
	signal: AbortSignal,
): Promise<HiddenRunReading | undefined> {
	const verdict = readHiddenRun(tool);
	if (verdict === undefined) return undefined;
	const lines = cleanTerminalOutput(tool.output)
		.split("\n")
		.map((line) => line.trim());
	const unread: HiddenRunReading = { verdict, source: "output" };
	if (verdict !== "unknown" || hiddenRun(tool)?.kind !== "test" || !sidecar.pool) return unread;
	if (lines.every((line) => line === "")) return unread;
	const result = await sidecar.pool
		.run({
			module: sidecar.module,
			priority: "interactive",
			timeoutMs: sidecar.timeoutMs,
			signal,
			schema: VerdictSchema,
			schemaName: "run_verdict",
			request: {
				messages: [
					{
						role: "user",
						content: VERDICT_PROMPT.render({
							command: String(tool.input["command"]).slice(0, 500),
							output: lines.join("\n").slice(-MAX_OUTPUT_CHARS),
						}),
					},
				],
				maxTokens: SIDECAR_MAX_TOKENS,
				thinking: false,
			},
		})
		.catch(() => undefined);
	if (!result?.ok || result.value.verdict === "unknown") return unread;
	const evidence = result.value.evidence.trim();
	const quoted = lines.some(
		(line) => line === evidence || (evidence.length >= MIN_PARTIAL_QUOTE && line.includes(evidence)),
	);
	if (evidence === "" || !quoted) return unread;
	if (result.value.verdict === "passed" && lineVerdicts(lines).some((v) => v !== undefined)) return unread;
	return { verdict: result.value.verdict, source: "sidecar", evidence };
}
