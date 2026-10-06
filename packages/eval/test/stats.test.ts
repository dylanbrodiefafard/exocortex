import { describe, expect, it } from "vitest";
import { computeTraceMetrics } from "../src/metrics.ts";
import { mulberry32 } from "../src/random.ts";
import type { RunRecord } from "../src/records.ts";
import {
	detectableDifference,
	holm,
	meanOf,
	pairedDifference,
	pairedRatio,
	pairRuns,
	signFlip,
	studentTQuantile,
	wilson,
} from "../src/stats.ts";

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

const successOf = (runs: readonly RunRecord[]) => runs.filter((r) => r.success).length / runs.length;

/** Standard normal draws (Box–Muller) from a seeded uniform generator. */
function normalFrom(random: () => number): () => number {
	return () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
}

/** The percentile bootstrap the report used before D-079, kept here to show what it got wrong. */
function percentileBootstrap(values: readonly number[], random: () => number): [number, number] {
	const resamples = 2_000;
	const means: number[] = [];
	for (let i = 0; i < resamples; i++) {
		let total = 0;
		for (let j = 0; j < values.length; j++) total += values[Math.floor(random() * values.length)] ?? 0;
		means.push(total / values.length);
	}
	means.sort((a, b) => a - b);
	return [means[Math.floor(resamples * 0.025)] ?? 0, means[Math.ceil(resamples * 0.975) - 1] ?? 0];
}

/** Per-task success-rate differences when the two configs are the same: each task has its own pass rate. */
function nullDeltas(tasks: number, repeats: number, random: () => number): number[] {
	const passes = (p: number) => {
		let k = 0;
		for (let i = 0; i < repeats; i++) if (random() < p) k += 1;
		return k;
	};
	return Array.from({ length: tasks }, () => {
		const p = 0.15 + 0.7 * random();
		return (passes(p) - passes(p)) / repeats;
	});
}

const excludesZero = (ci: readonly [number, number] | null) => ci !== null && (ci[0] > 1e-12 || ci[1] < -1e-12);

describe("studentTQuantile", () => {
	it("matches the printed t table", () => {
		expect(studentTQuantile(0.975, 1)).toBeCloseTo(12.706, 2);
		expect(studentTQuantile(0.975, 2)).toBeCloseTo(4.303, 3);
		expect(studentTQuantile(0.975, 5)).toBeCloseTo(2.571, 3);
		expect(studentTQuantile(0.975, 10)).toBeCloseTo(2.228, 3);
		expect(studentTQuantile(0.975, 29)).toBeCloseTo(2.045, 3);
		expect(studentTQuantile(0.8, 5)).toBeCloseTo(0.92, 3);
		expect(studentTQuantile(0.8, 11)).toBeCloseTo(0.876, 3);
		expect(studentTQuantile(0.975, 1000)).toBeCloseTo(1.962, 3);
	});
});

