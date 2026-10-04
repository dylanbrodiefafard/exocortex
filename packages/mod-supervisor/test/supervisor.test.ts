import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ChatRequest,
	createSidecarPool,
	ENGINE_PROFILES,
	type InferenceClient,
	type ModuleContext,
	runShellCommand,
	type TraceEventInput,
} from "@exocortex/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSupervisor } from "../src/supervisor.ts";

interface Script {
	ledger: object;
	verdicts: object[];
}

let repo: string;
let records: Omit<TraceEventInput, "module" | "synthetic">[];
let requests: ChatRequest[];

beforeEach(async () => {
	repo = mkdtempSync(join(tmpdir(), "exo-sup-"));
	writeFileSync(join(repo, "app.py"), "print('v1')\n");
	await runShellCommand("git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm base", {
		cwd: repo,
		timeoutMs: 10_000,
	});
	records = [];
	requests = [];
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

/** A sidecar engine that answers ledger and verdict prompts from a script. */
function scriptedClient(script: Script): InferenceClient {
	let verdictIndex = 0;
	return {
		async chat(request) {
			requests.push(request);
			const prompt = String(request.messages[0]?.["content"]);
			const reply = prompt.includes("acceptance checklist and evidence")
				? (script.verdicts[Math.min(verdictIndex++, script.verdicts.length - 1)] ?? {})
				: script.ledger;
			return {
				text: JSON.stringify(reply),
				finishReason: "stop",
				usage: { promptTokens: 100, completionTokens: 20, cachedTokens: null },
			};
		},
	};
}

function context(script: Script | undefined): ModuleContext {
	const pool = script
		? createSidecarPool({
				client: scriptedClient(script),
				target: { baseUrl: "http://x/v1", model: "m", apiKey: undefined, features: ENGINE_PROFILES.generic },
				config: {
					maxConcurrent: 3,
					reservedForMain: 1,
					timeoutMs: 5_000,
					sessionTokenBudget: 0,
					backgroundWhenIdleOnly: true,
				},
				moduleLimits: () => ({ maxCallsPerTurn: 100, maxTokensPerCall: 1024 }),
			})
		: undefined;
	return {
		cwd: repo,
		pool: () => pool,
		record: (event) => records.push(event),
		runCommand: (command, options) => runShellCommand(command, { cwd: repo, ...options }),
		log: () => {},
	};
}

const LEDGER = {
	is_task: true,
	follows_previous: false,
	criteria: ["Print v2 from app.py", "Add a README"],
	check_commands: ["python3 app.py", "rm -rf /"],
};
const INCOMPLETE = { verdict: "incomplete", missing: ["Add a README"], asked_user: false, reason: "no README" };
const COMPLETE = { verdict: "complete", missing: [], asked_user: false, reason: "all done" };
const DONE = { outcome: "completed" as const, lastAssistantText: "Done! I updated app.py." };
const signal = new AbortController().signal;

function kinds(): string[] {
	return records.map((r) => `${r.kind}:${String((r.data as { action?: string }).action ?? "")}`);
}

describe("supervisor", () => {
	it("suggests a follow-up listing what is missing, then counts the accepted suggestion as a continuation", async () => {
		const sup = createSupervisor({}, context({ ledger: LEDGER, verdicts: [INCOMPLETE] }));
		sup.onUserTurn?.({ text: "Make app.py print v2 and add a README. Check with `python3 app.py`.", origin: "user" });
		writeFileSync(join(repo, "app.py"), "print('v2')\n");
		sup.onToolResult?.({ toolName: "edit", input: { path: "app.py" }, isError: false, exitCode: null, output: "ok" });
		sup.onToolResult?.({
			toolName: "bash",
			input: { command: "python3 app.py" },
			isError: false,
			exitCode: 0,
			output: "v2",
		});

		const action = await sup.onSettle?.(DONE, signal);
		expect(action).toEqual({
			kind: "suggest",
			text: "Not done yet. These parts of my request still look unfinished:\n1. Add a README\nPlease finish them and verify your work before stopping.",
			summary: "supervisor: 1 item(s) look unfinished",
		});
		expect(kinds()).toEqual(["exo.ledger:", "exo.verdict:", "exo.action:suggested"]);

		// The verdict prompt saw the ledger, the diff, the agent's commands and the check output;
		// only the command quoted verbatim in the request was run ("rm -rf /" was not).
		const verdictPrompt = String(requests.at(-1)?.messages[0]?.["content"]);
		expect(verdictPrompt).toContain("1. Print v2 from app.py");
		expect(verdictPrompt).toContain("$ python3 app.py\nexit code: 0\nv2");
		expect(verdictPrompt).toContain("app.py | 2 +-");
		expect(verdictPrompt).toContain("Files the agent edited or wrote: app.py");
		expect(verdictPrompt).not.toContain("rm -rf");
		expect(records[0]?.data).toMatchObject({ checks: ["python3 app.py"] });

		sup.onUserTurn?.({ text: action?.kind === "suggest" ? action.text : "", origin: "user" });
		expect(kinds().at(-1)).toBe("exo.action:accepted");
		expect(sup.status?.()).toContain("1/3 continuations");
	});

	it("reports completion without acting", async () => {
		const sup = createSupervisor({}, context({ ledger: LEDGER, verdicts: [COMPLETE] }));
		sup.onUserTurn?.({ text: "Make app.py print v2 and add a README.", origin: "user" });
		expect(await sup.onSettle?.(DONE, signal)).toEqual({
			kind: "notify",
			summary: "supervisor: complete",
			level: "info",
		});
	});

	it("stays quiet when the agent asked the user a question, without calling the verdict sidecar", async () => {
		const sup = createSupervisor({}, context({ ledger: LEDGER, verdicts: [INCOMPLETE] }));
		sup.onUserTurn?.({ text: "Make app.py print v2.", origin: "user" });
		const action = await sup.onSettle?.(
			{ outcome: "completed", lastAssistantText: "I can do it two ways.\n\nWhich one do you prefer?" },
			signal,
		);
		expect(action).toBeUndefined();
		expect(kinds()).toEqual(["exo.ledger:", "exo.action:skipped"]);
		expect(records.at(-1)?.data).toEqual({ action: "skipped", reason: "asked_user" });
	});

	it("respects the verdict's asked_user flag", async () => {
		const sup = createSupervisor({}, context({ ledger: LEDGER, verdicts: [{ ...INCOMPLETE, asked_user: true }] }));
		sup.onUserTurn?.({ text: "Make app.py print v2.", origin: "user" });
		expect(await sup.onSettle?.(DONE, signal)).toMatchObject({ kind: "notify" });
	});

	it("auto mode continues until two continuations make no progress (no runaway loops)", async () => {
		const sup = createSupervisor(
			{ mode: "auto", maxContinuations: 10 },
			context({ ledger: LEDGER, verdicts: [INCOMPLETE] }),
		);
		sup.onUserTurn?.({ text: "Make app.py print v2 and add a README.", origin: "user" });
		const results: (string | undefined)[] = [];
		for (let i = 0; i < 5; i++) results.push((await sup.onSettle?.(DONE, signal))?.kind);
		expect(results).toEqual(["continue", "continue", undefined, undefined, undefined]);
		expect(records.filter((r) => (r.data as { reason?: string }).reason === "no_progress").length).toBeGreaterThan(0);
	});

	it("caps continuations per task", async () => {
		const sup = createSupervisor(
			{ mode: "auto", maxContinuations: 1 },
			context({ ledger: LEDGER, verdicts: [INCOMPLETE] }),
		);
		sup.onUserTurn?.({ text: "Make app.py print v2 and add a README.", origin: "user" });
		expect((await sup.onSettle?.(DONE, signal))?.kind).toBe("continue");
		writeFileSync(join(repo, "README.md"), "progress\n");
		expect(await sup.onSettle?.(DONE, signal)).toBeUndefined();
		expect(records.at(-1)?.data).toEqual({ action: "skipped", reason: "max_continuations" });
	});

	it("runs configured checks even when the request names none", async () => {
		const sup = createSupervisor(
			{ checks: ["echo configured-check"] },
			context({ ledger: { ...LEDGER, check_commands: [] }, verdicts: [COMPLETE] }),
		);
		sup.onUserTurn?.({ text: "Make app.py print v2.", origin: "user" });
		await sup.onSettle?.(DONE, signal);
		expect(String(requests.at(-1)?.messages[0]?.["content"])).toContain("$ echo configured-check\nexit code: 0");
	});

	it("does nothing for non-tasks, aborted runs, or without a sidecar engine", async () => {
		const chat = createSupervisor({}, context({ ledger: { ...LEDGER, is_task: false }, verdicts: [INCOMPLETE] }));
		chat.onUserTurn?.({ text: "thanks!", origin: "user" });
		expect(await chat.onSettle?.(DONE, signal)).toBeUndefined();

		const aborted = createSupervisor({}, context({ ledger: LEDGER, verdicts: [INCOMPLETE] }));
		aborted.onUserTurn?.({ text: "Make app.py print v2.", origin: "user" });
		expect(await aborted.onSettle?.({ outcome: "aborted", lastAssistantText: "" }, signal)).toBeUndefined();

		const offline = createSupervisor({}, context(undefined));
		offline.onUserTurn?.({ text: "Make app.py print v2.", origin: "user" });
		expect(await offline.onSettle?.(DONE, signal)).toBeUndefined();
	});

	it("falls back to default settings on invalid config", async () => {
		const sup = createSupervisor({ mode: "yolo" }, context({ ledger: LEDGER, verdicts: [INCOMPLETE] }));
		sup.onUserTurn?.({ text: "Make app.py print v2 and add a README.", origin: "user" });
		expect((await sup.onSettle?.(DONE, signal))?.kind).toBe("suggest");
	});
});
