import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ChatRequest,
	createSidecarPool,
	ENGINE_PROFILES,
	type ExoModule,
	type InferenceClient,
	type JsonValue,
	type ModuleContext,
	runShellCommand,
	type SettleAction,
	type SettleInfo,
	type TraceEventInput,
	type UserTurn,
} from "@exocortex/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSupervisor, fitSaved } from "../src/supervisor.ts";

/** A user message, then what the host does before the agent's first tool runs: the task's start is taken (D-102). */
async function begin(sup: ExoModule, turn: UserTurn): Promise<void> {
	sup.onUserTurn?.(turn);
	await sup.beforeToolCall?.({ toolName: "edit", toolCallId: "c", input: {} }, new AbortController().signal);
}

interface Script {
	/** The ledger sidecar's answer: one for every call, or one per call (the last repeats). */
	ledger: object | object[];
	verdicts: object[];
	/** The final-message sidecar's reading of the prompt it is sent (D-091); by default it finds nothing. */
	reading?: (prompt: string) => object;
}

const NOTHING_SAID = { asked_user: false, claims: [] };
const isReadingPrompt = (prompt: string) => prompt.includes("the last message a coding agent wrote");
const isVerdictPrompt = (prompt: string) => prompt.includes("whether a coding agent finished a task");
const isLedgerPrompt = (prompt: string) => prompt.includes("You keep the acceptance checklist");
const isFindPrompt = (prompt: string) => prompt.startsWith("You are reviewing a code change for bugs");

let repo: string;
let records: Omit<TraceEventInput, "module" | "synthetic">[];
let requests: ChatRequest[];
let saved: JsonValue[];
let logs: string[];

