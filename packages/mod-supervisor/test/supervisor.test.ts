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
		embedder: () => undefined,
		progress: () => {},
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
	it("shows the judge what is inside new files, and counts edits to them as progress", async () => {
		const sup = createSupervisor(
			{ warningSignals: true, runPromptChecks: false },
			context({ ledger: LEDGER, verdicts: [INCOMPLETE] }),
		);
		sup.onUserTurn?.({ text: "Make app.py print v2 and add a README.", origin: "user" });
		writeFileSync(join(repo, "it's new.py"), "def render():\n    raise NotImplementedError\n");
		writeFileSync(join(repo, "big.txt"), `${"filler line\n".repeat(4_000)}the end\n`);
		const first = await sup.onSettle?.(DONE, signal);
		const evidence = String(requests.at(-1)?.messages[0]?.["content"]);
		expect(evidence).toContain("+def render():");
		expect(evidence).toContain("1 stub marker(s) added in it's new.py: raise NotImplementedError");
		const firstHash = records.filter((r) => r.kind === "exo.action").length;

		// The follow-up is accepted twice; each time only the untracked file changes.
		for (const body of ["def render():\n    return 1\n", "def render():\n    return 2\n"]) {
			sup.onUserTurn?.({ text: (first as { text: string }).text, origin: "suggestion" });
			writeFileSync(join(repo, "it's new.py"), body);
			await sup.onSettle?.(DONE, signal);
		}
		expect(kinds().slice(firstHash)).not.toContain("exo.action:skipped");
	});

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

	it("leaves 'is the agent waiting on the user' to the verdict: a blocking question stops it, an offer does not", async () => {
		const blocked = createSupervisor({}, context({ ledger: LEDGER, verdicts: [{ ...INCOMPLETE, asked_user: true }] }));
		blocked.onUserTurn?.({ text: "Make app.py print v2.", origin: "user" });
		expect(await blocked.onSettle?.(DONE, signal)).toEqual({
			kind: "notify",
			summary: "supervisor: the agent is waiting for your answer",
			level: "info",
		});
		expect(records.at(-1)?.data).toEqual({ action: "skipped", reason: "asked_user" });

		// Ending on an offer used to switch the supervisor off before any verdict.
		const offered = createSupervisor({}, context({ ledger: LEDGER, verdicts: [INCOMPLETE] }));
		offered.onUserTurn?.({ text: "Make app.py print v2 and add a README.", origin: "user" });
		const action = await offered.onSettle?.(
			{ outcome: "completed", lastAssistantText: "Updated app.py.\n\nWould you like me to add tests too?" },
			signal,
		);
		expect(action).toMatchObject({ kind: "suggest" });
		expect(String(requests.at(-1)?.messages[0]?.["content"])).toContain("An offer of more work after it finished");
	});

	it("without an LLM verdict, a failing check does not continue an agent that ended on a question", async () => {
		const settings = { mode: "auto", preVerdict: true, checks: ["false"], runPromptChecks: false };
		const sup = createSupervisor(settings, context({ ledger: LEDGER, verdicts: [COMPLETE] }));
		sup.onUserTurn?.({ text: "Make app.py print v2.", origin: "user" });
		const asked = await sup.onSettle?.(
			{ outcome: "completed", lastAssistantText: "There are two ways to do this.\n\nWhich one do you prefer?" },
			signal,
		);
		expect(asked).toMatchObject({ kind: "notify", summary: "supervisor: the agent is waiting for your answer" });
		expect(await sup.onSettle?.(DONE, signal)).toMatchObject({ kind: "continue" });
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

describe("supervisor research options (all off by default)", () => {
	const editApp = (sup: ReturnType<typeof createSupervisor>) => {
		writeFileSync(join(repo, "app.py"), "print('v2')\n");
		sup.onToolResult?.({ toolName: "edit", input: { path: "app.py" }, isError: false, exitCode: null, output: "ok" });
	};

	it("preVerdict: a failing check means incomplete without asking the verdict sidecar", async () => {
		const sup = createSupervisor(
			{ preVerdict: true, checks: ["python3 -c 'import sys; sys.exit(3)'"] },
			context({ ledger: LEDGER, verdicts: [COMPLETE] }),
		);
		sup.onUserTurn?.({ text: "Make app.py print v2.", origin: "user" });
		editApp(sup);
		const action = await sup.onSettle?.(DONE, signal);
		expect(action).toMatchObject({ kind: "suggest" });
		expect(action?.kind === "suggest" && action.text).toContain(
			"Make `python3 -c 'import sys; sys.exit(3)'` pass (it exits with code 3)",
		);
		expect(requests.some((r) => String(r.messages[0]?.["content"]).includes("acceptance checklist and evidence"))).toBe(
			false,
		);
		expect(records.find((r) => r.kind === "exo.verdict")?.data).toMatchObject({ source: "deterministic" });
	});

	it("preVerdict: no changes at all is uncertain, and passing checks still go to the LLM", async () => {
		const quiet = createSupervisor({ preVerdict: true }, context({ ledger: LEDGER, verdicts: [INCOMPLETE] }));
		quiet.onUserTurn?.({ text: "Make app.py print v2.", origin: "user" });
		expect(await quiet.onSettle?.(DONE, signal)).toEqual({
			kind: "notify",
			summary: "supervisor: uncertain",
			level: "info",
		});

		const checked = createSupervisor(
			{ preVerdict: true, checks: ["true"] },
			context({ ledger: LEDGER, verdicts: [COMPLETE] }),
		);
		checked.onUserTurn?.({ text: "Make app.py print v2.", origin: "user" });
		editApp(checked);
		expect(await checked.onSettle?.(DONE, signal)).toMatchObject({ summary: "supervisor: complete" });
		expect(records.filter((r) => r.kind === "exo.verdict").at(-1)?.data).toMatchObject({ source: "llm" });
	});

	it("warningSignals: shows tampering and unsupported claims to the verdict", async () => {
		const sup = createSupervisor({ warningSignals: true }, context({ ledger: LEDGER, verdicts: [COMPLETE] }));
		sup.onUserTurn?.({ text: "Make app.py print v2.", origin: "user" });
		writeFileSync(join(repo, "app.py"), "print('v2')  # TODO: real output\n");
		sup.onToolResult?.({ toolName: "edit", input: { path: "app.py" }, isError: false, exitCode: null, output: "ok" });
		await sup.onSettle?.({ outcome: "completed", lastAssistantText: "Done. All tests pass." }, signal);
		const prompt = String(requests.at(-1)?.messages[0]?.["content"]);
		expect(prompt).toContain("## Warnings (detected automatically)");
		expect(prompt).toContain("stub marker(s) added in app.py");
		expect(prompt).toContain('the agent claims "All tests pass."');
	});

	it("per-criterion: derives the verdict in code and rejects made-up evidence quotes", async () => {
		const items = (status: string, evidence: string) => ({
			items: [
				{ criterion: 1, status: "met", evidence: "app.py | 2 +-", fix: "" },
				{ criterion: 2, status, evidence, fix: "Write README.md" },
			],
			failed: false,
			asked_user: false,
			reason: "r",
		});
		const unmet = createSupervisor(
			{ verdictStyle: "per-criterion" },
			context({ ledger: LEDGER, verdicts: [items("unmet", "")] }),
		);
		unmet.onUserTurn?.({ text: "Make app.py print v2 and add a README.", origin: "user" });
		editApp(unmet);
		const action = await unmet.onSettle?.(DONE, signal);
		expect(action?.kind === "suggest" && action.text).toContain("1. Write README.md");
		expect(String(requests.at(-1)?.messages[0]?.["content"])).toContain("Judge each checklist item separately");

		const invented = createSupervisor(
			{ verdictStyle: "per-criterion" },
			context({ ledger: LEDGER, verdicts: [items("met", "README.md | 10 ++++")] }),
		);
		invented.onUserTurn?.({ text: "Make app.py print v2 and add a README.", origin: "user" });
		editApp(invented);
		expect(await invented.onSettle?.(DONE, signal)).toMatchObject({ summary: "supervisor: uncertain" });
	});

	it("finalMessage=claims: the verdict sees unverified claims and the ending, not the narrative", async () => {
		const sup = createSupervisor({ finalMessage: "claims" }, context({ ledger: LEDGER, verdicts: [COMPLETE] }));
		sup.onUserTurn?.({ text: "Make app.py print v2.", origin: "user" });
		editApp(sup);
		const long = `${"I carefully restructured everything. ".repeat(30)}All tests pass. Let me know.`;
		await sup.onSettle?.({ outcome: "completed", lastAssistantText: long }, signal);
		const prompt = String(requests.at(-1)?.messages[0]?.["content"]);
		expect(prompt).toContain("- UNVERIFIED CLAIM: All tests pass.");
		expect(prompt.split("I carefully restructured").length - 1).toBeLessThan(10);
	});

	it("completeVotes: any dissent turns complete into uncertain; unanimity keeps it", async () => {
		const split = createSupervisor(
			{ completeVotes: 3 },
			context({ ledger: LEDGER, verdicts: [COMPLETE, COMPLETE, INCOMPLETE] }),
		);
		split.onUserTurn?.({ text: "Make app.py print v2.", origin: "user" });
		editApp(split);
		expect(await split.onSettle?.(DONE, signal)).toMatchObject({ summary: "supervisor: uncertain" });
		expect(records.filter((r) => r.kind === "exo.verdict").at(-1)?.data).toMatchObject({
			votes: 3,
			reason: "verdicts disagreed (incomplete)",
		});

		const agreed = createSupervisor({ completeVotes: 2 }, context({ ledger: LEDGER, verdicts: [COMPLETE] }));
		agreed.onUserTurn?.({ text: "Make app.py print v2.", origin: "user" });
		editApp(agreed);
		expect(await agreed.onSettle?.(DONE, signal)).toMatchObject({ summary: "supervisor: complete" });
	});
});
