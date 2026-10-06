import { ENGINE_PROFILES } from "@exocortex/core";
import { startFakeOpenAIServer } from "@exocortex/testkit";
import { describe, expect, it } from "vitest";
import { percentile, renderLoadTestMarkdown, runLoadTest } from "../src/loadtest.ts";

describe("runLoadTest against a fake engine", { timeout: 30_000 }, () => {
	it("measures both phases, keeps sidecars within their slots and reports the regression", async () => {
		const server = await startFakeOpenAIServer([], {
			fallback: { kind: "text", text: "1 2 3 4 5", delayMs: 15, cachedTokens: 3 },
		});
		try {
			const report = await runLoadTest({
				target: { baseUrl: server.baseUrl, model: "m", apiKey: undefined, features: ENGINE_PROFILES.generic },
				maxConcurrent: 4,
				reservedForMain: 1,
				mainRequests: 3,
				mainContextTokens: 200,
				mainMaxTokens: 16,
				sidecarBacklog: 8,
				sidecarPromptTokens: 50,
				sidecarMaxTokens: 8,
				sidecarTimeoutMs: 5_000,
			});
			expect(report.alone.samples).toHaveLength(3);
			expect(report.loaded.samples).toHaveLength(3);
			expect(report.alone.samples[0]?.cachedTokens).toBe(3);
			expect(report.sidecars.completed).toBeGreaterThanOrEqual(8);
			expect(report.sidecars.failed).toBe(0);
			expect(report.sidecars.maxRunningObserved).toBe(3);
			// Main requests bypass the pool: at most 3 sidecars + 1 main request in flight.
			expect(server.maxInFlight).toBeLessThanOrEqual(4);
			const markdown = renderLoadTestMarkdown(report, "t");
			expect(markdown).toContain("| **regression** |");
			expect(markdown).toMatch(/max running 3 of 3 slots/);
		} finally {
			await server.close();
		}
	});
});

describe("runLoadTest when the engine misbehaves", { timeout: 30_000 }, () => {
	const options = (baseUrl: string) => ({
		target: { baseUrl, model: "m", apiKey: undefined, features: ENGINE_PROFILES.generic },
		maxConcurrent: 4,
		reservedForMain: 1,
		mainRequests: 3,
		mainContextTokens: 200,
		mainMaxTokens: 16,
		sidecarBacklog: 6,
		sidecarPromptTokens: 50,
		sidecarMaxTokens: 8,
		sidecarTimeoutMs: 5_000,
	});

	it("reports a load phase in which every sidecar failed as failed, not as no regression", async () => {
		// Main requests stream; sidecar calls do not. Only the sidecars fail.
		const server = await startFakeOpenAIServer([], {
			respond: (body) =>
				(body as { stream?: boolean }).stream
					? { kind: "text", text: "1 2 3", delayMs: 10 }
					: { kind: "error", status: 500, message: "no slot" },
		});
		try {
			const report = await runLoadTest(options(server.baseUrl));
			expect(report.sidecars.completed).toBe(0);
			expect(report.sidecars.failed).toBeGreaterThan(0);
			// Before D-079 this printed a regression of about 0%: a pass.
			expect(report.regression).toBeNull();
			const markdown = renderLoadTestMarkdown(report, "t");
			expect(markdown).toContain("| **regression** | not measured |");
			expect(markdown).toContain("The load phase failed");
		} finally {
			await server.close();
		}
	});

	it("stops the sidecar load and rejects when a main request fails, instead of running for ever", async () => {
		let mainRequests = 0;
		const server = await startFakeOpenAIServer([], {
			respond: (body) => {
				if (!(body as { stream?: boolean }).stream) return { kind: "text", text: "ok", delayMs: 5 };
				mainRequests += 1;
				// The warm-up and the three unloaded requests pass; the first loaded one fails.
				return mainRequests <= 4 ? { kind: "text", text: "1 2 3" } : { kind: "error", status: 500, message: "down" };
			},
		});
		try {
			await expect(runLoadTest(options(server.baseUrl))).rejects.toThrow("main request failed: HTTP 500");
			// The saturating loop stopped: nothing is submitted any more.
			const seen = server.requests.length;
			await new Promise((resolve) => setTimeout(resolve, 150));
			expect(server.requests.length).toBe(seen);
			expect(server.inFlight).toBe(0);
		} finally {
			await server.close();
		}
	});
});

describe("percentile", () => {
	it("uses nearest-rank", () => {
		expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
		expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
		expect(percentile([], 0.5)).toBe(0);
	});
});
