import { Type } from "typebox";
import { SIDECAR_MAX_TOKENS, type SidecarPool } from "../inference/pool.ts";
import { classifyErrorLine, cleanTerminalOutput } from "./output.ts";
import { loadPrompt } from "./prompts.ts";
import type { ToolOutcome } from "./types.ts";

/**
 * Recognizing a run of the tests or the build in a shell command line, and reading how one ended
 * when a pipe hid its exit code. Shared by the supervisor's evidence (D-071), triage and the eval
 * (D-073), compaction (D-074) and memory (D-075).
 */

const TEST_RUNNER =
	/^(python3? -m (pytest|unittest)|pytest|cargo test|go test|ctest|make( -\S+)* (test|tests|check)|npm (run )?test|npx (vitest|jest)|tox)(\s|$)/;
const BUILD_RUNNER =
	/^(cargo (build|check|clippy)|go (build|vet)|make( -\S+)*( all)?$|cmake --build|npm run build|npx tsc|tsc)(\s|$)?/;
const RUN_PREFIX = /^((\w+=\S*|timeout\s+\d+[smh]?)\s+)+/;

export interface VerifyingRun {
	readonly kind: "test" | "build";
	/** The run itself: without a leading `cd … &&`, environment, redirection or what it is piped into. */
	readonly bare: string;
	/** Piped into another command without `pipefail`: the exit code is that command's. */
	readonly hidden: boolean;
}

/** The test or build run a command line ends in, if it does: its last `&&` step, up to the first pipe. */
export function verifyingRun(commandLine: string): VerifyingRun | undefined {
	const line = commandLine.trim();
	const [run = "", ...piped] = (line.split("&&").at(-1) ?? "").split("|").map((s) => s.trim());
	const bare = run.replace(/\s*2>&1/g, "").replace(RUN_PREFIX, "");
	const kind = TEST_RUNNER.test(bare) ? "test" : BUILD_RUNNER.test(bare) ? "build" : undefined;
	return kind ? { kind, bare, hidden: piped.length > 0 && !line.includes("pipefail") } : undefined;
}

/** What a run's output shows of how it ended, when its exit code does not say. */
export type RunVerdict = "passed" | "failed" | "unknown";

/** What a passing test run prints last, per runner (D-016's toolchains and CTest). */
const PASS_SUMMARY: readonly RegExp[] = [
	/^test result: ok\./,
	/^ok\s+\S+\s+(\d|\(cached\))/,
	/^PASS$/,
	/^OK( \(.*\))?$/,
	/^=* ?\d+ passed\b(?!.*\b(failed|errors?)\b)/,
	/^100% tests passed/,
];

/** The run whose exit code a pipe hid, if the call is one: it "succeeded" with the last command's status. */
export function hiddenRun(tool: Pick<ToolOutcome, "input" | "isError" | "exitCode">): VerifyingRun | undefined {
	const command = tool.input["command"];
	if (tool.isError || (tool.exitCode ?? 0) !== 0 || typeof command !== "string") return undefined;
	const run = verifyingRun(command);
	return run?.hidden ? run : undefined;
}

/**
 * Reads the output of a run whose exit code a pipe hid (D-075), as the agent itself has to:
 * `cargo test 2>&1 | tail -30` exits with `tail`'s status. Undefined when the exit code is the
 * run's own.
 * - `failed`: what was let through has a toolchain-specific error line. A warning or a line that
 *   only mentions an error is not enough, since the exit code is all that says otherwise.
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
	if (lines.some((line) => (classifyErrorLine(line) ?? classifyErrorLine(line.trim())) === "specific")) return "failed";
	const summarized = lines.some((line) => PASS_SUMMARY.some((pattern) => pattern.test(line.trim())));
	return run.kind === "test" && summarized ? "passed" : "unknown";
}

/**
 * How a call ended, for modules that act on pass and fail: its exit code, or for a run whose exit
 * code a pipe hid, what its output shows. The harness adapter fills `hidden` (it may have asked a
 * sidecar); without it the output is read here.
 */
export function outcomeOf(tool: Pick<ToolOutcome, "input" | "isError" | "exitCode" | "output" | "hidden">): RunVerdict {
	if (tool.isError || (tool.exitCode ?? 0) !== 0) return "failed";
	return tool.hidden ?? readHiddenRun(tool) ?? "passed";
}

/** A test or build run that failed behind a pipe (D-073): its exit code says success, its output does not. */
export function maskedFailure(
	tool: Pick<ToolOutcome, "input" | "isError" | "exitCode" | "output" | "hidden">,
): boolean {
	return hiddenRun(tool) !== undefined && outcomeOf(tool) === "failed";
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
	if (result.value.verdict === "passed" && lines.some((line) => classifyErrorLine(line) !== undefined)) return unread;
	return { verdict: result.value.verdict, source: "sidecar", evidence };
}
