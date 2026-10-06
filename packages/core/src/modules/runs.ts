import { classifyErrorLine, cleanTerminalOutput } from "./output.ts";
import type { ToolOutcome } from "./types.ts";

/**
 * Recognizing a run of the tests or the build in a shell command line, and a failure of one that
 * its exit code hides. Shared by the supervisor's evidence (D-071), triage and the eval (D-073).
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

/**
 * A test or build run that failed behind a pipe (D-073): `cargo test 2>&1 | tail -30` exits with
 * `tail`'s status, so the call looks like a success. It counts as a failure when what was let
 * through has a toolchain-specific error line; a warning or a line that only mentions an error
 * is not enough, since the exit code is all that says otherwise.
 */
export function maskedFailure(tool: Pick<ToolOutcome, "input" | "isError" | "exitCode" | "output">): boolean {
	const command = tool.input["command"];
	if (tool.isError || (tool.exitCode ?? 0) !== 0 || typeof command !== "string") return false;
	if (!verifyingRun(command)?.hidden) return false;
	return cleanTerminalOutput(tool.output)
		.split("\n")
		.some((line) => (classifyErrorLine(line) ?? classifyErrorLine(line.trim())) === "specific");
}
