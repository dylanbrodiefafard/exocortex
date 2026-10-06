import type { RecurringError, TraceMetrics } from "./metrics.ts";
import { invalidReason, type RunRecord } from "./records.ts";
import {
	holm,
	MIN_TASKS_FOR_INTERVAL,
	meanOf,
	type PairedDifference,
	type PairedRatio,
	pairedDifference,
	pairedRatio,
	pairRuns,
	type TaskValue,
	wilson,
} from "./stats.ts";

export interface ConfigSummary {
	readonly config: string;
	/** Valid runs: every rate and mean below is over these. */
	readonly runs: number;
	/** Runs that say nothing about the agent (setup, crash, harness or model-server failure), left out (D-079). */
	readonly invalid: number;
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
	/** Runs whose last verdict was `complete`, and how many of those passed their check. */
	readonly judgedComplete: number;
	readonly completeCorrect: number;
	/** Per-run mean of every token spent: main input, cached and output, plus sidecars (research R7.3). */
	readonly meanTotalTokens: number | null;
	/** Runs where the agent changed fixture tests or protected build files (put back before the check). */
	readonly tampered: number;
	/** Runs whose added test files were set aside before the check. */
	readonly setAside: number;
	/** Runs whose check exited 0 but ran fewer tests than the reference solution's: scored as failures. */
	readonly tooFewTests: number;
	readonly checkTimeouts: number;
	/** Passing runs with no verification after the last edit, or 3+ identical failed commands (R7.6). */
	readonly luckyPasses: number;
	/** Of failing runs with a last verdict, the share the supervisor did not call complete. */
	readonly failureRecall: number | null;
}

/**
 * One summary per config. `order` is the run's config order (`run.json`): configs run in a
 * shuffled order, so the order records appear in no longer says which one is the baseline.
 */
