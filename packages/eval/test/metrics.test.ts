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
			sidecarCalls: 0,
			sidecarTokens: 0,
			sidecarFailures: 0,
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

	it("handles an empty trace", () => {
		expect(computeTraceMetrics([])).toMatchObject({
			turns: 0,
			cacheHitRate: null,
			prefixKeptRate: null,
			maxPromptChars: 0,
		});
	});
});
