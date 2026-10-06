import { describe, expect, it } from "vitest";
import { computeTraceMetrics } from "../src/metrics.ts";
import type { RunRecord } from "../src/records.ts";
import { renderMarkdown, summarize } from "../src/report.ts";

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

const SIX = ["a", "b", "c", "d", "e", "f"];

describe("paired section", () => {
	it("says the sample is too small for an interval instead of printing a degenerate one", () => {
		const markdown = renderMarkdown(
			[run("a", "off", false), run("a", "on", true), run("b", "off", false), run("b", "on", true)],
			"t",
		);
		expect(markdown).toContain("## Paired by task vs `off`");
		// Two wins of two: the old bootstrap printed [+100, +100]. The exact p is 2/4.
		expect(markdown).toContain("| on | 2 | +100 | n too small | 0.500 | 0.500 | n too small | 2/0/0 |");
		expect(markdown).toContain("| on | — | — | 0% n too small | — |");
		expect(markdown).toContain("with fewer than 6 tasks no 95% interval exists");
		expect(markdown).not.toContain("unpaired");
	});

	it("gives the exact interval, a Holm-adjusted p across treatments and what the tasks can detect", () => {
		const records = SIX.flatMap((task, i) => [
			run(task, "off", i >= 4),
			run(task, "on", true),
			run(task, "worse", i === 4),
		]);
		const markdown = renderMarkdown(records, "t");
		// on: differences 1,1,1,1,0,0. worse: 0,0,0,0,0,−1.
		expect(markdown).toContain("| on | 6 | +67 | [0, +100] | 0.125 | 0.250 | ±93 | 4/0/2 |");
		expect(markdown).toContain("| worse | 6 | -17 | [-100, 0] | 1.000 | 1.000 | ±73 | 0/1/5 |");
		expect(markdown).toContain("adjusts for testing 2 configs against the baseline");
	});

	it("computes what is detectable from the per-task differences, not from the run count", () => {
		// Same 12 runs per config, same pooled pass rate. Left: every task moves alike across its
		// repeats (differences vary a lot between tasks). Right: repeats disagree within tasks and
		// the per-task differences are small. The old formula printed one number for both.
		const spread = SIX.flatMap((task, i) =>
			[1, 2].flatMap((repeat) => [run(task, "off", i % 2 === 0, { repeat }), run(task, "on", i % 2 === 1, { repeat })]),
		);
		const steady = SIX.flatMap((task, i) =>
			[1, 2].flatMap((repeat) => [
				run(task, "off", repeat === 1, { repeat }),
				run(task, "on", i === 0 ? true : repeat === 2, { repeat }),
			]),
		);
		const detectable = (markdown: string) => markdown.match(/\| on \| 6 \|.*?(±\d+|—) \| \d+\/\d+\/\d+ \|/)?.[1];
		// sd of ±1 alternating is 1.095; × 1.793 = 1.96, i.e. nothing below 196 points: undetectable.
		expect(detectable(renderMarkdown(spread, "t"))).toBe("±196");
		// One task at +0.5, five at 0: sd 0.204; × 1.793 = 0.37.
		expect(detectable(renderMarkdown(steady, "t"))).toBe("±37");
	});

	it("leaves an invalid run's block out of both configs and out of the success rates", () => {
		const records = [
			...SIX.flatMap((task) => [run(task, "off", false, { repeat: 1 }), run(task, "on", true, { repeat: 1 })]),
			// Repeat 2 of task a: the treatment crashed. The baseline's failure there must not count.
			run("a", "off", false, { repeat: 2 }),
			run("a", "on", false, { repeat: 2, outcome: "crashed" }),
		];
		const [off, on] = summarize(records);
		expect(off).toMatchObject({ runs: 7, invalid: 0, successes: 0 });
		expect(on).toMatchObject({ runs: 6, invalid: 1, successes: 6, successRate: 1, abnormal: 0 });
		const markdown = renderMarkdown(records, "t");
		expect(markdown).toContain("| a | 0/2 | 1/1 (+1 invalid) |");
		expect(markdown).toContain("| on | 6 | +100 | [+100, +100] | 0.031 | 0.031 | — | 6/0/0 |");
		expect(markdown).toContain("Left out: `on`: 1 (task, repeat) block with an invalid run.");
		expect(markdown).toContain("| config | r1 | r2 |\n|---|---|---|\n| off | 0/6 | 0/1 |\n| on | 6/6 | 0/0 |");
	});

	it("puts intervals on the cost columns, as ratios, and on the repeated-error rate, in points", () => {
		const metrics = (turns: number, inputTokens: number, toolErrors: number, repeatedToolErrors: number) => ({
			...computeTraceMetrics([]),
			turns,
			inputTokens,
			toolErrors,
			repeatedToolErrors,
		});
		const records = SIX.flatMap((task, i) => [
			run(task, "off", true, { metrics: metrics(10, 1_000 * (i + 1), 4, 2), wallClockMs: 20_000 }),
			// Every task: a fifth fewer turns, half the input tokens, half the time; errors 4 → 4, repeats 2 → 1.
			run(task, "on", true, { metrics: metrics(8, 500 * (i + 1), 4, 1), wallClockMs: 10_000 }),
		]);
		const markdown = renderMarkdown(records, "t");
		expect(markdown).toContain("| on | -20% [-20%, -20%] | -50% [-50%, -50%] | -50% [-50%, -50%] | -25 [-25, -25] |");
	});

	it("names tasks that had no ratio rather than dropping them silently", () => {
		const tokens = (inputTokens: number) => ({ ...computeTraceMetrics([]), inputTokens, turns: 3 });
		const markdown = renderMarkdown(
			[
				run("a", "off", true, { metrics: tokens(0) }),
				run("a", "on", true, { metrics: tokens(50) }),
				run("b", "off", true, { metrics: tokens(100) }),
				run("b", "on", true, { metrics: tokens(50) }),
			],
			"t",
		);
		expect(markdown).toContain("| on | 0% n too small | -50% n too small | 0% n too small | — |");
		expect(markdown).toContain("Left out: `on`: 1 task with no input tokens in one config.");
	});

	it("is the same report every time, also above the exact limit where subsets are sampled", () => {
		const tasks = Array.from({ length: 20 }, (_, i) => `t${i}`);
		const records = tasks.flatMap((task, i) => [run(task, "off", i % 3 === 0), run(task, "on", i % 2 === 0)]);
		expect(renderMarkdown(records, "t")).toBe(renderMarkdown(records, "t"));
		expect(renderMarkdown(records, "t")).toMatch(/\| on \| 20 \| \+15 \| \[-\d+, \+\d+\] \| 0\.\d{3} \|/);
	});

	it("is omitted for a single config", () => {
		expect(renderMarkdown([run("a", "off", true)], "t")).not.toContain("Paired");
	});
});