describe("signFlip", () => {
	it("matches p-values worked out by hand", () => {
		// ±1 ±2 ±3: only +6 and −6 are as extreme as the observed 6, out of 8.
		expect(signFlip([1, 2, 3]).p).toBeCloseTo(2 / 8);
		// ±3 ±1 ±2 against the observed 4: {4, 6, −4, −6} of 8.
		expect(signFlip([3, -1, 2]).p).toBeCloseTo(4 / 8);
		// Five wins and no loss: the sign test's 2 / 32.
		expect(signFlip([1, 1, 1, 1, 1]).p).toBeCloseTo(0.0625);
		expect(signFlip([0.5, -0.5]).p).toBe(1);
		expect(signFlip([0, 0, 0, 0, 0, 0, 0])).toEqual({ p: 1, ci: [0, 0] });
		expect(signFlip([])).toEqual({ p: 1, ci: null });
	});

	it("gives no interval below six tasks, where none exists at 95%", () => {
		for (const deltas of [[1], [1, 2], [1, 2, 3, 4, 5]]) expect(signFlip(deltas).ci).toBeNull();
		// The smallest p five tasks can reach is 2 / 32, above 0.05.
		expect(signFlip([9, 9, 9, 9, 9]).p).toBeGreaterThan(0.05);
	});

	it("gives the interval of subset means worked out by hand", () => {
		// Six tasks: 64 sign assignments, k = floor(0.025 × 64) = 1, so the extremes of the subset
		// means, which are the smallest and largest difference.
		expect(signFlip([1, 2, 3, 4, 5, 6])).toEqual({ p: 2 / 64, ci: [1, 6] });
		// Seven tasks: k = 3. The three smallest subset means of 1..7 are 1, 1.5 ({1,2}) and 2.
		expect(signFlip([1, 2, 3, 4, 5, 6, 7])).toEqual({ p: 2 / 128, ci: [2, 6] });
	});

	it("rejects exactly when the interval leaves zero out", () => {
		const random = mulberry32(3);
		const normal = normalFrom(random);
		for (let i = 0; i < 300; i++) {
			const n = 6 + (i % 6);
			const deltas = Array.from({ length: n }, () => 0.6 + normal());
			const { p, ci } = signFlip(deltas);
			expect(p <= 0.05).toBe(excludesZero(ci));
		}
	});

	it("is not thrown by sums that differ only in the last bits", () => {
		// 0.1 + 0.2 − 0.3 is not zero in floating point; the tie must still count as a tie.
		expect(signFlip([0.1, 0.2, -0.3]).p).toBe(1);
		expect(signFlip([1 / 3, 1 / 3, -2 / 3, 0, 0, 0]).ci).toEqual([-2 / 3, 1 / 3]);
	});

	it("is reproducible for a seed above the exact limit, and seeds agree closely", () => {
		const random = mulberry32(11);
		const deltas = Array.from({ length: 24 }, () => 0.3 + normalFrom(random)());
		const a = signFlip(deltas, 7);
		expect(signFlip(deltas, 7)).toEqual(a);
		const b = signFlip(deltas, 8);
		expect(b.ci?.[0]).toBeCloseTo(a.ci?.[0] ?? 0, 1);
		expect(b.ci?.[1]).toBeCloseTo(a.ci?.[1] ?? 0, 1);
		expect(Math.abs(a.p - b.p)).toBeLessThan(0.01);
	});

	// One test per design, each with its own clock. As one test the five took 10 s on an idle
	// machine and over 60 s on a busy one, nearly all of it in the two designs above the exact
	// limit: each of their simulations draws and sorts 49,999 sign assignments, which is the
	// procedure under test and cannot be made smaller without testing something else.
	it.each([
		[6, 3, 2_000],
		[8, 3, 2_000],
		[12, 5, 2_000],
		[20, 3, 300],
		[28, 5, 300],
	] as const)(
		"keeps its false-positive rate at or under 5% when the configs do not differ: %i tasks × %i repeats",
		{ timeout: 180_000 },
		(tasks, repeats, simulations) => {
			const random = mulberry32(42 + tasks);
			let rejected = 0;
			for (let s = 0; s < simulations; s++) {
				if (excludesZero(signFlip(nullDeltas(tasks, repeats, random), s + 1).ci)) rejected += 1;
			}
			// Three standard errors of slack over the nominal 5%.
			const slack = 3 * Math.sqrt((0.05 * 0.95) / simulations);
			expect(rejected / simulations).toBeLessThanOrEqual(0.05 + slack);
		},
	);

	it("is where the old percentile bootstrap went wrong: twice the stated error rate at six tasks", {
		timeout: 60_000,
	}, () => {
		const random = mulberry32(42);
		let rejected = 0;
		const simulations = 1_500;
		for (let s = 0; s < simulations; s++) {
			if (excludesZero(percentileBootstrap(nullDeltas(6, 3, random), random))) rejected += 1;
		}
		expect(rejected / simulations).toBeGreaterThan(0.09);
	});

	it("covers a true effect about as often as it says, not far more", { timeout: 60_000 }, () => {
		const random = mulberry32(5);
		const normal = normalFrom(random);
		const simulations = 3_000;
		let covered = 0;
		for (let s = 0; s < simulations; s++) {
			const ci = signFlip(Array.from({ length: 8 }, () => 0.3 + normal())).ci;
			if (ci && ci[0] <= 0.3 && ci[1] >= 0.3) covered += 1;
		}
		// Exact coverage at eight tasks is 1 − 12/256 = 95.3%.
		expect(covered / simulations).toBeGreaterThan(0.94);
		expect(covered / simulations).toBeLessThan(0.97);
	});
});

