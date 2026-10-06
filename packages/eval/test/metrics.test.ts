import type { StoredTraceEvent, TraceEventKind } from "@exocortex/core";
import { describe, expect, it } from "vitest";
import { computeTraceMetrics, failureOf } from "../src/metrics.ts";

let seq = 0;
function event(kind: TraceEventKind, data: unknown, extra: Partial<StoredTraceEvent> = {}): StoredTraceEvent {
	seq += 1;
	return {
		id: seq,
		sessionId: "s",
		seq,
		ts: seq,
		kind,
		turn: null,
		synthetic: false,
		module: null,
		data: data as StoredTraceEvent["data"],
		...extra,
	};
}

function toolError(text: string, exitCode = 1) {
	return event("tool.result", { toolName: "bash", isError: true, exitCode, content: [{ type: "text", text }] });
}

describe("failureOf", () => {
	it("ignores line numbers and addresses, but not which file or name the error is about", () => {
		const of = (text: string) => failureOf({ toolName: "bash", exitCode: 1, content: [{ type: "text", text }] });
		expect(of("running\nsrc/foo.py:12: error: 'x' at 0xdeadbeef")).toBe(of("src/foo.py:99: error: 'x' at 0x1234"));
		expect(of("src/foo.py:12: error: 'x'")).not.toBe(of("src/foo.py:12: error: 'yy'"));
		expect(of("src/foo.py:12: error: 'x'")).not.toBe(of("src/bar.py:12: error: 'x'"));
	});

	it("distinguishes tools, and knows a failure that printed nothing by its command", () => {
		const content = [{ type: "text", text: "error: boom" }];
		expect(failureOf({ toolName: "bash", content })).not.toBe(failureOf({ toolName: "read", content }));
		const commands = new Map([
			["a", "./one.sh"],
			["b", "./two.sh"],
		]);
		const silent = (toolCallId: string) => failureOf({ toolName: "bash", toolCallId, content: [] }, commands);
		expect(silent("a")).not.toBe(silent("b"));
	});
});

