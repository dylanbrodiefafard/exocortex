import {
	type ExoModule,
	loadPrompt,
	type ModuleContext,
	type SettleAction,
	type SettleInfo,
	SIDECAR_MAX_TOKENS,
	type ToolOutcome,
	type UserTurn,
} from "@exocortex/core";
import { type Static, Type } from "typebox";
import { asksUserQuestion, type CheckResult, diffFingerprint, formatEvidence } from "./evidence.ts";
import { parseSettings, type SupervisorSettings } from "./settings.ts";
import {
	extractClaims,
	lastFullRun,
	madeNoChanges,
	narrowTestSignal,
	parseDiff,
	stubSignals,
	tamperSignals,
	unsupportedClaims,
} from "./signals.ts";

export const SUPERVISOR_ID = "supervisor";

const LEDGER_PROMPT = loadPrompt(new URL("../prompts/ledger.v2.md", import.meta.url));
const VERDICT_PROMPT = loadPrompt(new URL("../prompts/verdict.v5.md", import.meta.url));
const ITEM_VERDICT_PROMPT = loadPrompt(new URL("../prompts/verdict-items.v5.md", import.meta.url));

const LedgerSchema = Type.Object({
	is_task: Type.Boolean(),
	follows_previous: Type.Boolean(),
	criteria: Type.Array(Type.String(), { maxItems: 16 }),
	check_commands: Type.Array(Type.String(), { maxItems: 10 }),
});

const VerdictSchema = Type.Object({
	verdict: Type.Union([
		Type.Literal("complete"),
		Type.Literal("incomplete"),
		Type.Literal("failed"),
		Type.Literal("uncertain"),
	]),
	missing: Type.Array(Type.String(), { maxItems: 16 }),
	/** Items the evidence shows neither way, as instructions to check them. */
	unverified: Type.Optional(Type.Array(Type.String(), { maxItems: 16 })),
	asked_user: Type.Boolean(),
	reason: Type.String(),
});

export type Verdict = Static<typeof VerdictSchema>;

const ItemVerdictSchema = Type.Object({
	items: Type.Array(
		Type.Object({
			criterion: Type.Integer({ minimum: 1 }),
			status: Type.Union([Type.Literal("met"), Type.Literal("unmet"), Type.Literal("unknown")]),
			evidence: Type.String(),
			fix: Type.String(),
		}),
		{ maxItems: 16 },
	),
	failed: Type.Boolean(),
	asked_user: Type.Boolean(),
	reason: Type.String(),
});

export type ItemVerdict = Static<typeof ItemVerdictSchema>;

/** A verdict plus how it was reached, as recorded in the trace. */
export interface Judgement extends Verdict {
	readonly source: "deterministic" | "llm";
	readonly votes?: number;
}

/** The goal ledger (brief §6.1 step 1): stored and used for verdicts, never injected. */
export interface Ledger {
	/**
	 * The user's own messages that make up the task, oldest first. The verdict reads them: the
	 * criteria are a sidecar's summary and lose the request's detail (D-071).
	 */
	readonly requests: readonly string[];
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
	/**
	 * What the workspace held when each of the agent's test or build runs ended, by position in
	 * `tools`. Compared with its state at settle, it shows whether anything changed since, whatever
	 * changed it: a file tool, `sed -i`, a code generator.
	 */
	readonly snapshots: Map<number, Promise<string | undefined>>;
	/** The agent was already asked to check what the verdict could not see (once per task). */
	verifyAsked: boolean;
}

