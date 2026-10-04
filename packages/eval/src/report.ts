import type { RunRecord } from "./run.ts";

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
	readonly sidecarFailures: number;
	readonly abnormal: number;
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
			sidecarFailures: sum(withMetrics.map((m) => m.sidecarFailures)),
			abnormal: runs.filter((r) => r.outcome !== "settled").length,
		};
	});
}

/** Markdown report: one row per config, then a task × config pass matrix. */
export function renderMarkdown(records: readonly RunRecord[], title: string): string {
	const summaries = summarize(records);
	const lines = [
		`# ${title}`,
		"",
		"| config | success | turns | input tok | cached tok | output tok | cache hit | prefix kept | median wall | repeated err | injections | continuations | sidecar tok | sidecar fail | abnormal |",
		"|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
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
					String(s.sidecarFailures),
					String(s.abnormal),
				].join(" | "),
			)
			.map((row) => `| ${row} |`),
		"",
		"Token columns are per-run means of main-model usage; *sidecar tok* is the per-run mean of Exocortex's own calls. *abnormal* counts runs that hit max turns, timed out or crashed.",
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
	return `${lines.join("\n")}\n`;
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