describe("computeTraceMetrics", () => {
	it("aggregates usage, requests, tool errors and synthetic content", () => {
		const fp = (hashes: string[]) => ({
			model: "m",
			messageHashes: hashes,
			toolsHash: "t",
			messageChars: hashes.length * 10,
			params: {},
		});
		const metrics = computeTraceMetrics([
			event("user.input", { text: "go", source: "interactive" }),
			event("llm.request", fp(["a", "b"])),
			event("tool.call", {}),
			toolError("FAILED test_x: AssertionError 1 != 2"),
			event("turn.end", { usage: { input: 100, cacheRead: 0, output: 10 } }),
			event("llm.request", fp(["a", "b", "c", "d"])),
			event("tool.call", {}),
			toolError("FAILED test_x: AssertionError 1 != 2"),
			event("turn.end", { usage: { input: 20, cacheRead: 80, output: 5 } }),
			event("message", { role: "custom", customType: "exo.supervisor" }, { synthetic: true, module: "supervisor" }),
			event("user.input", { text: "continue", source: "extension" }),
			event("llm.request", fp(["x"])),
			event("turn.end", { usage: { input: 50, cacheRead: 0, output: 1 } }),
		]);
		expect(metrics).toEqual({
			turns: 3,
			llmRequests: 3,
			inputTokens: 170,
			cachedTokens: 80,
			outputTokens: 16,
			cacheHitRate: 80 / 250,
			prefixKeptRate: 0.5,
			maxPromptChars: 40,
			toolCalls: 2,
			toolErrors: 2,
			repeatedToolErrors: 1,
			injections: 1,
			continuations: 1,
			compactions: 0,
			overflowCompactions: 0,
			failedCompactions: 0,
			errorStops: 0,
			lengthStops: 0,
			lastStopReason: null,
			compactionTokens: 0,
			compactionReplays: 0,
			trimmedOutputs: 0,
			trimmedRereads: 0,
			stuckLoops: 0,
			stuckLoopCalls: 0,
			// The same failure twice with nothing after it: it never had the chance to recur.
			recurringErrors: [{ occurrences: 2, hints: 0, after: "ended", fixed: false }],
			sidecarTokensByModule: {},
			sidecarCalls: 0,
			sidecarTokens: 0,
			sidecarFailures: 0,
			backgroundFinishedAtShutdown: 0,
			backgroundCutOff: 0,
			verdicts: { complete: 0, incomplete: 0, failed: 0, uncertain: 0 },
			lastVerdict: null,
			deterministicVerdicts: 0,
			verifiedAfterLastEdit: null,
			maxRepeatedFailures: 0, // the fixture's tool results carry no matching tool.call commands
		});
	});

	it("counts stuck loops and the calls made inside them, per task (D-069)", () => {
		let id = 0;
		const call = (command: string, text: string) => {
			id += 1;
			return [
				event("tool.call", { toolCallId: `c${id}`, toolName: "bash", input: { command } }),
				event("tool.result", {
					toolCallId: `c${id}`,
					toolName: "bash",
					isError: false,
					exitCode: 0,
					content: [{ type: "text", text }],
				}),
			];
		};
		const status = () => call("git status", "clean in 0.1s");
		const events = [
			event("user.input", { source: "interactive" }),
			...status(),
			...status(),
			...status(), // loop 1 established
			...status(), // +1 call inside it
			...call("ls", "a b"),
			...call("cat a", "1"),
			...call("ls", "a b"),
			...call("cat a", "1"),
			...call("ls", "a b"),
			...call("cat a", "1"), // loop 2 established
			...call("ls", "a b"), // +1
			event("user.input", { source: "extension" }),
			...call("cat a", "1"), // +1: a continuation is the same task
			event("user.input", { source: "interactive" }),
			...call("ls", "a b"), // a new request starts over
			...call("cat a", "2"),
		];
		expect(computeTraceMetrics(events)).toMatchObject({ stuckLoops: 2, stuckLoopCalls: 3 });
		expect(computeTraceMetrics([...status(), ...status()])).toMatchObject({ stuckLoops: 0, stuckLoopCalls: 0 });
	});

	it("counts sidecar cost and failures, excluding cap and budget rejections", () => {
		const base = {
			module: "triage",
			priority: "interactive" as const,
			promptHash: "h",
			startedAt: 0,
			queueMs: 0,
			latencyMs: 10,
			attempts: 1,
			maxTokens: 64,
			usage: { promptTokens: 100, cachedTokens: null, completionTokens: 20 },
			error: null,
		};
		const metrics = computeTraceMetrics(
			[],
			[
				{ ...base, outcome: "ok" },
				{ ...base, outcome: "timeout" },
				{ ...base, outcome: "rejected_turn_cap", usage: { promptTokens: 0, cachedTokens: null, completionTokens: 0 } },
			],
		);
		expect(metrics).toMatchObject({ sidecarCalls: 3, sidecarTokens: 240, sidecarFailures: 1 });
	});

	it("splits sidecar tokens by module", () => {
		const call = (module: string, promptTokens: number) => ({
			module,
			priority: "background" as const,
			outcome: "ok" as const,
			promptHash: "h",
			startedAt: 0,
			queueMs: 0,
			latencyMs: 10,
			attempts: 1,
			maxTokens: 64,
			usage: { promptTokens, cachedTokens: null, completionTokens: 10 },
			error: null,
		});
		const metrics = computeTraceMetrics([], [call("memory", 100), call("memory", 50), call("triage", 30)]);
		expect(metrics.sidecarTokensByModule).toEqual({ memory: 170, triage: 40 });
		expect(metrics.sidecarTokens).toBe(210);
	});

	it("counts context pressure: overflow and failed compactions, error and length stops", () => {
		const metrics = computeTraceMetrics([
			event("turn.end", { stopReason: "error" }),
			event("compaction", { reason: "overflow", willRetry: true }),
			event("turn.end", { stopReason: "length" }),
			event("compaction", { reason: "threshold" }),
			event("turn.end", { stopReason: "error" }),
			event("compaction.failed", { reason: "overflow", errorMessage: "recovery failed", aborted: false }),
			event("compaction.failed", { reason: "threshold", aborted: true }),
			event("turn.end", { stopReason: "stop" }),
		]);
		expect(metrics).toMatchObject({
			compactions: 2,
			overflowCompactions: 2,
			failedCompactions: 2,
			errorStops: 2,
			lengthStops: 1,
		});
	});

	it("counts supervisor verdicts and continuations (accepted suggestions and auto)", () => {
		const metrics = computeTraceMetrics([
			event(
				"exo.verdict",
				{ verdict: "incomplete", source: "deterministic" },
				{ synthetic: true, module: "supervisor" },
			),
			event("exo.action", { action: "suggested" }, { synthetic: true, module: "supervisor" }),
			event("exo.action", { action: "accepted" }, { synthetic: true, module: "supervisor" }),
			event("exo.verdict", { verdict: "incomplete" }, { synthetic: true, module: "supervisor" }),
			event("exo.action", { action: "continued" }, { synthetic: true, module: "supervisor" }),
			event("exo.verdict", { verdict: "complete" }, { synthetic: true, module: "supervisor" }),
			event("exo.action", { action: "skipped", reason: "asked_user" }, { synthetic: true, module: "supervisor" }),
		]);
		expect(metrics.continuations).toBe(2);
		expect(metrics.verdicts).toEqual({ complete: 1, incomplete: 2, failed: 0, uncertain: 0 });
		expect(metrics.lastVerdict).toBe("complete");
		expect(metrics.deterministicVerdicts).toBe(1);
	});

	it("flags process smells: no verification after the last edit, and blind retries", () => {
		const call = (id: string, toolName: string, command?: string) =>
			event("tool.call", { toolCallId: id, toolName, input: command === undefined ? { path: "a" } : { command } });
		const result = (id: string, toolName: string, isError: boolean) =>
			event("tool.result", { toolCallId: id, toolName, isError });
		const unverified = computeTraceMetrics([
			call("1", "bash", "cargo test"),
			result("1", "bash", false),
			call("2", "edit"),
			result("2", "edit", false),
		]);
		expect(unverified).toMatchObject({ verifiedAfterLastEdit: false, maxRepeatedFailures: 0 });
		const retried = computeTraceMetrics([
			call("1", "edit"),
			result("1", "edit", false),
			...["3", "4", "5"].flatMap((id) => [call(id, "bash", "make test"), result(id, "bash", true)]),
			call("6", "bash", "make test"),
			result("6", "bash", false),
		]);
		expect(retried).toMatchObject({ verifiedAfterLastEdit: true, maxRepeatedFailures: 3 });
	});

	it("counts background sidecar calls that finished at shutdown and those that were cut off (E2, D-086)", () => {
		const drained = (settled: number, remaining: number) =>
			event(
				"exo.action",
				{ action: "drained", settled, remaining, ms: 40, limitMs: 30_000 },
				{ synthetic: true, module: "sidecars" },
			);
		expect(computeTraceMetrics([])).toMatchObject({ backgroundFinishedAtShutdown: 0, backgroundCutOff: 0 });
		// One session per accepted suggestion or retry: the counts add up over a run's sessions.
		const metrics = computeTraceMetrics([drained(2, 0), drained(1, 3)]);
		expect(metrics).toMatchObject({ backgroundFinishedAtShutdown: 3, backgroundCutOff: 3 });
		// Waiting at shutdown is not the supervisor continuing the agent.
		expect(metrics.continuations).toBe(0);
	});

	describe("verified after the last edit (E1, D-086)", () => {
		let id = 0;
		/** One bash call and its result, `at` ms into the run. */
		function bash(command: string, at: number, result: { exitCode?: number; output?: string } = {}) {
			id += 1;
			const exitCode = result.exitCode ?? 0;
			return [
				event("tool.call", { toolCallId: `v${id}`, toolName: "bash", input: { command } }, { ts: at - 1 }),
				event(
					"tool.result",
					{
						toolCallId: `v${id}`,
						toolName: "bash",
						isError: exitCode !== 0,
						exitCode,
						content: [{ type: "text", text: result.output ?? "" }],
					},
					{ ts: at },
				),
			];
		}
		function edit(at: number) {
			id += 1;
			return [
				event("tool.call", { toolCallId: `v${id}`, toolName: "edit", input: { path: "src/lib.rs" } }, { ts: at - 1 }),
				event("tool.result", { toolCallId: `v${id}`, toolName: "edit", isError: false }, { ts: at }),
			];
		}
		/** The workspace differs from the baseline in one file, last written at `lastEditMs`. */
		const edited = (lastEditMs: number | null) => ({ edits: { files: ["src/lib.rs"], lastEditMs } });
		const verified = (events: StoredTraceEvent[], workspace?: Parameters<typeof computeTraceMetrics>[2]) =>
			computeTraceMetrics(events, [], workspace).verifiedAfterLastEdit;
		const GREEN = "test result: ok. 2 passed; 0 failed; 0 ignored";
		const RED = "test parse ... FAILED\ntest result: FAILED. 1 passed; 1 failed; 0 ignored";

		it("does not count a test run that failed behind a pipe", () => {
			const run = (output: string) => [...edit(10), ...bash("cargo test 2>&1 | tail -5", 20, { output })];
			expect(verified(run(RED))).toBe(false);
			expect(verified(run(RED), edited(10))).toBe(false);
			// The same line with the runner's pass summary is a verification.
			expect(verified(run(GREEN), edited(10))).toBe(true);
			// Cut down to nothing readable, it proves nothing either way.
			expect(verified(run(""), edited(10))).toBe(false);
		});

		it("does not count a command that only mentions a runner", () => {
			for (const command of ["grep -rn pytest .", "cat Makefile", "echo cargo test", "which make", "git log -- make"]) {
				expect(verified([...edit(10), ...bash(command, 20)], edited(10)), command).toBe(false);
				expect(verified([...edit(10), ...bash(command, 20)]), command).toBe(false);
			}
		});

		it("sees an edit made through bash, from the workspace's diff", () => {
			const events = [...bash("cargo test", 10, { output: GREEN }), ...bash("sed -i s/a/b/ src/lib.rs", 20)];
			// No edit tool was used: the trace alone cannot know (the old answer, kept when no diff exists).
			expect(verified(events)).toBeNull();
			expect(verified(events, edited(19))).toBe(false);
			expect(verified([...events, ...bash("cargo test", 30, { output: GREEN })], edited(19))).toBe(true);
		});

		it("says null only when the workspace is unchanged, whatever tools ran", () => {
			expect(
				verified([...edit(10), ...bash("git checkout src/lib.rs", 20)], { edits: { files: [], lastEditMs: null } }),
			).toBeNull();
		});

		it("counts the run that wrote the last change itself (a lock file, a formatter in the same line)", () => {
			// `Cargo.lock` is written while `cargo test` runs: before its result, after its call.
			expect(verified([...edit(10), ...bash("cargo test", 30, { output: GREEN })], edited(29))).toBe(true);
			expect(verified([...edit(10), ...bash("cargo test", 30, { output: GREEN })], edited(30.4))).toBe(true);
		});

		it("takes a deleted file as an edit at an unknown time", () => {
			const events = [...bash("cargo test", 10, { output: GREEN }), ...bash("rm src/old.rs", 20)];
			expect(verified(events, { edits: { files: ["src/old.rs"], lastEditMs: null } })).toBe(true);
			expect(verified(bash("rm src/old.rs", 20), { edits: { files: ["src/old.rs"], lastEditMs: null } })).toBe(false);
		});

		it("knows a test binary run by its path, and the task's own check when it names no known runner", () => {
			expect(verified([...edit(10), ...bash("./build/tests", 20)], edited(10))).toBe(true);
			expect(verified([...edit(10), ...bash("make -s && ./build/tests", 20)], edited(10))).toBe(true);
			// Nothing in `python3 tests/run.py` says it runs tests, unless the task's check is that command.
			const script = [...edit(10), ...bash("python3 tests/run.py", 20)];
			expect(verified(script, edited(10))).toBe(false);
			expect(verified(script, { ...edited(10), checks: ["python3 tests/run.py"] })).toBe(true);
			expect(
				verified([...edit(10), ...bash("python3 tests/run.py -v", 20)], {
					...edited(10),
					checks: ["python3 tests/run.py"],
				}),
			).toBe(true);
			// A check that is several commands names none of them as a test: `test -e x` is not one.
			const compound = { ...edited(10), checks: ["test -e .cargo && cargo test"] };
			expect(verified([...edit(10), ...bash("test -e .cargo", 20)], compound)).toBe(false);
		});

		it("a failing run is not a verification, and a later passing one is", () => {
			const failing = bash("make test", 20, { exitCode: 2, output: "FAILED" });
			expect(verified([...edit(10), ...failing], edited(10))).toBe(false);
			expect(verified([...edit(10), ...failing, ...bash("make test", 30)], edited(10))).toBe(true);
		});
	});

	describe("recurring errors and triage hints", () => {
		const ERROR = "error[E0502]: cannot borrow `x` as mutable";
		let next = 0;
		/** One bash call and its result; `note` is triage's rewrite note for it, if any. */
		function bash(command: string, failure: string | null, note?: string) {
			const toolCallId = `c${++next}`;
			return [
				event("tool.call", { toolCallId, toolName: "bash", input: { command } }),
				event("tool.result", {
					toolCallId,
					toolName: "bash",
					isError: failure !== null,
					exitCode: failure === null ? 0 : 101,
					content: [{ type: "text", text: failure ?? "ok" }],
				}),
				...(note === undefined
					? []
					: [event("exo.rewrite", { toolCallId, note }, { synthetic: true, module: "triage" })]),
			];
		}
		const recurring = (...steps: StoredTraceEvent[][]) => computeTraceMetrics(steps.flat()).recurringErrors;

		it("credits the first hint when the error never comes back", () => {
			expect(
				recurring(bash("cargo build", ERROR), bash("cargo build", ERROR, "repeat 2 + hint"), bash("cargo build", null)),
			).toEqual([{ occurrences: 2, hints: 1, after: "stopped", fixed: true }]);
		});

		it("credits the second hint when the error outlived the first", () => {
			expect(
				recurring(
					bash("cargo build", ERROR),
					bash("cargo build", ERROR, "repeat 2 + hint"),
					bash("cargo build", ERROR, "repeat 3 + hint"),
					bash("ls", null),
				),
			).toEqual([{ occurrences: 3, hints: 2, after: "stopped", fixed: false }]);
		});

		it("reports an error that came back after its last hint", () => {
			expect(
				recurring(
					bash("cargo build", ERROR),
					bash("cargo build", ERROR, "repeat 2 + hint"),
					bash("cargo build", ERROR, "repeat 3 + hint"),
					bash("cargo build", ERROR, "repeat 4"),
					bash("cargo build", null),
				),
			).toEqual([{ occurrences: 4, hints: 2, after: "recurred", fixed: true }]);
		});

		it("does not credit a hint the run ended on, or notes without a hint", () => {
			expect(recurring(bash("cargo build", ERROR), bash("cargo build", ERROR, "repeat 2 + hint"))).toEqual([
				{ occurrences: 2, hints: 1, after: "ended", fixed: false },
			]);
			expect(
				recurring(
					bash("cargo build", ERROR),
					bash("cargo build", ERROR, "repeat 2"),
					bash("cargo build", ERROR, "repeat 3 + 2 hypotheses"),
					bash("ls", null),
				),
			).toEqual([{ occurrences: 3, hints: 0, after: "recurred", fixed: false }]);
		});

		it("tracks signatures separately and ignores errors seen once", () => {
			expect(
				recurring(
					bash("cargo build", ERROR),
					bash("pytest", "FAILED test_a - AssertionError"),
					bash("cargo build", ERROR),
					bash("ls", null),
				),
			).toEqual([{ occurrences: 2, hints: 0, after: "stopped", fixed: false }]);
		});
	});

	it("counts a compaction followed by a re-run of something that had already passed (R4.4)", () => {
		let next = 0;
		const bash = (command: string, ok: boolean) => {
			const toolCallId = `r${++next}`;
			return [
				event("tool.call", { toolCallId, toolName: "bash", input: { command } }),
				event("tool.result", { toolCallId, toolName: "bash", isError: !ok, exitCode: ok ? 0 : 1, content: [] }),
			];
		};
		const replays = (...steps: StoredTraceEvent[][]) => computeTraceMetrics(steps.flat()).compactionReplays;
		const compaction = [event("compaction", { reason: "threshold" })];
		expect(replays(bash("cargo build", true), compaction, bash("ls", true), bash("cargo build", true))).toBe(1);
		// Not a replay: it failed before, it fails now, or it comes after the agent's first two commands.
		expect(replays(bash("cargo test", false), compaction, bash("cargo test", true))).toBe(0);
		expect(replays(bash("cargo build", true), compaction, bash("cargo build", false))).toBe(0);
		expect(
			replays(bash("cargo build", true), compaction, bash("ls", true), bash("pwd", true), bash("cargo build", true)),
		).toBe(0);
		expect(
			replays(bash("make", true), compaction, bash("make", true), compaction, bash("make", true), bash("make", true)),
		).toBe(2);
	});

	it("counts trimmed outputs whose saved full copy the agent read back (R2.1)", () => {
		const trimmed = (toolCallId: string, fullOutputPath?: string) =>
			event(
				"exo.rewrite",
				{ toolCallId, note: "trimmed 600→120 lines", ...(fullOutputPath ? { fullOutputPath } : {}) },
				{ synthetic: true, module: "trimmer" },
			);
		const call = (toolName: string, input: object) => event("tool.call", { toolCallId: "x", toolName, input });
		const metrics = computeTraceMetrics([
			call("read", { path: "/tmp/exo/a.log" }),
			trimmed("a", "/tmp/exo/a.log"),
			trimmed("b", "/tmp/exo/b.log"),
			trimmed("c"),
			event("exo.rewrite", { toolCallId: "d", note: "repeat 2" }, { synthetic: true, module: "triage" }),
			call("bash", { command: "grep -n error /tmp/exo/b.log | head" }),
			call("read", { path: "src/lib.rs" }),
		]);
		expect(metrics).toMatchObject({ trimmedOutputs: 3, trimmedRereads: 1 });
	});

	it("adds pi's own compaction calls to the main tokens, which no turn carries (D-079)", () => {
		const turn = event("turn.end", { stopReason: "stop", usage: { input: 1_000, cacheRead: 200, output: 50 } });
		const without = computeTraceMetrics([turn]);
		expect(without).toMatchObject({ inputTokens: 1_000, cachedTokens: 200, outputTokens: 50, compactionTokens: 0 });
		const metrics = computeTraceMetrics([
			turn,
			// Pi summarised the session itself: the usage is on the compaction entry only.
			event("compaction", {
				reason: "threshold",
				fromExtension: false,
				entry: { type: "compaction", summary: "…", usage: { input: 9_000, cacheRead: 0, output: 700 } },
			}),
			// Exocortex's compaction module supplied this one: its calls are sidecar calls, counted there.
			event("compaction", {
				reason: "threshold",
				fromExtension: true,
				entry: { type: "compaction", summary: "…", usage: { input: 5_000, cacheRead: 0, output: 500 } },
			}),
			// An older pi, or a summary with no usage reported.
			event("compaction", { reason: "manual", fromExtension: false, entry: { type: "compaction", summary: "…" } }),
		]);
		expect(metrics).toMatchObject({
			turns: 1,
			inputTokens: 10_000,
			cachedTokens: 200,
			outputTokens: 750,
			compactionTokens: 9_700,
			compactions: 3,
		});
	});

	it("remembers how the last turn ended", () => {
		expect(computeTraceMetrics([]).lastStopReason).toBeNull();
		const stops = (...reasons: unknown[]) =>
			computeTraceMetrics(reasons.map((stopReason) => event("turn.end", { stopReason }))).lastStopReason;
		expect(stops("toolUse", "error")).toBe("error");
		expect(stops("error", "stop")).toBe("stop");
		expect(stops("stop", undefined)).toBeNull();
	});

	it("handles an empty trace", () => {
		expect(computeTraceMetrics([])).toMatchObject({
			turns: 0,
			cacheHitRate: null,
			prefixKeptRate: null,
			maxPromptChars: 0,
		});
	});
});

