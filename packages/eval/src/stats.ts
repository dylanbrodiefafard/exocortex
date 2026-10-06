import { mulberry32 } from "./random.ts";
import { invalidReason, type RunRecord } from "./records.ts";

/**
 * Statistics for a paired A/B over tasks (research R7.1, D-079). The task is the unit: most
 * variance is between tasks, and repeats of one task are not independent evidence. Every interval
 * and p-value here comes from one procedure, the sign-flip (paired permutation) test on the mean
 * of the per-task differences, which is exact for any number of tasks and any distribution that is
 * symmetric under swapping the two configs.
 */

const ALPHA = 0.05;
const POWER = 0.8;
/** Up to this many tasks all 2^n sign assignments are enumerated; above it they are sampled. */
const EXACT_MAX_TASKS = 16;
const MONTE_CARLO_DRAWS = 49_999;
/**
 * Below this many tasks no two-sided 95% interval exists: the smallest p-value n tasks can give
 * is 2 / 2^n, which is above 0.05 until n = 6.
 */
export const MIN_TASKS_FOR_INTERVAL = 6;

export interface SignFlip {
	/** Two-sided p-value for "the mean difference is zero". Never below 2 / 2^n. */
	readonly p: number;
	/** The differences the test does not reject at 5%; null below {@link MIN_TASKS_FOR_INTERVAL} tasks. */
	readonly ci: readonly [number, number] | null;
}

/**
 * Sign-flip test on the mean of paired differences, and the interval from inverting it.
 *
 * Under the null, each task's difference is as likely to be `+d` as `-d`. Flipping the signs in
 * the set S changes the sum by `-2 * sum(S)`, so the flipped sum reaches the observed one exactly
 * when the mean of S is at or below zero, and for a shifted null `theta`, at or below `theta`.
 * The p-value and the interval are therefore both read off the sorted means of the non-empty
 * subsets (Hartigan's typical values): with N of them, `[M(k), M(N + 1 - k)]` covers the true mean
 * with probability at least `1 - 2k / (N + 1)`.
 *
 * `seed` matters only above {@link EXACT_MAX_TASKS} tasks, where subsets are sampled.
 */
export function signFlip(deltas: readonly number[], seed = 1): SignFlip {
	if (deltas.length === 0) return { p: 1, ci: null };
	const means = subsetMeans(deltas, seed);
	const total = means.length + 1;
	const eps = tolerance(deltas);
	let atOrBelow = 0;
	let atOrAbove = 0;
	for (const m of means) {
		if (m <= eps) atOrBelow += 1;
		if (m >= -eps) atOrAbove += 1;
	}
	const k = Math.floor((ALPHA / 2) * total);
	return {
		p: Math.min(1, (2 * (1 + Math.min(atOrBelow, atOrAbove))) / total),
		ci: k >= 1 ? [means[k - 1] as number, means[means.length - k] as number] : null,
	};
}

/** Sorted means of every non-empty subset of `deltas` (exact), or of sampled ones. */
function subsetMeans(deltas: readonly number[], seed: number): Float64Array {
	const n = deltas.length;
	if (n <= EXACT_MAX_TASKS) {
		const size = 2 ** n;
		const sums = new Float64Array(size);
		const counts = new Uint8Array(size);
		const means = new Float64Array(size - 1);
		for (let mask = 1; mask < size; mask++) {
			const low = mask & -mask;
			const rest = mask ^ low;
			sums[mask] = (sums[rest] as number) + (deltas[31 - Math.clz32(low)] as number);
			counts[mask] = (counts[rest] as number) + 1;
			means[mask - 1] = (sums[mask] as number) / (counts[mask] as number);
		}
		return means.sort();
	}
	const random = mulberry32(seed);
	const means = new Float64Array(MONTE_CARLO_DRAWS);
	let drawn = 0;
	while (drawn < MONTE_CARLO_DRAWS) {
		let sum = 0;
		let count = 0;
		let bits = 0;
		for (let i = 0; i < n; i++) {
			if (i % 32 === 0) bits = Math.floor(random() * 4_294_967_296);
			if ((bits >>> (i % 32)) & 1) {
				sum += deltas[i] as number;
				count += 1;
			}
		}
		// The empty subset is the observed assignment itself, which the `1 +` in the p-value counts.
		if (count === 0) continue;
		means[drawn] = sum / count;
		drawn += 1;
	}
	return means.sort();
}

