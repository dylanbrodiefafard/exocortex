import type { RunRecord } from "./run.ts";
import { minimumDetectableEffect, type PairedComparison, pairedComparison } from "./stats.ts";

export interface ConfigSummary {
	readonly config: string;
	readonly runs: number;
	readonly successes: number;
	readonly successRate: number;
	readonly meanTurns: number | null;
	readonly meanInputTokens: number | null;
	readonly meanCachedTokens: number | null;
	readonly meanOutputTokens: number | null;
	readonly cacheHitRate: number | null;
	readonly prefixKeptRate: number | null;
	readonly medianWallClockSec: number;
	readonly repeatedErrorRate: number | null;
	readonly injections: number;
	readonly continuations: number;
	readonly meanSidecarTokens: number | null;
	/** Supervisor verdict totals: complete / incomplete / failed / uncertain. */
	readonly verdicts: string;
	readonly sidecarFailures: number;
	readonly abnormal: number;
	/**
	 * Of runs whose last verdict was `complete`, the share whose hidden check passed: the costly
	 * supervisor error is a false "complete" (research §1c). Null without such runs.
	 */
	readonly completePrecision: number | null;
	/** Runs whose last verdict was `complete`. */
	readonly judgedComplete: number;
	/** Per-run mean of every token spent: main input, cached and output, plus sidecars (research R7.3). */
	readonly meanTotalTokens: number | null;
	/** Runs where the agent changed or deleted fixture tests (restored before the check). */
	readonly tampered: number;
	/** Passing runs with no verification after the last edit, or 3+ identical failed commands (R7.6). */
	readonly luckyPasses: number;
	/** Of failing runs with a last verdict, the share the supervisor did not call complete. */
	readonly failureRecall: number | null;
}

export function summarize(records: readonly RunRecord[]): ConfigSummary[] {
	const configs = [...new Set(records.map((r) => r.config))];
	return configs.map((config) => {
		const runs = records.filter((r) => r.config === config);
		const withMetrics = runs.flatMap((r) => (r.metrics ? [r.metrics] : []));
		const totalPrompt = sum(withMetrics.map((m) => m.inputTokens + m.cachedTokens));
		const totalErrors = sum(withMetrics.map((m) => m.toolErrors));
		const prefixRates = withMetrics.flatMap((m) => (m.prefixKeptRate === null ? [] : [m.prefixKeptRate]));
		const successes = runs.filter((r) => r.success).length;
		return {
			config,
			runs: runs.length,
			successes,
			successRate: runs.length > 0 ? successes / runs.length : 0,
			meanTurns: mean(withMetrics.map((m) => m.turns)),
			meanInputTokens: mean(withMetrics.map((m) => m.inputTokens)),
			meanCachedTokens: mean(withMetrics.map((m) => m.cachedTokens)),
			meanOutputTokens: mean(withMetrics.map((m) => m.outputTokens)),
			cacheHitRate: totalPrompt > 0 ? sum(withMetrics.map((m) => m.cachedTokens)) / totalPrompt : null,
			prefixKeptRate: mean(prefixRates),
			medianWallClockSec: median(runs.map((r) => r.wallClockMs / 1000)),
			repeatedErrorRate: totalErrors > 0 ? sum(withMetrics.map((m) => m.repeatedToolErrors)) / totalErrors : null,
			injections: sum(withMetrics.map((m) => m.injections)),
			continuations: sum(withMetrics.map((m) => m.continuations)),
			meanSidecarTokens: mean(withMetrics.map((m) => m.sidecarTokens)),
			verdicts: (["complete", "incomplete", "failed", "uncertain"] as const)
				.map((v) => sum(withMetrics.map((m) => m.verdicts[v])))
				.join("/"),
			sidecarFailures: sum(withMetrics.map((m) => m.sidecarFailures)),
			abnormal: runs.filter((r) => r.outcome !== "settled").length,
			meanTotalTokens: mean(withMetrics.map((m) => m.inputTokens + m.cachedTokens + m.outputTokens + m.sidecarTokens)),
			tampered: runs.filter((r) => (r.tamperedTests?.length ?? 0) > 0).length,
			luckyPasses: runs.filter(
				(r) =>
					r.success && r.metrics && (r.metrics.verifiedAfterLastEdit === false || r.metrics.maxRepeatedFailures >= 3),
			).length,
			...verdictQuality(runs),
		};
	});
}

function verdictQuality(runs: readonly RunRecord[]) {
	const judged = runs.filter((r) => r.metrics?.lastVerdict);
	const complete = judged.filter((r) => r.metrics?.lastVerdict === "complete");
	const failing = judged.filter((r) => !r.success);
	return {
		judgedComplete: complete.length,
		completePrecision: complete.length > 0 ? complete.filter((r) => r.success).length / complete.length : null,
		failureRecall:
			failing.length > 0 ? failing.filter((r) => r.metrics?.lastVerdict !== "complete").length / failing.length : null,
	};
}

