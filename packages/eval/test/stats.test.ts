import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/report.ts";
import type { RunRecord } from "../src/run.ts";
import { minimumDetectableEffect, pairedComparison, signTest } from "../src/stats.ts";

function run(taskId: string, config: string, success: boolean, extra: Partial<RunRecord> = {}): RunRecord {
	return {
		label: `${taskId}-${config}`,
		taskId,
		config,
		repeat: 0,
		outcome: "settled",
		success,
		checkExitCode: success ? 0 : 1,
		checkTimedOut: false,
		agentMs: 1_000,
		acceptedSuggestions: 0,
		wallClockMs: 10_000,
		metrics: null,
		...extra,
	};
}

describe("signTest", () => {
	it("matches exact binomial tails", () => {
		expect(signTest(0, 0)).toBe(1);
		expect(signTest(5, 0)).toBeCloseTo(0.0625);
		expect(signTest(8, 2)).toBeCloseTo(0.109375);
		expect(signTest(3, 3)).toBe(1);
	});
});

describe("minimumDetectableEffect", () => {
	it("reproduces the research survey's table (p = 0.64)", () => {
		expect(Math.round(minimumDetectableEffect(0.64, 15) * 100)).toBe(49);
		expect(Math.round(minimumDetectableEffect(0.64, 60) * 100)).toBe(25);
		expect(Math.round(minimumDetectableEffect(0.64, 300) * 100)).toBe(11);
		expect(minimumDetectableEffect(0.5, 0)).toBe(1);
	});
});

describe("pairedComparison", () => {
	const records = [
		// task a: 1/2 → 2/2 (win); task b: 0/1 → 0/1 (tie); task c: 1/1 → 0/1 (loss); task d only in baseline
		run("a", "off", true),
		run("a", "off", false),
		run("a", "on", true, { wallClockMs: 5_000 }),
		run("a", "on", true, { wallClockMs: 5_000 }),
		run("b", "off", false),
		run("b", "on", false),
		run("c", "off", true),
		run("c", "on", false),
		run("d", "off", true),
	];

	it("compares per-task success rates on shared tasks only", () => {
		const c = pairedComparison(records, "off", "on");
		expect(c).toMatchObject({ baseline: "off", treatment: "on", tasks: 3, wins: 1, losses: 1, ties: 1 });
		expect(c.meanDelta).toBeCloseTo((0.5 + 0 - 1) / 3);
		expect(c.signTestP).toBe(1);
		expect(c.ci[0]).toBeLessThanOrEqual(c.meanDelta);
		expect(c.ci[1]).toBeGreaterThanOrEqual(c.meanDelta);
		expect(c.wallClockChange).toBeCloseTo((-0.5 + 0 + 0) / 3);
		expect(c.turnsChange).toBeNull();
	});

	it("is reproducible for a seed", () => {
		expect(pairedComparison(records, "off", "on", 7).ci).toEqual(pairedComparison(records, "off", "on", 7).ci);
	});

	it("handles configs with nothing in common", () => {
		const c = pairedComparison([run("a", "off", true), run("b", "on", true)], "off", "on");
		expect(c).toMatchObject({ tasks: 0, meanDelta: 0, ci: [0, 0], signTestP: 1 });
	});

	it("uses metrics when present for turns and tokens", () => {
		const metrics = (turns: number, inputTokens: number) => ({ turns, inputTokens }) as unknown as RunRecord["metrics"];
		const c = pairedComparison(
			[run("a", "off", true, { metrics: metrics(10, 1000) }), run("a", "on", true, { metrics: metrics(8, 600) })],
			"off",
			"on",
		);
		expect(c.turnsChange).toBeCloseTo(-0.2);
		expect(c.inputTokensChange).toBeCloseTo(-0.4);
	});
});

describe("report", () => {
	it("adds a paired section against the first config", () => {
		const markdown = renderMarkdown(
			[run("a", "off", false), run("a", "on", true), run("b", "off", false), run("b", "on", true)],
			"t",
		);
		expect(markdown).toContain("## Paired by task vs `off`");
		expect(markdown).toContain("| on | 2 | +100 | [+100, +100] | 2/0/0 | 0.50 | — | — | 0% |");
		expect(markdown).toContain("can only detect differences of about 100 points");
	});

	it("omits it for a single config", () => {
		expect(renderMarkdown([run("a", "off", true)], "t")).not.toContain("Paired");
	});
});
