import {
	type ExoModule,
	loadPrompt,
	type ModuleContext,
	type RunOptions,
	type SettleAction,
	type SettleInfo,
	SIDECAR_MAX_TOKENS,
	startAndEnd,
	type ToolOutcome,
	type UserTurn,
} from "@exocortex/core";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { acceptRequestCheck, checkOutcome, plainTestOrBuild, standing } from "./checks.ts";
import { buildEvidence, type CheckResult, diffFingerprint, touchedFiles } from "./evidence.ts";
import { findingKey, type ReviewResult, reviewChange, reviewMessage, reviewRecord, reviewSummary } from "./review.ts";
import { parseSettings, type SupervisorSettings } from "./settings.ts";
import {
	admitClaims,
	CLAIM_KINDS,
	type Claim,
	lastFullRun,
	madeNoChanges,
	narrowTestSignal,
	parseDiff,
	runnerConfigSignals,
	stubSignals,
	tamperSignals,
	unsupportedClaims,
} from "./signals.ts";
import {
	commitExists,
	isCommitId,
	newFileDiffs,
	newSinceStart,
	taskStart,
	untrackedFiles,
	untrackedStates,
	workspaceFingerprint,
} from "./workspace.ts";

export const SUPERVISOR_ID = "supervisor";

const LEDGER_PROMPT = loadPrompt(new URL("../prompts/ledger.v4.md", import.meta.url));
const VERDICT_PROMPT = loadPrompt(new URL("../prompts/verdict.v7.md", import.meta.url));
const ITEM_VERDICT_PROMPT = loadPrompt(new URL("../prompts/verdict-items.v7.md", import.meta.url));
const FINAL_MESSAGE_PROMPT = loadPrompt(new URL("../prompts/final-message.v1.md", import.meta.url));

const LedgerSchema = Type.Object({
	is_task: Type.Boolean(),
	follows_previous: Type.Boolean(),
	criteria: Type.Array(Type.String(), { maxItems: 16 }),
	check_commands: Type.Array(Type.String(), { maxItems: 10 }),
	/** Commands the message says not to run, or to stop running (D-091). */
	do_not_run: Type.Array(Type.String(), { maxItems: 10 }),
});

const ReadingSchema = Type.Object({
	asked_user: Type.Boolean(),
	claims: Type.Array(
		Type.Object({ kind: Type.Union(CLAIM_KINDS.map((kind) => Type.Literal(kind))), quote: Type.String() }),
		{ maxItems: 6 },
	),
});

/**
 * What the agent's final message says, as a sidecar that judges nothing reads it (D-091): whether
 * the agent is waiting on the user, and its success claims, each one a sentence of the message.
 */
interface Reading {
	readonly asked_user: boolean;
	readonly claims: readonly Claim[];
}

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
	/** Verdicts that were asked for and came back (unanswered ones are not counted). */
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
	/**
	 * Check commands the request names, each accepted by the rule in `checks.ts`. Only these, and
	 * the configured ones, are ever run. A message that continues the task keeps them (D-084).
	 */
	readonly checkCommands: readonly string[];
}

interface Task {
	ledger: Promise<Ledger | undefined>;
	/**
	 * The working tree the task started from, as a commit ({@link taskStart}): `HEAD`, or a snapshot
	 * with the developer's uncommitted edits, so diffs cover commits made during the task and leave
	 * out what was already there (D-102). A message that continues a task takes the earlier one's,
	 * once its ledger says so.
	 */
	startRef: Promise<string | undefined>;
	/** Files git did not track when the task started, by size and time: the developer's, while unchanged (D-102). */
	untrackedAtStart: Promise<ReadonlyMap<string, string>>;
	/**
	 * `HEAD` when this message arrived. Workspace fingerprints for "did the files change since the
	 * tests ran" are all taken against it: `startRef` may change under a fingerprint already taken.
	 */
	readonly ownRef: Promise<string | undefined>;
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
	/** The task's work was reviewed once it was complete (once per task, D-097). */
	reviewed: boolean;
	/** Bugs a review of this task already reported ({@link findingKey}): not reported again. */
	readonly reported: Set<string>;
}

type ReviewTrigger = "settle" | "command";

/** Bugs a task remembers having reported; older ones may be reported again. */
const MAX_REPORTED = 50;

/** What is kept with the session so a rebuilt module carries on with the same task (D-078, D-084). */
const SavedSchema = Type.Object({
	v: Type.Literal(1),
	ledger: Type.Object({
		requests: Type.Array(Type.String(), { maxItems: 64 }),
		criteria: Type.Array(Type.String(), { minItems: 1, maxItems: 16 }),
		checkCommands: Type.Array(Type.String(), { maxItems: 10 }),
	}),
	startRef: Type.Union([Type.String(), Type.Null()]),
	continuations: Type.Integer({ minimum: 0 }),
	pending: Type.Union([Type.Object({ text: Type.String(), diffHash: Type.String() }), Type.Null()]),
	lastContinuationDiff: Type.Union([Type.String(), Type.Null()]),
	noProgressStreak: Type.Integer({ minimum: 0 }),
	verifyAsked: Type.Boolean(),
	reviewed: Type.Optional(Type.Boolean()),
	reported: Type.Optional(Type.Array(Type.String(), { maxItems: MAX_REPORTED })),
});

/** Enough for one criterion per requirement of a long specification (D-071; the brief had 7). */
const MAX_CRITERIA = 12;
/** How much of the user's request the verdict reads; longer ones keep their start and end. */
const REQUEST_CHARS = 16_000;
const REQUEST_CUT = { mark: "… (middle of a long request left out) …", startShare: 0.75 };
/**
 * How much of the agent's final message the verdict reads (D-089). For a review, an explanation or
 * an answer the message is the work, and it is often the only evidence: a longer one keeps its
 * start, where the deliverable is, and its end, where a question to the user is.
 */
