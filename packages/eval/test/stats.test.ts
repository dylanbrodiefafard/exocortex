import { describe, expect, it } from "vitest";
import { computeTraceMetrics } from "../src/metrics.ts";
import { renderMarkdown } from "../src/report.ts";
import type { RunRecord } from "../src/run.ts";
import { minimumDetectableEffect, pairedComparison, pairedRelativeChange, signTest } from "../src/stats.ts";

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

describe("pairedRelativeChange", () => {
	const tokens = (r: RunRecord) => r.metrics?.inputTokens ?? null;
	const spent = (taskId: string, config: string, inputTokens: number) =>
		run(taskId, config, true, { metrics: { ...computeTraceMetrics([]), inputTokens } });

	it("averages per-task relative changes and says what it could detect", () => {
		const change = pairedRelativeChange(
			[
				spent("a", "off", 100),
				spent("a", "off", 300),
				spent("a", "on", 220),
				spent("b", "off", 100),
				spent("b", "on", 130),
				spent("c", "off", 0),
				spent("c", "on", 50),
				run("d", "off", true),
				spent("d", "on", 50),
			],
			"off",
			"on",
			tokens,
		);
		// a: 200 → 220 (+10%), b: +30%; c has a zero baseline and d no baseline data.
		expect(change?.tasks).toBe(2);
		expect(change?.mean).toBeCloseTo(0.2);
		expect(change?.ci[0]).toBeGreaterThanOrEqual(0.1 - 1e-9);
		expect(change?.ci[1]).toBeLessThanOrEqual(0.3 + 1e-9);
		// sd of (0.1, 0.3) is 0.1414; 2.8 × sd / √2 = 0.28.
		expect(change?.detectable).toBeCloseTo(0.28);
	});

	it("is null without shared tasks, and has no detectable size for one task", () => {
		expect(pairedRelativeChange([spent("a", "off", 100)], "off", "on", tokens)).toBeNull();
		expect(pairedRelativeChange([spent("a", "off", 100), spent("a", "on", 50)], "off", "on", tokens)).toMatchObject({
			mean: -0.5,
			detectable: null,
		});
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

	it("reports verdict quality against the hidden checks", () => {
		const judged = (taskId: string, success: boolean, lastVerdict: string) =>
			run(taskId, "sup", success, {
				metrics: { ...computeTraceMetrics([]), lastVerdict: lastVerdict as "complete" | "incomplete" },
			});
		const markdown = renderMarkdown(
			[
				judged("a", true, "complete"),
				judged("b", false, "complete"),
				judged("c", false, "incomplete"),
				run("d", "sup", false),
			],
			"t",
		);
		expect(markdown).toContain("| sup | 2 | 50% | 50% |");
	});

	it("counts tampered runs, lucky passes and total tokens", () => {
		const metrics = (verifiedAfterLastEdit: boolean | null, maxRepeatedFailures: number) => ({
			...computeTraceMetrics([]),
			inputTokens: 100,
			outputTokens: 10,
			sidecarTokens: 40,
			verifiedAfterLastEdit,
			maxRepeatedFailures,
		});
		const markdown = renderMarkdown(
			[
				run("a", "x", true, { metrics: metrics(false, 0), tamperedTests: ["tests/t.py"] }),
				run("b", "x", true, { metrics: metrics(true, 3) }),
				run("c", "x", true, { metrics: metrics(true, 0) }),
				run("d", "x", false, { metrics: metrics(false, 5) }),
			],
			"t",
		);
		expect(markdown).toMatch(/\| 150 \| 0 \| 0\/0\/0\/0 \| 0 \| 1 \| 2 \|/);
	});

	it("shows success by repeat when there are repeats", () => {
		const markdown = renderMarkdown(
			[
				run("a", "off", false, { repeat: 1 }),
				run("a", "off", false, { repeat: 2 }),
				run("a", "memory", false, { repeat: 1 }),
				run("a", "memory", true, { repeat: 2 }),
			],
			"t",
		);
		expect(markdown).toContain("| config | r1 | r2 |");
		expect(markdown).toContain("| memory | 0/1 | 1/1 |");
	});

	it("puts each config's total tokens side by side next to success by repeat (D-058)", () => {
		const spent = (taskId: string, config: string, repeat: number, inputTokens: number, memory = 0) =>
			run(taskId, config, config === "memory", {
				repeat,
				metrics: {
					...computeTraceMetrics([]),
					inputTokens,
					outputTokens: 100,
					sidecarTokens: memory,
					sidecarTokensByModule: memory > 0 ? { memory } : {},
				},
			});
		const markdown = renderMarkdown(
			[
				spent("a", "all-off", 1, 900),
				spent("b", "all-off", 1, 1900),
				spent("a", "all-off", 2, 900),
				spent("b", "all-off", 2, 1900),
				spent("a", "memory", 1, 900, 200),
				spent("b", "memory", 1, 1900, 200),
				spent("a", "memory", 2, 700),
				spent("b", "memory", 2, 1500),
			],
			"t",
		);
		expect(markdown).toContain("### Token budget");
		expect(markdown).toContain(
			"| config | main tok | memory sidecar tok | total tok | total r1 | total r2 | tok per pass | Δ total vs `all-off` | 95% CI | detectable Δ |",
		);
		expect(markdown).toContain("| all-off | 1500 | 0 | 1500 | 1500 | 1500 | — | — | — | — |");
		// a: 1000 → 1000 (0%), b: 2000 → 1900 (−5%); mean −2.5%, which rounds to −2%.
		expect(markdown).toMatch(
			/\| memory \| 1350 \| 100 \| 1450 \| 1700 \| 1200 \| 1450 \| -2% \| \[-5%, 0%\] \| ±7% \|/,
		);
		expect(markdown).toContain(
			"one repeat column has 2 runs per config and can only detect differences of about 100 points",
		);
		expect(markdown).toContain("all 2 repeats together (4 runs) about 99 points");
	});

	it("shows which triage hint preceded the end of each repeated error (D-057)", () => {
		const errors = (
			config: string,
			recurringErrors: NonNullable<ReturnType<typeof computeTraceMetrics>["recurringErrors"]>,
		) => run("a", config, true, { metrics: { ...computeTraceMetrics([]), recurringErrors } });
		const markdown = renderMarkdown(
			[
				errors("all-off", [
					{ occurrences: 2, hints: 0, after: "stopped", fixed: true },
					{ occurrences: 3, hints: 0, after: "recurred", fixed: false },
					{ occurrences: 5, hints: 0, after: "recurred", fixed: false },
				]),
				errors("triage", [
					{ occurrences: 2, hints: 1, after: "stopped", fixed: true },
					{ occurrences: 2, hints: 1, after: "stopped", fixed: false },
					{ occurrences: 3, hints: 2, after: "stopped", fixed: true },
					{ occurrences: 4, hints: 2, after: "recurred", fixed: false },
					{ occurrences: 2, hints: 1, after: "ended", fixed: false },
					{ occurrences: 2, hints: 0, after: "stopped", fixed: false },
				]),
			],
			"t",
		);
		expect(markdown).toContain("| all-off | 3 | 1/3 (33%) | 2 | 1/2 (50%) |");
		expect(markdown).toContain("| triage | 6 | 4/6 (67%) | 2 | 1/2 (50%) |");
		expect(markdown).toContain("### Which hint preceded the end of the error");
		expect(markdown).toContain("| triage | 5 | 2 | 1 | 2 | 1 | 1 | 1 | 1 |");
		expect(markdown).not.toMatch(/\| all-off \| 0 \| 0 \|/);
	});

	it("leaves the hint table out when no config gave hints, and the section out without repeats", () => {
		const errors = run("a", "all-off", true, {
			metrics: {
				...computeTraceMetrics([]),
				recurringErrors: [{ occurrences: 2, hints: 0, after: "stopped", fixed: true }],
			},
		});
		expect(renderMarkdown([errors], "t")).toContain("## Repeated errors");
		expect(renderMarkdown([errors], "t")).not.toContain("Which hint");
		expect(renderMarkdown([run("a", "all-off", true)], "t")).not.toContain("## Repeated errors");
	});

	it("counts compactions, overflows and the failures that came with them (D-059)", () => {
		const pressure = (
			taskId: string,
			config: string,
			success: boolean,
			extra: Partial<ReturnType<typeof computeTraceMetrics>>,
		) => run(taskId, config, success, { metrics: { ...computeTraceMetrics([]), ...extra } });
		const markdown = renderMarkdown(
			[
				pressure("a", "all-off", true, {}),
				pressure("b", "all-off", false, { compactions: 2, overflowCompactions: 1 }),
				pressure("c", "all-off", false, { failedCompactions: 1, overflowCompactions: 1, errorStops: 2 }),
				pressure("a", "compaction", true, { compactions: 1, lengthStops: 1 }),
				pressure("b", "compaction", true, { compactions: 1 }),
				run("c", "compaction", false),
			],
			"t",
		);
		expect(markdown).toContain("## Context pressure");
		expect(markdown).toContain("| all-off | 1/3 | 0/1 | 1/2 | 2 | 1 | 2 | 0 | 2 |");
		expect(markdown).toContain("| compaction | 2/2 | 2/2 | — | 0 | 0 | 0 | 1 | 0 |");
	});

	it("says so when nothing compacted, and points at provider errors", () => {
		expect(renderMarkdown([run("a", "off", true)], "t")).toContain(
			"No run compacted or overflowed its context window.\n",
		);
		const errored = run("a", "off", false, { metrics: { ...computeTraceMetrics([]), errorStops: 3 } });
		expect(renderMarkdown([errored], "t")).toContain("3 turns ended in a provider error");
	});

	it("omits it for a single config", () => {
		expect(renderMarkdown([run("a", "off", true)], "t")).not.toContain("Paired");
	});
});