describe("detectableDifference", () => {
	it("is (t(0.975) + t(0.80)) × sd / √tasks", () => {
		// 12 tasks, 11 df: (2.201 + 0.876) / √12 = 0.888.
		expect(detectableDifference(1, 12)).toBeCloseTo(0.888, 3);
		expect(detectableDifference(0.25, 12)).toBeCloseTo(0.222, 3);
		// 28 tasks, 27 df: (2.052 + 0.855) / √28 = 0.549.
		expect(detectableDifference(1, 28)).toBeCloseTo(0.549, 3);
	});

	it("uses the all-same-sign rule at six tasks and says nothing below that or without spread", () => {
		// Φ(1.793)^6 = 0.8.
		expect(detectableDifference(1, 6)).toBeCloseTo(1.793, 3);
		expect(detectableDifference(1, 5)).toBeNull();
		expect(detectableDifference(0, 12)).toBeNull();
	});

	it("is detected about 80% of the time by the test it describes", { timeout: 60_000 }, () => {
		const random = mulberry32(9);
		const normal = normalFrom(random);
		for (const tasks of [6, 8, 12]) {
			const effect = detectableDifference(1, tasks) ?? 0;
			const simulations = 2_000;
			let detected = 0;
			for (let s = 0; s < simulations; s++) {
				if (signFlip(Array.from({ length: tasks }, () => effect + normal())).p <= 0.05) detected += 1;
			}
			expect(detected / simulations, `${tasks} tasks`).toBeGreaterThan(0.74);
			expect(detected / simulations, `${tasks} tasks`).toBeLessThan(0.86);
		}
	});
});

describe("holm", () => {
	it("steps down from the smallest p-value and never lets a later one fall below an earlier", () => {
		// Sorted 0.01, 0.03, 0.04 → 3 × 0.01, 2 × 0.03, max(0.06, 1 × 0.04).
		const adjusted = holm([0.01, 0.04, 0.03]);
		expect(adjusted[0]).toBeCloseTo(0.03);
		expect(adjusted[1]).toBeCloseTo(0.06);
		expect(adjusted[2]).toBeCloseTo(0.06);
		expect(holm([0.5, 0.6])).toEqual([1, 1]);
		expect(holm([0.04])).toEqual([0.04]);
		expect(holm([])).toEqual([]);
	});
});

describe("wilson", () => {
	it("matches the textbook interval", () => {
		const [low, high] = wilson(8, 10) ?? [0, 0];
		expect(low).toBeCloseTo(0.4902, 3);
		expect(high).toBeCloseTo(0.9433, 3);
		// Never degenerate at 0/n or n/n, unlike a normal-approximation interval.
		expect(wilson(5, 5)?.[0]).toBeCloseTo(0.5655, 3);
		expect(wilson(5, 5)?.[1]).toBe(1);
		expect(wilson(0, 0)).toBeNull();
	});
});