const FINAL_MESSAGE_CHARS = 16_000;
/** In `claims` mode the verdict still sees this much of the ending, to spot a question to the user. */
const CLAIMS_TAIL_CHARS = 300;
const VOTE_TEMPERATURE = 0.7;
const GIT_TIMEOUT_MS = 10_000;
/** The longest a timer runs: a check command with no limit of its own (D-098). */
const NO_TIME_LIMIT_MS = 2 ** 31 - 1;
/** Enough of a diff for the evidence budget; a longer one loses its start, and says so. */
const GIT_OUTPUT_CHARS = 256 * 1024;
/** New files whose content is offered to the evidence; each is read up to the evidence budget. */
const MAX_NEW_FILES = 50;
/**
 * The fewest characters, spaces aside, a quoted evidence line must have. `}` and `return x` are in
 * every diff; a line that long is rarely there by chance.
 */
const MIN_QUOTE_CHARS = 12;

/**
 * The supervisor module (brief §6.1, D-010, D-011): extracts a goal ledger from each request,
 * and when the agent stops, gathers deterministic evidence, asks an isolated verdict sidecar
 * whether the request is done, and on `incomplete` suggests (or, in auto mode, sends) a short
 * follow-up listing what is missing. Every failure degrades to doing nothing.
 */
export function createSupervisor(raw: Readonly<Record<string, unknown>>, ctx: ModuleContext): ExoModule {
	const { settings, problems } = parseSettings(raw);
	for (const problem of problems) ctx.log(problem);
	// The task the next settle judges, and the last one that had a ledger: what a later message may continue.
	let task: Task | undefined = restoreTask(ctx, ctx.savedState);
	let anchor: Task | undefined = task;
	let lastVerdict: string | undefined;

	/**
	 * Keeps the task with the session. Resolves once it is saved, and never rejects. A message that
	 * turned out not to be a task leaves the earlier task's state in place: it is still the one a
	 * later message may continue.
	 */
	const persist = async (current: Task): Promise<void> => {
		try {
			const [ledger, startRef] = await Promise.all([current.ledger, current.startRef]);
			if (task !== current || !ledger || ledger.criteria.length === 0) return;
			ctx.saveState({
				v: 1,
				ledger: {
					requests: ledger.requests.slice(-64).map((request) => request.slice(0, REQUEST_CHARS)),
					criteria: [...ledger.criteria],
					checkCommands: [...ledger.checkCommands],
				},
				startRef: startRef ?? null,
				continuations: current.continuations,
				pending: current.pending ?? null,
				lastContinuationDiff: current.lastContinuationDiff ?? null,
				noProgressStreak: current.noProgressStreak,
				verifyAsked: current.verifyAsked,
				reviewed: current.reviewed,
				reported: [...current.reported].slice(-MAX_REPORTED),
			});
		} catch (error) {
			ctx.log(`supervisor state not saved: ${String(error)}`);
		}
	};

	/**
	 * Starts a review of the task's change as a background job (D-097): no time limit, stopped by
	 * the host when the user sends a message or presses Escape. Its findings come back as a
	 * follow-up like the verdict's. False when the host cannot run it.
	 */
	/** A review of the task's change, as a follow-up (D-097); undefined when it was stopped. */
	const reviewAction = async (
		current: Task | undefined,
		requests: readonly string[],
		trigger: ReviewTrigger,
		signal: AbortSignal,
	): Promise<SettleAction | undefined> => {
		const result = await runReview(ctx, settings, current, requests, signal);
		if (signal.aborted) return undefined;
		if (result === undefined) {
			return { kind: "notify", summary: "supervisor: the review got no answer from the engine", level: "warning" };
		}
		// The last wait, before anything about the task changes: a review stopped here changes nothing.
		const diffHash =
			result !== "no_changes" && result.findings.length > 0
				? ((await workspaceFingerprint(ctx, await current?.startRef)) ?? "")
				: "";
		if (signal.aborted) return undefined;
		keepReview(ctx, current, result, trigger);
		if (result === "no_changes") {
			return { kind: "notify", summary: "supervisor: no changes to review since the task began", level: "info" };
		}
		if (result.findings.length === 0) {
			if (current) await persist(current);
			return { kind: "notify", summary: `supervisor: ${reviewSummary(result)}`, level: "info" };
		}
		const action = reviewFollowUp(ctx, settings, current, result, diffHash);
		if (current) await persist(current);
		return {
			...action,
			// Used: sent, put in the editor, or added to the user's draft. A later review does not repeat it.
			commit: () => {
				for (const finding of result.findings) current?.reported.add(findingKey(finding));
				if (current) void persist(current);
			},
		};
	};

	/** `/exo review`: the review as a background job (D-097). False when the host cannot run one. */
	const startReview = (current: Task | undefined, requests: readonly string[]): boolean =>
		ctx.background("reviewing the changes", (signal) => reviewAction(current, requests, "command", signal));

	/**
	 * What the supervisor does once the agent stops (brief §6.1): the ledger, the evidence and the
	 * user's checks, the verdict, its follow-up, and on `complete` the review (D-097). It runs as a
	 * background job, so the user has the session back at once (D-098). Undefined when it was
	 * stopped, which changes nothing: every change to the task comes after the last wait.
	 */
	const judgeWork = async (current: Task, info: SettleInfo, signal: AbortSignal): Promise<SettleAction | undefined> => {
		const skip = (reason: string): undefined => {
			ctx.record({ kind: "exo.action", data: { action: "skipped", reason } });
			return undefined;
		};
		// The ledger is read while the agent works; it has no deadline, only the engine's liveness.
		const ledger = await current.ledger;
		if (signal.aborted) return undefined;
		if (!ledger || ledger.criteria.length === 0) return skip("no_ledger");
		if (current.continuations >= settings.maxContinuations) return skip("max_continuations");

		// Asked at most once per settle, and only if something needs it.
		let asked: Promise<Reading | undefined> | undefined;
		const reading = () => {
			asked ??= readFinalMessage(ctx, settings, info.lastAssistantText, signal);
			return asked;
		};
		const evidence = await gatherEvidence(ctx, settings, current, ledger, reading, signal);
		if (signal.aborted) return undefined;
		// Counted only once the verdict is in: a job stopped during it must leave the streak as it was.
		const { streak, stalled } = nextStreak(current, evidence.diffHash);
		if (stalled) {
			current.noProgressStreak = streak;
			await persist(current);
			return skip("no_progress");
		}

		const verdict = await decide(ctx, settings, ledger, evidence, info.lastAssistantText, reading, signal);
		if (signal.aborted) return undefined;
		current.noProgressStreak = streak;
		if (!verdict) return skip("verdict_unavailable");
		lastVerdict = verdict.verdict;
		recordVerdict(ctx, verdict, ledger, current, evidence);
		return afterVerdict(current, ledger, verdict, evidence, signal);
	};

	/** The follow-up to a verdict: on `complete`, the review's when there is one to run (D-097). */
	const afterVerdict = async (
		current: Task,
		ledger: Ledger,
		verdict: Judgement,
		evidence: Gathered,
		signal: AbortSignal,
	): Promise<SettleAction | undefined> => {
		const reviewNext =
			settings.review &&
			verdict.verdict === "complete" &&
			!verdict.asked_user &&
			!current.reviewed &&
			!evidence.noChanges;
		if (reviewNext) {
			// The verdict's own action on `complete` is a notice; the review's follow-up says more.
			const reviewed = await reviewAction(current, ledger.requests, "settle", signal);
			if (signal.aborted) return undefined;
			if (reviewed?.kind === "notify") {
				return { ...reviewed, summary: reviewed.summary.replace("supervisor: ", "supervisor: complete · ") };
			}
			if (reviewed) return reviewed;
		}
		const action = act(ctx, settings, current, verdict, evidence);
		await persist(current);
		return action;
	};

	return {
		id: SUPERVISOR_ID,

		onUserTurn(turn: UserTurn) {
			// Whatever the last verdict was, it was about the work before this message.
			lastVerdict = undefined;
			const current = task;
			const accepted = current?.pending && acceptance(turn.text, current.pending.text);
			if (current?.pending && accepted) {
				// The user (or eval harness) sent our suggestion, as it was or edited: same task, one more continuation.
				current.continuations += 1;
				current.lastContinuationDiff = current.pending.diffHash;
				current.pending = undefined;
				const { added } = accepted;
				if (added !== "") {
					// What the user wrote into the suggestion is theirs, and part of the request.
					current.ledger = current.ledger.then(
						async (ledger) =>
							ledger && {
								...ledger,
								requests: [...ledger.requests, added],
								checkCommands: await stillWanted(ctx, settings, ledger, added),
							},
					);
				}
				ctx.record({
					kind: "exo.action",
					data: {
						action: "accepted",
						continuation: current.continuations,
						...(accepted.edited ? { edited: true } : {}),
					},
				});
				void persist(current);
				return;
			}
			const earlier = anchor;
			const head = taskStart(ctx);
			const next: Task = {
				ledger: Promise.resolve(undefined),
				startRef: head,
				untrackedAtStart: untrackedStates(ctx),
				ownRef: head,
				tools: [],
				continuations: 0,
				pending: undefined,
				lastContinuationDiff: undefined,
				noProgressStreak: 0,
				verifyAsked: false,
				reviewed: false,
				reported: new Set(),
				snapshots: new Map(),
			};
			next.ledger = Promise.resolve(earlier?.ledger)
				.then((previous) => extractLedger(ctx, settings, turn, previous))
				.then((result) => {
					if (!result) return undefined;
					// The same task goes on: its starting commit, and what the supervisor already spent on it.
					if (result.follows && earlier) {
						next.startRef = earlier.startRef;
						next.untrackedAtStart = earlier.untrackedAtStart;
						next.continuations += earlier.continuations;
						next.lastContinuationDiff ??= earlier.lastContinuationDiff;
						next.noProgressStreak = earlier.noProgressStreak;
						next.verifyAsked ||= earlier.verifyAsked;
						next.reviewed ||= earlier.reviewed;
						for (const key of earlier.reported) next.reported.add(key);
					}
					anchor = next;
					void persist(next);
					return result.ledger;
				})
				.catch((error) => {
					ctx.log(`ledger failed: ${String(error)}`);
					return undefined;
				});
			task = next;
		},

		/** The task's start is taken before the agent changes anything (D-102): its first tool waits for it. */
		async beforeToolCall() {
			const current = task;
			if (current) await Promise.all([current.startRef, current.untrackedAtStart]).catch(() => undefined);
		},

		onToolResult(tool: ToolOutcome) {
			if (!task) return;
			const current = task;
			current.tools.push(tool);
			if (lastFullRun([tool], runOptions(settings))) {
				current.snapshots.set(
					current.tools.length - 1,
					current.ownRef.then((ref) => workspaceFingerprint(ctx, ref)).catch(() => undefined),
				);
			}
		},

		async onSettle(info: SettleInfo, signal: AbortSignal): Promise<SettleAction | undefined> {
			const current = task;
			if (info.outcome !== "completed") return undefined;
			// The agent ran without a message this module saw (it was switched on mid-run, say).
			if (!current) {
				ctx.record({ kind: "exo.action", data: { action: "skipped", reason: "no_task" } });
				return undefined;
			}
			current.pending = undefined;
			// In the background, with no time limit: Escape or a new message stops it (D-098). Without a
			// UI (print mode) nobody types, and it runs here, inside the hook's budget, as before.
			if (ctx.background("checking the work", (jobSignal) => judgeWork(current, info, jobSignal))) return undefined;
			return judgeWork(current, info, signal);
		},

		async command(args: string) {
			if (args.trim() !== "review") return undefined;
			const current = task ?? anchor;
			const ledger = await current?.ledger;
			if (!startReview(current, ledger?.requests ?? [])) {
				return "Review: it runs in the background, which needs pi's interactive UI.";
			}
			return "Reviewing the changes in the background. The findings will go in your editor; Escape or a new message stops the review.";
		},

		status() {
			if (!task) return `supervisor (${settings.mode}): idle`;
			return `supervisor (${settings.mode}): ${lastVerdict ?? "watching"} · ${task.continuations}/${settings.maxContinuations} continuations`;
		},
	};
}

