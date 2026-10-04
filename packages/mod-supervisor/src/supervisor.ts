import {
	type ExoModule,
	loadPrompt,
	type ModuleContext,
	type SettleAction,
	type SettleInfo,
	type ToolOutcome,
	type UserTurn,
} from "@exocortex/core";
import { type Static, Type } from "typebox";
import { asksUserQuestion, type CheckResult, diffFingerprint, formatEvidence } from "./evidence.ts";
import { parseSettings, type SupervisorSettings } from "./settings.ts";

export const SUPERVISOR_ID = "supervisor";

const LEDGER_PROMPT = loadPrompt(new URL("../prompts/ledger.v1.md", import.meta.url));
const VERDICT_PROMPT = loadPrompt(new URL("../prompts/verdict.v1.md", import.meta.url));

const LedgerSchema = Type.Object({
	is_task: Type.Boolean(),
	follows_previous: Type.Boolean(),
	criteria: Type.Array(Type.String(), { maxItems: 10 }),
	check_commands: Type.Array(Type.String(), { maxItems: 10 }),
});

const VerdictSchema = Type.Object({
	verdict: Type.Union([
		Type.Literal("complete"),
		Type.Literal("incomplete"),
		Type.Literal("failed"),
		Type.Literal("uncertain"),
	]),
	missing: Type.Array(Type.String(), { maxItems: 10 }),
	asked_user: Type.Boolean(),
	reason: Type.String(),
});

export type Verdict = Static<typeof VerdictSchema>;

/** The goal ledger (brief §6.1 step 1): stored and used for verdicts, never injected. */
export interface Ledger {
	readonly criteria: readonly string[];
	/** Check commands quoted verbatim in the request (only these, plus configured ones, are ever run). */
	readonly checkCommands: readonly string[];
}

interface Task {
	readonly prompt: string;
	readonly ledger: Promise<Ledger | undefined>;
	/** Commit the task started from (`git rev-parse HEAD`), so diffs cover commits made during the task. */
	readonly startRef: Promise<string | undefined>;
	readonly tools: ToolOutcome[];
	continuations: number;
	pending: { readonly text: string; readonly diffHash: string } | undefined;
	lastContinuationDiff: string | undefined;
	noProgressStreak: number;
}

const MAX_CRITERIA = 7;
const FINAL_MESSAGE_CHARS = 1_500;
const GIT_TIMEOUT_MS = 10_000;
/** Enough of a diff for the evidence budget and a stable change fingerprint. */
const GIT_OUTPUT_CHARS = 256 * 1024;

/**
 * The supervisor module (brief §6.1, D-010, D-011): extracts a goal ledger from each request,
 * and when the agent stops, gathers deterministic evidence, asks an isolated verdict sidecar
 * whether the request is done, and on `incomplete` suggests (or, in auto mode, sends) a short
 * follow-up listing what is missing. Every failure degrades to doing nothing.
 */