beforeEach(async () => {
	repo = mkdtempSync(join(tmpdir(), "exo-sup-"));
	writeFileSync(join(repo, "app.py"), "print('v1')\n");
	await runShellCommand("git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm base", {
		cwd: repo,
		timeoutMs: 10_000,
	});
	records = [];
	requests = [];
	saved = [];
	logs = [];
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

/** A sidecar engine that answers ledger, verdict and review prompts from a script. */
function scriptedClient(script: Script): InferenceClient {
	let verdictIndex = 0;
	let ledgerIndex = 0;
	const pick = <T>(list: readonly T[], index: number) => list[Math.min(index, list.length - 1)];
	return {
		async chat(request) {
			requests.push(request);
			const prompt = String(request.messages[0]?.["content"]);
			const reply = isReadingPrompt(prompt)
				? (script.reading?.(prompt) ?? NOTHING_SAID)
				: isVerdictPrompt(prompt)
					? (pick(script.verdicts, verdictIndex++) ?? {})
					: isFindPrompt(prompt)
						? { findings: [] }
						: Array.isArray(script.ledger)
							? (pick(script.ledger, ledgerIndex++) ?? {})
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
					thinking: "auto",
				},
			})
		: undefined;
	return {
		cwd: repo,
		sessionId: "test-session",
		savedState: undefined,
		saveState: (value) => saved.push(value),
		pool: () => pool,
		embedder: () => undefined,
		progress: () => {},
		record: (event) => records.push(event),
		runCommand: (command, options) => runShellCommand(command, { cwd: repo, ...options }),
		log: (message) => logs.push(message),
		background: () => false,
		deliverLate: () => false,
		forkPrefix: async () => undefined,
	};
}

const NEW = {
	relation: "new_task",
	added_criteria: ["Print v2 from app.py", "Add a README"],
	dropped_criteria: [],
	check_commands: ["sh ./check.sh", "rm -rf /"],
	do_not_run: [],
};
const CONTINUES = {
	relation: "continues",
	added_criteria: [],
	dropped_criteria: [],
	check_commands: [],
	do_not_run: [],
};
const CHAT = { ...CONTINUES, relation: "chat" };
const CLOSES = { ...CONTINUES, relation: "closes" };
const INCOMPLETE = { verdict: "incomplete", missing: ["Add a README"], asked_user: false, reason: "no README" };
const COMPLETE = { verdict: "complete", missing: [], asked_user: false, reason: "all done" };
const DONE: SettleInfo = { outcome: "completed", lastAssistantText: "Done! I updated app.py." };
const signal = new AbortController().signal;

function kinds(): string[] {
	return records.map((r) => `${r.kind}:${String((r.data as { action?: string }).action ?? "")}`);
}
const verdictPrompts = () => requests.map((r) => String(r.messages[0]?.["content"])).filter(isVerdictPrompt);
const verdictPrompt = () => verdictPrompts().at(-1) ?? "";
const ledgerRecord = () => records.findLast((r) => r.kind === "exo.ledger")?.data as Record<string, unknown>;
const skipped = () => records.filter((r) => r.kind === "exo.action").map((r) => (r.data as { reason?: string }).reason);
/** What the host does with a follow-up it shows or sends: tells the module (D-107). */
const delivered = (action: SettleAction | undefined) => {
	action?.commit?.();
	return action;
};
const textOf = (action: SettleAction | undefined) => (action && "text" in action ? action.text : "");
const write = (path: string, text: string) => writeFileSync(join(repo, path), text);
const flush = () => new Promise((resolve) => setTimeout(resolve, 50));
/** The supervisor fingerprints the workspace when a test run ends; the agent's next call comes later. */
const snapshotTaken = () => new Promise((resolve) => setTimeout(resolve, 300));

describe("supervisor", () => {
	it("shows the judge what is inside new files, and counts edits to them as progress", async () => {
		const sup = createSupervisor({ runPromptChecks: false }, context({ ledger: NEW, verdicts: [INCOMPLETE] }));
		await begin(sup, { text: "Make app.py print v2 and add a README.", origin: "user" });
		write("it's new.py", "def render():\n    raise NotImplementedError\n");
		write("big.txt", `${"filler line\n".repeat(4_000)}the end\n`);
		let action = delivered(await sup.onSettle?.(DONE, signal));
		expect(verdictPrompt()).toContain("+def render():");
		// The warning signs are always shown (D-107).
		expect(verdictPrompt()).toContain("1 stub marker(s) added in it's new.py: raise NotImplementedError");
		const firstHash = records.filter((r) => r.kind === "exo.action").length;

		// The follow-up is accepted twice; each time only the untracked file changes.
		for (const body of ["def render():\n    return 1\n", "def render():\n    return 2\n"]) {
			await begin(sup, { text: textOf(action), origin: "suggestion" });
			write("it's new.py", body);
			action = delivered(await sup.onSettle?.(DONE, signal));
		}
		expect(kinds().slice(firstHash)).not.toContain("exo.action:skipped");
	});

	it("suggests a follow-up listing what is missing, and counts it once it is shown and sent back", async () => {
		const sup = createSupervisor({}, context({ ledger: NEW, verdicts: [INCOMPLETE] }));
		await begin(sup, { text: "Make app.py print v2 and add a README. Check with `sh ./check.sh`.", origin: "user" });
		write("app.py", "print('v2')\n");
		write("check.sh", "python3 app.py\n");
		sup.onToolResult?.({ toolName: "edit", input: { path: "app.py" }, isError: false, exitCode: null, output: "ok" });
		sup.onToolResult?.({
			toolName: "bash",
			input: { command: "python3 app.py" },
			isError: false,
			exitCode: 0,
			output: "v2",
		});

		const action = await sup.onSettle?.(DONE, signal);
		expect(action).toMatchObject({
			kind: "suggest",
			text: "Not done yet. These parts of my request still look unfinished:\n1. Add a README\nPlease finish them and verify your work before stopping.",
			summary: "supervisor: 1 item(s) look unfinished",
		});
		// Nothing is recorded as suggested until the host shows it (D-107).
		expect(kinds()).toEqual(["exo.ledger:", "exo.verdict:"]);
		delivered(action);
		expect(kinds()).toEqual(["exo.ledger:", "exo.verdict:", "exo.action:suggested"]);

		// The verdict prompt saw the ledger, the diff, the agent's commands and the check output;
		// only the test command the request names in a code span was run ("rm -rf /" was not).
		const prompt = verdictPrompt();
		expect(prompt).toContain("1. Print v2 from app.py");
		expect(prompt).toContain("$ sh ./check.sh\nexit code: 0\nv2");
		expect(prompt).toContain("app.py | 2 +-");
		expect(prompt).toContain("Files the agent edited or wrote: app.py");
		expect(prompt).not.toContain("rm -rf");
		expect(records[0]?.data).toMatchObject({
			relation: "new_task",
			checks: ["sh ./check.sh"],
			refused: [{ command: "rm -rf /", reason: "it is not a whole code span of the request" }],
		});

		await begin(sup, { text: textOf(action), origin: "user" });
		expect(records.at(-1)?.data).toEqual({ action: "accepted", followUp: 1 });
	});

	it("does not take a follow-up the host never delivered for an accepted one (D-107)", async () => {
		const sup = createSupervisor({}, context({ ledger: [NEW, CONTINUES], verdicts: [INCOMPLETE] }));
		await begin(sup, { text: "Make app.py print v2 and add a README.", origin: "user" });
		const action = await sup.onSettle?.(DONE, signal);
		// Not committed: the host dropped it. The same text typed by the user is a message of its own.
		await begin(sup, { text: textOf(action), origin: "user" });
		await sup.onSettle?.(DONE, signal);
		expect(kinds()).not.toContain("exo.action:accepted");
		expect(ledgerRecord()).toMatchObject({ relation: "continues" });
	});

	it("reports completion without acting", async () => {
		const sup = createSupervisor({}, context({ ledger: NEW, verdicts: [COMPLETE] }));
		await begin(sup, { text: "Make app.py print v2 and add a README.", origin: "user" });
		expect(await sup.onSettle?.(DONE, signal)).toEqual({
			kind: "notify",
			summary: "supervisor: complete",
			level: "info",
		});
	});

	it("leaves 'is the agent waiting on the user' to the verdict: a blocking question stops it, an offer does not", async () => {
		const blocked = createSupervisor({}, context({ ledger: NEW, verdicts: [{ ...INCOMPLETE, asked_user: true }] }));
		await begin(blocked, { text: "Make app.py print v2.", origin: "user" });
		expect(await blocked.onSettle?.(DONE, signal)).toEqual({
			kind: "notify",
			summary: "supervisor: the agent is waiting for your answer",
			level: "info",
		});
		expect(records.at(-1)?.data).toEqual({ action: "skipped", reason: "asked_user" });

		// Ending on an offer used to switch the supervisor off before any verdict.
		const offered = createSupervisor({}, context({ ledger: NEW, verdicts: [INCOMPLETE] }));
		await begin(offered, { text: "Make app.py print v2 and add a README.", origin: "user" });
		const action = await offered.onSettle?.(
			{ outcome: "completed", lastAssistantText: "Updated app.py.\n\nWould you like me to add tests too?" },
			signal,
		);
		expect(action).toMatchObject({ kind: "suggest" });
		expect(verdictPrompt()).toContain("An offer of more work after it finished");
	});

	it("says so when the verdict gets no answer, instead of going quiet (D-107)", async () => {
		const sup = createSupervisor({}, context({ ledger: NEW, verdicts: [{}] }));
		await begin(sup, { text: "Make app.py print v2.", origin: "user" });
		expect(await sup.onSettle?.(DONE, signal)).toMatchObject({
			kind: "notify",
			level: "warning",
			summary: expect.stringContaining("supervisor: the verdict got no answer from the engine"),
		});
		expect(skipped().at(-1)).toBe("verdict_unavailable");
	});

	it("auto mode continues until two continuations make no progress, and says when it stops (no runaway loops)", async () => {
		const sup = createSupervisor(
			{ mode: "auto", maxContinuations: 10 },
			context({ ledger: NEW, verdicts: [INCOMPLETE] }),
		);
		await begin(sup, { text: "Make app.py print v2 and add a README.", origin: "user" });
		const results: (string | undefined)[] = [];
		for (let i = 0; i < 4; i++) {
			const action = delivered(await sup.onSettle?.(DONE, signal));
			results.push(action?.kind);
		}
		expect(results).toEqual(["continue", "continue", "notify", "notify"]);
		expect(skipped()).toContain("no_progress");
		expect(sup.status?.()).toContain("2/10 auto continuations");
	});

	it("still judges the work at the follow-up limit, and says what it found (D-107)", async () => {
		const sup = createSupervisor(
			{ mode: "auto", maxContinuations: 1 },
			context({ ledger: NEW, verdicts: [INCOMPLETE] }),
		);
		await begin(sup, { text: "Make app.py print v2 and add a README.", origin: "user" });
		expect(delivered(await sup.onSettle?.(DONE, signal))?.kind).toBe("continue");
		write("README.md", "progress\n");
		expect(await sup.onSettle?.(DONE, signal)).toEqual({
			kind: "notify",
			summary: "supervisor: 1 item(s) look unfinished (follow-up limit reached)",
			level: "info",
		});
		expect(verdictPrompts()).toHaveLength(2);
		expect(skipped().at(-1)).toBe("max_continuations");
	});

	it("does not limit suggestions: the user sends each one", async () => {
		const sup = createSupervisor({ maxContinuations: 0 }, context({ ledger: NEW, verdicts: [INCOMPLETE] }));
		await begin(sup, { text: "Make app.py print v2 and add a README.", origin: "user" });
		expect(await sup.onSettle?.(DONE, signal)).toMatchObject({ kind: "suggest" });
	});

	it("runs configured checks even when the request names none", async () => {
		const sup = createSupervisor(
			{ checks: ["echo configured-check"] },
			context({ ledger: { ...NEW, check_commands: [] }, verdicts: [COMPLETE] }),
		);
		await begin(sup, { text: "Make app.py print v2.", origin: "user" });
		await sup.onSettle?.(DONE, signal);
		expect(verdictPrompt()).toContain("$ echo configured-check\nexit code: 0");
	});

	it("does nothing for chat with no task open, aborted runs, or without a sidecar engine", async () => {
		const chat = createSupervisor({}, context({ ledger: CHAT, verdicts: [INCOMPLETE] }));
		await begin(chat, { text: "thanks!", origin: "user" });
		expect(await chat.onSettle?.(DONE, signal)).toBeUndefined();
		expect(skipped().at(-1)).toBe("not_a_task");

		const aborted = createSupervisor({}, context({ ledger: NEW, verdicts: [INCOMPLETE] }));
		await begin(aborted, { text: "Make app.py print v2.", origin: "user" });
		expect(await aborted.onSettle?.({ outcome: "aborted", lastAssistantText: "" }, signal)).toBeUndefined();

		const offline = createSupervisor({}, context(undefined));
		await begin(offline, { text: "Make app.py print v2.", origin: "user" });
		expect(await offline.onSettle?.(DONE, signal)).toBeUndefined();
	});

	it("tells a request it could not read apart from one that asks for nothing (D-107)", async () => {
		const sup = createSupervisor({}, context({ ledger: { relation: "maybe" }, verdicts: [COMPLETE] }));
		await begin(sup, { text: "Make app.py print v2.", origin: "user" });
		expect(await sup.onSettle?.(DONE, signal)).toMatchObject({
			kind: "notify",
			level: "warning",
			summary: expect.stringContaining("supervisor: could not read your message, so the work was not checked"),
		});
		expect(skipped().at(-1)).toBe("ledger_failed");
	});

	it("falls back to default settings on invalid config", async () => {
		const sup = createSupervisor({ mode: "yolo" }, context({ ledger: NEW, verdicts: [INCOMPLETE] }));
		await begin(sup, { text: "Make app.py print v2 and add a README.", origin: "user" });
		expect((await sup.onSettle?.(DONE, signal))?.kind).toBe("suggest");
	});
});

describe("how a message changes the task (delta ledger, D-107)", () => {
	const A_B_C = {
		...NEW,
		added_criteria: ["Parse the input", "Add a CSV export", "Print a summary"],
		check_commands: [],
	};

	it("drops what the user takes back, and adds what they ask for, keeping the rest", async () => {
		const ledgers = [
			A_B_C,
			{ ...CONTINUES, dropped_criteria: [2] },
			{ ...CONTINUES, added_criteria: ["Add a --verbose flag"] },
		];
		const sup = createSupervisor({}, context({ ledger: ledgers, verdicts: [COMPLETE] }));
		await begin(sup, { text: "Parse the input, export CSV and print a summary.", origin: "user" });
		await sup.onSettle?.(DONE, signal);
		await begin(sup, { text: "drop the CSV export, not needed", origin: "user" });
		await sup.onSettle?.(DONE, signal);
		expect(verdictPrompt()).toContain("Acceptance checklist:\n1. Parse the input\n2. Print a summary\n\nEvidence:");
		await begin(sup, { text: "also add a --verbose flag", origin: "user" });
		await sup.onSettle?.(DONE, signal);
		expect(verdictPrompt()).toContain("1. Parse the input\n2. Print a summary\n3. Add a --verbose flag");
		// The sidecar was shown the open checklist, numbered, to say what to drop.
		const asked = requests.map((r) => String(r.messages[0]?.["content"])).filter(isLedgerPrompt);
		expect(asked[1]).toContain("1. Parse the input\n2. Add a CSV export\n3. Print a summary");
		expect(verdictPrompt()).toContain("(The developer then added:)\ndrop the CSV export, not needed");
	});

	it("goes on with the open task for a nudge that adds nothing", async () => {
		const sup = createSupervisor({}, context({ ledger: [NEW, CONTINUES], verdicts: [INCOMPLETE, COMPLETE] }));
		await begin(sup, { text: "Make app.py print v2 and add a README.", origin: "user" });
		await sup.onSettle?.(DONE, signal);
		await begin(sup, { text: "Your replies keep getting cut off. Make the edits now.", origin: "user" });
		write("app.py", "print('v2')\n");
		await sup.onSettle?.(DONE, signal);
		expect(verdictPrompt()).toContain("1. Print v2 from app.py\n2. Add a README");
	});

	it("ends the task when the user closes it: no verdict, and nothing kept", async () => {
		const sup = createSupervisor({}, context({ ledger: [NEW, CLOSES], verdicts: [INCOMPLETE] }));
		await begin(sup, { text: "Make app.py print v2 and add a README.", origin: "user" });
		await sup.onSettle?.(DONE, signal);
		await begin(sup, { text: "thanks, that's good enough", origin: "user" });
		expect(await sup.onSettle?.(DONE, signal)).toBeUndefined();
		expect(verdictPrompts()).toHaveLength(1);
		expect(skipped().at(-1)).toBe("closed");
		await flush();
		expect(saved.at(-1)).toBeNull();
	});

	it("does not judge unchanged work again after a chat reply, and does once the files change (D-107)", async () => {
		const sup = createSupervisor(
			{ checks: ["echo checked"] },
			context({ ledger: [NEW, CHAT], verdicts: [INCOMPLETE] }),
		);
		await begin(sup, { text: "Make app.py print v2 and add a README.", origin: "user" });
		const first = await sup.onSettle?.(DONE, signal);
		await begin(sup, { text: "why did you pick print over logging?", origin: "user" });
		// The follow-up nobody sent is offered again, not only named (D-107).
		const again = await sup.onSettle?.({ outcome: "completed", lastAssistantText: "Because..." }, signal);
		expect(again).toMatchObject({
			kind: "suggest",
			text: textOf(first),
			summary: "supervisor: 1 item(s) look unfinished (nothing changed since)",
		});
		expect(verdictPrompts()).toHaveLength(1);
		expect(skipped().at(-1)).toBe("unchanged");
		write("README.md", "# App\n");
		await sup.onSettle?.(DONE, signal);
		expect(verdictPrompts()).toHaveLength(2);

		// A notice that stands is named.
		const done = createSupervisor({}, context({ ledger: [NEW, CHAT], verdicts: [COMPLETE] }));
		await begin(done, { text: "Make app.py print v2 and add a README.", origin: "user" });
		await done.onSettle?.(DONE, signal);
		await begin(done, { text: "thanks, how does it work?", origin: "user" });
		expect(await done.onSettle?.(DONE, signal)).toEqual({
			kind: "notify",
			summary: "supervisor: nothing changed since the last check (complete)",
			level: "info",
		});
	});

	it("forgets a task whose every item was dropped (D-107)", async () => {
		const sup = createSupervisor(
			{},
			context({ ledger: [NEW, { ...CONTINUES, dropped_criteria: [1, 2] }], verdicts: [COMPLETE] }),
		);
		await begin(sup, { text: "Make app.py print v2 and add a README.", origin: "user" });
		await sup.onSettle?.(DONE, signal);
		await begin(sup, { text: "forget both, not needed", origin: "user" });
		expect(await sup.onSettle?.(DONE, signal)).toBeUndefined();
		expect(skipped().at(-1)).toBe("no_criteria");
		await flush();
		expect(saved.at(-1)).toBeNull();
	});

	it("keeps every criterion of a long request, and past the cap keeps the newest and says so", async () => {
		const criteria = Array.from({ length: 14 }, (_, i) => `Rule ${i + 1}`);
		const sup = createSupervisor({}, context({ ledger: { ...NEW, added_criteria: criteria }, verdicts: [COMPLETE] }));
		await begin(sup, { text: "Implement rules 1 to 14.", origin: "user" });
		await sup.onSettle?.(DONE, signal);
		expect(verdictPrompt()).toContain("14. Rule 14");

		const many = Array.from({ length: 40 }, (_, i) => `Rule ${i + 1}`);
		const capped = createSupervisor({}, context({ ledger: { ...NEW, added_criteria: many }, verdicts: [COMPLETE] }));
		await begin(capped, { text: "Implement rules 1 to 40.", origin: "user" });
		await capped.onSettle?.(DONE, signal);
		expect(verdictPrompt()).toContain("32. Rule 40");
		expect(verdictPrompt()).not.toContain("Rule 8\n");
		expect(logs.some((l) => l.includes("the oldest are left out") && l.includes("Rule 1;"))).toBe(true);
	});
});

describe("what the judge is given (D-071)", () => {
	it("reads the request itself, with later messages of the same task, beside the checklist", async () => {
		const sup = createSupervisor({}, context({ ledger: NEW, verdicts: [COMPLETE] }));
		await begin(sup, { text: "Make app.py print v2. Round 1.005 to 100, ties to even.", origin: "user" });
		await sup.onSettle?.(DONE, signal);
		expect(verdictPrompt()).toContain(
			"Developer's request:\n<<<\nMake app.py print v2. Round 1.005 to 100, ties to even.\n>>>",
		);

		const followed = createSupervisor(
			{},
			context({ ledger: [NEW, { ...CONTINUES, added_criteria: ["Keep the newline"] }], verdicts: [COMPLETE] }),
		);
		await begin(followed, { text: "Make app.py print v2.", origin: "user" });
		await followed.onSettle?.(DONE, signal);
		await begin(followed, { text: "Also keep the trailing newline.", origin: "user" });
		await followed.onSettle?.(DONE, signal);
		expect(verdictPrompt()).toContain(
			"Make app.py print v2.\n\n(The developer then added:)\nAlso keep the trailing newline.",
		);
	});

	it("reads every reply of the task, not only the last: an answer given earlier counts (D-107)", async () => {
		const sup = createSupervisor(
			{},
			context({ ledger: [NEW, { ...CONTINUES, added_criteria: ["Fix the typo"] }], verdicts: [COMPLETE] }),
		);
		await begin(sup, { text: "Summarize app.py in 3 sentences.", origin: "user" });
		await sup.onSettle?.(
			{
				outcome: "completed",
				lastAssistantText: "Done.",
				assistantTexts: ["It prints a version. It has one line. It is Python.", "Done."],
			},
			signal,
		);
		expect(verdictPrompt()).toContain(
			"--- reply 1 of 2 ---\nIt prints a version. It has one line. It is Python.\n--- reply 2 of 2 (final) ---\nDone.",
		);
		await begin(sup, { text: "Also fix the typo in app.py.", origin: "user" });
		write("app.py", "print('v2')\n");
		await sup.onSettle?.({ outcome: "completed", lastAssistantText: "Fixed." }, signal);
		const prompt = verdictPrompt();
		expect(prompt).toContain("The agent's replies to the developer during this task, oldest first");
		expect(prompt).toContain("It prints a version.");
		expect(prompt).toContain("--- reply 3 of 3 (final) ---\nFixed.");
	});

	it("does not count a reply twice across an auto continuation, which does not end the host's span (D-107)", async () => {
		const sup = createSupervisor({ mode: "auto" }, context({ ledger: NEW, verdicts: [INCOMPLETE] }));
		await begin(sup, { text: "Make app.py print v2 and add a README.", origin: "user" });
		delivered(
			await sup.onSettle?.({ outcome: "completed", lastAssistantText: "First.", assistantTexts: ["First."] }, signal),
		);
		write("app.py", "print('v2')\n");
		await sup.onSettle?.(
			{ outcome: "completed", lastAssistantText: "Second.", assistantTexts: ["First.", "Second."] },
			signal,
		);
		expect(verdictPrompt()).toContain("--- reply 1 of 2 ---\nFirst.\n--- reply 2 of 2 (final) ---\nSecond.");
	});

	it("keeps the replies a compaction took out of the host's span (D-107)", async () => {
		const sup = createSupervisor({ mode: "auto" }, context({ ledger: NEW, verdicts: [INCOMPLETE] }));
		await begin(sup, { text: "Summarize app.py, then add a README.", origin: "user" });
		const span = (texts: string[]) => ({
			outcome: "completed" as const,
			lastAssistantText: texts.at(-1) ?? "",
			assistantTexts: texts,
		});
		delivered(await sup.onSettle?.(span(["The summary.", "Working on it."]), signal));
		write("README.md", "# App\n");
		// The context was compacted after "The summary.": the span now starts after the summary.
		await sup.onSettle?.(span(["Working on it.", "Done."]), signal);
		expect(verdictPrompt()).toContain(
			"--- reply 1 of 3 ---\nThe summary.\n--- reply 2 of 3 ---\nWorking on it.\n--- reply 3 of 3 (final) ---\nDone.",
		);
	});

	it("does not leave the start of the run to a tokenizer: the verdict prompt fits a small window (D-107)", async () => {
		const sup = createSupervisor({}, context({ ledger: NEW, verdicts: [COMPLETE] }));
		await begin(sup, { text: "Write data.py.", origin: "user" });
		write("data.py", "x = 1\n".repeat(60_000));
		await sup.onSettle?.({ ...DONE, contextWindow: 65_536 }, signal);
		// (65,536 − 36,864 output − 4,000 template) × 0.75 × 3 characters per token, and a little for the template.
		expect(verdictPrompt().length).toBeLessThan(55_000 + 12_000);
	});

	it("says what an uncertain verdict rests on when it names no item", async () => {
		const sup = createSupervisor(
			{},
			context({
				ledger: NEW,
				verdicts: [{ verdict: "uncertain", missing: [], asked_user: false, reason: "no tests ran" }],
			}),
		);
		await begin(sup, { text: "Make app.py print v2.", origin: "user" });
		expect(await sup.onSettle?.(DONE, signal)).toMatchObject({ summary: "supervisor: uncertain: no tests ran" });
	});

	it("tells the judge when the agent's test run proves nothing, without running anything", async () => {
		const sup = createSupervisor({}, context({ ledger: { ...NEW, check_commands: [] }, verdicts: [COMPLETE] }));
		await begin(sup, { text: "Make app.py print v2.", origin: "user" });
		const command = "python3 -m unittest discover -q -s tests -t . 2>&1 | tail -5";
		sup.onToolResult?.({ toolName: "bash", input: { command }, isError: false, exitCode: 0, output: "OK" });
		await snapshotTaken();
		// Changed from the shell: no file tool was used.
		write("app.py", "print('v2')\n");
		sup.onToolResult?.({
			toolName: "bash",
			input: { command: "sed -i s/v1/v2/ app.py" },
			isError: false,
			exitCode: 0,
			output: "",
		});
		await sup.onSettle?.(DONE, signal);
		expect(verdictPrompt()).toContain(
			`Note: files changed after the agent's last full test run (\`${command}\`), so that result does not cover the finished work.`,
		);
		expect(verdictPrompt()).toContain("is another command's (a pipe, `;` or `||`), not the test run's");
		expect(verdictPrompt()).not.toContain("## Check commands");
		expect(records.find((r) => r.kind === "exo.verdict")?.data).toMatchObject({ checks: [] });
	});

	it("does not call a test run stale when the files are as they were when it ran", async () => {
		const sup = createSupervisor({}, context({ ledger: { ...NEW, check_commands: [] }, verdicts: [COMPLETE] }));
		await begin(sup, { text: "Make app.py print v2.", origin: "user" });
		write("app.py", "print('v2')\n");
		sup.onToolResult?.({
			toolName: "bash",
			input: { command: "cargo test" },
			isError: false,
			exitCode: 0,
			output: "ok",
		});
		await snapshotTaken();
		// An edit that was undone: the file tools were used, the content is what was tested.
		sup.onToolResult?.({ toolName: "edit", input: { path: "app.py" }, isError: false, exitCode: null, output: "ok" });
		await sup.onSettle?.(DONE, signal);
		expect(verdictPrompt()).toContain("$ cargo test  → exit 0");
		expect(verdictPrompt()).not.toContain("files changed after");
	});

	it("shows the commands of the whole task, from earlier messages too (D-107)", async () => {
		const sup = createSupervisor({}, context({ ledger: [NEW, CONTINUES], verdicts: [INCOMPLETE] }));
		await begin(sup, { text: "Make app.py print v2.", origin: "user" });
		sup.onToolResult?.({ toolName: "bash", input: { command: "ls -la" }, isError: false, exitCode: 0, output: "" });
		await sup.onSettle?.(DONE, signal);
		await begin(sup, { text: "continue", origin: "user" });
		sup.onToolResult?.({ toolName: "bash", input: { command: "cat app.py" }, isError: false, exitCode: 0, output: "" });
		write("app.py", "print('v2')\n");
		await sup.onSettle?.(DONE, signal);
		expect(verdictPrompt()).toContain("$ ls -la  → exit 0\n$ cat app.py  → exit 0");
	});

	it("leaves out what test runs leave behind, and says so (D-107)", async () => {
		const sup = createSupervisor({}, context({ ledger: NEW, verdicts: [COMPLETE] }));
		await begin(sup, { text: "Make app.py print v2.", origin: "user" });
		mkdirSync(join(repo, "__pycache__"));
		write("__pycache__/app.cpython-312.pyc", "\0bytecode");
		write("app.py", "print('v2')\n");
		await sup.onSettle?.(DONE, signal);
		const prompt = verdictPrompt();
		expect(prompt).not.toContain("app.cpython-312.pyc");
		expect(prompt).toContain("(1 new file that test and build runs leave behind");
		expect(prompt).toContain("Running tests and builds creates files the agent did not write on purpose");
	});

	it("sizes the evidence from the context window (D-107)", async () => {
		const big = "x = 1\n".repeat(30_000);
		const small = createSupervisor({}, context({ ledger: NEW, verdicts: [COMPLETE] }));
		await begin(small, { text: "Write data.py.", origin: "user" });
		write("data.py", big);
		await small.onSettle?.({ ...DONE, contextWindow: 16_384 }, signal);
		expect(verdictPrompt()).toContain("## Diff (long files cut short)");

		const wide = createSupervisor({}, context({ ledger: NEW, verdicts: [COMPLETE] }));
		await begin(wide, { text: "Write data.py.", origin: "user" });
		write("data.py", `${big}y = 2\n`);
		await wide.onSettle?.({ ...DONE, contextWindow: 262_144 }, signal);
		expect(verdictPrompt()).toContain("## Diff\n");
		expect(verdictPrompt().split("+x = 1").length - 1).toBe(30_000);
	});
});

describe("the agent's replies and the warnings", () => {
	const editApp = (sup: ReturnType<typeof createSupervisor>) => {
		write("app.py", "print('v2')\n");
		sup.onToolResult?.({ toolName: "edit", input: { path: "app.py" }, isError: false, exitCode: null, output: "ok" });
	};

	it("shows tampering and unsupported claims to the verdict", async () => {
		const reading = () => ({ asked_user: false, claims: [{ kind: "tests_pass", quote: "All tests pass." }] });
		const sup = createSupervisor({}, context({ ledger: NEW, verdicts: [COMPLETE], reading }));
		await begin(sup, { text: "Make app.py print v2.", origin: "user" });
		write("app.py", "print('v2')  # TODO: real output\n");
		sup.onToolResult?.({ toolName: "edit", input: { path: "app.py" }, isError: false, exitCode: null, output: "ok" });
		await sup.onSettle?.({ outcome: "completed", lastAssistantText: "Done. All tests pass." }, signal);
		const prompt = verdictPrompt();
		expect(prompt).toContain("## Warnings (detected automatically)");
		expect(prompt).toContain("stub marker(s) added in app.py");
		expect(prompt).toContain('the agent claims "All tests pass."');
	});

	it("shows the judge a reply that is the work: its start, where the deliverable is, not only its end (D-089)", async () => {
		const REVIEW = {
			...NEW,
			added_criteria: ["Numbered list of issues ordered by priority", "Severity labels", "A list of positives"],
			check_commands: [],
		};
		const issues = Array.from(
			{ length: 11 },
			(_, i) => `${i + 1}. [minor] ${"The handler swallows the error it catches. ".repeat(7)}`,
		);
		const review = [
			"## Issues (by priority)",
			...issues,
			"## Positives",
			...Array.from({ length: 8 }, (_, i) => `- Positive ${i + 1}: ${"clear naming and small functions. ".repeat(5)}`),
			"**Assumptions:** I did not run the tests, as asked.",
		].join("\n");
		expect(review.length).toBeGreaterThan(4_500);
		const sup = createSupervisor({}, context({ ledger: REVIEW, verdicts: [COMPLETE] }));
		sup.onUserTurn?.({
			text: "Review the latest commit as a numbered, labelled list. Do not run tests.",
			origin: "user",
		});
		await sup.onSettle?.({ outcome: "completed", lastAssistantText: review }, signal);
		const prompt = verdictPrompt();
		expect(prompt).toContain("Agent's final message (all of it):");
		expect(prompt).toContain(review);
		expect(prompt).toContain("the agent's replies below are that work");
	});

	it("marks the gap in a very long final message, and keeps both ends (D-089)", async () => {
		const sup = createSupervisor({}, context({ ledger: NEW, verdicts: [COMPLETE] }));
		await begin(sup, { text: "Make app.py print v2.", origin: "user" });
		editApp(sup);
		const long = `## Issues first\n${"filler sentence. ".repeat(4_000)}\nShould I also update the README?`;
		await sup.onSettle?.({ outcome: "completed", lastAssistantText: long }, signal);
		const prompt = verdictPrompt();
		expect(prompt).toContain("Agent's final message (long: its middle is not shown):");
		expect(prompt).toContain("## Issues first");
		expect(prompt).toContain("Should I also update the README?");
		expect(prompt).toMatch(/… \(\d+ characters in the middle of this reply are not shown\) …/);
		expect(prompt).toContain("Never call an item missing because it would be in a part you were not given");
		expect(prompt.length).toBeLessThan(long.length);
	});

	it("verifyUncertain (on by default): asks the agent once to check what the evidence does not show", async () => {
		const UNCERTAIN = {
			verdict: "uncertain",
			missing: [],
			unverified: ["Check that 1.005 rounds to 100"],
			asked_user: false,
			reason: "no test covers rounding",
		};
		// An agent that changed nothing has nothing to verify: the notice says what is not shown.
		const idle = createSupervisor({}, context({ ledger: NEW, verdicts: [UNCERTAIN] }));
		await begin(idle, { text: "Make app.py print v2.", origin: "user" });
		expect(await idle.onSettle?.(DONE, signal)).toEqual({
			kind: "notify",
			summary: 'supervisor: uncertain: 1 item(s) not shown, such as "Check that 1.005 rounds to 100"',
			level: "info",
		});

		const sup = createSupervisor({ review: false }, context({ ledger: NEW, verdicts: [UNCERTAIN] }));
		await begin(sup, { text: "Make app.py print v2.", origin: "user" });
		editApp(sup);
		const action = await sup.onSettle?.(DONE, signal);
		expect(action).toMatchObject({
			kind: "suggest",
			text: "Before you stop: I could not confirm these parts of my request from your changes and test runs:\n1. Check that 1.005 rounds to 100\nCheck each one against my request and show what proves it (a command you run, or the code). Fix whatever turns out not to be done.",
			summary: "supervisor: 1 item(s) to verify",
		});
		delivered(action);
		expect(records.at(-1)?.data).toEqual({ action: "suggested", unverified: ["Check that 1.005 rounds to 100"] });

		// Accepted, and still uncertain afterwards: it is not asked a second time.
		await begin(sup, { text: textOf(action), origin: "suggestion" });
		expect(await sup.onSettle?.(DONE, signal)).toMatchObject({
			kind: "notify",
			summary: expect.stringContaining("supervisor: uncertain"),
		});

		// Off: the notice alone.
		const quiet = createSupervisor(
			{ verifyUncertain: false, review: false },
			context({ ledger: NEW, verdicts: [UNCERTAIN] }),
		);
		await begin(quiet, { text: "Make app.py print v2.", origin: "user" });
		editApp(quiet);
		expect(await quiet.onSettle?.(DONE, signal)).toMatchObject({ kind: "notify" });
	});

	it("reviews the change by default once the work looks complete (D-107)", async () => {
		const sup = createSupervisor({ reviewPasses: 2 }, context({ ledger: NEW, verdicts: [COMPLETE] }));
		await begin(sup, { text: "Make app.py print v2.", origin: "user" });
		editApp(sup);
		expect(await sup.onSettle?.(DONE, signal)).toMatchObject({
			kind: "notify",
			summary: "supervisor: complete · review found nothing that held up (0 proposed by 2/2 passes)",
		});
	});
});

describe("saved state (D-107)", () => {
	it("is cut to fit: the developer's new files first, then the oldest replies, then the oldest additions", () => {
		const base = {
			v: 2 as const,
			ledger: { requests: ["the task", "an addition"], criteria: ["x"], checkCommands: [] },
			startRef: null,
			untrackedAtStart: Array.from({ length: 500 }, (_, i): [string, string] => [`${"d".repeat(500)}${i}`, "stat:1:2"]),
			replies: ["old reply", "new reply"],
			autoContinuations: 0,
			followUps: 0,
			pending: null,
			lastContinuationDiff: null,
			noProgressStreak: 0,
			verifyAsked: false,
			reviewed: false,
			reported: [],
			judged: null,
		};
		const fitted = fitSaved(base);
		expect(JSON.stringify(fitted).length).toBeLessThan(200_000);
		expect(fitted.untrackedAtStart.length).toBeLessThan(500);
		expect(fitted.replies).toEqual(["old reply", "new reply"]);
		const wordy = fitSaved({ ...base, untrackedAtStart: [], replies: ["r".repeat(250_000), "last"] });
		expect(wordy.replies).toEqual(["last"]);
		expect(wordy.ledger.requests).toEqual(["the task", "an addition"]);
	});
});
