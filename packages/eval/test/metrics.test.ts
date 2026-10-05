import type { StoredTraceEvent, TraceEventKind } from "@exocortex/core";
import { describe, expect, it } from "vitest";
import { computeTraceMetrics, errorSignature } from "../src/metrics.ts";

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

describe("errorSignature", () => {
	it("normalizes numbers, paths, quoted strings and hex", () => {
		const a = errorSignature({
			toolName: "bash",
			exitCode: 1,
			content: [{ type: "text", text: "running\nsrc/foo.py:12: error: 'x' at 0xdeadbeef" }],
		});
		const b = errorSignature({
			toolName: "bash",
			exitCode: 1,
			content: [{ type: "text", text: "src/bar/baz.py:99: error: 'yy' at 0x1234" }],
		});
		expect(a).toBe(b);
		expect(a).toBe("bash|1|<path>:<n>: error: <str> at <hex>");
	});

	it("distinguishes tools and exit codes", () => {
		const content = [{ type: "text", text: "error: boom" }];
		expect(errorSignature({ toolName: "bash", exitCode: 1, content })).not.toBe(
			errorSignature({ toolName: "bash", exitCode: 2, content }),
		);
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
			toolError("FAILED test_x: AssertionError 3 != 4"),
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
			// The same failure twice with nothing after it: it never had the chance to recur.
			recurringErrors: [{ occurrences: 2, hints: 0, after: "ended", fixed: false }],
			sidecarTokensByModule: {},
			sidecarCalls: 0,
			sidecarTokens: 0,
			sidecarFailures: 0,
			verdicts: { complete: 0, incomplete: 0, failed: 0, uncertain: 0 },
			lastVerdict: null,
			deterministicVerdicts: 0,
			verifiedAfterLastEdit: null,
			maxRepeatedFailures: 0, // the fixture's tool results carry no matching tool.call commands
		});
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

	it("handles an empty trace", () => {
		expect(computeTraceMetrics([])).toMatchObject({
			turns: 0,
			cacheHitRate: null,
			prefixKeptRate: null,
			maxPromptChars: 0,
		});
	});
});