describe("repeated errors (D-073)", () => {
	const call = (toolCallId: string, command: string) => event("tool.call", { toolCallId, input: { command } });
	const result = (toolCallId: string, text: string, isError = true) =>
		event("tool.result", {
			toolName: "bash",
			toolCallId,
			isError,
			exitCode: isError ? 101 : 0,
			content: [{ type: "text", text }],
		});
	const failing = (names: string) =>
		`${names
			.split(" ")
			.map((n) => `test ${n} ... FAILED`)
			.join("\n")}\nerror: test failed, to rerun pass \`--lib\``;

	it("does not count a run with fewer failing tests as the same error again", () => {
		const metrics = computeTraceMetrics([
			call("1", "cargo test"),
			result("1", failing("a b c")),
			call("2", "cargo test"),
			result("2", failing("a b")),
			call("3", "cargo test"),
			result("3", failing("a")),
		]);
		expect(metrics.toolErrors).toBe(3);
		expect(metrics.repeatedToolErrors).toBe(0);
		expect(metrics.recurringErrors).toEqual([]);
	});

	it("follows a test run that failed behind a pipe", () => {
		const metrics = computeTraceMetrics([
			call("1", "cargo test 2>&1 | tail -5"),
			result("1", failing("a"), false),
			call("2", "cargo test 2>&1 | tail -5"),
			result("2", failing("a"), false),
			call("3", "cargo test 2>&1 | tail -5"),
			result("3", "test result: ok. 3 passed", false),
		]);
		expect(metrics.recurringErrors).toEqual([{ occurrences: 2, hints: 0, after: "stopped", fixed: true }]);
	});
});
