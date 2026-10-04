import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChatRequestFingerprint, openTraceStore, type StoredTraceEvent, sharedPrefix } from "@exocortex/core";
import {
	type FakeOpenAIServer,
	type FakeOpenAIServerOptions,
	type ScriptedReply,
	startFakeOpenAIServer,
} from "@exocortex/testkit";
import { afterEach, describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..", "..", "..");
const PI_BIN = join(REPO, "node_modules", ".bin", "pi");
const ADAPTER_DIR = join(REPO, "packages", "pi-adapter");

let server: FakeOpenAIServer | undefined;
let tmp: string | undefined;

afterEach(async () => {
	await server?.close();
	if (tmp) await rm(tmp, { recursive: true, force: true });
	server = undefined;
	tmp = undefined;
});

interface PiRun {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly dbPath: string;
}

/**
 * Runs the real pi CLI in print mode against a scripted fake model, isolated from user config
 * (pi and Exocortex), with only our extension loaded.
 */
async function runPi(
	script: readonly ScriptedReply[],
	env: Record<string, string> = {},
	prompt = "do the task",
	extra: { readonly exoConfig?: object; readonly server?: FakeOpenAIServerOptions } = {},
): Promise<PiRun> {
	server = await startFakeOpenAIServer(script, extra.server ?? {});
	tmp = await mkdtemp(join(tmpdir(), "exo-pi-"));
	const dbPath = join(tmp, "exo.db");
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
	await writeFile(join(tmp, "models.json"), JSON.stringify(models));
	await writeFile(join(tmp, "exo.jsonc"), JSON.stringify({ ...extra.exoConfig, trace: { dbPath } }));
	const args = [
		"-p",
		"--offline",
		"-ne",
		"-ns",
		"-np",
		"-nc",
		"--no-themes",
		"--no-session",
		"--model",
		"fake/fake-model",
		"-e",
		ADAPTER_DIR,
		prompt,
	];
	const cwd = tmp;
	return new Promise((resolve, reject) => {
		// stdin must be closed: print mode otherwise waits for piped input.
		const child = spawn(PI_BIN, args, {
			cwd,
			env: { ...process.env, PI_CODING_AGENT_DIR: cwd, EXO_CONFIG: join(cwd, "exo.jsonc"), ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr, dbPath }));
	});
}

function eventNames(stderr: string): string[] {
	return stderr
		.split("\n")
		.map((line) => /^\[exo \+\d+ms\] (\S+)/.exec(line)?.[1])
		.filter((name): name is string => name !== undefined);
}

function readTrace(dbPath: string) {
	const store = openTraceStore({ path: dbPath });
	try {
		const sessions = store.sessions();
		const events = sessions.flatMap((s) => store.events(s.id));
		const sidecarCalls = sessions.flatMap((s) => store.sidecarCalls(s.id));
		return { sessions, events, sidecarCalls };
	} finally {
		store.close();
	}
}

function dataOf(event: StoredTraceEvent | undefined): Record<string, unknown> {
	return (event?.data ?? {}) as Record<string, unknown>;
}

const ONE_TOOL_CALL: readonly ScriptedReply[] = [
	{ kind: "tool_calls", calls: [{ name: "bash", arguments: { command: "echo exo-e2e" } }] },
	{ kind: "text", text: "All done." },
];

describe("pi CLI with the Exocortex extension", { timeout: 30_000 }, () => {
	it("traces the event sequence of a one-tool-call task", async () => {
		const run = await runPi(ONE_TOOL_CALL, { EXO_DEBUG: "1" });

		expect(run.code).toBe(0);
		expect(run.stdout.trim()).toBe("All done.");
		const names = eventNames(run.stderr);
		// Order-preserving subsequence of the lifecycle documented in docs/PI_API_NOTES.md §2.
		const expected = [
			"session_start",
			"input",
			"before_agent_start",
			"agent_start",
			"turn_start",
			"context",
			"before_provider_request",
			"message_end",
			"tool_call",
			"tool_result",
			"turn_end",
			"turn_start",
			"before_provider_request",
			"turn_end",
			"agent_end",
			"agent_settled",
			"session_shutdown",
		];
		let cursor = 0;
		for (const name of names) if (name === expected[cursor]) cursor += 1;
		expect(expected.slice(cursor), `missing from: ${names.join(",")}`).toEqual([]);
		expect(names).not.toContain("message_update");
		expect(names).not.toContain("exo.error");
		expect(server?.requests).toHaveLength(2);
	});

	it("is silent on stderr when debug is off", async () => {
		const run = await runPi([{ kind: "text", text: "ok" }]);
		expect(run.code).toBe(0);
		expect(run.stderr).toBe("");
	});

	it("persists a harness-agnostic trace to SQLite", async () => {
		const run = await runPi(ONE_TOOL_CALL, { EXO_TRACE_LABEL: "e2e-1" });
		expect(run.code).toBe(0);

		const { sessions, events } = readTrace(run.dbPath);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({ harness: "pi", label: "e2e-1" });
		expect(sessions[0]?.endedAt).not.toBeNull();
		expect(events.map((e) => e.kind)).toEqual([
			"session.start",
			"user.input",
			"message", // system prompt
			"message", // user
			"llm.request",
			"message", // assistant tool call
			"tool.call",
			"tool.result",
			"message", // tool result
			"turn.end",
			"llm.request",
			"message", // assistant final
			"turn.end",
			"agent.settled",
			"session.end",
		]);

		const toolResult = dataOf(events.find((e) => e.kind === "tool.result"));
		expect(toolResult).toMatchObject({ toolName: "bash", isError: false, exitCode: 0 });
		expect(JSON.stringify(toolResult["content"])).toContain("exo-e2e");

		const [first, second] = events
			.filter((e) => e.kind === "llm.request")
			.map((e) => e.data as unknown as ChatRequestFingerprint);
		if (!first || !second) throw new Error("expected two llm.request events");
		expect(sharedPrefix(first, second)).toMatchObject({ fullPrefixKept: true, toolsMatch: true });
		expect(second.messageHashes.length).toBeGreaterThan(first.messageHashes.length);

		expect(events.filter((e) => e.turn !== null).map((e) => e.turn)).toContain(1);
		expect(events.every((e) => !e.synthetic)).toBe(true);
	});

	it("records failing commands with their exit code", async () => {
		const run = await runPi([
			{ kind: "tool_calls", calls: [{ name: "bash", arguments: { command: "echo boom >&2; exit 3" } }] },
			{ kind: "text", text: "It failed." },
		]);
		expect(run.code).toBe(0);
		const toolResult = dataOf(readTrace(run.dbPath).events.find((e) => e.kind === "tool.result"));
		expect(toolResult).toMatchObject({ isError: true, exitCode: 3 });
	});

	it("fails closed: a broken config disables tracing without breaking pi", async () => {
		const run = await runPi([{ kind: "text", text: "still works" }], { EXO_CONFIG: "/nonexistent/exo.jsonc" });
		expect(run.code).toBe(0);
		expect(run.stdout.trim()).toBe("still works");
		expect(readTrace(run.dbPath).sessions).toEqual([]);
	});

	it("runs sidecar calls through the pool against the main model's endpoint and records them", async () => {
		const run = await runPi([{ kind: "text", text: "pong", cachedTokens: 4 }], {}, "/exo ping");
		expect(run.code).toBe(0);
		expect(run.stderr).toMatch(/Exocortex sidecar OK in \d+ ms \(10 prompt tokens, 4 cached\): pong/);
		// The only request is the sidecar's: non-streaming, thinking off, to the main model's id.
		expect(server?.requests).toEqual([
			expect.objectContaining({
				model: "fake-model",
				stream: false,
				max_tokens: 16,
				chat_template_kwargs: { enable_thinking: false },
			}),
		]);
		const { sidecarCalls } = readTrace(run.dbPath);
		expect(sidecarCalls).toEqual([
			expect.objectContaining({
				module: "exo.ping",
				priority: "interactive",
				outcome: "ok",
				attempts: 1,
				usage: { promptTokens: 10, cachedTokens: 4, completionTokens: 5 },
			}),
		]);
	});

	it("reports sidecar status", async () => {
		const run = await runPi([], {}, "/exo status");
		expect(run.code).toBe(0);
		expect(run.stderr).toMatch(/Exocortex: enabled/);
		expect(run.stderr).toMatch(/sidecars: 0 running/);
	});

	it("supervisor (auto mode) catches an early 'done', continues the agent, and records the verdicts", async () => {
		const mainReplies: ScriptedReply[] = [
			{ kind: "text", text: "Done! I updated the greeting." },
			{ kind: "text", text: "Added the README too. Everything is finished." },
		];
		const ledger = {
			is_task: true,
			follows_previous: false,
			criteria: ["Update greeting", "Add a README"],
			check_commands: [],
		};
		const verdicts = [
			{ verdict: "incomplete", missing: ["Add a README"], asked_user: false, reason: "no README" },
			{ verdict: "complete", missing: [], asked_user: false, reason: "done" },
		];
		let main = 0;
		let verdict = 0;
		const run = await runPi([], {}, "Update the greeting and add a README.", {
			exoConfig: { modules: { supervisor: { enabled: true, mode: "auto" } } },
			server: {
				respond: (body) => {
					const request = body as { stream?: boolean; messages: { content: unknown }[] };
					if (request.stream) return mainReplies[main++] ?? { kind: "text", text: "(extra)" };
					const isVerdict = JSON.stringify(request.messages).includes("acceptance checklist and evidence");
					const reply = isVerdict ? verdicts[verdict++] : ledger;
					return { kind: "text", text: JSON.stringify(reply ?? {}) };
				},
			},
		});
		expect(run.code).toBe(0);
		expect(run.stdout.trim()).toBe("Added the README too. Everything is finished.");
		expect(main).toBe(2);
		expect(verdict).toBe(2);

		// The continuation reached the main model as the latest user-role message.
		const mainRequests = (server?.requests ?? []).filter((r) => (r as { stream?: boolean }).stream);
		const lastMessages = (mainRequests[1] as { messages: { role: string; content: unknown }[] }).messages;
		expect(lastMessages.at(-1)?.role).toBe("user");
		expect(JSON.stringify(lastMessages.at(-1)?.content)).toContain("1. Add a README");

		const { events, sidecarCalls } = readTrace(run.dbPath);
		const exo = events.filter((e) => e.kind.startsWith("exo."));
		expect(exo.map((e) => e.kind)).toEqual(["exo.ledger", "exo.verdict", "exo.action", "exo.verdict"]);
		expect(exo.every((e) => e.synthetic && e.module === "supervisor")).toBe(true);
		expect(dataOf(exo[2])).toMatchObject({ action: "continued", continuation: 1 });
		const injected = events.find((e) => e.kind === "message" && e.synthetic);
		expect(injected).toMatchObject({ module: "supervisor" });
		expect(sidecarCalls.map((c) => c.priority)).toEqual(["interactive", "critical", "critical"]);
	});

	it("/exo supervisor off disables the module for the session", async () => {
		const run = await runPi([], {}, "/exo supervisor off", {
			exoConfig: { modules: { supervisor: { enabled: true } } },
		});
		expect(run.code).toBe(0);
		expect(run.stderr).toMatch(/Supervisor: off for this session/);
	});
});
