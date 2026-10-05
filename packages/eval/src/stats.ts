import type { RunRecord } from "./run.ts";

/** z(0.975) + z(0.80): two-sided α = 0.05 at 80% power. */
const Z_SUM = 1.96 + 0.84;
const BOOTSTRAP_RESAMPLES = 2_000;

/** One task's numbers under one config, averaged over its repeats. */
interface TaskMeans {
	readonly successRate: number;
	readonly turns: number | null;
	readonly inputTokens: number | null;
	readonly wallClockSec: number;
}

export interface PairedComparison {
	readonly baseline: string;
	readonly treatment: string;
	/** Tasks run under both configs. */
	readonly tasks: number;
	/** Mean over tasks of (treatment − baseline) success rate, in [-1, 1]. */
	readonly meanDelta: number;
	/** 95% task-cluster bootstrap interval for {@link meanDelta}. */
	readonly ci: readonly [number, number];
	readonly wins: number;
	readonly losses: number;
	readonly ties: number;
	/** Two-sided exact sign test over tasks that differ (ties dropped). */
	readonly signTestP: number;
	/** Mean relative change over tasks with data in both, e.g. -0.12 = 12% fewer. */
	readonly turnsChange: number | null;
	readonly inputTokensChange: number | null;
	readonly wallClockChange: number | null;
}

/**
 * Compares two configs task by task (research R7.1): tasks are the unit of analysis, since most
 * variance is between tasks and repeats of one task are not independent evidence.
 */
export function pairedComparison(
	records: readonly RunRecord[],
	baseline: string,
	treatment: string,
	seed = 1,
): PairedComparison {
	const base = taskMeans(records, baseline);
	const treat = taskMeans(records, treatment);
	const tasks = [...base.keys()].filter((t) => treat.has(t));
	const pairs = tasks.map((t) => ({ b: base.get(t) as TaskMeans, t: treat.get(t) as TaskMeans }));
	const deltas = pairs.map((p) => p.t.successRate - p.b.successRate);
	const wins = deltas.filter((d) => d > 0).length;
	const losses = deltas.filter((d) => d < 0).length;
	return {
		baseline,
		treatment,
		tasks: tasks.length,
		meanDelta: mean(deltas) ?? 0,
		ci: bootstrapCi(deltas, seed),
		wins,
		losses,
		ties: deltas.length - wins - losses,
		signTestP: signTest(wins, losses),
		turnsChange: relativeChange(pairs.map((p) => [p.b.turns, p.t.turns])),
		inputTokensChange: relativeChange(pairs.map((p) => [p.b.inputTokens, p.t.inputTokens])),
		wallClockChange: relativeChange(pairs.map((p) => [p.b.wallClockSec, p.t.wallClockSec])),
	};
}

export interface PairedChange {
	/** Tasks with a non-zero baseline value under both configs. */
	readonly tasks: number;
	/** Mean over tasks of (treatment − baseline) / baseline. */
	readonly mean: number;
	/** 95% task-cluster bootstrap interval for {@link mean}. */
	readonly ci: readonly [number, number];
	/**
	 * Smallest mean relative change this many tasks could detect, given how much the per-task
	 * changes vary (two-sided α = 0.05, 80% power). Null with fewer than 2 tasks.
	 */
	readonly detectable: number | null;
}

/**
 * Relative change of any per-run quantity, paired by task like {@link pairedComparison}: each
 * task's runs are averaged per config first. Null when no task has data under both configs.
 */
export function pairedRelativeChange(
	records: readonly RunRecord[],
	baseline: string,
	treatment: string,
	measure: (record: RunRecord) => number | null,
	seed = 1,
): PairedChange | null {
	const byTask = (config: string) => {
		const values = new Map<string, number[]>();
		for (const r of records) {
			const value = r.config === config ? measure(r) : null;
			if (value !== null) values.set(r.taskId, [...(values.get(r.taskId) ?? []), value]);
		}
		return values;
	};
	const base = byTask(baseline);
	const treat = byTask(treatment);
	const changes = [...base].flatMap(([task, values]) => {
		const b = mean(values);
		const t = mean(treat.get(task) ?? []);
		return b === null || t === null || b === 0 ? [] : [(t - b) / b];
	});
	const average = mean(changes);
	if (average === null) return null;
	const variance = changes.reduce((sum, c) => sum + (c - average) ** 2, 0) / Math.max(1, changes.length - 1);
	return {
		tasks: changes.length,
		mean: average,
		ci: bootstrapCi(changes, seed),
		detectable: changes.length < 2 ? null : Z_SUM * Math.sqrt(variance / changes.length),
	};
}

/**
 * Smallest success-rate difference detectable with `runsPerArm` independent runs per config at a
 * baseline rate `p` (two-sided α = 0.05, 80% power, normal approximation).
 */
export function minimumDetectableEffect(p: number, runsPerArm: number): number {
	if (runsPerArm <= 0) return 1;
	return Math.min(1, Z_SUM * Math.sqrt((2 * p * (1 - p)) / runsPerArm));
}

/** Two-sided exact binomial (p = 0.5) test of wins vs. losses. */
export function signTest(wins: number, losses: number): number {
	const n = wins + losses;
	if (n === 0) return 1;
	const k = Math.min(wins, losses);
	let tail = 0;
	for (let i = 0; i <= k; i++) tail += binomial(n, i);
	return Math.min(1, (2 * tail) / 2 ** n);
}

function taskMeans(records: readonly RunRecord[], config: string): Map<string, TaskMeans> {
	const byTask = new Map<string, RunRecord[]>();
	for (const r of records) {
		if (r.config === config) byTask.set(r.taskId, [...(byTask.get(r.taskId) ?? []), r]);
	}
	const out = new Map<string, TaskMeans>();
	for (const [task, runs] of byTask) {
		const metrics = runs.flatMap((r) => (r.metrics ? [r.metrics] : []));
		out.set(task, {
			successRate: runs.filter((r) => r.success).length / runs.length,
			turns: mean(metrics.map((m) => m.turns)),
			inputTokens: mean(metrics.map((m) => m.inputTokens)),
			wallClockSec: mean(runs.map((r) => r.wallClockMs / 1000)) ?? 0,
		});
	}
	return out;
}

/** Percentile bootstrap over tasks with a seeded generator, so reports are reproducible. */
function bootstrapCi(values: readonly number[], seed: number): readonly [number, number] {
	if (values.length === 0) return [0, 0];
	const random = mulberry32(seed);
	const means: number[] = [];
	for (let i = 0; i < BOOTSTRAP_RESAMPLES; i++) {
		let total = 0;
		for (let j = 0; j < values.length; j++) total += values[Math.floor(random() * values.length)] ?? 0;
		means.push(total / values.length);
	}
	means.sort((a, b) => a - b);
	return [means[Math.floor(BOOTSTRAP_RESAMPLES * 0.025)] ?? 0, means[Math.ceil(BOOTSTRAP_RESAMPLES * 0.975) - 1] ?? 0];
}

function relativeChange(pairs: readonly (readonly [number | null, number | null])[]): number | null {
	const changes = pairs.flatMap(([b, t]) => (b === null || t === null || b === 0 ? [] : [(t - b) / b]));
	return mean(changes);
}

function binomial(n: number, k: number): number {
	let result = 1;
	for (let i = 1; i <= k; i++) result = (result * (n - k + i)) / i;
	return result;
}

function mean(values: readonly number[]): number | null {
	return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}