describe("report", () => {
	it("reports verdict quality against the hidden checks with a Wilson interval", () => {
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
		// 1 of 2: the Wilson interval is [9%, 91%], which is the point of printing it.
		expect(markdown).toContain("| sup | 2 | 50% | [9%, 91%] | 50% | — | — | — |");
	});

	it("pairs precision of complete against the baseline by task", () => {
		const judged = (taskId: string, config: string, success: boolean, lastVerdict: "complete" | "incomplete") =>
			run(taskId, config, success, { metrics: { ...computeTraceMetrics([]), lastVerdict } });
		const records = SIX.flatMap((task, i) => [
			// Baseline: says complete on everything, right on two tasks of six.
			judged(task, "supervisor", i < 2, "complete"),
			// Treatment: says complete on four tasks, right on all four (two were never called complete).
			judged(task, "supervisor-think", i < 4, i < 4 ? "complete" : "incomplete"),
		]);
		const markdown = renderMarkdown(records, "t");
		expect(markdown).toContain("| supervisor | 6 | 33% | [10%, 70%] | 0% | — | — | — |");
		// Tasks a–d have a verdict of complete in both: differences 0, 0, +1, +1.
		expect(markdown).toContain("| supervisor-think | 4 | 100% | [51%, 100%] | 100% | +50 | n too small | 0.500 |");
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
				run("b", "x", true, { metrics: metrics(true, 3), tamperedFiles: ["Makefile"] }),
				run("c", "x", true, { metrics: metrics(true, 0) }),
				run("d", "x", false, { metrics: metrics(false, 5) }),
			],
			"t",
		);
		// total tok | sidecar fail | verdicts | abnormal | invalid | tampered | lucky passes
		expect(markdown).toMatch(/\| 150 \| 0 \| 0\/0\/0\/0 \| 0 \| 0 \| 2 \| 2 \|/);
		expect(markdown).not.toContain("## Check guard");
	});

	it("shows what the check guard did when it did something", () => {
		const markdown = renderMarkdown(
			[
				run("a", "x", true, { setAsideTests: ["tests/test_mine.py"] }),
				run("b", "x", false, { checkExitCode: 0, tooFewTests: true, checkTests: 0 }),
				run("c", "x", false, { checkTimedOut: true, checkExitCode: null }),
				run("d", "x", true),
			],
			"t",
		);
		expect(markdown).toContain("## Check guard");
		expect(markdown).toContain("| x | 1 | 1 | 1 |");
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
		// a: 1000 → 1000 (×1), b: 2000 → 1900 (×0.95); geometric mean √0.95 = −2.5%, which rounds to −3%.
		expect(markdown).toContain("| memory | 1350 | 100 | 1450 | 1700 | 1200 | 1450 | -3% | n too small | — |");
		expect(markdown).toContain("One repeat column is one run per task: read it as a trend, not as a test.");
		expect(markdown).not.toContain("runs per config and can only detect");
	});

	it("gives the token change its interval and detectable size from six tasks on", () => {
		const spent = (taskId: string, config: string, repeat: number, inputTokens: number) =>
			run(taskId, config, true, { repeat, metrics: { ...computeTraceMetrics([]), inputTokens } });
		const records = SIX.flatMap((task, i) =>
			[1, 2].flatMap((repeat) => [
				spent(task, "all-off", repeat, 1_000),
				// Three tasks 10% dearer, three 10% cheaper per the log scale: ×1.1 and ×1/1.1.
				spent(task, "memory", repeat, i < 3 ? 1_100 : 1_000 / 1.1),
			]),
		);
		const markdown = renderMarkdown(records, "t");
		// sd of ±ln 1.1 over six tasks is 0.1044; × 1.793 = 0.187 → e^0.187 − 1 = 21%.
		expect(markdown).toMatch(/\| memory \| .* \| 0% \| \[-9%, \+10%\] \| ±21% \|/);
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

	it("shows loops without progress and the calls made inside them per config (D-069)", () => {
		const looped = (taskId: string, config: string, success: boolean, stuckLoops: number, stuckLoopCalls: number) =>
			run(taskId, config, success, { metrics: { ...computeTraceMetrics([]), stuckLoops, stuckLoopCalls } });
		const markdown = renderMarkdown(
			[
				looped("a", "all-off", false, 2, 9),
				looped("b", "all-off", true, 0, 0),
				looped("a", "triage", true, 1, 1),
				looped("b", "triage", true, 0, 0),
			],
			"t",
		);
		expect(markdown).toContain("| all-off | 1/2 | 0/1 | 2 | 9 | 4.5 |");
		expect(markdown).toContain("| triage | 1/2 | 1/1 | 1 | 1 | 1.0 |");
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
				pressure("b", "compaction", true, { compactions: 1, compactionReplays: 1 }),
				run("c", "compaction", false),
			],
			"t",
		);
		expect(markdown).toContain("## Context pressure");
		expect(markdown).toContain("## Stuck loops\n\nNo run repeated a call");
		expect(markdown).toContain("| all-off | 1/3 | 0/1 | 1/2 | 0/2 | 2 | 1 | 2 | 0 | 2 |");
		expect(markdown).toContain("| compaction | 2/2 | 2/2 | — | 1/2 | 0 | 0 | 0 | 1 | 0 |");
	});

	it("says so when nothing compacted, and points at provider errors", () => {
		expect(renderMarkdown([run("a", "off", true)], "t")).toContain(
			"No run compacted or overflowed its context window.\n",
		);
		const errored = run("a", "off", false, { metrics: { ...computeTraceMetrics([]), errorStops: 3, toolCalls: 2 } });
		expect(renderMarkdown([errored], "t")).toContain("3 turns ended in a provider error");
	});

	it("shows how often trimmed outputs were read back", () => {
		const trimmed = (config: string, trimmedOutputs: number, trimmedRereads: number) =>
			run("a", config, true, { metrics: { ...computeTraceMetrics([]), trimmedOutputs, trimmedRereads } });
		const markdown = renderMarkdown([trimmed("all-off", 0, 0), trimmed("trimmer", 8, 2)], "t");
		expect(markdown).toContain("## Trimmed outputs");
		expect(markdown).toContain("| trimmer | 8 | 2 (25%) |");
		expect(markdown).not.toContain("| all-off | 0 |");
		expect(renderMarkdown([trimmed("all-off", 0, 0)], "t")).not.toContain("## Trimmed outputs");
	});

	it("shows background sidecar work that was finished or cut off when the session ended (E2)", () => {
		const ended = (taskId: string, config: string, finished: number, cutOff: number, extra: Partial<RunRecord> = {}) =>
			run(taskId, config, true, {
				metrics: { ...computeTraceMetrics([]), backgroundFinishedAtShutdown: finished, backgroundCutOff: cutOff },
				...extra,
			});
		const markdown = renderMarkdown(
			[
				ended("a", "all-off", 0, 0, { closeMs: 40 }),
				ended("a", "memory", 2, 0, { closeMs: 1_900 }),
				ended("b", "memory", 1, 3, { closeMs: 30_100 }),
				ended("c", "memory", 0, 0, { closeMs: 35_000, killedAtClose: true }),
			],
			"t",
		);
		expect(markdown).toContain("## Background work at session end");
		// config | finished while pi waited | cut off | runs with a call cut off | pi killed at close | median close
		expect(markdown).toContain("| memory | 3 | 3 | 1 | 1 | 30.1s |");
		expect(markdown).not.toContain("| all-off | 0 | 0 |");
		expect(markdown).toContain("a card whose lesson was cut off");
		// Nothing in the background anywhere: no section.
		expect(renderMarkdown([ended("a", "all-off", 0, 0)], "t")).not.toContain("## Background work");
		// A record from before the metric existed is not a run with nothing cut off, but it is not shown either.
		expect(renderMarkdown([run("a", "old", true, { metrics: computeTraceMetrics([]) })], "t")).not.toContain(
			"## Background work",
		);
	});
});