/** Enough for one criterion per requirement of a long specification (D-071; the brief had 7). */
const MAX_CRITERIA = 12;
/** How much of the user's request the verdict reads; longer ones keep their start and end. */
const REQUEST_CHARS = 16_000;
const FINAL_MESSAGE_CHARS = 1_500;
/** In `claims` mode the verdict still sees this much of the ending, to spot a question to the user. */
const CLAIMS_TAIL_CHARS = 300;
const VOTE_TEMPERATURE = 0.7;
const GIT_TIMEOUT_MS = 10_000;
/** Enough of a diff for the evidence budget and a stable change fingerprint. */
const GIT_OUTPUT_CHARS = 256 * 1024;
/** New files whose content is shown, and how much of each. */
const MAX_NEW_FILES = 12;
const NEW_FILE_CHARS = 6_000;

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
				verifyAsked: false,
				snapshots: new Map(),
			};
		},

		onToolResult(tool: ToolOutcome) {
			if (!task) return;
			task.tools.push(tool);
			if (lastFullRun([tool])) task.snapshots.set(task.tools.length - 1, workspaceState(ctx));
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
			if (current.continuations >= settings.maxContinuations) return skip("max_continuations");

			const evidence = await gatherEvidence(ctx, settings, current, ledger, info.lastAssistantText, signal);
			if (stalled(current, evidence.diffHash)) return skip("no_progress");

			const verdict = await decide(ctx, settings, ledger, evidence, info.lastAssistantText, signal);
			if (!verdict) return skip("verdict_unavailable");
			lastVerdict = verdict.verdict;
			ctx.record({
				kind: "exo.verdict",
				data: {
					...verdict,
					criteria: [...ledger.criteria],
					continuations: current.continuations,
					checks: evidence.checks.map((c) => ({
						command: c.command,
						source: c.source,
						exitCode: c.output.exitCode,
						timedOut: c.output.timedOut,
					})),
				},
			});
			return act(ctx, settings, current, verdict, evidence);
		},

		status() {
			if (!task) return `supervisor (${settings.mode}): idle`;
			return `supervisor (${settings.mode}): ${lastVerdict ?? "watching"} · ${task.continuations}/${settings.maxContinuations} continuations`;
		},
	};
}

/** Brief §6.1 guard: two continuations in a row that leave the diff unchanged stop the supervisor. */
function stalled(task: Task, diffHash: string): boolean {
	if (task.lastContinuationDiff === undefined) return false;
	task.noProgressStreak = diffHash === task.lastContinuationDiff ? task.noProgressStreak + 1 : 0;
	return task.noProgressStreak >= 2;
}

/** The deterministic pre-verdict when enabled and decisive, else the (voted) LLM verdict. */
async function decide(
	ctx: ModuleContext,
	settings: SupervisorSettings,
	ledger: Ledger,
	evidence: { readonly text: string; readonly checks: readonly CheckResult[]; readonly noChanges: boolean },
	finalMessage: string,
	signal: AbortSignal,
): Promise<Judgement | undefined> {
	// Without an LLM verdict to read the final message, the question heuristic stands in for it.
	const pre = settings.preVerdict ? preVerdict(evidence.checks, evidence.noChanges) : undefined;
	const deterministic = pre && { ...pre, asked_user: asksUserQuestion(finalMessage) };
	return deterministic ?? (await judgeWithVotes(ctx, settings, ledger, evidence.text, finalMessage, signal));
}

