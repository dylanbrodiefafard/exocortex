import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FakeOpenAIServer, type ScriptedReply, startFakeOpenAIServer } from "@exocortex/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/report.ts";
import { type RunRecord, runEval } from "../src/run.ts";
import { loadTask, type Task } from "../src/task.ts";

const REPO = join(import.meta.dirname, "..", "..", "..");
const TASK = loadTask(join(REPO, "tasks", "py-pagination"));
const CONFIGS_DIR = join(REPO, "packages", "eval", "configs");

let server: FakeOpenAIServer | undefined;
let tmp: string | undefined;

afterEach(async () => {
	await server?.close();
	if (tmp) rmSync(tmp, { recursive: true, force: true });
	server = undefined;
	tmp = undefined;
});

async function evalWith(
	script: readonly ScriptedReply[],
	task: Task = TASK,
	fallback?: ScriptedReply,
): Promise<{ records: RunRecord[]; runDir: string }> {
	server = await startFakeOpenAIServer(script, fallback ? { fallback } : {});
	tmp = mkdtempSync(join(tmpdir(), "exo-eval-"));
	const agentDir = join(tmp, "agent");
	const models = {
		providers: {
			fake: {
				baseUrl: server.baseUrl,
				api: "openai-completions",
				apiKey: "none",
				compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStore: false },
				models: [{ id: "fake-model", contextWindow: 32768, maxTokens: 1024 }],
			},
		},
	};
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "models.json"), JSON.stringify(models));
	const runDir = join(tmp, "run");
	const records = await runEval({
		tasks: [task],
		configs: ["all-off"],
		configsDir: CONFIGS_DIR,
		repeats: 1,
		runDir,
		model: "fake/fake-model",
		piAgentDir: agentDir,
		extraPiArgs: ["--offline"],
	});
	return { records, runDir };
}

describe("runEval with the real pi CLI and a scripted model", { timeout: 60_000 }, () => {
	it("scores a run that fixes the task as a success, with trace metrics", async () => {
		const patch = TASK.solutionPatch ?? "";
		const { records, runDir } = await evalWith([
			{
				kind: "tool_calls",
				calls: [{ name: "bash", arguments: { command: "python3 -m unittest -q test_pagination" } }],
			},
			{ kind: "tool_calls", calls: [{ name: "bash", arguments: { command: `git apply ${patch}` } }] },
			{ kind: "text", text: "Fixed." },
		]);
		const [record] = records;
		expect(record).toMatchObject({ taskId: "py-pagination", config: "all-off", outcome: "settled", success: true });
		expect(record?.metrics).toMatchObject({
			turns: 3,
			llmRequests: 3,
			toolCalls: 2,
			toolErrors: 1,
			repeatedToolErrors: 0,
			injections: 0,
			continuations: 0,
			prefixKeptRate: 1,
		});
		expect(readFileSync(join(runDir, "results.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
		const markdown = renderMarkdown(records, "test");
		expect(markdown).toContain("| all-off | 1/1 (100%) |");
		expect(markdown).toContain("| py-pagination | 1/1 |");
	});

	it("scores a run that changes nothing as a failure", async () => {
		const { records } = await evalWith([{ kind: "text", text: "Looks fine to me." }]);
		expect(records[0]).toMatchObject({ outcome: "settled", success: false, checkExitCode: 1 });
	});

	it("aborts at maxTurns and records the abnormal outcome", async () => {
		const looping: Task = { ...TASK, spec: { ...TASK.spec, maxTurns: 3 } };
		const { records } = await evalWith([], looping, {
			kind: "tool_calls",
			calls: [{ name: "bash", arguments: { command: "echo still working" } }],
		});
		expect(records[0]).toMatchObject({ outcome: "max_turns", success: false });
		expect(records[0]?.metrics?.turns).toBeGreaterThanOrEqual(3);
	});
});