/** The verdict as the trace keeps it, with the criteria and what each check command did. */
function recordVerdict(ctx: ModuleContext, verdict: Judgement, ledger: Ledger, task: Task, evidence: Gathered): void {
	ctx.record({
		kind: "exo.verdict",
		data: {
			...verdict,
			criteria: [...ledger.criteria],
			continuations: task.continuations,
			checks: evidence.checks.map((c) => ({
				command: c.command,
				source: c.source,
				exitCode: c.output.exitCode,
				timedOut: c.output.timedOut,
				outcome: checkOutcome(c.output),
			})),
		},
	});
}

/** The user's configured checks are their definition of "the tests" (D-084): core's reading takes them as test runs. */
function runOptions(settings: SupervisorSettings): RunOptions {
	return { tests: settings.checks };
}

/**
 * The task a previous instance saved, or undefined. Saved state is untrusted (it may be an older
 * version's, or edited): its shape is checked, a starting commit that is not a commit id is
 * dropped, and each check command must pass the same rule as when it was first accepted, against
 * the saved requests.
 */
function restoreTask(ctx: ModuleContext, saved: unknown): Task | undefined {
	if (!Value.Check(SavedSchema, saved)) return undefined;
	const requests = saved.ledger.requests.map((request) => startAndEnd(request, REQUEST_CHARS, REQUEST_CUT));
	const ledger: Ledger = {
		requests,
		criteria: saved.ledger.criteria.slice(0, MAX_CRITERIA),
		checkCommands: saved.ledger.checkCommands.filter((command) =>
			requests.some((request) => acceptRequestCheck(command, request).ok),
		),
	};
	const ref = saved.startRef;
	// A start snapshot is pruned with time (D-102): without it the diff is against `HEAD`.
	const startRef = isCommitId(ref)
		? commitExists(ctx, ref).then((kept) => (kept ? ref : undefined))
		: Promise.resolve(undefined);
	return {
		ledger: Promise.resolve(ledger),
		startRef,
		// Not saved: every untracked file counts as new, as before D-102.
		untrackedAtStart: Promise.resolve(new Map()),
		ownRef: startRef,
		tools: [],
		continuations: saved.continuations,
		pending: saved.pending ?? undefined,
		lastContinuationDiff: saved.lastContinuationDiff ?? undefined,
		noProgressStreak: saved.noProgressStreak,
		verifyAsked: saved.verifyAsked,
		reviewed: saved.reviewed ?? false,
		reported: new Set(saved.reported ?? []),
		snapshots: new Map(),
	};
}