function act(
	ctx: ModuleContext,
	settings: SupervisorSettings,
	task: Task,
	verdict: Verdict,
	evidence: { readonly diffHash: string; readonly noChanges: boolean },
): SettleAction | undefined {
	const { diffHash } = evidence;
	const items = (list: readonly string[] | undefined) =>
		(list ?? [])
			.map((m) => m.trim())
			.filter(Boolean)
			.slice(0, MAX_CRITERIA);
	const missing = items(verdict.missing);
	const unverified = items(verdict.unverified);
	const follow = (text: string, summary: string, data: { readonly [key: string]: string[] }): SettleAction => {
		if (settings.mode === "auto") {
			task.continuations += 1;
			task.lastContinuationDiff = diffHash;
			ctx.record({ kind: "exo.action", data: { action: "continued", continuation: task.continuations, ...data } });
			return { kind: "continue", text, summary };
		}
		task.pending = { text, diffHash };
		ctx.record({ kind: "exo.action", data: { action: "suggested", ...data } });
		return { kind: "suggest", text, summary };
	};
	// Whether the agent is waiting on the user is the verdict's call (D-062): it can tell a blocking
	// question from an offer of more work, which a pattern on the last line cannot.
	if (verdict.verdict === "incomplete" && verdict.asked_user) {
		ctx.record({ kind: "exo.action", data: { action: "skipped", reason: "asked_user" } });
		return { kind: "notify", summary: "supervisor: the agent is waiting for your answer", level: "info" };
	}
	if (verdict.verdict === "incomplete" && missing.length > 0) {
		return follow(continuationMessage(missing), `supervisor: ${missing.length} item(s) look unfinished`, { missing });
	}
	// The judge could not tell from the diff and the test runs. The agent can: it has the whole
	// conversation and the tools. Asked once per task, and never when it is waiting on the user.
	const canVerify = settings.verifyUncertain && !task.verifyAsked && !verdict.asked_user && !evidence.noChanges;
	if (verdict.verdict === "uncertain" && unverified.length > 0 && canVerify) {
		task.verifyAsked = true;
		return follow(verificationMessage(unverified), `supervisor: ${unverified.length} item(s) to verify`, {
			unverified,
		});
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

/**
 * The user-role request to check what the verdict could not see (D-071). The agent reviews its
 * own work, as SWE-agent's submit review and OpenHands' critic follow-up have it do.
 */
export function verificationMessage(unverified: readonly string[]): string {
	return [
		"Before you stop: I could not confirm these parts of my request from your changes and test runs:",
		...unverified.map((m, i) => `${i + 1}. ${m}`),
		"Check each one against my request and show what proves it (a command you run, or the code). Fix whatever turns out not to be done.",
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
			maxTokens: SIDECAR_MAX_TOKENS,
			temperature: 0.2,
			thinking: settings.thinking,
		},
	});
	if (!result.ok) {
		ctx.log(`ledger ${result.outcome}: ${result.error}`);
		return undefined;
	}
	const value = result.value;
	if (!value.is_task) {
		ctx.record({ kind: "exo.ledger", data: { is_task: false } });
		return value.follows_previous ? previous : undefined;
	}
	const ledger: Ledger = {
		requests: value.follows_previous && previous ? [...previous.requests, prompt] : [prompt],
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
	finalMessage: string,
	signal: AbortSignal,
): Promise<{
	readonly text: string;
	readonly diffHash: string;
	readonly checks: readonly CheckResult[];
	readonly noChanges: boolean;
}> {
	const startRef = (await task.startRef) ?? "HEAD";
	const [stat, diff, untracked] = await Promise.all([
		git(ctx, `diff --stat ${startRef}`),
		git(ctx, `diff ${startRef}`),
		git(ctx, "ls-files --others --exclude-standard"),
	]);
	const untrackedFiles = (untracked ?? "").split("\n").filter(Boolean).slice(0, 30);
	// `git diff` leaves out files git does not track yet, which is where new work usually is.
	const tracked = diff;
	const diffWithNew =
		tracked === undefined ? undefined : [tracked, ...(await newFileDiffs(ctx, untrackedFiles))].join("\n");

	const checks = await runChecks(ctx, settings, ledger, signal);
	const tested = lastFullRun(task.tools);
	const [before, now] = tested ? await Promise.all([task.snapshots.get(tested.index), workspaceState(ctx)]) : [];
	const changedSinceTests = before !== undefined && now !== undefined ? before !== now : undefined;
	return {
		text: formatEvidence({
			diffStat: stat,
			diff: diffWithNew,
			untracked: untrackedFiles,
			tools: task.tools,
			...(changedSinceTests === undefined ? {} : { changedSinceTests }),
			checks,
			...(settings.warningSignals ? { warnings: warningsFor(diffWithNew, task.tools, finalMessage) } : {}),
			maxChars: settings.maxEvidenceChars,
		}),
		diffHash: diffFingerprint(diffWithNew, untrackedFiles),
		checks,
		noChanges: madeNoChanges(tracked, untrackedFiles, task.tools),
	};
}

/** The user's check commands (config, and those quoted in the request), run now that the agent has stopped. */
async function runChecks(
	ctx: ModuleContext,
	settings: SupervisorSettings,
	ledger: Ledger,
	signal: AbortSignal,
): Promise<CheckResult[]> {
	const named = new Map<string, CheckResult["source"]>();
	for (const command of settings.runPromptChecks ? ledger.checkCommands : []) named.set(command, "request");
	for (const command of settings.checks) named.set(command, "config");
	const checks: CheckResult[] = [];
	for (const [command, source] of named) {
		if (signal.aborted) break;
		checks.push({
			command,
			output: await ctx.runCommand(command, { timeoutMs: settings.checkTimeoutMs, signal }),
			source,
		});
	}
	return checks;
}

/**
 * Untracked files as "new file" diffs, so the verdict and the warning signals see their content
 * and a continuation that only edits new files still counts as progress. Each file gives its
 * first few thousand characters, smallest file first, so one large file cannot crowd out the rest.
 */
async function newFileDiffs(ctx: ModuleContext, files: readonly string[]): Promise<string[]> {
	const diffs: string[] = [];
	for (const file of files.slice(0, MAX_NEW_FILES)) {
		const quoted = `'${file.replace(/'/g, "'\\''")}'`;
		const out = await ctx
			.runCommand(`git diff --no-index -- /dev/null ${quoted} | head -c ${NEW_FILE_CHARS}`, {
				timeoutMs: GIT_TIMEOUT_MS,
				tailChars: NEW_FILE_CHARS,
			})
			.catch(() => undefined);
		const text = out?.outputTail.trimEnd() ?? "";
		if (text.startsWith("diff --git")) diffs.push(text);
	}
	return diffs.sort((x, y) => x.length - y.length);
}

/** Research R1.2 #4–#7: tampered tests, stubs, unsupported success claims, narrow test runs. */
export function warningsFor(diff: string | undefined, tools: readonly ToolOutcome[], finalMessage: string): string[] {
	const files = parseDiff(diff ?? "");
	const narrow = narrowTestSignal(tools);
	const claims = unsupportedClaims(extractClaims(finalMessage), tools).map(
		(c) => `the agent claims "${c.sentence}" but ran no successful matching command after its last edit`,
	);
	return [...tamperSignals(files), ...stubSignals(files), ...claims, ...(narrow ? [narrow] : [])];
}

/**
 * Research R1.1: verdicts that need no LLM. A check command that fails (run just now, so after
 * every edit) means `incomplete`; a "finished" task that changed nothing is `uncertain`.
 */
export function preVerdict(checks: readonly CheckResult[], noChanges: boolean): Judgement | undefined {
	const failing = checks.filter((c) => c.output.timedOut || c.output.exitCode !== 0);
	if (failing.length > 0) {
		return {
			verdict: "incomplete",
			missing: failing.map((c) => {
				const how = c.output.timedOut ? "it timed out" : `it exits with code ${c.output.exitCode}`;
				return `Make \`${c.command}\` pass (${how})`;
			}),
			asked_user: false,
			reason: "a check command failed",
			source: "deterministic",
		};
	}
	if (noChanges) {
		return {
			verdict: "uncertain",
			missing: [],
			asked_user: false,
			reason: "no changes were made",
			source: "deterministic",
		};
	}
	return undefined;
}

/** Research R1.5: a `complete` verdict must survive re-asking; any dissent downgrades to `uncertain`. */
async function judgeWithVotes(
	ctx: ModuleContext,
	settings: SupervisorSettings,
	ledger: Ledger,
	evidence: string,
	finalMessage: string,
	signal: AbortSignal,
): Promise<Judgement | undefined> {
	const first = await judge(ctx, settings, ledger, evidence, finalMessage, signal, 0.2);
	if (!first) return undefined;
	if (first.verdict !== "complete" || settings.completeVotes <= 1) return { ...first, source: "llm" };
	const others = await Promise.all(
		Array.from({ length: settings.completeVotes - 1 }, () =>
			judge(ctx, settings, ledger, evidence, finalMessage, signal, VOTE_TEMPERATURE),
		),
	);
	const dissent = others.find((v) => v?.verdict !== "complete");
	if (!others.some((v) => v?.verdict !== "complete")) return { ...first, source: "llm", votes: settings.completeVotes };
	return {
		verdict: "uncertain",
		missing: [],
		asked_user: first.asked_user,
		reason: `verdicts disagreed (${dissent?.verdict ?? "unavailable"})`,
		source: "llm",
		votes: settings.completeVotes,
	};
}

async function judge(
	ctx: ModuleContext,
	settings: SupervisorSettings,
	ledger: Ledger,
	evidence: string,
	finalMessage: string,
	signal: AbortSignal,
	temperature: number,
): Promise<Verdict | undefined> {
	const pool = ctx.pool();
	if (!pool) return undefined;
	const criteria = ledger.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
	const userRequest = requestView(ledger.requests);
	const final = finalMessageView(finalMessage, settings.finalMessage);
	const common = { module: SUPERVISOR_ID, priority: "critical" as const, timeoutMs: settings.verdictTimeoutMs, signal };
	const request = (content: string) => ({
		messages: [{ role: "user" as const, content }],
		maxTokens: SIDECAR_MAX_TOKENS,
		temperature,
		thinking: settings.thinking,
	});
	if (settings.verdictStyle === "per-criterion") {
		const result = await pool.run({
			...common,
			schema: ItemVerdictSchema,
			schemaName: "item_verdict",
			request: request(
				ITEM_VERDICT_PROMPT.render({
					request: userRequest,
					criteria,
					evidence,
					final_label: final.label,
					final_message: final.text,
				}),
			),
		});
		if (!result.ok) {
			ctx.log(`verdict ${result.outcome}: ${result.error}`);
			return undefined;
		}
		return aggregateItems(result.value, ledger.criteria, evidence);
	}
	const result = await pool.run({
		...common,
		schema: VerdictSchema,
		schemaName: "verdict",
		request: request(VERDICT_PROMPT.render({ request: userRequest, criteria, evidence, final_message: final.text })),
	});
	if (!result.ok) {
		ctx.log(`verdict ${result.outcome}: ${result.error}`);
		return undefined;
	}
	return result.value;
}

/** The user's messages for this task as the verdict reads them: verbatim, later ones marked as additions. */
function requestView(requests: readonly string[]): string {
	const text = requests.map((r, i) => (i === 0 ? r.trim() : `(The developer then added:)\n${r.trim()}`)).join("\n\n");
	if (text.length <= REQUEST_CHARS) return text;
	const head = Math.floor(REQUEST_CHARS * 0.75);
	return `${text.slice(0, head)}\n… (middle of a long request left out) …\n${text.slice(head - REQUEST_CHARS)}`;
}

/** Research R1.3: in `claims` mode the judge sees the agent's success claims, labelled unverified. */
function finalMessageView(finalMessage: string, mode: SupervisorSettings["finalMessage"]) {
	if (mode === "tail") {
		return { label: "Agent's final message (truncated)", text: finalMessage.slice(-FINAL_MESSAGE_CHARS) };
	}
	const claims = extractClaims(finalMessage).map((c) => `- UNVERIFIED CLAIM: ${c.sentence}`);
	return {
		label: "The agent's unverified claims, then the last words of its final message",
		text: `${claims.length > 0 ? claims.join("\n") : "(no success claims)"}\n…\n${finalMessage.slice(-CLAIMS_TAIL_CHARS)}`,
	};
}

/**
 * Research R1.4: the verdict follows from the items in code. A `met` item must quote a line
 * that really is in the evidence, otherwise it counts as unknown; any unmet item → `incomplete`.
 */
export function aggregateItems(value: ItemVerdict, criteria: readonly string[], evidence: string): Verdict {
	const haystack = normalize(evidence);
	const statuses = criteria.map((criterion, index) => {
		const item = value.items.find((i) => i.criterion === index + 1);
		if (!item) return { status: "unknown", fix: criterion };
		const quoted = item.evidence.trim() !== "" && haystack.includes(normalize(item.evidence));
		if (item.status === "met" && !quoted) return { status: "unknown", fix: criterion };
		return { status: item.status, fix: item.status === "unmet" ? item.fix.trim() || criterion : criterion };
	});
	const base = { asked_user: value.asked_user, reason: value.reason };
	if (value.failed) return { ...base, verdict: "failed", missing: [] };
	const unmet = statuses.filter((s) => s.status === "unmet").map((s) => s.fix);
	if (unmet.length > 0) return { ...base, verdict: "incomplete", missing: unmet };
	if (statuses.every((s) => s.status === "met")) return { ...base, verdict: "complete", missing: [] };
	const unverified = statuses.filter((s) => s.status === "unknown").map((s) => s.fix);
	return { ...base, verdict: "uncertain", missing: [], unverified };
}

function normalize(text: string): string {
	return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * A fingerprint of the workspace's content: tracked changes plus the content of files git does
 * not track or ignore. Undefined outside a git repository or when git is slow. Never rejects.
 */
async function workspaceState(ctx: ModuleContext): Promise<string | undefined> {
	const command =
		"git rev-parse --is-inside-work-tree >/dev/null 2>&1 && " +
		"{ git diff HEAD; git ls-files --others --exclude-standard -z | xargs -0 -r cat; } 2>/dev/null | git hash-object --stdin";
	const out = await ctx.runCommand(command, { timeoutMs: GIT_TIMEOUT_MS }).catch(() => undefined);
	return out && out.exitCode === 0 && !out.timedOut ? out.outputTail.trim() || undefined : undefined;
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