describe("pairRuns", () => {
	it("drops a (task, repeat) block from both configs when either run was invalid", () => {
		const records = [
			run("a", "off", true, { repeat: 1 }),
			run("a", "on", false, { repeat: 1 }),
			// Repeat 2 crashed under `on`: the baseline's pass in that block must not count either.
			run("a", "off", true, { repeat: 2 }),
			run("a", "on", false, { repeat: 2, outcome: "crashed" }),
			run("a", "off", false, { repeat: 3 }),
			run("a", "on", true, { repeat: 3 }),
			// Only one config ran this block: not a pair, and not a dropped one.
			run("b", "off", true, { repeat: 1 }),
			run("c", "other", true, { repeat: 1 }),
		];
		const pairing = pairRuns(records, "off", "on");
		expect(pairing.droppedBlocks).toBe(1);
		expect(pairing.tasks).toHaveLength(1);
		expect(pairing.tasks[0]?.baseline.map((r) => r.repeat)).toEqual([1, 3]);
		expect(pairing.tasks[0]?.treatment.map((r) => r.repeat)).toEqual([1, 3]);
		// Without the block rule the baseline would read 2/3 against 1/2; with it both are 1/2.
		expect(pairedDifference(records, "off", "on", successOf)).toMatchObject({ tasks: 1, mean: 0, droppedBlocks: 1 });
	});

	it("treats a provider error before any tool call as invalid, and a later one as a failure", () => {
		const errored = (toolCalls: number) => ({ ...computeTraceMetrics([]), toolCalls, lastStopReason: "error" });
		const records = [
			run("a", "off", true),
			run("a", "on", false, { metrics: errored(0) }),
			run("b", "off", true),
			run("b", "on", false, { metrics: errored(4) }),
		];
		expect(pairRuns(records, "off", "on")).toMatchObject({ droppedBlocks: 1, tasks: [{ task: "b" }] });
	});
});

describe("pairedDifference", () => {
	const records = [
		// task a: 1/2 → 2/2 (win); task b: 0/1 → 0/1 (tie); task c: 1/1 → 0/1 (loss); task d only in baseline
		run("a", "off", true),
		run("a", "off", false),
		run("a", "on", true),
		run("a", "on", true),
		run("b", "off", false),
		run("b", "on", false),
		run("c", "off", true),
		run("c", "on", false),
		run("d", "off", true),
	];

	it("compares per-task values on shared tasks only", () => {
		const c = pairedDifference(records, "off", "on", successOf);
		expect(c).toMatchObject({ tasks: 3, wins: 1, losses: 1, ties: 1, droppedTasks: 0, droppedBlocks: 0 });
		expect(c?.mean).toBeCloseTo((0.5 + 0 - 1) / 3);
		// ±0.5 ± 0 ± 1 against −0.5: every assignment but the two ±1.5 ones is as extreme.
		expect(c?.p).toBe(1);
		expect(c?.ci).toBeNull();
		expect(c?.detectable).toBeNull();
	});

	it("is null for configs with nothing in common, and leaves out tasks without a value", () => {
		expect(pairedDifference([run("a", "off", true), run("b", "on", true)], "off", "on", successOf)).toBeNull();
		const turns = meanOf((r) => r.metrics?.turns ?? null);
		const withTurns = (taskId: string, config: string, value: number) =>
			run(taskId, config, true, { metrics: { ...computeTraceMetrics([]), turns: value } });
		const c = pairedDifference(
			[withTurns("a", "off", 10), withTurns("a", "on", 8), run("b", "off", true), withTurns("b", "on", 5)],
			"off",
			"on",
			turns,
		);
		expect(c).toMatchObject({ tasks: 1, mean: -2, droppedTasks: 1 });
	});

	it("gives an interval and a detectable size from six tasks on", () => {
		// Six tasks, differences 1, 1, 1, 1, 0, 0 in success rate.
		const records6 = ["a", "b", "c", "d", "e", "f"].flatMap((task, i) => [
			run(task, "off", i >= 4),
			run(task, "on", true),
		]);
		const c = pairedDifference(records6, "off", "on", successOf);
		expect(c).toMatchObject({ tasks: 6, wins: 4, losses: 0, ties: 2 });
		expect(c?.mean).toBeCloseTo(4 / 6);
		expect(c?.ci).toEqual([0, 1]);
		// One-sided: 1 + (subsets of the two zeros, 3 of them, with mean ≤ 0) of 64; doubled.
		expect(c?.p).toBeCloseTo((2 * 4) / 64);
		// sd of (1,1,1,1,0,0) is 0.5164; 1.793 × sd.
		expect(c?.detectable).toBeCloseTo(0.926, 3);
	});
});