export function createSupervisor(raw: Readonly<Record<string, unknown>>, ctx: ModuleContext): ExoModule {
	const { settings, problems } = parseSettings(raw);
	for (const problem of problems) ctx.log(problem);
	let task: Task | undefined;
	let lastLedger: Ledger | undefined;
	let lastVerdict: string | undefined;

	return {
		id: SUPERVISOR_ID,

		onUserTurn(turn: UserTurn) {
			if (task?.pending && sameText(turn.text, task.pending.text)) {
				// The user (or eval harness) accepted our suggestion: same task, one more continuation.
				task.continuations += 1;
				task.lastContinuationDiff = task.pending.diffHash;
				task.pending = undefined;
				ctx.record({ kind: "exo.action", data: { action: "accepted", continuation: task.continuations } });
				return;
			}
			const previous = lastLedger;
			const ledger = extractLedger(ctx, settings, turn.text, previous).then((result) => {
				if (result) lastLedger = result;
				return result;
			});
			task = {
				prompt: turn.text,
				ledger,
				startRef: gitHead(ctx),
				tools: [],
				continuations: 0,
				pending: undefined,
				lastContinuationDiff: undefined,
				noProgressStreak: 0,
			};
		},

		onToolResult(tool: ToolOutcome) {
			task?.tools.push(tool);
		},

		async onSettle(info: SettleInfo, signal: AbortSignal): Promise<SettleAction | undefined> {
			const current = task;
			if (!current || info.outcome !== "completed") return undefined;
			current.pending = undefined;
			const skip = (reason: string): undefined => {
				ctx.record({ kind: "exo.action", data: { action: "skipped", reason } });
				return undefined;
			};

			const ledger = await withTimeout(current.ledger, settings.ledgerTimeoutMs);
			if (!ledger || ledger.criteria.length === 0) return skip("no_ledger");
			if (asksUserQuestion(info.lastAssistantText)) return skip("asked_user");
			if (current.continuations >= settings.maxContinuations) return skip("max_continuations");

			const evidence = await gatherEvidence(ctx, settings, current, ledger, signal);
			if (current.lastContinuationDiff !== undefined) {
				current.noProgressStreak =
					evidence.diffHash === current.lastContinuationDiff ? current.noProgressStreak + 1 : 0;
				if (current.noProgressStreak >= 2) return skip("no_progress");
			}

			const verdict = await judge(ctx, settings, ledger, evidence.text, info.lastAssistantText, signal);
			if (!verdict) return skip("verdict_unavailable");
			lastVerdict = verdict.verdict;
			ctx.record({
				kind: "exo.verdict",
				data: { ...verdict, criteria: [...ledger.criteria], continuations: current.continuations },
			});
			return act(ctx, settings, current, verdict, evidence.diffHash);
		},

		status() {
			if (!task) return `supervisor (${settings.mode}): idle`;
			return `supervisor (${settings.mode}): ${lastVerdict ?? "watching"} · ${task.continuations}/${settings.maxContinuations} continuations`;
		},
	};
}

function act(
	ctx: ModuleContext,
	settings: SupervisorSettings,
	task: Task,
	verdict: Verdict,
	diffHash: string,
): SettleAction | undefined {
	const missing = verdict.missing
		.map((m) => m.trim())
		.filter(Boolean)
		.slice(0, MAX_CRITERIA);
	if (verdict.verdict === "incomplete" && missing.length > 0 && !verdict.asked_user) {
		const text = continuationMessage(missing);
		const summary = `supervisor: ${missing.length} item(s) look unfinished`;
		if (settings.mode === "auto") {
			task.continuations += 1;
			task.lastContinuationDiff = diffHash;
			ctx.record({ kind: "exo.action", data: { action: "continued", continuation: task.continuations, missing } });
			return { kind: "continue", text, summary };
		}
		task.pending = { text, diffHash };
		ctx.record({ kind: "exo.action", data: { action: "suggested", missing } });
		return { kind: "suggest", text, summary };
	}
	if (verdict.verdict === "failed") {
		return { kind: "notify", summary: `supervisor: looks failed: ${verdict.reason}`.slice(0, 200), level: "warning" };
	}
	return { kind: "notify", summary: `supervisor: ${verdict.verdict}`, level: "info" };
}

/** The user-role follow-up (brief §6.1 step 4): short and specific. */
export function continuationMessage(missing: readonly string[]): string {
	return [
		"Not done yet. These parts of my request still look unfinished:",
		...missing.map((m, i) => `${i + 1}. ${m}`),
		"Please finish them and verify your work before stopping.",
	].join("\n");
}

