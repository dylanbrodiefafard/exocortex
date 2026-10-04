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

describe("percentile", () => {
	it("uses nearest-rank", () => {
		expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
		expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
		expect(percentile([], 0.5)).toBe(0);
	});
});