export function summarize(records: readonly RunRecord[], order: readonly string[] = []): ConfigSummary[] {
	const present = new Set(records.map((r) => r.config));
	const configs = [...new Set([...order.filter((config) => present.has(config)), ...present])];
	return configs.map((config) => {
		const all = records.filter((r) => r.config === config);
		const runs = all.filter((r) => invalidReason(r) === null);
		const withMetrics = runs.flatMap((r) => (r.metrics ? [r.metrics] : []));
		const totalPrompt = sum(withMetrics.map((m) => m.inputTokens + m.cachedTokens));
		const totalErrors = sum(withMetrics.map((m) => m.toolErrors));
		const prefixRates = withMetrics.flatMap((m) => (m.prefixKeptRate === null ? [] : [m.prefixKeptRate]));
		const successes = runs.filter((r) => r.success).length;
		return {
			config,
			runs: runs.length,
			invalid: all.length - runs.length,
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
			meanTotalTokens: mean(withMetrics.map(totalTokens)),
			tampered: runs.filter((r) => (r.tamperedTests?.length ?? 0) + (r.tamperedFiles?.length ?? 0) > 0).length,
			setAside: runs.filter((r) => (r.setAsideTests?.length ?? 0) > 0).length,
			tooFewTests: runs.filter((r) => r.tooFewTests === true).length,
			checkTimeouts: runs.filter((r) => r.checkTimedOut).length,
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
		completeCorrect: complete.filter((r) => r.success).length,
		completePrecision: complete.length > 0 ? complete.filter((r) => r.success).length / complete.length : null,
		failureRecall:
			failing.length > 0 ? failing.filter((r) => r.metrics?.lastVerdict !== "complete").length / failing.length : null,
	};
}

/**
 * Markdown report: one row per config, then a task × config pass matrix. The first config of
 * `order` (else the first seen) is the baseline every other one is paired against.
 */
export function renderMarkdown(records: readonly RunRecord[], title: string, order: readonly string[] = []): string {
	const summaries = summarize(records, order);
	const lines = [
		`# ${title}`,
		"",
		"| config | success | turns | input tok | cached tok | output tok | cache hit | prefix kept | median wall | repeated err | injections | continuations | sidecar tok | total tok | sidecar fail | verdicts c/i/f/u | abnormal | invalid | tampered | lucky passes |",
		"|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
		...summaries
			.map((s) =>
				[
					s.config,
					s.runs > 0 ? `${s.successes}/${s.runs} (${pct(s.successRate)})` : "0/0",
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
					String(s.invalid),
					String(s.tampered),
					String(s.luckyPasses),
				].join(" | "),
			)
			.map((row) => `| ${row} |`),
		"",
		"Token columns are per-run means of main-model usage; *sidecar tok* is the per-run mean of Exocortex's own calls. *total tok* adds main and sidecar tokens, the cost to weigh against success. *abnormal* counts runs that hit max turns or timed out. *invalid* counts runs where the harness or the model server failed (setup, a crash, a harness error, or a provider error before any tool call), after one retry: they are left out of every other column, and out of both configs in the paired statistics. *tampered* counts runs that changed or deleted fixture tests or protected build files (put back before the check, so they could not pass that way). *lucky passes* are passing runs that never verified after their last edit or retried one failing command 3+ times.",
		"",
		"## Per task",
		"",
	];
	const configs = summaries.map((s) => s.config);
	lines.push(`| task | ${configs.join(" | ")} |`, `|---|${configs.map(() => "---").join("|")}|`);
	for (const task of [...new Set(records.map((r) => r.taskId))]) {
		const cells = configs.map((config) => {
			const all = records.filter((r) => r.taskId === task && r.config === config);
			const runs = all.filter((r) => invalidReason(r) === null);
			const invalid = all.length - runs.length;
			return `${runs.filter((r) => r.success).length}/${runs.length}${invalid > 0 ? ` (+${invalid} invalid)` : ""}`;
		});
		lines.push(`| ${task} | ${cells.join(" | ")} |`);
	}
	const valid = records.filter((r) => invalidReason(r) === null);
	lines.push(
		...guardSection(summaries),
		...verdictSection(records, summaries),
		...recurringSection(valid, configs),
		...loopSection(valid, configs),
		...trimmerSection(valid, configs),
		...contextSection(valid, configs),
		...repeatSection(records, valid, summaries),
		...pairedSection(records, summaries),
	);
	return `${lines.join("\n")}\n`;
}

/** Every token a run spent: main input, cached and output, plus all sidecar calls. */
function totalTokens(m: TraceMetrics): number {
	return m.inputTokens + m.cachedTokens + m.outputTokens + m.sidecarTokens;
}

/** Metrics of a config's valid runs. */
function metricsOf(records: readonly RunRecord[], config: string): TraceMetrics[] {
	return records.flatMap((r) => (r.config === config && r.metrics && invalidReason(r) === null ? [r.metrics] : []));
}

/** What the check guard did (D-079), shown only when it did something. */
function guardSection(summaries: readonly ConfigSummary[]): string[] {
	if (summaries.every((s) => s.setAside + s.tooFewTests + s.checkTimeouts === 0)) return [];
	return [
		"",
		"## Check guard",
		"",
		"| config | runs with added tests set aside | passed with too few tests | check timeouts |",
		"|---|---|---|---|",
		...summaries.map((s) => `| ${s.config} | ${s.setAside} | ${s.tooFewTests} | ${s.checkTimeouts} |`),
		"",
		"Test files the agent added are set aside before the check, so a wrong one cannot fail a correct solution and none can replace a hidden test; the count is normal behaviour, not tampering. *Passed with too few tests* are runs whose check exited 0 after running fewer tests than the reference solution does: they are scored as failures. A check that times out twice is scored as a failure too, since a hang is the solution's doing. Look at a run's `tamperedFiles` in `results.jsonl` when a config fails more with the guard than without: a solution that needed a build-file change the reference solution did not make is failed by it.",
	];
}

/**
 * How repeated errors went, and whether each triage hint preceded the end of its error (D-057).
 * The first table needs no triage, so the baseline row is the natural rate to compare against.
 */
function recurringSection(records: readonly RunRecord[], configs: readonly string[]): string[] {
	const rows = configs.map((config) => ({
		config,
		errors: metricsOf(records, config).flatMap((m) => m.recurringErrors ?? []),
	}));
	if (rows.every((r) => r.errors.length === 0)) return [];
	const count = (errors: readonly RecurringError[], test: (e: RecurringError) => boolean) => errors.filter(test).length;
	const share = (part: number, whole: number) => (whole === 0 ? "—" : `${part}/${whole} (${pct(part / whole)})`);
	const hinted = rows.filter((r) => r.errors.some((e) => e.hints > 0));
	const lines = [
		"",
		"## Repeated errors",
		"",
		"| config | errors seen 2+ times | gone after the 2nd time | errors seen 3+ times | gone after the 3rd time |",
		"|---|---|---|---|---|",
		...rows.map(({ config, errors }) => {
			const thrice = count(errors, (e) => e.occurrences >= 3);
			return `| ${config} | ${errors.length} | ${share(errors.length - thrice, errors.length)} | ${thrice} | ${share(
				count(errors, (e) => e.occurrences === 3),
				thrice,
			)} |`;
		}),
		"",
		"One row per config, counting each failure once per run. A failure is the same one again only when it reports the same errors (line numbers and run times aside): a run with fewer failing tests, or another message, is a new failure and is not counted as a repeat. A test or build run that failed behind a pipe counts as a failure. Triage shows its first hint on the 2nd occurrence and its second on the 3rd, so *gone after the 2nd time* is where hint 1 can act and *gone after the 3rd time* where hint 2 can. Compare each against the baseline row: that is how often the agent gets past the error unaided. An error also counts as gone when the run ended.",
	];
	if (hinted.length === 0) return lines;
	return [
		...lines,
		"",
		"### Which hint preceded the end of the error",
		"",
		"| config | errors hinted | stopped after hint 1 | …and fixed | got hint 2 | stopped after hint 2 | …and fixed | came back after the last hint | run ended |",
		"|---|---|---|---|---|---|---|---|---|",
		...hinted.map(({ config, errors }) => {
			const withHints = errors.filter((e) => e.hints > 0);
			const stopped = (hints: number, fixed = false) =>
				count(withHints, (e) => e.hints === hints && e.after === "stopped" && (!fixed || e.fixed));
			return `| ${[
				config,
				withHints.length,
				stopped(1),
				stopped(1, true),
				count(withHints, (e) => e.hints >= 2),
				stopped(2),
				stopped(2, true),
				count(withHints, (e) => e.after === "recurred"),
				count(withHints, (e) => e.after === "ended"),
			].join(" | ")} |`;
		}),
		"",
		"Each hinted error is credited to the last hint the agent saw for it. *Stopped* means the error did not come back and the agent kept working; *…and fixed* means the command that last failed that way later succeeded. *Run ended* means no tool result followed the hint, so nothing can be said. The second hint earns its sidecar call only if *stopped after hint 2* is a real share of *got hint 2* and beats the baseline's *gone after the 3rd time*; otherwise cap hints at 1 (D-043, AB_PLAN step 3).",
	];
}

/** Research R2.1: how often the agent went back for what the trimmer cut. */
function trimmerSection(records: readonly RunRecord[], configs: readonly string[]): string[] {
	const rows = configs.map((config) => {
		const metrics = metricsOf(records, config);
		return {
			config,
			trimmed: sum(metrics.map((m) => m.trimmedOutputs ?? 0)),
			reread: sum(metrics.map((m) => m.trimmedRereads ?? 0)),
		};
	});
	if (rows.every((r) => r.trimmed === 0)) return [];
	return [
		"",
		"## Trimmed outputs",
		"",
		"| config | outputs trimmed | full output read back |",
		"|---|---|---|",
		...rows
			.filter((r) => r.trimmed > 0)
			.map((r) => `| ${r.config} | ${r.trimmed} | ${r.reread} (${pct(r.reread / r.trimmed)}) |`),
		"",
		"*Read back* counts trimmed outputs whose saved full copy the agent later opened (its path appears in a later tool call). Each one is a sign the trimmer cut something the agent needed: token savings that come with many read-backs are not savings (research R2.1, R2.4).",
	];
}

/** Loops without progress per config (D-069): what triage's loop notices are there to cut short. */
function loopSection(records: readonly RunRecord[], configs: readonly string[]): string[] {
	const looped = (r: RunRecord) => (r.metrics?.stuckLoops ?? 0) > 0;
	const heading = ["", "## Stuck loops", ""];
	if (!records.some(looped))
		return [...heading, "No run repeated a call or a short cycle of calls with the same results 3 times running."];
	return [
		...heading,
		"| config | runs with a loop | success with a loop | loops | calls made inside a loop | per loop |",
		"|---|---|---|---|---|---|",
		...configs.map((config) => {
			const runs = records.filter((r) => r.config === config && r.metrics);
			const stuck = runs.filter(looped);
			const loops = sum(stuck.map((r) => r.metrics?.stuckLoops ?? 0));
			const calls = sum(stuck.map((r) => r.metrics?.stuckLoopCalls ?? 0));
			return `| ${[
				config,
				`${stuck.length}/${runs.length}`,
				stuck.length === 0 ? "—" : `${stuck.filter((r) => r.success).length}/${stuck.length}`,
				loops,
				calls,
				loops === 0 ? "—" : (calls / loops).toFixed(1),
			].join(" | ")} |`;
		}),
		"",
		"A *loop* is the same tool call, or the same cycle of up to 5 calls, returning the same results 3 times in a row, counted from the original outputs so the definition is the same with triage on or off. *Calls made inside a loop* are the ones after that point and before the agent did something else: the turns a notice can save. Triage speaks at the 3rd round and again at the 6th, so compare *per loop* against the baseline row; a loop that ends in a failing command also shows under *Repeated errors*.",
	];
}

/** Compactions and context overflows per config: the evidence D-053 asks for before masking is revisited. */
function contextSection(records: readonly RunRecord[], configs: readonly string[]): string[] {
	const pressured = (r: RunRecord) =>
		r.metrics !== null &&
		r.metrics.compactions + (r.metrics.overflowCompactions ?? 0) + (r.metrics.failedCompactions ?? 0) > 0;
	const heading = ["", "## Context pressure", ""];
	if (!records.some(pressured)) {
		const stopped = sum(records.map((r) => r.metrics?.errorStops ?? 0));
		return [
			...heading,
			`No run compacted or overflowed its context window.${stopped > 0 ? ` ${stopped} turns ended in a provider error: check the logs in case an overflow went unrecognised.` : ""}`,
		];
	}
	const passed = (runs: readonly RunRecord[]) =>
		runs.length === 0 ? "—" : `${runs.filter((r) => r.success).length}/${runs.length}`;
	return [
		...heading,
		"| config | runs that compacted | success with compaction | success without | replays after compaction | overflow compactions | failed compactions | error stops | length stops | failed runs under context pressure |",
		"|---|---|---|---|---|---|---|---|---|---|",
		...configs.map((config) => {
			const runs = records.filter((r) => r.config === config && r.metrics);
			const metrics = metricsOf(records, config);
			const compacted = runs.filter((r) => (r.metrics?.compactions ?? 0) > 0);
			return `| ${[
				config,
				`${compacted.length}/${runs.length}`,
				passed(compacted),
				passed(runs.filter((r) => !compacted.includes(r))),
				`${sum(metrics.map((m) => m.compactionReplays ?? 0))}/${sum(metrics.map((m) => m.compactions))}`,
				sum(metrics.map((m) => m.overflowCompactions ?? 0)),
				sum(metrics.map((m) => m.failedCompactions ?? 0)),
				sum(metrics.map((m) => m.errorStops ?? 0)),
				sum(metrics.map((m) => m.lengthStops ?? 0)),
				runs.filter((r) => pressured(r) && !r.success).length,
			].join(" | ")} |`;
		}),
		"",
		"*Replays after compaction* counts compactions after which one of the agent's next two commands re-ran a command that had already passed: the summary lost that it was done (research R4.4). *Overflow compactions* are the ones pi started because a request no longer fit the context window or the reply was cut short, whether they succeeded or not; *failed compactions* could not produce a summary or could not recover. *Error stops* and *length stops* count turns that ended in a provider error or at the output limit: an overflow pi did not recognise shows up there. *Failed runs under context pressure* failed their check after compacting or overflowing. Runs that compact are the long ones, so compare *success with compaction* across configs, not against *success without*. Retro-masking is reconsidered only if these failures are common in the baseline (D-053).",
	];
}

/**
 * Success by repeat index: the learning curve for modules that learn across runs (memory), with
 * what each config spent, so the comparison can be read at matched budgets (research R5.4, D-058).
 * `valid` is `records` without the invalid runs; the paired numbers need both.
 */
function repeatSection(
	records: readonly RunRecord[],
	valid: readonly RunRecord[],
	summaries: readonly ConfigSummary[],
): string[] {
	const repeats = [...new Set(valid.map((r) => r.repeat))].sort((a, b) => a - b);
	if (repeats.length < 2) return [];
	const cell = (config: string, repeat: number) => {
		const runs = valid.filter((r) => r.config === config && r.repeat === repeat);
		return `${runs.filter((r) => r.success).length}/${runs.length}`;
	};
	return [
		"",
		"## Success by repeat",
		"",
		`| config | ${repeats.map((r) => `r${r}`).join(" | ")} |`,
		`|---|${repeats.map(() => "---").join("|")}|`,
		...summaries.map((s) => `| ${s.config} | ${repeats.map((r) => cell(s.config, r)).join(" | ")} |`),
		"",
		"Repeats run in order (all tasks for r1, then r2, …), so a module that learns, like memory, can only help from r2 on; a rise over r1 that the baseline does not show is its effect on the same tasks (an upper bound, research §5c). One repeat column is one run per task: read it as a trend, not as a test.",
		...budgetSection(records, valid, summaries, repeats),
	];
}

const totalOf: TaskValue = meanOf((r) => (r.metrics ? totalTokens(r.metrics) : null));

/** Total tokens per config, side by side and by repeat, with what the tasks can detect. */
function budgetSection(
	records: readonly RunRecord[],
	valid: readonly RunRecord[],
	summaries: readonly ConfigSummary[],
	repeats: readonly number[],
): string[] {
	const [baseline] = summaries;
	if (!baseline) return [];
	const byRepeat = (repeat: number) => valid.filter((r) => r.repeat === repeat);
	const modules = [...new Set(valid.flatMap((r) => Object.keys(r.metrics?.sidecarTokensByModule ?? {})))].sort();
	const rows = summaries.map((s) => {
		const metrics = metricsOf(valid, s.config);
		const spent = sum(metrics.map(totalTokens));
		const delta = s === baseline ? null : pairedRatio(records, baseline.config, s.config, totalOf);
		return [
			s.config,
			fixed(mean(metrics.map((m) => m.inputTokens + m.cachedTokens + m.outputTokens)), 0),
			...modules.map((id) => fixed(mean(metrics.map((m) => m.sidecarTokensByModule?.[id] ?? 0)), 0)),
			fixed(s.meanTotalTokens, 0),
			...repeats.map((repeat) => fixed(mean(metricsOf(byRepeat(repeat), s.config).map(totalTokens)), 0)),
			s.successes > 0 && metrics.length > 0 ? fixed(spent / s.successes, 0) : "—",
			delta ? change(delta.change) : "—",
			delta ? interval(delta.ci, change) : "—",
			delta?.detectable == null ? "—" : `±${Math.round(delta.detectable * 100)}%`,
		];
	});
	const header = [
		"config",
		"main tok",
		...modules.map((id) => `${id} sidecar tok`),
		"total tok",
		...repeats.map((r) => `total r${r}`),
		"tok per pass",
		`Δ total vs \`${baseline.config}\``,
		"95% CI",
		"detectable Δ",
	];
	return [
		"",
		"### Token budget",
		"",
		`| ${header.join(" | ")} |`,
		`|${header.map(() => "---").join("|")}|`,
		...rows.map((row) => `| ${row.join(" | ")} |`),
		"",
		'Per-run means. *main tok* is everything the main model read and wrote (input, cached and output, and pi\'s own compaction calls), which includes any text a module injected, such as memory\'s recalled cards; the sidecar columns are each module\'s own calls; *total tok* is their sum. *tok per pass* is all tokens spent divided by passing runs. *Δ total* is the typical per-task change against the baseline (the geometric mean of the per-task ratios), with the interval from the same paired test as Δ success below; *detectable Δ* is the smallest change these tasks would show 80% of the time (α = 0.05), so an interval that spans zero inside it means "no difference this run could see", not "no difference". For what the run can say about success, read *detectable Δ* in the paired table below. Read a learning module at matched budgets (research R5.4, D-055): it must not lose success, and any gain has to outweigh the extra tokens, because a baseline given the same budget often catches up.',
	];
}

const precisionOf: TaskValue = (runs) => {
	const complete = runs.filter((r) => r.metrics?.lastVerdict === "complete");
	return complete.length > 0 ? complete.filter((r) => r.success).length / complete.length : null;
};

/** Supervisor verdict quality against the hidden checks, for configs that produced verdicts. */
function verdictSection(records: readonly RunRecord[], summaries: readonly ConfigSummary[]): string[] {
	const judged = summaries.filter((s) => s.completePrecision !== null || s.failureRecall !== null);
	const [baseline] = summaries;
	if (judged.length === 0 || !baseline) return [];
	return [
		"",
		"## Supervisor verdicts vs hidden checks",
		"",
		`| config | judged complete | precision of complete | 95% interval | failures caught | Δ precision vs \`${baseline.config}\` | 95% CI | p |`,
		"|---|---|---|---|---|---|---|---|",
		...judged.map((s) => {
			const delta = s === baseline ? null : pairedDifference(records, baseline.config, s.config, precisionOf);
			return `| ${[
				s.config,
				s.judgedComplete,
				s.completePrecision === null ? "—" : pct(s.completePrecision),
				interval(wilson(s.completeCorrect, s.judgedComplete), pct, "—"),
				s.failureRecall === null ? "—" : pct(s.failureRecall),
				delta ? points(delta.mean) : "—",
				delta ? interval(delta.ci, points) : "—",
				delta ? delta.p.toFixed(3) : "—",
			].join(" | ")} |`;
		}),
		"",
		"*Precision of complete*: of runs whose last verdict was `complete`, the share whose check passed (a false `complete` sends the user away from broken work). Its interval is a Wilson interval over runs, which treats repeats of one task as independent, so it is somewhat too narrow. *Failures caught*: of failing runs with a verdict, the share not called complete. *Δ precision* is the mean per-task difference in precision, in points, over tasks where both configs called at least one run complete, with the paired test's interval and p-value.",
	];
}

const successOf: TaskValue = (runs) => runs.filter((r) => r.success).length / runs.length;
const repeatedErrorRateOf: TaskValue = (runs) => {
	const errors = sum(runs.map((r) => r.metrics?.toolErrors ?? 0));
	return errors > 0 ? sum(runs.map((r) => r.metrics?.repeatedToolErrors ?? 0)) / errors : null;
};

/** Each config against the first one (the baseline), task by task, with what the tasks can detect. */
function pairedSection(records: readonly RunRecord[], summaries: readonly ConfigSummary[]): string[] {
	const [baseline, ...treatments] = summaries;
	if (!baseline || treatments.length === 0) return [];
	const difference = (value: TaskValue) =>
		treatments.map((t) => pairedDifference(records, baseline.config, t.config, value));
	const ratio = (value: TaskValue) => treatments.map((t) => pairedRatio(records, baseline.config, t.config, value));
	const success = difference(successOf);
	const adjusted = holm(success.map((c) => c?.p ?? 1));
	const turns = ratio(meanOf((r) => r.metrics?.turns ?? null));
	const input = ratio(meanOf((r) => r.metrics?.inputTokens ?? null));
	const wall = ratio(meanOf((r) => r.wallClockMs / 1000));
	const repeated = difference(repeatedErrorRateOf);
	const dropped = treatments.flatMap((t, i) => {
		const notes = [
			blocks(pairRuns(records, baseline.config, t.config).droppedBlocks),
			noRatio("turns", turns[i]),
			noRatio("input tokens", input[i]),
		].filter((note) => note !== "");
		return notes.length > 0 ? [`\`${t.config}\`: ${notes.join("; ")}.`] : [];
	});
	return [
		"",
		`## Paired by task vs \`${baseline.config}\``,
		"",
		"| config | tasks | Δ success | 95% CI | p | Holm p | detectable Δ | wins/losses/ties |",
		"|---|---|---|---|---|---|---|---|",
		...treatments.map((t, i) => `| ${successRow(t.config, success[i] ?? null, adjusted[i] ?? 1)} |`),
		"",
		"| config | Δ turns | Δ input tok | Δ wall | Δ repeated-error rate |",
		"|---|---|---|---|---|",
		...treatments.map(
			(t, i) =>
				`| ${[
					t.config,
					ratioCell(turns[i] ?? null),
					ratioCell(input[i] ?? null),
					ratioCell(wall[i] ?? null),
					differenceCell(repeated[i] ?? null),
				].join(" | ")} |`,
		),
		"",
		`The unit is the task: each task's runs are averaged per config, and repeats of a task are not counted as independent evidence. Δ success is the mean over tasks of the per-task success-rate difference, in points. Its interval and p-value come from the exact sign-flip test on those differences (D-079); with fewer than ${MIN_TASKS_FOR_INTERVAL} tasks no 95% interval exists and the smallest possible p is above 0.05, so the table says *n too small*. *Holm p* adjusts for testing ${treatments.length} config${treatments.length === 1 ? "" : "s"} against the baseline: use it when asking "did any of these help". *Detectable Δ* is the smallest true difference these tasks would show 80% of the time (α = 0.05), computed from how much the per-task differences vary; an interval that spans zero inside it means "nothing this run could see". It is itself an estimate, and a rough one with few tasks. Δ turns, input tokens and wall-clock are typical per-task relative changes (geometric mean of the per-task ratios) and Δ repeated-error rate is in points, each with the same test's 95% interval in brackets. A (task, repeat) block with an invalid run in either config is left out of both. Treat any per-slice result as descriptive (D-045).`,
		...(dropped.length > 0 ? ["", `Left out: ${dropped.join(" ")}`] : []),
	];
}

function blocks(count: number): string {
	return count > 0 ? `${count} (task, repeat) block${count === 1 ? "" : "s"} with an invalid run` : "";
}

function noRatio(name: string, ratio: PairedRatio | null | undefined): string {
	const count = ratio?.droppedTasks ?? 0;
	return count > 0 ? `${count} task${count === 1 ? "" : "s"} with no ${name} in one config` : "";
}

function successRow(config: string, c: PairedDifference | null, holmP: number): string {
	if (!c) return [config, "0", "—", "—", "—", "—", "—", "—"].join(" | ");
	return [
		config,
		String(c.tasks),
		points(c.mean),
		interval(c.ci, points),
		c.p.toFixed(3),
		holmP.toFixed(3),
		c.detectable === null
			? c.tasks < MIN_TASKS_FOR_INTERVAL
				? "n too small"
				: "—"
			: `±${Math.round(c.detectable * 100)}`,
		`${c.wins}/${c.losses}/${c.ties}`,
	].join(" | ");
}

function ratioCell(c: PairedRatio | null): string {
	return c ? `${change(c.change)} ${interval(c.ci, change)}` : "—";
}

function differenceCell(c: PairedDifference | null): string {
	return c ? `${points(c.mean)} ${interval(c.ci, points)}` : "—";
}

function interval(
	ci: readonly [number, number] | null,
	format: (value: number) => string,
	missing = "n too small",
): string {
	return ci ? `[${format(ci[0])}, ${format(ci[1])}]` : missing;
}

function points(delta: number): string {
	const value = Math.round(delta * 100);
	return `${value > 0 ? "+" : ""}${value}`;
}

function change(value: number): string {
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