async function extractLedger(
	ctx: ModuleContext,
	settings: SupervisorSettings,
	prompt: string,
	previous: Ledger | undefined,
): Promise<Ledger | undefined> {
	const pool = ctx.pool();
	if (!pool) return undefined;
	const result = await pool.run({
		module: SUPERVISOR_ID,
		priority: "interactive",
		timeoutMs: settings.ledgerTimeoutMs,
		schema: LedgerSchema,
		schemaName: "goal_ledger",
		request: {
			messages: [
				{
					role: "user",
					content: LEDGER_PROMPT.render({
						prompt,
						previous: previous ? previous.criteria.map((c) => `- ${c}`).join("\n") : "(none)",
					}),
				},
			],
			maxTokens: 700,
			temperature: 0.2,
			thinking: settings.thinking,
		},
	});
	if (!result.ok) {
		ctx.log(`supervisor: ledger ${result.outcome}: ${result.error}`);
		return undefined;
	}
	const value = result.value;
	if (!value.is_task) {
		ctx.record({ kind: "exo.ledger", data: { is_task: false } });
		return value.follows_previous ? previous : undefined;
	}
	const ledger: Ledger = {
		criteria: value.criteria
			.map((c) => c.trim())
			.filter(Boolean)
			.slice(0, MAX_CRITERIA),
		// Safety (D-011): only commands that literally appear in the user's request are ever run.
		checkCommands: value.check_commands.map((c) => c.trim()).filter((c) => c !== "" && prompt.includes(c)),
	};
	ctx.record({
		kind: "exo.ledger",
		data: {
			is_task: true,
			follows_previous: value.follows_previous,
			criteria: [...ledger.criteria],
			checks: [...ledger.checkCommands],
		},
	});
	return ledger;
}

async function gatherEvidence(
	ctx: ModuleContext,
	settings: SupervisorSettings,
	task: Task,
	ledger: Ledger,
	signal: AbortSignal,
): Promise<{ readonly text: string; readonly diffHash: string }> {
	const startRef = (await task.startRef) ?? "HEAD";
	const [stat, diff, untracked] = await Promise.all([
		git(ctx, `diff --stat ${startRef}`),
		git(ctx, `diff ${startRef}`),
		git(ctx, "ls-files --others --exclude-standard"),
	]);
	const untrackedFiles = (untracked ?? "").split("\n").filter(Boolean).slice(0, 30);

	const commands = [...new Set([...settings.checks, ...(settings.runPromptChecks ? ledger.checkCommands : [])])];
	const checks: CheckResult[] = [];
	for (const command of commands) {
		if (signal.aborted) break;
		checks.push({ command, output: await ctx.runCommand(command, { timeoutMs: settings.checkTimeoutMs, signal }) });
	}
	return {
		text: formatEvidence({
			diffStat: stat,
			diff,
			untracked: untrackedFiles,
			tools: task.tools,
			checks,
			maxChars: settings.maxEvidenceChars,
		}),
		diffHash: diffFingerprint(diff, untrackedFiles),
	};
}

async function judge(
	ctx: ModuleContext,
	settings: SupervisorSettings,
	ledger: Ledger,
	evidence: string,
	finalMessage: string,
	signal: AbortSignal,
): Promise<Verdict | undefined> {
	const pool = ctx.pool();
	if (!pool) return undefined;
	const result = await pool.run({
		module: SUPERVISOR_ID,
		priority: "critical",
		timeoutMs: settings.verdictTimeoutMs,
		signal,
		schema: VerdictSchema,
		schemaName: "verdict",
		request: {
			messages: [
				{
					role: "user",
					content: VERDICT_PROMPT.render({
						criteria: ledger.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n"),
						evidence,
						final_message: finalMessage.slice(-FINAL_MESSAGE_CHARS),
					}),
				},
			],
			maxTokens: 800,
			temperature: 0.2,
			thinking: settings.thinking,
		},
	});
	if (!result.ok) {
		ctx.log(`supervisor: verdict ${result.outcome}: ${result.error}`);
		return undefined;
	}
	return result.value;
}

/** stdout of a git command, or undefined when it fails (e.g. not a repository). */
async function git(ctx: ModuleContext, args: string): Promise<string | undefined> {
	const out = await ctx.runCommand(`git ${args}`, { timeoutMs: GIT_TIMEOUT_MS, tailChars: GIT_OUTPUT_CHARS });
	return out.exitCode === 0 ? out.outputTail : undefined;
}

async function gitHead(ctx: ModuleContext): Promise<string | undefined> {
	return (await git(ctx, "rev-parse --verify HEAD"))?.trim() || undefined;
}

function sameText(a: string, b: string): boolean {
	return a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
	return Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms).unref())]);
}
