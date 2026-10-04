import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FakeOpenAIServer, startFakeOpenAIServer } from "@exocortex/testkit";
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
}

/** Runs the real pi CLI in print mode, isolated from user config, with only our extension loaded. */
async function runPi(prompt: string, env: Record<string, string>): Promise<PiRun> {
	if (!server) throw new Error("server not started");
	tmp = await mkdtemp(join(tmpdir(), "exo-pi-"));
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
	return new Promise((resolve, reject) => {
		// stdin must be closed: print mode otherwise waits for piped input.
		const child = spawn(PI_BIN, args, {
			cwd: tmp,
			env: { ...process.env, PI_CODING_AGENT_DIR: tmp, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

function eventNames(stderr: string): string[] {
	return stderr
		.split("\n")
		.map((line) => /^\[exo \+\d+ms\] (\S+)/.exec(line)?.[1])
		.filter((name): name is string => name !== undefined);
}

describe("pi CLI with the Exocortex extension", { timeout: 30_000 }, () => {
	it("traces the event sequence of a one-tool-call task", async () => {
		server = await startFakeOpenAIServer([
			{ kind: "tool_calls", calls: [{ name: "bash", arguments: { command: "echo exo-e2e" } }] },
			{ kind: "text", text: "All done." },
		]);

		const run = await runPi("say hi", { EXO_DEBUG: "1" });

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
		expect(server.requests).toHaveLength(2);
	});

	it("is silent when debug is off", async () => {
		server = await startFakeOpenAIServer([{ kind: "text", text: "ok" }]);
		const run = await runPi("say hi", {});
		expect(run.code).toBe(0);
		expect(eventNames(run.stderr)).toEqual([]);
	});
});