const textLines = (text: string) =>
	text
		.split("\n")
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter(Boolean);

/**
 * Whether the user's message is our suggestion sent back: unchanged, or edited (D-010 logs
 * accept, edit and reject). Edited means at least half of the suggestion's lines are still there;
 * `added` is what the user wrote into it. Anything further from it is a new message, and the
 * ledger sidecar decides whether it continues the task.
 */
function acceptance(
	text: string,
	suggestion: string,
): { readonly edited: boolean; readonly added: string } | undefined {
	const ours = textLines(suggestion);
	const theirs = textLines(text);
	if (ours.join("\n") === theirs.join("\n")) return { edited: false, added: "" };
	const kept = ours.filter((line) => theirs.includes(line)).length;
	if (kept * 2 < ours.length) return undefined;
	return { edited: true, added: theirs.filter((line) => !ours.includes(line)).join("\n") };
}

/**
 * The check commands that what the user wrote into a suggestion leaves standing: all but those the
 * ledger sidecar reads it as saying not to run. With no answer they all stand: the user asked for
 * them, and nothing has been read that takes that back.
 */
async function stillWanted(
	ctx: ModuleContext,
	settings: SupervisorSettings,
	ledger: Ledger,
	added: string,
): Promise<readonly string[]> {
	if (ledger.checkCommands.length === 0) return ledger.checkCommands;
	const value = await askLedger(ctx, settings, added, ledger);
	return value ? standing(ledger.checkCommands, value.do_not_run, added).commands : ledger.checkCommands;
}

/** Brief §6.1 guard: two continuations in a row that leave the diff unchanged stop the supervisor. */
function nextStreak(task: Task, diffHash: string): { readonly streak: number; readonly stalled: boolean } {
	if (task.lastContinuationDiff === undefined) return { streak: task.noProgressStreak, stalled: false };
	const streak = diffHash === task.lastContinuationDiff ? task.noProgressStreak + 1 : 0;
	return { streak, stalled: streak >= 2 };
}

interface Gathered {
	readonly text: string;
	readonly quotable: readonly string[];
	readonly diffHash: string;
	readonly checks: readonly CheckResult[];
	readonly noChanges: boolean;
	/** The agent's success claims, when a setting needs them and the sidecar read them. */
	readonly claims: readonly Claim[] | undefined;
}

