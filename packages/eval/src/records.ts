import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TraceMetrics, WorkspaceEdits } from "./metrics.ts";
import type { RunOutcome } from "./pi-rpc.ts";

export interface RunRecord {
	/** Unique per attempt: also the trace label and the stem of the run's log files. */
	readonly label: string;
	readonly taskId: string;
	readonly config: string;
	readonly repeat: number;
	readonly outcome: RunOutcome | "setup_failed" | "harness_error";
	readonly success: boolean;
	readonly checkExitCode: number | null;
	readonly checkTimedOut: boolean;
	readonly agentMs: number;
	/** Supervisor (or other) editor suggestions the harness accepted on the user's behalf. */
	readonly acceptedSuggestions: number;
	/** Fixture test files the agent changed or deleted (restored before the check, D-048). */
	readonly tamperedTests?: readonly string[];
	/** Protected build and runner files the agent changed, deleted or added (put back or set aside, D-079). */
	readonly tamperedFiles?: readonly string[];
	/** Test files the agent added, set aside before the check so they can neither fail nor fake it (D-079). */
	readonly setAsideTests?: readonly string[];
	/** Tests the check ran and passed, when its output says; null when it does not. */
	readonly checkTests?: number | null;
	/** The check exited 0 but ran fewer tests than the task's `minTests`: scored as a failure (D-079). */
	readonly tooFewTests?: boolean;
	/** 2 when the first attempt was invalid and the run was repeated once (D-079). */
	readonly attempts?: number;
	/**
	 * How the workspace differed from the task's baseline when the agent stopped, before the check
	 * guard touched it (D-086). Kept so a re-rendered report can still tell an edit from none.
	 */
	readonly edits?: WorkspaceEdits;
	/**
	 * How long pi took to shut down once the agent had settled: mostly its wait for background
	 * sidecar calls (D-086). Not part of `wallClockMs`: an interactive user does not wait for it.
	 */
	readonly closeMs?: number;
	/** Pi outlasted the close grace and was killed: the end of its trace, and any card still being written, is missing. */
	readonly killedAtClose?: boolean;
	/** The whole run, from preparing the workspace to the check's end, without `closeMs`. */
	readonly wallClockMs: number;
	readonly metrics: TraceMetrics | null;
	readonly error?: string;
}

/**
 * Why a run says nothing about the agent (D-079): the harness or the model server failed, not the
 * task. Such a run is retried once, kept out of every success rate, and dropped from paired
 * statistics together with the other config's run of the same task and repeat.
 */
export type InvalidReason = "setup_failed" | "crashed" | "harness_error" | "provider_error";

export function invalidReason(record: RunRecord): InvalidReason | null {
	if (record.outcome === "setup_failed" || record.outcome === "crashed" || record.outcome === "harness_error") {
		return record.outcome;
	}
	// The model server answered nothing useful: the run's last turn was a provider error and the
	// agent never got to call a tool. An error after real work may be the agent's doing (an
	// overflowed context, D-059) and stays a failure.
	const metrics = record.metrics;
	if (metrics && metrics.toolCalls === 0 && metrics.lastStopReason === "error") return "provider_error";
	return null;
}

/**
 * A run directory's records: `results.json` when the run finished, else `results.jsonl`. A line
 * that does not parse (the run was killed mid-write) is skipped with a warning, not fatal.
 */
export function readResults(runDir: string, warn: (message: string) => void = () => {}): RunRecord[] {
	const json = join(runDir, "results.json");
	if (existsSync(json)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(json, "utf8"));
			if (Array.isArray(parsed)) return parsed.filter(isRecord);
			warn(`${json}: not a list of results; reading results.jsonl instead`);
		} catch (error) {
			warn(`${json}: ${error instanceof Error ? error.message : String(error)}; reading results.jsonl instead`);
		}
	}
	return readResultLines(runDir, warn);
}

/** The records appended so far to `results.jsonl`, skipping lines that do not parse. */
export function readResultLines(runDir: string, warn: (message: string) => void = () => {}): RunRecord[] {
	const jsonl = join(runDir, "results.jsonl");
	if (!existsSync(jsonl)) return [];
	const records: RunRecord[] = [];
	for (const [index, line] of readFileSync(jsonl, "utf8").split("\n").entries()) {
		if (line.trim() === "") continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (isRecord(parsed)) records.push(parsed);
			else warn(`${jsonl}:${index + 1}: not a run record, skipped`);
		} catch {
			warn(`${jsonl}:${index + 1}: unparsable line skipped`);
		}
	}
	return records;
}

function isRecord(value: unknown): value is RunRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record["label"] === "string" &&
		typeof record["taskId"] === "string" &&
		typeof record["config"] === "string" &&
		typeof record["repeat"] === "number" &&
		typeof record["success"] === "boolean"
	);
}
