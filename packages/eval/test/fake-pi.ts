import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What the stand-in for pi's CLI does with a prompt. It speaks just enough of pi's RPC protocol
 * (PI_API_NOTES §12) to drive the eval harness without a model.
 */
export interface FakePiBehavior {
	/** Never answer anything. */
	readonly silent?: boolean;
	/** Exit with this code as soon as a prompt arrives. */
	readonly exitOnPrompt?: number;
	/** Exit on the prompt unless this run is a retry (its trace label ends in `--retry`). */
	readonly crashUnlessRetry?: boolean;
	/** Exit on the prompt when the trace label contains this text. */
	readonly crashWhenLabelHas?: string;
	/** Answer the prompt as handled by an extension: accepted, and no run follows. */
	readonly handled?: boolean;
	/** Answer the prompt with `success: false`. */
	readonly rejectPrompt?: boolean;
	/** Shell command run in the workspace before the turns, standing in for the agent's edits. */
	readonly shell?: string;
	/** Turns to emit (`turn_start` … `turn_end`) before settling. Default 1. */
	readonly turns?: number;
	/** After those turns, start another one instead of settling, and wait. */
	readonly thenAnotherTurn?: boolean;
	/** Never settle after the turns. */
	readonly neverSettle?: boolean;
	/** Do not answer or act on `abort`. */
	readonly ignoreAbort?: boolean;
	/** Ask for the editor text to be set to this before settling, the first time only. */
	readonly suggestOnce?: string;
}

const SOURCE = `
const { execSync } = require("node:child_process");
const behavior = JSON.parse(process.env.FAKE_PI ?? "{}");
const label = process.env.EXO_TRACE_LABEL ?? "";
const out = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
let prompts = 0;
function handle(command) {
	if (behavior.silent) return;
	if (command.type === "abort") {
		if (behavior.ignoreAbort) return;
		out({ type: "response", id: command.id, command: "abort", success: true });
		out({ type: "agent_settled" });
		return;
	}
	if (command.type !== "prompt") return;
	prompts += 1;
	const crash =
		behavior.exitOnPrompt !== undefined ||
		(behavior.crashUnlessRetry && !label.endsWith("--retry")) ||
		(behavior.crashWhenLabelHas && label.includes(behavior.crashWhenLabelHas));
	if (crash) process.exit(behavior.exitOnPrompt ?? 3);
	if (behavior.rejectPrompt) {
		out({ type: "response", id: command.id, command: "prompt", success: false, error: "no model" });
		return;
	}
	if (behavior.handled) {
		out({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "handled" } });
		return;
	}
	out({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "started" } });
	if (behavior.shell && prompts === 1) execSync(behavior.shell, { stdio: "ignore" });
	for (let turn = 0; turn < (behavior.turns ?? 1); turn++) {
		out({ type: "turn_start", turnIndex: turn });
		out({ type: "turn_end", turnIndex: turn });
	}
	if (behavior.thenAnotherTurn) {
		out({ type: "turn_start", turnIndex: 99 });
		return;
	}
	if (behavior.neverSettle) return;
	if (behavior.suggestOnce && prompts === 1) {
		out({ type: "extension_ui_request", id: "ui-1", method: "set_editor_text", text: behavior.suggestOnce });
	}
	out({ type: "agent_settled" });
}
let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	for (let newline = buffer.indexOf("\\n"); newline !== -1; newline = buffer.indexOf("\\n")) {
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		if (line.trim() !== "") handle(JSON.parse(line));
	}
});
process.stdin.on("end", () => process.exit(0));
`;

/** Writes the fake CLI into `dir` and returns its path, for `PiRpcOptions.cliPath`. */
export function writeFakePi(dir: string): string {
	const path = join(dir, "fake-pi.cjs");
	writeFileSync(path, SOURCE);
	return path;
}

/** The environment that tells the fake what to do. */
export function fakePiEnv(behavior: FakePiBehavior): Record<string, string> {
	return { FAKE_PI: JSON.stringify(behavior) };
}