/** The deterministic pre-verdict when enabled and decisive, else the (voted) LLM verdict. */
async function decide(
	ctx: ModuleContext,
	settings: SupervisorSettings,
	ledger: Ledger,
	evidence: Gathered,
	finalMessage: string,
	reading: () => Promise<Reading | undefined>,
	signal: AbortSignal,
): Promise<Judgement | undefined> {
	const pre = settings.preVerdict ? preVerdict(evidence.checks, evidence.noChanges) : undefined;
	if (!pre) return judgeWithVotes(ctx, settings, ledger, evidence, finalMessage, signal);
	// `asked_user` only changes what follows an `incomplete` (see `act`).
	if (pre.verdict !== "incomplete") return pre;
	// The failing check gives the verdict. Whether the agent is waiting on the user is a reading of
	// its message, so a sidecar is asked (D-091). With no answer there is no verdict: following up on
	// an agent that may be waiting for the user is the dearer mistake.
	const read = await reading();
	return read && { ...pre, asked_user: read.asked_user };
}

/** A verdict's list as it is used: trimmed, without empty or repeated items, at most one per criterion. */
function items(list: readonly string[] | undefined): string[] {
	return [...new Set((list ?? []).map((m) => m.trim()).filter(Boolean))].slice(0, MAX_CRITERIA);
}