describe("pairedRatio", () => {
	const tokens = meanOf((r) => r.metrics?.inputTokens ?? null);
	const spent = (taskId: string, config: string, inputTokens: number) =>
		run(taskId, config, true, { metrics: { ...computeTraceMetrics([]), inputTokens } });

	it("is the geometric mean of the per-task ratios, and counts the tasks it could not use", () => {
		const change = pairedRatio(
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
		// a: 200 → 220 (×1.1), b: ×1.3; c has a zero baseline and d no baseline data.
		expect(change).toMatchObject({ tasks: 2, droppedTasks: 2, ci: null, detectable: null });
		expect(change?.change).toBeCloseTo(Math.sqrt(1.1 * 1.3) - 1);
	});

	it("reads halving on one task and doubling on another as no change", () => {
		const records = [spent("a", "off", 100), spent("a", "on", 50), spent("b", "off", 100), spent("b", "on", 200)];
		expect(pairedRatio(records, "off", "on", tokens)?.change).toBeCloseTo(0);
		// The mean of the plain ratios, which the report used before, reads the same data as +25%.
		expect((0.5 - 1 + (2 - 1)) / 2).toBe(0.25);
	});

	it("is null without shared tasks", () => {
		expect(pairedRatio([spent("a", "off", 100)], "off", "on", tokens)).toBeNull();
		expect(pairedRatio([spent("a", "off", 0), spent("a", "on", 5)], "off", "on", tokens)).toBeNull();
	});

	it("is centred on no change when the configs do not differ, where a mean of ratios is not", () => {
		const random = mulberry32(21);
		const normal = normalFrom(random);
		const simulations = 400;
		let logScale = 0;
		let meanOfRatios = 0;
		let rejected = 0;
		for (let s = 0; s < simulations; s++) {
			const records = Array.from({ length: 10 }, (_, task) => [
				spent(`t${task}`, "off", 1_000 * Math.exp(0.5 * normal())),
				spent(`t${task}`, "on", 1_000 * Math.exp(0.5 * normal())),
			]).flat();
			const ratio = pairedRatio(records, "off", "on", tokens);
			logScale += Math.log1p(ratio?.change ?? 0) / simulations;
			if (excludesZero(ratio?.ci ?? null)) rejected += 1;
			const pairs = Array.from({ length: 10 }, (_, task) => records.filter((r) => r.taskId === `t${task}`));
			meanOfRatios +=
				pairs.reduce((sum, [b, t]) => sum + (tokens(t ? [t] : []) ?? 0) / (tokens(b ? [b] : []) ?? 1) - 1, 0) /
				10 /
				simulations;
		}
		expect(Math.abs(logScale)).toBeLessThan(0.04);
		expect(meanOfRatios).toBeGreaterThan(0.15);
		expect(rejected / simulations).toBeLessThanOrEqual(0.05 + 3 * Math.sqrt((0.05 * 0.95) / simulations));
	});

	it("gives an interval in the same units from six tasks on", () => {
		// Every task spends 20% less: the interval is the point.
		const records = ["a", "b", "c", "d", "e", "f"].flatMap((task, i) => [
			spent(task, "off", 1_000 * (i + 1)),
			spent(task, "on", 800 * (i + 1)),
		]);
		const ratio = pairedRatio(records, "off", "on", tokens);
		expect(ratio?.change).toBeCloseTo(-0.2);
		expect(ratio?.ci?.[0]).toBeCloseTo(-0.2);
		expect(ratio?.ci?.[1]).toBeCloseTo(-0.2);
		expect(ratio?.p).toBeCloseTo(2 / 64);
	});
});