/** Markdown report: one row per config, then a task × config pass matrix. */
export function renderMarkdown(records: readonly RunRecord[], title: string): string {
	const summaries = summarize(records);
	const lines = [
		`# ${title}`,
		"",
		"| config | success | turns | input tok | cached tok | output tok | cache hit | prefix kept | median wall | repeated err | injections | continuations | sidecar tok | total tok | sidecar fail | verdicts c/i/f/u | abnormal | tampered | lucky passes |",
		"|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
		...summaries
			.map((s) =>
				[
					s.config,
					`${s.successes}/${s.runs} (${pct(s.successRate)})`,
					fixed(s.meanTurns, 1),
					fixed(s.meanInputTokens, 0),
					fixed(s.meanCachedTokens, 0),
					fixed(s.meanOutputTokens, 0),
					s.cacheHitRate === null ? "—" : pct(s.cacheHitRate),
					s.prefixKeptRate === null ? "—" : pct(s.prefixKeptRate),
					`${s.medianWallClockSec.toFixed(0)}s`,
					s.repeatedErrorRate === null ? "—" : pct(s.repeatedErrorRate),
					String(s.injections),
					String(s.continuations),
					fixed(s.meanSidecarTokens, 0),
					fixed(s.meanTotalTokens, 0),
					String(s.sidecarFailures),
					s.verdicts,
					String(s.abnormal),
					String(s.tampered),
					String(s.luckyPasses),
				].join(" | "),
			)
			.map((row) => `| ${row} |`),
		"",
		"Token columns are per-run means of main-model usage; *sidecar tok* is the per-run mean of Exocortex's own calls. *total tok* adds main and sidecar tokens, the cost to weigh against success. *abnormal* counts runs that hit max turns, timed out or crashed. *tampered* counts runs that changed or deleted fixture tests (restored before the check, so they could not pass that way). *lucky passes* are passing runs that never verified after their last edit or retried one failing command 3+ times.",
		"",
		"## Per task",
		"",
	];
	const configs = summaries.map((s) => s.config);
	lines.push(`| task | ${configs.join(" | ")} |`, `|---|${configs.map(() => "---").join("|")}|`);
	for (const task of [...new Set(records.map((r) => r.taskId))]) {
		const cells = configs.map((config) => {
			const runs = records.filter((r) => r.taskId === task && r.config === config);
			return `${runs.filter((r) => r.success).length}/${runs.length}`;
		});
		lines.push(`| ${task} | ${cells.join(" | ")} |`);
	}
	lines.push(...verdictSection(summaries), ...pairedSection(records, summaries));
	return `${lines.join("\n")}\n`;
}

/** Supervisor verdict quality against the hidden checks, for configs that produced verdicts. */
function verdictSection(summaries: readonly ConfigSummary[]): string[] {
	const judged = summaries.filter((s) => s.completePrecision !== null || s.failureRecall !== null);
	if (judged.length === 0) return [];
	return [
		"",
		"## Supervisor verdicts vs hidden checks",
		"",
		"| config | judged complete | precision of complete | failures caught |",
		"|---|---|---|---|",
		...judged.map(
			(s) =>
				`| ${s.config} | ${s.judgedComplete} | ${s.completePrecision === null ? "—" : pct(s.completePrecision)} | ${s.failureRecall === null ? "—" : pct(s.failureRecall)} |`,
		),
		"",
		"*Precision of complete*: of runs whose last verdict was `complete`, the share whose check passed (a false `complete` sends the user away from broken work). *Failures caught*: of failing runs with a verdict, the share not called complete.",
	];
}

/** Each config against the first one (the baseline), task by task, with the run counts' power. */
function pairedSection(records: readonly RunRecord[], summaries: readonly ConfigSummary[]): string[] {
	const [baseline, ...treatments] = summaries;
	if (!baseline || treatments.length === 0) return [];
	const comparisons = treatments.map((t) => pairedComparison(records, baseline.config, t.config));
	// Pooled rate, kept off 0 and 1 where the normal approximation says nothing.
	const pooled = records.filter((r) => r.success).length / records.length;
	const mde = minimumDetectableEffect(Math.min(0.95, Math.max(0.05, pooled)), baseline.runs);
	return [
		"",
		`## Paired by task vs \`${baseline.config}\``,
		"",
		"| config | tasks | Δ success | 95% CI | wins/losses/ties | sign test p | Δ turns | Δ input tok | Δ wall |",
		"|---|---|---|---|---|---|---|---|---|",
		...comparisons.map((c) => `| ${pairedRow(c)} |`),
		"",
		`Δ success is the mean over tasks of the per-task success-rate difference, in points; the CI is a task-level bootstrap. Δ turns, input tokens and wall-clock are mean per-task relative changes. With ${baseline.runs} runs per config at a ${pct(pooled)} pooled success rate, an unpaired comparison can only detect differences of about ${Math.round(mde * 100)} points (α = 0.05, 80% power): treat smaller differences, and any per-slice result, as descriptive (D-045).`,
	];
}

function pairedRow(c: PairedComparison): string {
	return [
		c.treatment,
		String(c.tasks),
		points(c.meanDelta),
		`[${points(c.ci[0])}, ${points(c.ci[1])}]`,
		`${c.wins}/${c.losses}/${c.ties}`,
		c.signTestP.toFixed(2),
		change(c.turnsChange),
		change(c.inputTokensChange),
		change(c.wallClockChange),
	].join(" | ");
}

function points(delta: number): string {
	const value = Math.round(delta * 100);
	return `${value > 0 ? "+" : ""}${value}`;
}

function change(value: number | null): string {
	if (value === null) return "—";
	const rounded = Math.round(value * 100);
	return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

function sum(values: readonly number[]): number {
	return values.reduce((a, b) => a + b, 0);
}

function mean(values: readonly number[]): number | null {
	return values.length > 0 ? sum(values) / values.length : null;
}

function median(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function pct(value: number): string {
	return `${Math.round(value * 100)}%`;
}

function fixed(value: number | null, digits: number): string {
	return value === null ? "—" : value.toFixed(digits);
}