function act(
	ctx: ModuleContext,
	settings: SupervisorSettings,
	task: Task,
	verdict: Verdict,
	evidence: { readonly diffHash: string; readonly noChanges: boolean },
): SettleAction | undefined {
	const { diffHash } = evidence;
	const missing = items(verdict.missing);
	const unverified = items(verdict.unverified);
	const follow = (text: string, summary: string, data: { readonly [key: string]: string[] }): SettleAction =>
		followUp(ctx, settings, task, { text, summary, data, diffHash });
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

/**
 * The task's change reviewed for bugs (D-097): everything since the task began, tracked files with
 * each changed function whole, and new files. "no_changes" when there is nothing to review;
 * undefined when no pass answered or the review was stopped. Changes nothing: see {@link keepReview}.
 */
async function runReview(
	ctx: ModuleContext,
	settings: SupervisorSettings,
	task: Task | undefined,
	requests: readonly string[],
	signal: AbortSignal,
): Promise<ReviewResult | "no_changes" | undefined> {
	try {
		const startRef = await task?.startRef;
		const base = isCommitId(startRef) ? startRef : "HEAD";
		const [tracked, untracked] = await Promise.all([git(ctx, `diff --function-context ${base}`), untrackedFiles(ctx)]);
		const added = task ? await newSinceStart(ctx, untracked ?? [], await task.untrackedAtStart) : (untracked ?? []);
		const shown = await newFileDiffs(ctx.cwd, added, {
			touched: touchedFiles(task?.tools ?? []),
			maxFiles: MAX_NEW_FILES,
			maxBytes: settings.reviewMaxChars,
		});
		const diff = [tracked?.trimEnd() ?? "", ...shown.diffs].filter(Boolean).join("\n");
		if (diff === "") return "no_changes";
		const result = await reviewChange(ctx, settings, { requests, diff, reported: task?.reported ?? new Set() }, signal);
		return signal.aborted ? undefined : result;
	} catch (error) {
		ctx.log(`review failed: ${String(error)}`);
		return undefined;
	}
}

/**
 * A follow-up to the agent (brief §6.1 step 4): in auto mode a continuation, otherwise a
 * suggestion the user sends or edits. Either one counts toward the task's continuations once it
 * is used, and records the diff it was made on, for the no-progress guard.
 */
function followUp(
	ctx: ModuleContext,
	settings: SupervisorSettings,
	task: Task,
	follow: {
		readonly text: string;
		readonly summary: string;
		readonly data: { readonly [key: string]: string[] };
		readonly diffHash: string;
	},
): SettleAction {
	const { text, summary, data, diffHash } = follow;
	if (settings.mode === "auto") {
		task.continuations += 1;
		task.lastContinuationDiff = diffHash;
		ctx.record({ kind: "exo.action", data: { action: "continued", continuation: task.continuations, ...data } });
		return { kind: "continue", text, summary };
	}
	task.pending = { text, diffHash };
	ctx.record({ kind: "exo.action", data: { action: "suggested", ...data } });
	return { kind: "suggest", text, summary };
}

/**
 * What a review that found bugs asks of the agent (D-097). Without a task (a `/exo review` before
 * any request) it is only offered: there is nothing to count it against.
 */
function reviewFollowUp(
	ctx: ModuleContext,
	settings: SupervisorSettings,
	task: Task | undefined,
	result: ReviewResult,
	diffHash: string,
): SettleAction {
	const text = reviewMessage(result.findings);
	const summary = `supervisor: ${reviewSummary(result)}`;
	if (!task) return { kind: "suggest", text, summary };
	if (task.continuations >= settings.maxContinuations) {
		ctx.record({ kind: "exo.action", data: { action: "skipped", reason: "max_continuations" } });
		return { kind: "notify", summary: `${summary} (not sent: the task is at its follow-up limit)`, level: "info" };
	}
	return followUp(ctx, settings, task, {
		text,
		summary,
		data: { findings: result.findings.map((f) => `${f.file}: ${f.title}`) },
		diffHash,
	});
}

/**
 * A review whose result is used: traced. Its bugs are remembered as reported only once its
 * follow-up is used (see `reviewFollowUp`), so a later review may find again what the user never took.
 */
function keepReview(
	ctx: ModuleContext,
	task: Task | undefined,
	result: ReviewResult | "no_changes",
	trigger: ReviewTrigger,
): void {
	if (result === "no_changes") return;
	if (task && trigger === "settle") task.reviewed = true;
	ctx.record({ kind: "exo.review", data: { trigger, ...reviewRecord(result) } });
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

/**
 * The ledger for a message, and whether the message continues the earlier task (`previous`).
 * Undefined when the sidecar is unavailable or the message is neither a task nor a continuation.
 */
async function extractLedger(
	ctx: ModuleContext,
	settings: SupervisorSettings,
	turn: UserTurn,
	previous: Ledger | undefined,
): Promise<{ readonly ledger: Ledger; readonly follows: boolean } | undefined> {
	const prompt = turn.text;
	const value = await askLedger(ctx, settings, prompt, previous);
	if (!value) return undefined;
	const continued = value.follows_previous ? previous : undefined;
	// Safety (D-011, D-084): the sidecar proposes commands, `checks.ts` decides which may be run.
	const proposed = [...new Set(value.check_commands.map((c) => c.trim()).filter(Boolean))];
	const inUse = continued?.checkCommands ?? [];
	const left = standing([...inUse, ...proposed], value.do_not_run, prompt);
	// A message that goes on with the task keeps its check commands, unless it says to stop running one.
	const carried = inUse.filter((command) => left.commands.includes(command));
	const stopped = inUse.filter((command) => !carried.includes(command));
	if (!value.is_task) {
		ctx.record({ kind: "exo.ledger", data: { is_task: false, ...(stopped.length > 0 ? { stopped } : {}) } });
		return continued && { ledger: { ...continued, checkCommands: carried }, follows: true };
	}
	const refusedByRequest =
		left.unidentified === undefined
			? "the request says not to run it"
			: `the request says not to run "${left.unidentified.slice(0, 80)}", which could not be matched to a command`;
	const refused: { command: string; reason: string }[] = [];
	const accepted = proposed.filter((command) => {
		const verdict =
			turn.origin !== "user"
				? { ok: false as const, reason: "the message was not typed by the user" }
				: left.commands.includes(command)
					? acceptRequestCheck(command, prompt)
					: { ok: false as const, reason: refusedByRequest };
		if (!verdict.ok) refused.push({ command, reason: verdict.reason });
		return verdict.ok;
	});
	const ledger: Ledger = {
		requests: continued ? [...continued.requests, prompt] : [prompt],
		criteria: value.criteria
			.map((c) => c.trim())
			.filter(Boolean)
			.slice(0, MAX_CRITERIA),
		checkCommands: [...new Set([...carried, ...accepted])],
	};
	ctx.record({
		kind: "exo.ledger",
		data: {
			is_task: true,
			follows_previous: continued !== undefined,
			criteria: [...ledger.criteria],
			checks: [...ledger.checkCommands],
			refused,
			...(stopped.length > 0 ? { stopped } : {}),
		},
	});
	return { ledger, follows: continued !== undefined };
}

/** What the ledger sidecar reads in one message; undefined when there is no sidecar or it failed. */
async function askLedger(
	ctx: ModuleContext,
	settings: SupervisorSettings,
	prompt: string,
	previous: Ledger | undefined,
): Promise<Static<typeof LedgerSchema> | undefined> {
	const list = (items: readonly string[] | undefined) =>
		items?.length ? items.map((c) => `- ${c}`).join("\n") : "(none)";
	const result = await ctx.pool()?.run({
		module: SUPERVISOR_ID,
		priority: "interactive",
		schema: LedgerSchema,
		schemaName: "goal_ledger",
		request: {
			messages: [
				{
					role: "user",
					content: LEDGER_PROMPT.render({
						prompt,
						previous: list(previous?.criteria),
						previous_checks: list(previous?.checkCommands),
					}),
				},
			],
			maxTokens: SIDECAR_MAX_TOKENS,
			temperature: 0.2,
			thinking: settings.thinking,
		},
	});
	if (result && !result.ok) ctx.log(`ledger ${result.outcome}: ${result.error}`);
	return result?.ok ? result.value : undefined;
}

/**
 * The final-message sidecar's reading (D-091), or undefined when it did not answer. Its claims are
 * kept only when each is a sentence of the message (`admitClaims`). An empty message says nothing.
 */
async function readFinalMessage(
	ctx: ModuleContext,
	settings: SupervisorSettings,
	finalMessage: string,
	signal: AbortSignal,
): Promise<Reading | undefined> {
	if (finalMessage.trim() === "") return { asked_user: false, claims: [] };
	const result = await ctx.pool()?.run({
		module: SUPERVISOR_ID,
		priority: "critical",
		signal,
		schema: ReadingSchema,
		schemaName: "final_message",
		request: {
			messages: [{ role: "user", content: FINAL_MESSAGE_PROMPT.render(finalMessageView(finalMessage, "message")) }],
			maxTokens: SIDECAR_MAX_TOKENS,
			temperature: 0.2,
			thinking: settings.thinking,
		},
	});
	if (result && !result.ok) ctx.log(`final message ${result.outcome}: ${result.error}`);
	return result?.ok
		? { asked_user: result.value.asked_user, claims: admitClaims(result.value.claims, finalMessage) }
		: undefined;
}

async function gatherEvidence(
	ctx: ModuleContext,
	settings: SupervisorSettings,
	task: Task,
	ledger: Ledger,
	reading: () => Promise<Reading | undefined>,
	signal: AbortSignal,
): Promise<Gathered> {
	// Asked now, so the sidecar reads the message while git and the checks run.
	const claimed = settings.warningSignals || settings.finalMessage === "claims" ? reading() : undefined;
	const [startRef, ownRef] = await Promise.all([task.startRef, task.ownRef]);
	const base = isCommitId(startRef) ? startRef : "HEAD";
	const [stat, tracked, untracked] = await Promise.all([
		git(ctx, `diff --stat ${base}`),
		gitDiff(ctx, base),
		untrackedFiles(ctx),
	]);
	const newFiles = await newSinceStart(ctx, untracked ?? [], await task.untrackedAtStart);
	// `git diff` leaves out files git does not track yet, which is where new work usually is.
	const shown = await newFileDiffs(ctx.cwd, newFiles, {
		touched: touchedFiles(task.tools),
		maxFiles: MAX_NEW_FILES,
		maxBytes: settings.maxEvidenceChars,
	});
	const diffWithNew =
		tracked === undefined ? undefined : [tracked.trimEnd(), ...shown.diffs].filter(Boolean).join("\n");

	const checks = await runChecks(ctx, settings, ledger, signal);
	const runs = runOptions(settings);
	const tested = lastFullRun(task.tools, runs);
	const [before, now] = tested
		? await Promise.all([task.snapshots.get(tested.index), workspaceFingerprint(ctx, ownRef)])
		: [];
	const changedSinceTests = before !== undefined && now !== undefined ? before !== now : undefined;
	// Progress is measured on the files themselves, shown to the judge or not: the text of the
	// evidence leaves out what does not fit.
	const state = now !== undefined && startRef === ownRef ? now : await workspaceFingerprint(ctx, startRef);
	const claims = (await claimed)?.claims;
	const evidence = buildEvidence({
		diffStat: stat,
		diff: diffWithNew,
		untracked: newFiles,
		newFilesNotShown: shown.notShown,
		tools: task.tools,
		...(changedSinceTests === undefined ? {} : { changedSinceTests }),
		checks,
		...(settings.warningSignals ? { warnings: warningsFor(diffWithNew, task.tools, claims ?? [], runs) } : {}),
		runs,
		maxChars: settings.maxEvidenceChars,
	});
	return {
		...evidence,
		diffHash: state ?? diffFingerprint(diffWithNew, newFiles),
		checks,
		noChanges: madeNoChanges(tracked, newFiles, task.tools),
		claims,
	};
}

/**
 * The user's check commands (config, and those their request named), run now that the agent has
 * stopped. Each is shown while it runs (D-011): these are shell commands in the user's tree.
 */
async function runChecks(
	ctx: ModuleContext,
	settings: SupervisorSettings,
	ledger: Ledger,
	signal: AbortSignal,
): Promise<CheckResult[]> {
	const named = new Map<string, CheckResult["source"]>();
	for (const command of settings.runPromptChecks ? ledger.checkCommands : []) {
		// Checked where it is run as well as where it was accepted: nothing else may put a command here.
		if (plainTestOrBuild(command).ok) named.set(command, "request");
	}
	for (const command of settings.checks) named.set(command, "config");
	const checks: CheckResult[] = [];
	for (const [command, source] of named) {
		if (signal.aborted) break;
		ctx.progress(`running: ${command}`);
		checks.push({
			command,
			// The user's own command takes as long as it takes, unless they set a limit (D-098).
			output: await ctx.runCommand(command, { timeoutMs: settings.checkTimeoutMs ?? NO_TIME_LIMIT_MS, signal }),
			source,
		});
	}
	return checks;
}

/** Research R1.2 #4–#7: tampered tests, stubs, unsupported success claims, narrow test runs. */
export function warningsFor(
	diff: string | undefined,
	tools: readonly ToolOutcome[],
	claimed: readonly Claim[],
	runs: RunOptions = {},
): string[] {
	const files = parseDiff(diff ?? "");
	const narrow = narrowTestSignal(tools, runs);
	const claims = unsupportedClaims(claimed, tools, runs).map(
		(c) => `the agent claims "${c.sentence}" but ran no matching command that passed after its last edit`,
	);
	return [
		...tamperSignals(files),
		...runnerConfigSignals(files),
		...stubSignals(files),
		...claims,
		...(narrow ? [narrow] : []),
	];
}

/**
 * Research R1.1: verdicts that need no LLM. A check command that fails (run just now, so after
 * every edit) means `incomplete`; a "finished" task that changed nothing is `uncertain`. A check
 * that did not finish (it timed out or was killed) is neither: it never yields `incomplete`.
 */
export function preVerdict(checks: readonly CheckResult[], noChanges: boolean): Judgement | undefined {
	const failing = checks.filter((c) => checkOutcome(c.output) === "failed");
	if (failing.length > 0) {
		return {
			verdict: "incomplete",
			missing: failing.map((c) => `Make \`${c.command}\` pass (it exits with code ${c.output.exitCode})`),
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

/**
 * A verdict that agrees with its own lists (D-084): `complete` means nothing is missing and
 * nothing is unverified, whatever word the judge chose.
 */
function consistent(verdict: Verdict): Verdict {
	const missing = items(verdict.missing);
	const unverified = items(verdict.unverified);
	const lists = { missing, ...(verdict.unverified === undefined ? {} : { unverified }) };
	if (verdict.verdict !== "complete") return { ...verdict, ...lists };
	if (missing.length > 0) {
		return {
			...verdict,
			...lists,
			verdict: "incomplete",
			reason: `called complete with items missing: ${verdict.reason}`,
		};
	}
	if (unverified.length > 0) {
		return {
			...verdict,
			...lists,
			verdict: "uncertain",
			reason: `called complete with items unverified: ${verdict.reason}`,
		};
	}
	return { ...verdict, ...lists };
}

/**
 * Research R1.5: a `complete` verdict must survive re-asking; any dissent downgrades to
 * `uncertain`, and what the dissenters found goes on as items to verify. A vote that never came
 * back (a timeout, an engine error) is no vote: it is not counted for or against.
 */
async function judgeWithVotes(
	ctx: ModuleContext,
	settings: SupervisorSettings,
	ledger: Ledger,
	evidence: Gathered,
	finalMessage: string,
	signal: AbortSignal,
): Promise<Judgement | undefined> {
	const first = await judge(ctx, settings, ledger, evidence, finalMessage, signal, 0.2);
	if (!first) return undefined;
	if (first.verdict !== "complete" || settings.completeVotes <= 1) return { ...first, source: "llm" };
	const asked = await Promise.all(
		Array.from({ length: settings.completeVotes - 1 }, () =>
			judge(ctx, settings, ledger, evidence, finalMessage, signal, VOTE_TEMPERATURE),
		),
	);
	const others = asked.filter((v) => v !== undefined);
	const votes = others.length + 1;
	const dissenters = others.filter((v) => v.verdict !== "complete");
	if (dissenters.length === 0) return { ...first, source: "llm", votes };
	return {
		verdict: "uncertain",
		missing: [],
		unverified: items(dissenters.flatMap((v) => [...v.missing, ...(v.unverified ?? [])])),
		asked_user: first.asked_user,
		reason: `verdicts disagreed (${dissenters[0]?.verdict})`,
		source: "llm",
		votes,
	};
}

async function judge(
	ctx: ModuleContext,
	settings: SupervisorSettings,
	ledger: Ledger,
	evidence: Gathered,
	finalMessage: string,
	signal: AbortSignal,
	temperature: number,
): Promise<Verdict | undefined> {
	const pool = ctx.pool();
	if (!pool) return undefined;
	const criteria = ledger.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
	const userRequest = requestView(ledger.requests);
	const final = finalMessageView(finalMessage, settings.finalMessage, evidence.claims);
	const common = { module: SUPERVISOR_ID, priority: "critical" as const, signal };
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
				ITEM_VERDICT_PROMPT.render({ request: userRequest, criteria, evidence: evidence.text, ...final }),
			),
		});
		if (!result.ok) {
			ctx.log(`verdict ${result.outcome}: ${result.error}`);
			return undefined;
		}
		return aggregateItems(result.value, ledger.criteria, evidence.quotable);
	}
	const result = await pool.run({
		...common,
		schema: VerdictSchema,
		schemaName: "verdict",
		request: request(VERDICT_PROMPT.render({ request: userRequest, criteria, evidence: evidence.text, ...final })),
	});
	if (!result.ok) {
		ctx.log(`verdict ${result.outcome}: ${result.error}`);
		return undefined;
	}
	return consistent(result.value);
}

/** The user's messages for this task as the verdict reads them: verbatim, later ones marked as additions. */
function requestView(requests: readonly string[]): string {
	const text = requests.map((r, i) => (i === 0 ? r.trim() : `(The developer then added:)\n${r.trim()}`)).join("\n\n");
	return startAndEnd(text, REQUEST_CHARS, REQUEST_CUT);
}

/**
 * The agent's final message as the verdict reads it, under a heading that says how much of it that
 * is (D-089): the judge takes what it is not shown for absent unless it is told.
 * - `message`: all of it, or the start and the end of a long one with the gap marked.
 * - `claims` (research R1.3): only its success claims as a sidecar read them (D-091), labelled
 *   unverified, and its last words. `claims` is undefined when that sidecar did not answer.
 */
function finalMessageView(finalMessage: string, mode: SupervisorSettings["finalMessage"], claims?: readonly Claim[]) {
	const message = finalMessage.trim();
	if (mode === "message") {
		const leftOut = message.length - FINAL_MESSAGE_CHARS;
		return {
			final_label:
				leftOut > 0 ? "Agent's final message (long: its middle is not shown)" : "Agent's final message (all of it)",
			final_message: startAndEnd(message, FINAL_MESSAGE_CHARS, {
				mark: `… (${leftOut} characters in the middle of the message are not shown) …`,
				startShare: 0.75,
			}),
		};
	}
	const listed =
		claims === undefined
			? "(the agent's claims could not be read)"
			: claims.map((c) => `- UNVERIFIED CLAIM: ${c.sentence}`).join("\n") || "(no success claims)";
	return {
		final_label:
			"The agent's unverified claims, then the last words of its final message (the text of the message is not shown)",
		final_message: `${listed}\n…\n${message.slice(-CLAIMS_TAIL_CHARS)}`,
	};
}

/**
 * Whether `quote` is, or is part of, one of the evidence's quotable lines, and long enough to
 * show something. A quote spanning lines is in none of them. The marker a line starts with
 * (`+`, `-`, `$`) may be left off.
 */
function isQuoted(quote: string, quotable: readonly string[]): boolean {
	if (quote.trim().includes("\n")) return false;
	const wanted = normalize(quote);
	if (wanted.replace(/^[+\-$]/, "").replace(/\s/g, "").length < MIN_QUOTE_CHARS) return false;
	return quotable.some((line) => normalize(line).includes(wanted));
}

/**
 * Research R1.4: the verdict follows from the items in code. A `met` item must quote a line that
 * really is in the evidence and can show something (`quotable`: see `Evidence`), otherwise it
 * counts as unknown; any unmet item → `incomplete`.
 */
export function aggregateItems(value: ItemVerdict, criteria: readonly string[], quotable: readonly string[]): Verdict {
	const statuses = criteria.map((criterion, index) => {
		const item = value.items.find((i) => i.criterion === index + 1);
		if (!item) return { status: "unknown", fix: criterion };
		if (item.status === "met" && !isQuoted(item.evidence, quotable)) return { status: "unknown", fix: criterion };
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

/** stdout of a git command, or undefined when it fails (e.g. not a repository). Names are printed as they are. */
async function git(ctx: ModuleContext, args: string): Promise<string | undefined> {
	const out = await ctx.runCommand(`git -c core.quotePath=false ${args}`, {
		timeoutMs: GIT_TIMEOUT_MS,
		tailChars: GIT_OUTPUT_CHARS,
	});
	return out.exitCode === 0 ? out.outputTail : undefined;
}

/** `git diff <base>`. Only the end of a very long one is kept: it then starts at a file, and says what is gone. */
async function gitDiff(ctx: ModuleContext, base: string): Promise<string | undefined> {
	const diff = await git(ctx, `diff ${base}`);
	if (diff === undefined || diff.length < GIT_OUTPUT_CHARS) return diff;
	const firstWhole = diff.indexOf("\ndiff --git ");
	return `(the diff is very long: the files at its start are not shown)\n${firstWhole === -1 ? "" : diff.slice(firstWhole + 1)}`;
}