/** Sums of the same numbers in another order differ in the last bits: compare with this slack. */
function tolerance(values: readonly number[]): number {
	return 1e-9 * Math.max(1, ...values.map((v) => Math.abs(v)));
}

/**
 * Smallest true mean difference a paired comparison over `tasks` tasks would detect 80% of the
 * time at two-sided α = 0.05, when the per-task differences have standard deviation `sd`:
 * `(t(0.975) + t(0.80)) * sd / sqrt(tasks)` with `tasks - 1` degrees of freedom, which simulation
 * puts within 5% of the sign-flip test's real 80% point from seven tasks up, for roughly normal
 * differences. Null when nothing can be detected (too few tasks) or `sd` gives no estimate (zero:
 * every task moved alike).
 */
export function detectableDifference(sd: number, tasks: number): number | null {
	if (tasks < MIN_TASKS_FOR_INTERVAL || !(sd > 0)) return null;
	// At six tasks the test rejects only when all six differences share a sign, which the t formula
	// overstates by a quarter: 80% power needs Φ(mean / sd)^6 = 0.8, so mean = 1.793 sd.
	if (tasks === MIN_TASKS_FOR_INTERVAL) return 1.793 * sd;
	const df = tasks - 1;
	return ((studentTQuantile(1 - ALPHA / 2, df) + studentTQuantile(POWER, df)) * sd) / Math.sqrt(tasks);
}

/** Holm's step-down adjustment: controls the chance of any false positive across `pValues`. */
export function holm(pValues: readonly number[]): number[] {
	const order = pValues.map((p, index) => ({ p, index })).sort((a, b) => a.p - b.p);
	const adjusted = new Array<number>(pValues.length).fill(1);
	let running = 0;
	for (const [rank, { p, index }] of order.entries()) {
		running = Math.max(running, Math.min(1, (pValues.length - rank) * p));
		adjusted[index] = running;
	}
	return adjusted;
}

/** Wilson score interval (95%) for `successes` out of `n` independent trials; null when n = 0. */
export function wilson(successes: number, n: number): readonly [number, number] | null {
	if (n <= 0) return null;
	const z = 1.959964;
	const p = successes / n;
	const denominator = 1 + (z * z) / n;
	const centre = (p + (z * z) / (2 * n)) / denominator;
	const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
	return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** One task's valid runs under each config. */
interface TaskRuns {
	readonly task: string;
	readonly baseline: readonly RunRecord[];
	readonly treatment: readonly RunRecord[];
}

export interface Pairing {
	readonly tasks: readonly TaskRuns[];
	/** (task, repeat) blocks left out of both configs because a run in one of them was invalid. */
	readonly droppedBlocks: number;
}

/**
 * Pairs two configs' runs by (task, repeat) block. A block counts only when both configs ran it
 * and neither run was invalid (D-079): dropping just the broken run would leave the task's two
 * means over different repeats.
 */
export function pairRuns(records: readonly RunRecord[], baseline: string, treatment: string): Pairing {
	const blocks = new Map<string, { task: string; baseline: RunRecord[]; treatment: RunRecord[] }>();
	for (const r of records) {
		if (r.config !== baseline && r.config !== treatment) continue;
		const key = `${r.taskId}\u0000${r.repeat}`;
		const block = blocks.get(key) ?? { task: r.taskId, baseline: [], treatment: [] };
		blocks.set(key, block);
		// A config compared with itself has every run on both sides.
		if (r.config === baseline) block.baseline.push(r);
		if (r.config === treatment) block.treatment.push(r);
	}
	const tasks = new Map<string, { task: string; baseline: RunRecord[]; treatment: RunRecord[] }>();
	let droppedBlocks = 0;
	for (const block of blocks.values()) {
		if (block.baseline.length === 0 || block.treatment.length === 0) continue;
		if ([...block.baseline, ...block.treatment].some((r) => invalidReason(r) !== null)) {
			droppedBlocks += 1;
			continue;
		}
		const task = tasks.get(block.task) ?? { task: block.task, baseline: [], treatment: [] };
		tasks.set(block.task, task);
		task.baseline.push(...block.baseline);
		task.treatment.push(...block.treatment);
	}
	return { tasks: [...tasks.values()], droppedBlocks };
}

/** Reduces one task's runs under one config to a number; null when the runs carry no value. */
export type TaskValue = (runs: readonly RunRecord[]) => number | null;

interface PairedEstimate {
	/** Tasks with a value under both configs. */
	readonly tasks: number;
	/** Paired tasks left out because one side had no usable value. */
	readonly droppedTasks: number;
	readonly droppedBlocks: number;
	/** 95% interval from the sign-flip test; null below {@link MIN_TASKS_FOR_INTERVAL} tasks. */
	readonly ci: readonly [number, number] | null;
	/** Two-sided sign-flip p-value. */
	readonly p: number;
	/** Smallest true effect these tasks would detect (α = 0.05, 80% power); null when not estimable. */
	readonly detectable: number | null;
}

export interface PairedDifference extends PairedEstimate {
	/** Mean over tasks of (treatment − baseline). */
	readonly mean: number;
	readonly wins: number;
	readonly losses: number;
	readonly ties: number;
}

/** Mean per-task difference of `value` between two configs. Null when no task has both values. */
export function pairedDifference(
	records: readonly RunRecord[],
	baseline: string,
	treatment: string,
	value: TaskValue,
	seed = 1,
): PairedDifference | null {
	const pairing = pairRuns(records, baseline, treatment);
	const deltas = pairing.tasks.flatMap((t) => {
		const b = value(t.baseline);
		const v = value(t.treatment);
		return b === null || v === null ? [] : [v - b];
	});
	if (deltas.length === 0) return null;
	const eps = tolerance(deltas);
	const wins = deltas.filter((d) => d > eps).length;
	const losses = deltas.filter((d) => d < -eps).length;
	return {
		tasks: deltas.length,
		droppedTasks: pairing.tasks.length - deltas.length,
		droppedBlocks: pairing.droppedBlocks,
		mean: mean(deltas),
		...signFlip(deltas, seed),
		detectable: detectableDifference(standardDeviation(deltas), deltas.length),
		wins,
		losses,
		ties: deltas.length - wins - losses,
	};
}

export interface PairedRatio extends PairedEstimate {
	/**
	 * Geometric mean over tasks of treatment / baseline, minus 1: -0.12 reads "12% less on a typical
	 * task". Unlike a mean of ratios it is zero on average when the configs do not differ.
	 */
	readonly change: number;
}

/**
 * Relative change of a positive quantity (tokens, turns, seconds), from the mean of the per-task
 * log ratios. A mean of plain ratios is biased upward (halving and doubling average to +25%), and
 * its sign-flip null does not hold; the log ratio is symmetric, so the same exact test applies.
 * Tasks where either side is zero have no ratio and are counted in `droppedTasks`.
 */
export function pairedRatio(
	records: readonly RunRecord[],
	baseline: string,
	treatment: string,
	value: TaskValue,
	seed = 1,
): PairedRatio | null {
	const pairing = pairRuns(records, baseline, treatment);
	const logs = pairing.tasks.flatMap((t) => {
		const b = value(t.baseline);
		const v = value(t.treatment);
		return b === null || v === null || !(b > 0) || !(v > 0) ? [] : [Math.log(v / b)];
	});
	if (logs.length === 0) return null;
	const test = signFlip(logs, seed);
	const detectable = detectableDifference(standardDeviation(logs), logs.length);
	return {
		tasks: logs.length,
		droppedTasks: pairing.tasks.length - logs.length,
		droppedBlocks: pairing.droppedBlocks,
		change: Math.expm1(mean(logs)),
		ci: test.ci && [Math.expm1(test.ci[0]), Math.expm1(test.ci[1])],
		p: test.p,
		detectable: detectable === null ? null : Math.expm1(detectable),
	};
}

/** A task's mean of a per-run number over the runs that have one. */
export function meanOf(measure: (record: RunRecord) => number | null): TaskValue {
	return (runs) => {
		const values = runs.flatMap((r) => {
			const value = measure(r);
			return value === null ? [] : [value];
		});
		return values.length > 0 ? mean(values) : null;
	};
}

function mean(values: readonly number[]): number {
	return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Sample standard deviation (n − 1); 0 for fewer than two values. */
function standardDeviation(values: readonly number[]): number {
	if (values.length < 2) return 0;
	const average = mean(values);
	return Math.sqrt(values.reduce((sum, v) => sum + (v - average) ** 2, 0) / (values.length - 1));
}

/** Quantile of Student's t for `p` in (0.5, 1), by bisection on the CDF. */
export function studentTQuantile(p: number, df: number): number {
	let low = 0;
	let high = 1;
	while (studentTCdf(high, df) < p) high *= 2;
	for (let i = 0; i < 80; i++) {
		const mid = (low + high) / 2;
		if (studentTCdf(mid, df) < p) low = mid;
		else high = mid;
	}
	return (low + high) / 2;
}

/** P(T ≤ t) for t ≥ 0, through the regularized incomplete beta function. */
function studentTCdf(t: number, df: number): number {
	return 1 - 0.5 * incompleteBeta(df / (df + t * t), df / 2, 0.5);
}

/** Regularized incomplete beta I_x(a, b) for 0 < x ≤ 1, by its continued fraction. */
function incompleteBeta(x: number, a: number, b: number): number {
	if (x >= 1) return 1;
	const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
	return x < (a + 1) / (a + b + 2) ? (front * betaFraction(x, a, b)) / a : 1 - (front * betaFraction(1 - x, b, a)) / b;
}

/** Modified Lentz evaluation of the incomplete beta continued fraction. */
function betaFraction(x: number, a: number, b: number): number {
	const tiny = 1e-300;
	const guard = (v: number) => (Math.abs(v) < tiny ? tiny : v);
	let c = 1;
	let d = 1 / guard(1 - ((a + b) * x) / (a + 1));
	let h = d;
	for (let m = 1; m <= 300; m++) {
		const even = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
		d = 1 / guard(1 + even * d);
		c = guard(1 + even / c);
		h *= d * c;
		const odd = (-(a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
		d = 1 / guard(1 + odd * d);
		c = guard(1 + odd / c);
		h *= d * c;
		if (Math.abs(d * c - 1) < 1e-14) break;
	}
	return h;
}

const LANCZOS = [
	0.999_999_999_999_809_9, 676.520_368_121_885_1, -1_259.139_216_722_402_8, 771.323_428_777_653_1,
	-176.615_029_162_140_6, 12.507_343_278_686_905, -0.138_571_095_265_720_12, 9.984_369_578_019_572e-6,
	1.505_632_735_149_311_6e-7,
];

/** ln Γ(z) for z ≥ 0.5 (Lanczos, g = 7). */
function lnGamma(z: number): number {
	const x = z - 1;
	let series = LANCZOS[0] as number;
	for (let i = 1; i < LANCZOS.length; i++) series += (LANCZOS[i] as number) / (x + i);
	const t = x + 7.5;
	return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(series);
}
