import { createHash } from "node:crypto";
import {
	type ExoModule,
	loadPrompt,
	type ModuleContext,
	type RunOptions,
	type SettleAction,
	type SettleInfo,
	SIDECAR_MAX_TOKENS,
	SIDECAR_THINKING_TOKENS,
	startAndEnd,
	type ToolOutcome,
	type UserTurn,
} from "@exocortex/core";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { acceptRequestCheck, checkOutcome, plainTestOrBuild, standing } from "./checks.ts";
import { type CheckResult, diffFingerprint, formatEvidence, touchedFiles } from "./evidence.ts";
import {
	type Finding,
	findingKey,
	type ReviewResult,
	reviewChange,
	reviewMessage,
	reviewRecord,
	reviewSummary,
} from "./review.ts";
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
	type GitResult,
	git,
	isByproduct,
	isCommitId,
	listUntracked,
	newFileDiffs,
	newSinceStart,
	notARepository,
	taskStart,
	untrackedStates,
	workspaceFingerprint,
} from "./workspace.ts";

export const SUPERVISOR_ID = "supervisor";

const LEDGER_PROMPT = loadPrompt(new URL("../prompts/ledger.v5.md", import.meta.url));
const VERDICT_PROMPT = loadPrompt(new URL("../prompts/verdict.v8.md", import.meta.url));
const FINAL_MESSAGE_PROMPT = loadPrompt(new URL("../prompts/final-message.v1.md", import.meta.url));

/** What the ledger sidecar reads in a message: how it changes the open task (D-107). */
const LedgerSchema = Type.Object({
	relation: Type.Union([
		Type.Literal("new_task"),
		Type.Literal("continues"),
		Type.Literal("closes"),
		Type.Literal("chat"),
	]),
	added_criteria: Type.Array(Type.String()),
	/** Items of the open task's checklist the message takes back, 1-based. */
	dropped_criteria: Type.Array(Type.Integer()),
	check_commands: Type.Array(Type.String()),
	/** Commands the message says not to run, or to stop running (D-091). */
	do_not_run: Type.Array(Type.String()),
});
type LedgerReading = Static<typeof LedgerSchema>;
type Relation = LedgerReading["relation"];

const ReadingSchema = Type.Object({
	asked_user: Type.Boolean(),
	claims: Type.Array(
		Type.Object({ kind: Type.Union(CLAIM_KINDS.map((kind) => Type.Literal(kind))), quote: Type.String() }),
	),
});

const VerdictSchema = Type.Object({
	verdict: Type.Union([
		Type.Literal("complete"),
		Type.Literal("incomplete"),
		Type.Literal("failed"),
		Type.Literal("uncertain"),
	]),
	missing: Type.Array(Type.String()),
	/** Items the evidence shows neither way, as instructions to check them. */
	unverified: Type.Optional(Type.Array(Type.String())),
	asked_user: Type.Boolean(),
	reason: Type.String(),
});

export type Verdict = Static<typeof VerdictSchema>;
/** A verdict as it is used and recorded: its lists cleaned, and agreeing with its word (D-084). */
export type Judgement = Verdict;

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

/**
 * What a user message turned out to be, once the ledger sidecar read it (D-107):
 * - `task`: there is a task to judge, new or carried on (`continues`, `chat`);
 * - `closed`: the user ended the open task;
 * - `none`: no work was asked for and no task is open;
 * - `failed`: the sidecar could not read the message;
 * - `offline`: there is no sidecar engine.
 */
type Turn =
	| { readonly kind: "task"; readonly ledger: Ledger; readonly relation: Relation | "restored" }
	| { readonly kind: "closed" }
	| { readonly kind: "none" }
	| { readonly kind: "offline" }
	| { readonly kind: "failed"; readonly error: string };

interface Snapshot {
	readonly ref: string | undefined;
	readonly fingerprint: string | undefined;
}

interface Task {
	turn: Promise<Turn>;
	/**
	 * The task that is open once this message has been read: this one, an earlier one it did not
	 * replace, or none once the user closed it. What a later message continues.
	 */
	open: Promise<Task | undefined>;
	/**
	 * The working tree the task started from, as a commit ({@link taskStart}): `HEAD`, or a snapshot
	 * with the developer's uncommitted edits, so diffs cover commits made during the task and leave
	 * out what was already there (D-102). A message that continues a task takes the earlier one's.
	 */
	startRef: Promise<string | undefined>;
	/** Files git did not track when the task started, by size and time: the developer's, while unchanged (D-102). */
	untrackedAtStart: Promise<ReadonlyMap<string, string>>;
	/** `HEAD` when this message arrived: what a snapshot after a test run is taken against. */
	readonly ownRef: Promise<string | undefined>;
	/** The task's tool calls, oldest first, over all its messages (D-107). */
	readonly tools: ToolOutcome[];
	/** What the workspace held when each of the agent's test or build runs ended. */
	readonly snapshots: Map<ToolOutcome, Promise<Snapshot>>;
	/** The agent's replies to the task's earlier messages, oldest first (D-107). */
	earlierReplies: string[];
	/** Its replies since the latest message, as of the last settle. */
	replies: string[];
	/** Auto-mode continuations sent: what `maxContinuations` limits (D-107). */
	autoContinuations: number;
	/** Follow-ups the agent was given (sent, or a suggestion the user sent): a reason to judge again. */
	followUps: number;
	pending: { readonly text: string; readonly diffHash: string } | undefined;
	lastContinuationDiff: string | undefined;
	noProgressStreak: number;
	/** The agent was already asked to check what the verdict could not see (once per task). */
	verifyAsked: boolean;
	/** The task's work was reviewed (once per task, D-097). */
	reviewed: boolean;
	/** Bugs a review of this task already reported ({@link findingKey}): not reported again. */
	readonly reported: Set<string>;
	/** The last judgment: what it was made on, and what it said. The same state is not judged again (D-107). */
	judged:
		| {
				readonly key: string;
				readonly summary: string;
				/** Its follow-up, offered again while nothing changes (not saved). */
				readonly action?: SettleAction;
		  }
		| undefined;
}

type ReviewTrigger = "settle" | "command";
/** A review that could not run: git or the engine failed. */
interface ReviewError {
	readonly error: string;
}

/** Bugs a task remembers having reported; older ones may be reported again. */
const MAX_REPORTED = 50;
/** Enough for any real checklist; past it the newest items are kept, and the cut is logged (D-107). */
const MAX_CRITERIA = 32;
/** A task's tool calls kept for the evidence; the oldest go first. */
const MAX_TOOLS = 1_000;
/**
 * What is saved of the requests and replies (D-107): the host keeps at most 256 KB of a module's
 * state, and each change is a line in the session file. Each request up to 16,000 characters and
 * all of them up to 64,000; replies up to 4,000 each and 32,000 in all, the newest kept.
 */
const SAVED_REQUEST_CHARS = 16_000;
const SAVED_REQUESTS_TOTAL = 64_000;
const SAVED_REPLY_CHARS = 4_000;
const SAVED_REPLIES_TOTAL = 32_000;
/** New files at the task's start kept with the session; past this, the rest count as new after a reload. */
const SAVED_UNTRACKED = 500;
/** The most the saved state may take as JSON: under the host's 256 KB, with room to spare. */
const SAVED_STATE_CHARS = 200_000;

/** What is kept with the session so a rebuilt module carries on with the same task (D-078, D-084, D-107). */
const SavedSchema = Type.Object({
	v: Type.Literal(2),
	ledger: Type.Object({
		requests: Type.Array(Type.String()),
		criteria: Type.Array(Type.String(), { minItems: 1 }),
		checkCommands: Type.Array(Type.String()),
	}),
	startRef: Type.Union([Type.String(), Type.Null()]),
	untrackedAtStart: Type.Array(Type.Tuple([Type.String(), Type.String()])),
	replies: Type.Array(Type.String()),
	autoContinuations: Type.Integer({ minimum: 0 }),
	followUps: Type.Integer({ minimum: 0 }),
	pending: Type.Union([Type.Object({ text: Type.String(), diffHash: Type.String() }), Type.Null()]),
	lastContinuationDiff: Type.Union([Type.String(), Type.Null()]),
	noProgressStreak: Type.Integer({ minimum: 0 }),
	verifyAsked: Type.Boolean(),
	reviewed: Type.Boolean(),
	reported: Type.Array(Type.String()),
	judged: Type.Union([Type.Object({ key: Type.String(), summary: Type.String() }), Type.Null()]),
});

/**
 * Budgets (D-107): a share of the main model's context window, so a strong model with a long window
 * reads the evidence whole instead of a fixed 40,000 characters. The verdict and the review run
 * while the agent is idle; their prefill delays nothing but them.
 *
 * What a judging call may write comes off first: its answer and its thinking room
 * (`SIDECAR_MAX_TOKENS + SIDECAR_THINKING_TOKENS`), and the prompt's own text. Of what is left a
 * share is used, at ~3 characters per token (code tokenizes denser than prose).
 */
const CHARS_PER_TOKEN = 3;
const OUTPUT_TOKENS = SIDECAR_MAX_TOKENS + SIDECAR_THINKING_TOKENS;
/** The prompt template, the checklist and the JSON instruction, generously. */
const TEMPLATE_TOKENS = 4_000;
/** The share of the input room used: margin for a tokenizer that counts more than three characters per token. */
const INPUT_SHARE = 0.75;
/** The least input room assumed, for a window too small to leave any. */
const MIN_INPUT_TOKENS = 4_000;
/** The window assumed when the harness does not say. */
const FALLBACK_WINDOW_TOKENS = 65_536;
const REQUEST_SHARE = 0.15;
const REPLIES_SHARE = 0.25;
const REQUEST_CUT = { mark: "… (middle of a long request left out) …", startShare: 0.75 };

interface Budgets {
	readonly requests: number;
	readonly replies: number;
	readonly evidence: number;
	/** What one review prompt reads in all: the request, the uses and the change. */
	readonly review: number;
}

function budgetsFor(contextWindow: number | undefined): Budgets {
	const window = contextWindow !== undefined && contextWindow > 0 ? contextWindow : FALLBACK_WINDOW_TOKENS;
	const input = Math.max(MIN_INPUT_TOKENS, window - OUTPUT_TOKENS - TEMPLATE_TOKENS);
	const total = Math.floor(input * INPUT_SHARE * CHARS_PER_TOKEN);
	return {
		requests: Math.floor(total * REQUEST_SHARE),
		replies: Math.floor(total * REPLIES_SHARE),
		evidence: Math.floor(total * (1 - REQUEST_SHARE - REPLIES_SHARE)),
		review: total,
	};
}

/** The longest a timer runs: a check command with no limit of its own (D-098). */
const NO_TIME_LIMIT_MS = 2 ** 31 - 1;
/** Enough of a diff for any budget; a longer one loses its start, and says so. */
const GIT_OUTPUT_CHARS = 8 * 1024 * 1024;
/** New files whose content is offered to the evidence; each is read up to the evidence budget. */
const MAX_NEW_FILES = 50;
/** Git's empty tree: what a repository with no commit yet is diffed against. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * The supervisor module (brief §6.1, D-010, D-011, D-107): reads how each user message changes the
 * task's checklist, and when the agent stops, gathers deterministic evidence, asks an isolated
 * verdict sidecar whether the request is done, and follows up: on `incomplete` with what is
 * missing, on `uncertain` with what to verify, and with the bugs a review of the change found.
 * Failures are said, not swallowed; none of them stops the session.
 */
export function createSupervisor(raw: Readonly<Record<string, unknown>>, ctx: ModuleContext): ExoModule {
	const { settings, problems } = parseSettings(raw);
	for (const problem of problems) ctx.log(problem);
	// The task the next settle judges (the latest message's).
	let task: Task | undefined = restoreTask(ctx, ctx.savedState);
	let lastSummary: string | undefined;
	let lastWindow: number | undefined;

	/** Keeps the task with the session. Resolves once it is saved, and never rejects. */
	const persist = async (current: Task): Promise<void> => {
		try {
			const [turn, startRef, untracked] = await Promise.all([current.turn, current.startRef, current.untrackedAtStart]);
			if (task !== current) return;
			// A closed task, or one whose every item was dropped, is not picked up again (D-107).
			if (turn.kind === "closed" || (turn.kind === "task" && turn.ledger.criteria.length === 0)) {
				ctx.saveState(null);
				return;
			}
			if (turn.kind !== "task") return;
			const { ledger } = turn;
			ctx.saveState(
				fitSaved({
					v: 2,
					ledger: {
						requests: savedRequests(ledger.requests),
						criteria: [...ledger.criteria],
						checkCommands: [...ledger.checkCommands],
					},
					startRef: startRef ?? null,
					untrackedAtStart: [...untracked].slice(0, SAVED_UNTRACKED).map(([path, state]) => [path, state]),
					replies: savedReplies([...current.earlierReplies, ...current.replies]),
					autoContinuations: current.autoContinuations,
					followUps: current.followUps,
					pending: current.pending ?? null,
					lastContinuationDiff: current.lastContinuationDiff ?? null,
					noProgressStreak: current.noProgressStreak,
					verifyAsked: current.verifyAsked,
					reviewed: current.reviewed,
					reported: [...current.reported].slice(-MAX_REPORTED),
					judged: current.judged ? { key: current.judged.key, summary: current.judged.summary } : null,
				}),
			);
		} catch (error) {
			ctx.log(`supervisor state not saved: ${String(error)}`);
		}
	};

	/** A review of the task's change on its own, as a follow-up (`/exo review`, D-097); undefined when it was stopped. */
	const reviewAction = async (
		current: Task | undefined,
		requests: readonly string[],
		signal: AbortSignal,
	): Promise<SettleAction | undefined> => {
		const result = await runReview(ctx, settings, current, requests, budgetsFor(lastWindow), signal);
		if (signal.aborted) return undefined;
		if (failedReview(result)) {
			return { kind: "notify", summary: `supervisor: the review could not run: ${result.error}`, level: "warning" };
		}
		keepReview(ctx, current, result, "command");
		if (result === "no_changes") {
			return { kind: "notify", summary: "supervisor: no changes to review since the task began", level: "info" };
		}
		if (result.findings.length === 0) {
			return { kind: "notify", summary: `supervisor: ${reviewSummary(result)}`, level: "info" };
		}
		const text = reviewMessage(result.findings);
		const summary = `supervisor: ${reviewSummary(result)}`;
		// Without a task (a review before any request) it is only offered: there is nothing to count it against.
		if (!current) return { kind: "suggest", text, summary };
		// Measured as a verdict's follow-up is, so the no-progress guard compares like with like (D-107).
		const state = (await workspaceFingerprint(ctx, await current.startRef, signal)) ?? "";
		const diffHash = progressHash(state, lastReply(current));
		if (signal.aborted) return undefined;
		return followUp(ctx, settings, current, {
			text,
			summary,
			data: { findings: result.findings.map((f) => `${f.file}: ${f.title}`) },
			diffHash,
			onCommit: () => {
				for (const finding of result.findings) current.reported.add(findingKey(finding));
			},
			persist,
		});
	};

	/**
	 * What the supervisor does once the agent stops (brief §6.1): the evidence and the user's
	 * checks, the verdict, its follow-up, and the review (D-097). It runs as a background job, so
	 * the user has the session back at once (D-098). Undefined when it was stopped, which changes
	 * nothing: every change to the task comes after the last wait.
	 */
	const judgeWork = async (current: Task, info: SettleInfo, signal: AbortSignal): Promise<SettleAction | undefined> => {
		// The ledger is read while the agent works; it has no deadline, only the engine's liveness.
		const turn = await current.turn;
		if (signal.aborted) return undefined;
		if (turn.kind !== "task") return notJudged(ctx, turn);
		const { ledger } = turn;
		if (ledger.criteria.length === 0) return skipped(ctx, "no_criteria");
		const budgets = budgetsFor(info.contextWindow);

		const state = await workspaceFingerprint(ctx, await current.startRef, signal);
		if (signal.aborted) return undefined;
		// Nothing the judgment rests on changed since the last one (a chat reply): it stands (D-107).
		const key = state === undefined ? undefined : judgedKey(state, ledger, current.followUps);
		if (key !== undefined && current.judged?.key === key) {
			const { action, summary } = current.judged;
			// A follow-up nobody sent still stands: it is offered again, not only named (D-107).
			if (action && action.kind !== "notify") {
				return skipped(ctx, "unchanged", { ...action, summary: `${action.summary} (nothing changed since)` });
			}
			const last = summary.replace(/^supervisor: /, "");
			return skipped(ctx, "unchanged", notice(`nothing changed since the last check (${last})`, "info"));
		}

		return judgeEvidence(current, ledger, info, { state, key, budgets }, signal);
	};

	/** The rest of {@link judgeWork}: the evidence, the guard against follow-ups that change nothing, and the verdict. */
	const judgeEvidence = async (
		current: Task,
		ledger: Ledger,
		info: SettleInfo,
		given: { readonly state: string | undefined; readonly key: string | undefined; readonly budgets: Budgets },
		signal: AbortSignal,
	): Promise<SettleAction | undefined> => {
		const { state, key, budgets } = given;
		// Asked now, so the sidecar reads the message while git and the checks run.
		const reading = readFinalMessage(ctx, info.lastAssistantText, signal);
		const evidence = await gatherEvidence(ctx, settings, current, ledger, { state, reading, budgets }, signal);
		if (signal.aborted) return undefined;
		const progress = progressHash(evidence.diffHash, lastReply(current));
		// Counted only once the verdict is in: a job stopped during it must leave the streak as it was.
		const { streak, stalled } = nextStreak(current, progress);
		if (stalled) {
			current.noProgressStreak = streak;
			await persist(current);
			const said = "two follow-ups in a row changed nothing; not following up again until something does";
			return skipped(ctx, "no_progress", notice(said, "info"));
		}

		const verdict = await judge(ctx, ledger, evidence, replyList(current), budgets, signal);
		if (signal.aborted) return undefined;
		current.noProgressStreak = streak;
		if ("error" in verdict) {
			const said = `the verdict got no answer from the engine, so the work was not checked (${verdict.error})`;
			return skipped(ctx, "verdict_unavailable", notice(said, "warning"));
		}
		lastSummary = verdict.verdict;
		recordVerdict(ctx, verdict, ledger, current, evidence);
		const action = await afterVerdict(current, ledger, verdict, { ...evidence, diffHash: progress }, budgets, signal);
		if (signal.aborted || action === undefined) return undefined;
		if (key !== undefined) current.judged = { key, summary: action.summary, action };
		await persist(current);
		return action;
	};

	/**
	 * The follow-up to a verdict (brief §6.1 step 4): what is missing, what to verify, and the bugs
	 * a review found, as one message (D-107). Undefined when the review was stopped.
	 */
	const afterVerdict = async (
		current: Task,
		ledger: Ledger,
		verdict: Judgement,
		evidence: Gathered,
		budgets: Budgets,
		signal: AbortSignal,
	): Promise<SettleAction | undefined> => {
		const { diffHash } = evidence;
		const missing = items(verdict.missing);
		// Whether the agent is waiting on the user is the verdict's call (D-062): it can tell a blocking
		// question from an offer of more work, which a pattern on the last line cannot.
		if (verdict.verdict === "incomplete" && verdict.asked_user) {
			return skipped(ctx, "asked_user", notice("the agent is waiting for your answer", "info"));
		}
		if (verdict.verdict === "incomplete" && missing.length > 0) {
			const summary = `supervisor: ${missing.length} item(s) look unfinished`;
			const text = continuationMessage(missing);
			return followUp(ctx, settings, current, { text, summary, data: { missing }, diffHash, persist });
		}
		if (verdict.verdict === "failed") return notice(`looks failed: ${verdict.reason}`, "warning");
		return settledAction(current, ledger, verdict, evidence, budgets, signal);
	};

	/** After a `complete` or `uncertain` verdict: the request to verify, the review, or a notice (D-107). */
	const settledAction = async (
		current: Task,
		ledger: Ledger,
		verdict: Judgement,
		evidence: Gathered,
		budgets: Budgets,
		signal: AbortSignal,
	): Promise<SettleAction | undefined> => {
		const unverified = items(verdict.unverified);
		const working = !verdict.asked_user && !evidence.noChanges;
		// The judge could not tell from the diff and the test runs. The agent can: it has the whole
		// conversation and the tools. Asked once per task, and never when it is waiting on the user.
		const verify = verdict.verdict === "uncertain" && unverified.length > 0 && working && canVerify(settings, current);
		const reviewNext = settings.review && working && evidence.gitWorks && !current.reviewed;
		const review = reviewNext
			? await reviewAtSettle(ctx, settings, current, ledger.requests, budgets, signal)
			: { findings: [], note: "", failed: false };
		if (signal.aborted) return undefined;
		const word = verdictWord(verdict, unverified);
		const { findings } = review;
		if (!verify && findings.length === 0) {
			return notice([word, review.note].filter(Boolean).join(" · "), review.failed ? "warning" : "info");
		}
		const summary = [verify ? `${unverified.length} item(s) to verify` : word, review.note].filter(Boolean).join(" · ");
		return followUp(ctx, settings, current, {
			...combined(verify ? unverified : [], findings),
			summary: `supervisor: ${summary}`,
			diffHash: evidence.diffHash,
			onCommit: () => {
				if (verify) current.verifyAsked = true;
				for (const finding of findings) current.reported.add(findingKey(finding));
			},
			persist,
		});
	};

	/** A new message: a provisional task, until the ledger sidecar says what the message does to the open one. */
	const newTurn = (turn: UserTurn): Task => {
		const earlier = task;
		const head = taskStart(ctx);
		const next: Task = {
			turn: Promise.resolve({ kind: "none" }),
			open: Promise.resolve(undefined),
			startRef: head,
			untrackedAtStart: untrackedStates(ctx),
			ownRef: head,
			tools: [],
			snapshots: new Map(),
			earlierReplies: [],
			replies: [],
			autoContinuations: 0,
			followUps: 0,
			pending: undefined,
			lastContinuationDiff: undefined,
			noProgressStreak: 0,
			verifyAsked: false,
			reviewed: false,
			reported: new Set(),
			judged: undefined,
		};
		const previous = earlier ? earlier.open : Promise.resolve(undefined);
		next.turn = previous
			.then(async (open) => {
				const previousTurn = await open?.turn;
				const ledger = previousTurn?.kind === "task" ? previousTurn.ledger : undefined;
				const read = await readMessage(ctx, turn, ledger);
				if (read.kind === "task" && read.relation !== "new_task" && open) carryOn(next, open);
				return read;
			})
			.catch((error): Turn => {
				ctx.log(`ledger failed: ${String(error)}`);
				return { kind: "failed", error: String(error) };
			});
		next.open = next.turn.then(async (read) => {
			if (read.kind === "task") return next;
			if (read.kind === "closed") return undefined;
			// Not read, or not about work: whatever was open stays open.
			return earlier ? earlier.open : undefined;
		});
		void next.turn.then(() => persist(next));
		return next;
	};

	return {
		id: SUPERVISOR_ID,

		onUserTurn(turn: UserTurn) {
			// Whatever the last verdict was, it was about the work before this message.
			lastSummary = undefined;
			const current = task;
			const accepted = current?.pending && acceptance(turn.text, current.pending.text);
			if (current?.pending && accepted) {
				// The user (or eval harness) sent our suggestion, as it was or edited: the same task goes on.
				current.followUps += 1;
				current.lastContinuationDiff = current.pending.diffHash;
				current.pending = undefined;
				current.earlierReplies.push(...current.replies);
				current.replies = [];
				if (accepted.edit !== "") {
					// What the user changed in the suggestion is theirs: read it for the checklist (D-107).
					const edit = accepted.edit;
					current.turn = current.turn.then(async (read) =>
						read.kind === "task" ? { ...read, ledger: await applyEdit(ctx, read.ledger, edit, turn) } : read,
					);
				}
				ctx.record({
					kind: "exo.action",
					data: { action: "accepted", followUp: current.followUps, ...(accepted.edited ? { edited: true } : {}) },
				});
				void persist(current);
				return;
			}
			task = newTurn(turn);
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
			if (current.tools.length > MAX_TOOLS) {
				for (const dropped of current.tools.splice(0, current.tools.length - MAX_TOOLS)) {
					current.snapshots.delete(dropped);
				}
			}
			if (lastFullRun([tool], runOptions(settings))) {
				const ref = current.ownRef;
				current.snapshots.set(
					tool,
					ref
						.then(async (at) => ({ ref: at, fingerprint: await workspaceFingerprint(ctx, at) }))
						.catch(() => ({ ref: undefined, fingerprint: undefined })),
				);
			}
		},

		async onSettle(info: SettleInfo, signal: AbortSignal): Promise<SettleAction | undefined> {
			const current = task;
			if (info.contextWindow !== undefined) lastWindow = info.contextWindow;
			// The agent ran without a message this module saw (it was switched on mid-run, say).
			if (!current) {
				ctx.record({ kind: "exo.action", data: { action: "skipped", reason: "no_task" } });
				return undefined;
			}
			takeReplies(
				current,
				(info.assistantTexts ?? [info.lastAssistantText]).filter((text) => text.trim() !== ""),
			);
			if (info.outcome !== "completed") return undefined;
			current.pending = undefined;
			// In the background, with no time limit: Escape or a new message stops it (D-098). Without a
			// UI (print mode) nobody types, and it runs here, inside the hook's budget, as before.
			if (ctx.background("checking the work", (jobSignal) => judgeWork(current, info, jobSignal))) return undefined;
			return judgeWork(current, info, signal);
		},

		async command(args: string) {
			if (args.trim() !== "review") return undefined;
			const current = await task?.open;
			const turn = await current?.turn;
			const requests = turn?.kind === "task" ? turn.ledger.requests : [];
			const started = ctx.background("reviewing the changes", (signal) => reviewAction(current, requests, signal));
			if (!started) return "Review: it runs in the background, which needs pi's interactive UI.";
			return "Reviewing the changes in the background. The findings will go in your editor; Escape or a new message stops the review.";
		},

		status() {
			if (!task) return `supervisor (${settings.mode}): idle`;
			const count =
				settings.mode === "auto" ? ` · ${task.autoContinuations}/${settings.maxContinuations} auto continuations` : "";
			return `supervisor (${settings.mode}): ${lastSummary ?? "watching"}${count}`;
		},
	};
}

/** One follow-up for what to verify and the bugs a review found (D-107), and its trace data. */
function combined(
	unverified: readonly string[],
	findings: readonly Finding[],
): { readonly text: string; readonly data: { readonly [key: string]: string[] } } {
	const parts = [
		unverified.length > 0 ? verificationMessage(unverified) : "",
		findings.length > 0 ? reviewMessage(findings) : "",
	];
	const data: { [key: string]: string[] } = {};
	if (unverified.length > 0) data["unverified"] = [...unverified];
	if (findings.length > 0) data["findings"] = findings.map((f) => `${f.file}: ${f.title}`);
	return { text: parts.filter(Boolean).join("\n\n"), data };
}

/** Whether the agent may still be asked to verify what the verdict could not see: once per task (D-071). */
function canVerify(settings: SupervisorSettings, task: Task): boolean {
	return settings.verifyUncertain && !task.verifyAsked;
}

/** The verdict in a few words: for `uncertain`, how much was not shown and the first of it (D-107). */
function verdictWord(verdict: Verdict, unverified: readonly string[]): string {
	if (verdict.verdict !== "uncertain") return verdict.verdict;
	const first = unverified[0];
	// With no item named, the judge's reason is all there is to say.
	if (first === undefined) return `uncertain: ${verdict.reason.trim() || "the evidence does not show either way"}`;
	return `uncertain: ${unverified.length} item(s) not shown, such as "${first}"`;
}

/** A notice to the user from the supervisor, cut to a status line's length. */
function notice(text: string, level: "info" | "warning"): SettleAction {
	return { kind: "notify", summary: `supervisor: ${text}`.slice(0, 300), level };
}

/** Records why the work was not judged or followed up, and says so when there is something to say. */
function skipped(ctx: ModuleContext, reason: string, action?: SettleAction): SettleAction | undefined {
	ctx.record({ kind: "exo.action", data: { action: "skipped", reason } });
	return action;
}

/** A message that left nothing to judge: said when it was a failure, recorded otherwise (D-107). */
function notJudged(ctx: ModuleContext, turn: Exclude<Turn, { kind: "task" }>): SettleAction | undefined {
	switch (turn.kind) {
		case "offline":
			return undefined;
		case "failed":
			return skipped(
				ctx,
				"ledger_failed",
				notice(`could not read your message, so the work was not checked (${turn.error})`, "warning"),
			);
		case "closed":
			return skipped(ctx, "closed");
		case "none":
			return skipped(ctx, "not_a_task");
	}
}

/**
 * The review run after a verdict (D-097, D-107): its findings, a note for the summary, and whether
 * it failed (git or the engine), which is logged and said.
 */
async function reviewAtSettle(
	ctx: ModuleContext,
	settings: SupervisorSettings,
	task: Task,
	requests: readonly string[],
	budgets: Budgets,
	signal: AbortSignal,
): Promise<{ readonly findings: readonly Finding[]; readonly note: string; readonly failed: boolean }> {
	const review = await runReview(ctx, settings, task, requests, budgets, signal);
	if (failedReview(review)) {
		if (!signal.aborted) ctx.log(`review failed: ${review.error}`);
		return { findings: [], note: `the review could not run (${review.error})`, failed: true };
	}
	if (signal.aborted) return { findings: [], note: "", failed: false };
	keepReview(ctx, task, review, "settle");
	if (review === "no_changes") return { findings: [], note: "", failed: false };
	return { findings: review.findings, note: reviewSummary(review), failed: false };
}

type Saved = Static<typeof SavedSchema>;

/** The requests as saved: the first (the task itself) and the newest, each and all within budget. */
function savedRequests(requests: readonly string[]): string[] {
	const each = requests.map((r) => startAndEnd(r, SAVED_REQUEST_CHARS, REQUEST_CUT));
	const length = (list: readonly string[]) => list.reduce((sum, r) => sum + r.length, 0);
	// The oldest additions go first; the first request says what the task is.
	while (each.length > 2 && length(each) > SAVED_REQUESTS_TOTAL) each.splice(1, 1);
	return length(each) > SAVED_REQUESTS_TOTAL
		? each.map((r) => startAndEnd(r, Math.floor(SAVED_REQUESTS_TOTAL / each.length), REQUEST_CUT))
		: each;
}

/** The newest replies, each and all within budget. */
function savedReplies(replies: readonly string[]): string[] {
	const kept: string[] = [];
	let left = SAVED_REPLIES_TOTAL;
	for (const reply of [...replies].reverse()) {
		const cut = startAndEnd(reply, Math.min(SAVED_REPLY_CHARS, left), { mark: "… (left out when saved) …" });
		if (left <= 0 || cut.length > left) break;
		kept.unshift(cut);
		left -= cut.length;
	}
	return kept;
}

/**
 * The state cut until it fits {@link SAVED_STATE_CHARS} as JSON (D-107): a state over the host's
 * limit is not saved at all, and the stale one before it would come back. The developer's new
 * files go first, then the oldest replies, then the oldest additions to the request.
 */
export function fitSaved(state: Saved): Saved {
	let fitted = state;
	const size = () => JSON.stringify(fitted).length;
	while (size() > SAVED_STATE_CHARS) {
		const { untrackedAtStart, replies, ledger } = fitted;
		if (untrackedAtStart.length > 0) {
			fitted = { ...fitted, untrackedAtStart: untrackedAtStart.slice(0, Math.floor(untrackedAtStart.length / 2)) };
		} else if (replies.length > 0) fitted = { ...fitted, replies: replies.slice(1) };
		else if (ledger.requests.length > 1)
			fitted = { ...fitted, ledger: { ...ledger, requests: ledger.requests.slice(1) } };
		else return { ...fitted, ledger: { ...ledger, requests: ledger.requests.map((r) => r.slice(0, 1_000)) } };
	}
	return fitted;
}

function failedReview(result: ReviewResult | "no_changes" | ReviewError): result is ReviewError {
	return typeof result === "object" && "error" in result;
}

/**
 * The replies since the user's last message, as the host gives them at a settle. They normally
 * start with those it gave at the last one; when they don't, a compaction ended the span and took
 * those away, so they are kept as earlier replies (D-107). Where the two overlap, the overlap is
 * kept once.
 */
function takeReplies(task: Task, span: readonly string[]): void {
	const before = task.replies;
	const continues = before.every((reply, i) => span[i] === reply);
	if (!continues) {
		let overlap = Math.min(before.length, span.length);
		while (overlap > 0 && !before.slice(-overlap).every((reply, i) => span[i] === reply)) overlap -= 1;
		task.earlierReplies.push(...before.slice(0, before.length - overlap));
	}
	task.replies = [...span];
}

/** What a later message of the same task takes from the earlier one: its start, its history and its counts. */
function carryOn(next: Task, earlier: Task): void {
	next.startRef = earlier.startRef;
	next.untrackedAtStart = earlier.untrackedAtStart;
	next.tools.unshift(...earlier.tools);
	for (const [tool, snapshot] of earlier.snapshots) next.snapshots.set(tool, snapshot);
	next.earlierReplies = [...earlier.earlierReplies, ...earlier.replies];
	next.autoContinuations += earlier.autoContinuations;
	next.followUps += earlier.followUps;
	next.lastContinuationDiff ??= earlier.lastContinuationDiff;
	next.noProgressStreak = earlier.noProgressStreak;
	next.verifyAsked ||= earlier.verifyAsked;
	next.reviewed ||= earlier.reviewed;
	next.judged = earlier.judged;
	for (const key of earlier.reported) next.reported.add(key);
}

/** What a judgment rests on: the files, the request, the checks and the follow-ups given. Not the agent's chat. */
function judgedKey(state: string, ledger: Ledger, followUps: number): string {
	return createHash("sha256")
		.update(JSON.stringify([state, ledger.requests, ledger.criteria, ledger.checkCommands, followUps]))
		.digest("hex")
		.slice(0, 16);
}

/** Progress for the no-progress guard: the files, or what the agent said at the end (a reply may be the work). */
function progressHash(diffHash: string, finalMessage: string): string {
	return createHash("sha256").update(diffHash).update("\0").update(finalMessage.trim()).digest("hex").slice(0, 16);
}

/** The agent's final message, as the task keeps it. */
function lastReply(task: Task): string {
	return replyList(task).at(-1) ?? "";
}

/** The task's replies, oldest first: the last is the agent's final message. */
function replyList(task: Task): string[] {
	return [...task.earlierReplies, ...task.replies];
}

/** The verdict as the trace keeps it, with the criteria and what each check command did. */
function recordVerdict(ctx: ModuleContext, verdict: Judgement, ledger: Ledger, task: Task, evidence: Gathered): void {
	ctx.record({
		kind: "exo.verdict",
		data: {
			...verdict,
			criteria: [...ledger.criteria],
			autoContinuations: task.autoContinuations,
			followUps: task.followUps,
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
	if (saved === undefined || saved === null) return undefined;
	if (!Value.Check(SavedSchema, saved)) {
		ctx.log("the saved task is from another version or damaged: starting without it");
		return undefined;
	}
	const requests = saved.ledger.requests;
	const ledger: Ledger = {
		requests,
		criteria: saved.ledger.criteria.slice(-MAX_CRITERIA),
		checkCommands: saved.ledger.checkCommands.filter((command) =>
			requests.some((request) => acceptRequestCheck(command, request).ok),
		),
	};
	const ref = saved.startRef;
	// A start snapshot is pruned with time (D-102): without it the diff is against `HEAD`.
	const startRef = isCommitId(ref)
		? commitExists(ctx, ref).then((kept) => {
				if (!kept) ctx.log("the task's starting snapshot is gone: its changes are taken from HEAD");
				return kept ? ref : undefined;
			})
		: Promise.resolve(undefined);
	const turn: Turn = { kind: "task", ledger, relation: "restored" };
	const restored: Task = {
		turn: Promise.resolve(turn),
		open: Promise.resolve(undefined),
		startRef,
		untrackedAtStart: Promise.resolve(new Map(saved.untrackedAtStart)),
		ownRef: startRef,
		tools: [],
		snapshots: new Map(),
		earlierReplies: [...saved.replies],
		replies: [],
		autoContinuations: saved.autoContinuations,
		followUps: saved.followUps,
		pending: saved.pending ?? undefined,
		lastContinuationDiff: saved.lastContinuationDiff ?? undefined,
		noProgressStreak: saved.noProgressStreak,
		verifyAsked: saved.verifyAsked,
		reviewed: saved.reviewed,
		reported: new Set(saved.reported.slice(-MAX_REPORTED)),
		judged: saved.judged ?? undefined,
	};
	restored.open = Promise.resolve(restored);
	return restored;
}

const textLines = (text: string) =>
	text
		.split("\n")
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter(Boolean);

/**
 * Whether the user's message is our suggestion sent back: unchanged, or edited (D-010 logs
 * accept, edit and reject). Edited means at least half of the suggestion's lines are still there;
 * `edit` says what the user wrote into it and which of its lines they deleted (D-107). Anything
 * further from it is a new message, and the ledger sidecar decides what it does to the task.
 */
function acceptance(text: string, suggestion: string): { readonly edited: boolean; readonly edit: string } | undefined {
	const ours = textLines(suggestion);
	const theirs = textLines(text);
	if (ours.join("\n") === theirs.join("\n")) return { edited: false, edit: "" };
	const kept = ours.filter((line) => theirs.includes(line)).length;
	if (kept * 2 < ours.length) return undefined;
	const added = theirs.filter((line) => !ours.includes(line)).join("\n");
	const removed = ours.filter((line) => !theirs.includes(line));
	const deleted =
		removed.length > 0
			? `(The developer deleted these lines from the follow-up suggested to them before sending it:)\n${removed.map((line) => `- ${line}`).join("\n")}`
			: "";
	return { edited: true, edit: [added, deleted].filter(Boolean).join("\n\n") };
}

/**
 * The checklist after the user's edit of a suggestion (D-107): the ledger sidecar reads what they
 * wrote into it and what they deleted, as it reads any message that continues the task. With no
 * answer the edit still goes in the request the verdict reads, and the checklist stays.
 */
async function applyEdit(ctx: ModuleContext, ledger: Ledger, edit: string, turn: UserTurn): Promise<Ledger> {
	const requests = [...ledger.requests, edit];
	const result = await askLedger(ctx, edit, ledger);
	if (!result?.ok) {
		if (result) ctx.log(`could not read your edit of the follow-up for the checklist: ${result.error}`);
		return { ...ledger, requests };
	}
	const value = result.value;
	const commands = acceptCommands(value, edit, turn, ledger.checkCommands);
	const criteria = applyDeltas(ctx, ledger.criteria, value.added_criteria, value.dropped_criteria);
	ctx.record({
		kind: "exo.ledger",
		data: {
			relation: "edited_follow_up",
			added: value.added_criteria,
			dropped: value.dropped_criteria,
			criteria,
			checks: commands.checks,
			refused: commands.refused,
			...(commands.stopped.length > 0 ? { stopped: commands.stopped } : {}),
		},
	});
	return { requests, criteria: criteria.length > 0 ? criteria : ledger.criteria, checkCommands: commands.checks };
}

/** Brief §6.1 guard: two follow-ups in a row that leave the work unchanged stop the supervisor's follow-ups. */
function nextStreak(task: Task, progress: string): { readonly streak: number; readonly stalled: boolean } {
	if (task.lastContinuationDiff === undefined) return { streak: task.noProgressStreak, stalled: false };
	const streak = progress === task.lastContinuationDiff ? task.noProgressStreak + 1 : 0;
	return { streak, stalled: streak >= 2 };
}

interface Gathered {
	readonly text: string;
	readonly diffHash: string;
	readonly checks: readonly CheckResult[];
	readonly noChanges: boolean;
	/** Whether git could say what changed: without it there is nothing to review. */
	readonly gitWorks: boolean;
}

/** A verdict's list as it is used: trimmed, without empty or repeated items. */
function items(list: readonly string[] | undefined): string[] {
	return [...new Set((list ?? []).map((m) => m.trim()).filter(Boolean))];
}

/**
 * A follow-up to the agent (brief §6.1 step 4): in auto mode a continuation, otherwise a
 * suggestion the user sends or edits. Nothing about the task changes until it is delivered: its
 * `commit` counts it and records it, as what it was delivered as (D-107). In auto mode at the
 * task's limit it is only reported.
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
		readonly onCommit?: () => void;
		readonly persist: (task: Task) => Promise<void>;
	},
): SettleAction {
	const { text, summary, data, diffHash } = follow;
	if (settings.mode === "auto" && task.autoContinuations >= settings.maxContinuations) {
		ctx.record({ kind: "exo.action", data: { action: "skipped", reason: "max_continuations", ...data } });
		return { kind: "notify", summary: `${summary} (follow-up limit reached)`, level: "info" };
	}
	const commit = (delivered?: SettleAction["kind"]) => {
		follow.onCommit?.();
		const as = delivered ?? (settings.mode === "auto" ? "continue" : "suggest");
		if (as === "continue") {
			task.autoContinuations += 1;
			task.followUps += 1;
			task.lastContinuationDiff = diffHash;
			// The replies stay where they are: the host's next span of them runs on past this continuation.
			ctx.record({ kind: "exo.action", data: { action: "continued", continuation: task.autoContinuations, ...data } });
		} else {
			task.pending = { text, diffHash };
			ctx.record({ kind: "exo.action", data: { action: "suggested", ...data } });
		}
		void follow.persist(task);
	};
	return settings.mode === "auto"
		? { kind: "continue", text, summary, commit }
		: { kind: "suggest", text, summary, commit };
}

/**
 * The task's change reviewed for bugs (D-097): everything since the task began, tracked files with
 * each changed function whole, and new files. "no_changes" when there is nothing to review; an
 * error when git or the engine failed. Changes nothing: see {@link keepReview}.
 */
async function runReview(
	ctx: ModuleContext,
	settings: SupervisorSettings,
	task: Task | undefined,
	requests: readonly string[],
	budgets: Budgets,
	signal: AbortSignal,
): Promise<ReviewResult | "no_changes" | ReviewError> {
	try {
		const base = await diffBase(ctx, await task?.startRef, signal);
		if (base === undefined) return { error: "not a git repository" };
		const [tracked, untracked] = await Promise.all([
			gitDiff(ctx, `--function-context ${base}`, signal),
			listUntracked(ctx, signal),
		]);
		if (!tracked.ok) return { error: tracked.error };
		if (!untracked.ok) return { error: untracked.error };
		const made = untracked.files.filter((file) => !isByproduct(file));
		const added = task ? await newSinceStart(ctx, made, await task.untrackedAtStart) : made;
		const shown = await newFileDiffs(ctx.cwd, added, {
			touched: touchedFiles(task?.tools ?? []),
			maxFiles: MAX_NEW_FILES,
			maxBytes: budgets.review,
		});
		const diff = [tracked.out.trimEnd(), ...shown.diffs].filter(Boolean).join("\n");
		if (diff === "") return "no_changes";
		const result = await reviewChange(
			ctx,
			settings,
			{ requests, diff, reported: task?.reported ?? new Set(), maxChars: budgets.review },
			signal,
		);
		return result ?? { error: "no pass got an answer from the engine" };
	} catch (error) {
		return { error: String(error) };
	}
}

/**
 * A review whose result is used: traced. Its bugs are remembered as reported only once its
 * follow-up is delivered, so a later review may find again what the user never took.
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
 * What a message does to the open task (`previous`), as the ledger sidecar reads it, with its
 * changes to the checklist applied in code (D-107): the sidecar says what was added and dropped,
 * and code keeps the rest, instead of the sidecar rewriting the whole list.
 */
async function readMessage(ctx: ModuleContext, turn: UserTurn, previous: Ledger | undefined): Promise<Turn> {
	const prompt = turn.text;
	const result = await askLedger(ctx, prompt, previous);
	if (result === undefined) return { kind: "offline" };
	if (!result.ok) return { kind: "failed", error: result.error };
	const value = result.value;
	// Nothing open to continue: a message that asks for work starts a task, any other is about nothing.
	const relation: Relation = !previous && value.relation === "continues" ? "new_task" : value.relation;
	if (relation === "closes") {
		ctx.record({ kind: "exo.ledger", data: { relation } });
		return previous ? { kind: "closed" } : { kind: "none" };
	}
	// A message that asks for work but names none of it is taken as chat: it changes nothing.
	const chat = relation === "chat" || value.added_criteria.every((c) => c.trim() === "");
	const asked = chat && relation !== "continues" ? "chat" : relation;
	const inUse = asked === "new_task" ? [] : (previous?.checkCommands ?? []);
	const commands = acceptCommands(value, prompt, turn, inUse);
	if (asked === "chat") return chatTurn(ctx, previous, commands);
	const criteria =
		relation === "new_task"
			? applyDeltas(ctx, [], value.added_criteria, [])
			: applyDeltas(ctx, previous?.criteria ?? [], value.added_criteria, value.dropped_criteria);
	const ledger: Ledger = {
		requests: relation === "continues" && previous ? [...previous.requests, prompt] : [prompt],
		criteria,
		checkCommands: commands.checks,
	};
	ctx.record({
		kind: "exo.ledger",
		data: {
			relation,
			added: value.added_criteria,
			dropped: relation === "continues" ? value.dropped_criteria : [],
			criteria: [...ledger.criteria],
			checks: [...ledger.checkCommands],
			refused: commands.refused,
			...(commands.stopped.length > 0 ? { stopped: commands.stopped } : {}),
		},
	});
	return { kind: "task", relation, ledger };
}

/** A message that asks for no work: the open task goes on as it was, but for a check the user stopped. */
function chatTurn(
	ctx: ModuleContext,
	previous: Ledger | undefined,
	commands: { readonly checks: string[]; readonly stopped: string[] },
): Turn {
	ctx.record({
		kind: "exo.ledger",
		data: { relation: "chat", ...(commands.stopped.length > 0 ? { stopped: commands.stopped } : {}) },
	});
	if (!previous) return { kind: "none" };
	return { kind: "task", relation: "chat", ledger: { ...previous, checkCommands: commands.checks } };
}

/** The checklist with the sidecar's changes applied: items dropped by number, new ones added, newest kept past the cap. */
function applyDeltas(
	ctx: ModuleContext,
	criteria: readonly string[],
	added: readonly string[],
	dropped: readonly number[],
): string[] {
	const drop = new Set(dropped);
	const kept = criteria.filter((_, i) => !drop.has(i + 1));
	const next = [...new Set([...kept, ...added.map((c) => c.trim()).filter(Boolean)])];
	if (next.length <= MAX_CRITERIA) return next;
	const cut = next.slice(0, next.length - MAX_CRITERIA);
	ctx.log(`the checklist is over ${MAX_CRITERIA} items: the oldest are left out of the verdict: ${cut.join("; ")}`);
	return next.slice(-MAX_CRITERIA);
}

/**
 * The check commands that stand after a message: those in use that it does not stop, and those it
 * names that may be run (D-011, D-084: the sidecar proposes, `checks.ts` decides). What was refused
 * goes in the trace (`exo.ledger`), not in the problem notes: a command written outside a code span
 * is the rule working, not a fault (D-107).
 */
function acceptCommands(
	value: LedgerReading,
	prompt: string,
	turn: UserTurn,
	inUse: readonly string[],
): {
	readonly checks: string[];
	readonly refused: { command: string; reason: string }[];
	readonly stopped: string[];
} {
	const proposed = [...new Set(value.check_commands.map((c) => c.trim()).filter(Boolean))];
	const left = standing([...inUse, ...proposed], value.do_not_run, prompt);
	const carried = inUse.filter((command) => left.commands.includes(command));
	const stopped = inUse.filter((command) => !carried.includes(command));
	const refusedByRequest =
		left.unidentified === undefined
			? "the request says not to run it"
			: `the request says not to run "${left.unidentified.slice(0, 80)}", which could not be matched to a command`;
	const refused: { command: string; reason: string }[] = [];
	const accepted = proposed.filter((command) => {
		if (inUse.includes(command)) return false;
		const verdict =
			turn.origin !== "user"
				? { ok: false as const, reason: "the message was not typed by the user" }
				: left.commands.includes(command)
					? acceptRequestCheck(command, prompt)
					: { ok: false as const, reason: refusedByRequest };
		if (!verdict.ok) refused.push({ command, reason: verdict.reason });
		return verdict.ok;
	});
	return { checks: [...new Set([...carried, ...accepted])], refused, stopped };
}

/** What the ledger sidecar reads in one message; undefined when there is no sidecar engine. */
async function askLedger(
	ctx: ModuleContext,
	prompt: string,
	previous: Ledger | undefined,
): Promise<
	{ readonly ok: true; readonly value: LedgerReading } | { readonly ok: false; readonly error: string } | undefined
> {
	const list = (entries: readonly string[] | undefined, numbered: boolean) =>
		entries?.length ? entries.map((c, i) => (numbered ? `${i + 1}. ${c}` : `- ${c}`)).join("\n") : "(none)";
	const pool = ctx.pool();
	if (!pool) return undefined;
	const result = await pool.run({
		module: SUPERVISOR_ID,
		kind: "judge",
		priority: "interactive",
		schema: LedgerSchema,
		schemaName: "goal_ledger",
		request: {
			messages: [
				{
					role: "user",
					content: LEDGER_PROMPT.render({
						prompt,
						previous: list(previous?.criteria, true),
						previous_checks: list(previous?.checkCommands, false),
					}),
				},
			],
			maxTokens: SIDECAR_MAX_TOKENS,
			temperature: 0.2,
		},
	});
	if (!result.ok) {
		ctx.log(`ledger ${result.outcome}: ${result.error}`);
		return { ok: false, error: `${result.outcome}: ${result.error}` };
	}
	return { ok: true, value: result.value };
}

/**
 * The agent's success claims in its final message, as a sidecar that judges nothing reads them
 * (D-091), each kept only when it is a sentence of the message (`admitClaims`). Undefined when
 * the sidecar did not answer; an empty message claims nothing.
 */
async function readFinalMessage(
	ctx: ModuleContext,
	finalMessage: string,
	signal: AbortSignal,
): Promise<readonly Claim[] | undefined> {
	if (finalMessage.trim() === "") return [];
	const pool = ctx.pool();
	if (!pool) return undefined;
	const result = await pool.run({
		module: SUPERVISOR_ID,
		kind: "judge",
		priority: "critical",
		signal,
		schema: ReadingSchema,
		schemaName: "final_message",
		request: {
			messages: [
				{
					role: "user",
					content: FINAL_MESSAGE_PROMPT.render({
						final_label: "Agent's final message (all of it)",
						final_message: finalMessage.trim(),
					}),
				},
			],
			maxTokens: SIDECAR_MAX_TOKENS,
			temperature: 0.2,
		},
	});
	if (!result.ok) {
		if (!signal.aborted) ctx.log(`reading the agent's claims ${result.outcome}: ${result.error}`);
		return undefined;
	}
	return admitClaims(result.value.claims, finalMessage);
}

/** What `git diff` compares the working tree with: the task's start, `HEAD`, or the empty tree before the first commit. */
async function diffBase(
	ctx: ModuleContext,
	startRef: string | undefined,
	signal: AbortSignal,
): Promise<string | undefined> {
	if (isCommitId(startRef)) return startRef;
	// Outside a repository `git diff` compares files instead (and prints its usage): ask first.
	const head = await git(ctx, "rev-parse --verify -q HEAD", { signal });
	if (head.ok) return "HEAD";
	return notARepository(head) ? undefined : EMPTY_TREE;
}

/** What git says outside a repository, for the commands not run there. */
const NOT_A_REPOSITORY: { readonly ok: false; readonly error: string } = { ok: false, error: "not a git repository" };

async function gatherEvidence(
	ctx: ModuleContext,
	settings: SupervisorSettings,
	task: Task,
	ledger: Ledger,
	given: {
		readonly state: string | undefined;
		readonly reading: Promise<readonly Claim[] | undefined>;
		readonly budgets: Budgets;
	},
	signal: AbortSignal,
): Promise<Gathered> {
	const { budgets } = given;
	const base = await diffBase(ctx, await task.startRef, signal);
	const [stat, tracked, untracked] = await Promise.all([
		base === undefined ? NOT_A_REPOSITORY : git(ctx, `diff --stat ${base}`, { signal, tailChars: GIT_OUTPUT_CHARS }),
		base === undefined ? NOT_A_REPOSITORY : gitDiff(ctx, base, signal),
		base === undefined ? NOT_A_REPOSITORY : listUntracked(ctx, signal),
	]);
	const listed = untracked.ok ? untracked.files : [];
	const made = listed.filter((file) => !isByproduct(file));
	const byproducts = listed.length - made.length;
	const newFiles = await newSinceStart(ctx, made, await task.untrackedAtStart);
	// `git diff` leaves out files git does not track yet, which is where new work usually is.
	const shown = await newFileDiffs(ctx.cwd, newFiles, {
		touched: touchedFiles(task.tools),
		maxFiles: MAX_NEW_FILES,
		maxBytes: budgets.evidence,
	});
	const diffWithNew = tracked.ok ? [tracked.out.trimEnd(), ...shown.diffs].filter(Boolean).join("\n") : undefined;
	const gitProblem = [stat, tracked, untracked].find(
		(r): r is { readonly ok: false; readonly error: string } => !r.ok && !notARepository(r),
	);
	if (gitProblem) ctx.log(`could not read the task's changes: ${gitProblem.error}`);

	const checks = await runChecks(ctx, settings, ledger, signal);
	const runs = runOptions(settings);
	const tested = lastFullRun(task.tools, runs);
	const tool = tested ? task.tools[tested.index] : undefined;
	const snapshot = tool ? await task.snapshots.get(tool) : undefined;
	const now = snapshot?.fingerprint === undefined ? undefined : await workspaceFingerprint(ctx, snapshot.ref, signal);
	const changedSinceTests =
		snapshot?.fingerprint !== undefined && now !== undefined ? snapshot.fingerprint !== now : undefined;
	const claims = (await given.reading) ?? [];
	const text = formatEvidence({
		diffStat: stat.ok ? stat.out : undefined,
		...(gitProblem ? { gitProblem: gitProblem.error } : {}),
		diff: diffWithNew,
		untracked: newFiles,
		byproducts,
		newFilesNotShown: shown.notShown,
		tools: task.tools,
		...(changedSinceTests === undefined ? {} : { changedSinceTests }),
		checks,
		warnings: warningsFor(diffWithNew, task.tools, claims, runs),
		runs,
		maxChars: budgets.evidence,
	});
	return {
		text,
		diffHash: given.state ?? diffFingerprint(diffWithNew, newFiles),
		checks,
		noChanges: untracked.ok && madeNoChanges(tracked.ok ? tracked.out : undefined, newFiles, task.tools),
		gitWorks: stat.ok && tracked.ok && untracked.ok,
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

/** Research R1.2 #4–#7, always on since D-107: tampered tests, stubs, unsupported success claims, narrow test runs. */
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

async function judge(
	ctx: ModuleContext,
	ledger: Ledger,
	evidence: Gathered,
	replies: readonly string[],
	budgets: Budgets,
	signal: AbortSignal,
): Promise<Judgement | { readonly error: string }> {
	const pool = ctx.pool();
	if (!pool) return { error: "no sidecar engine" };
	const criteria = ledger.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
	const result = await pool.run({
		module: SUPERVISOR_ID,
		priority: "critical",
		kind: "judge",
		signal,
		schema: VerdictSchema,
		schemaName: "verdict",
		request: {
			messages: [
				{
					role: "user",
					content: VERDICT_PROMPT.render({
						request: requestView(ledger.requests, budgets.requests),
						criteria,
						evidence: evidence.text,
						...repliesView(replies, budgets.replies),
					}),
				},
			],
			maxTokens: SIDECAR_MAX_TOKENS,
			temperature: 0.2,
		},
	});
	if (!result.ok) {
		if (!signal.aborted) ctx.log(`verdict ${result.outcome}: ${result.error}`);
		return { error: `${result.outcome}: ${result.error}`.slice(0, 200) };
	}
	return consistent(result.value);
}

/** The user's messages for this task as the verdict reads them: verbatim, later ones marked as additions. */
function requestView(requests: readonly string[], room: number): string {
	const text = requests.map((r, i) => (i === 0 ? r.trim() : `(The developer then added:)\n${r.trim()}`)).join("\n\n");
	return startAndEnd(text, room, REQUEST_CUT);
}

/**
 * Room for each of several texts in `room` characters: an equal share each, what a short one
 * leaves over going to the longer ones.
 */
function shares(lengths: readonly number[], room: number): number[] {
	const order = lengths.map((length, index) => ({ length, index })).sort((x, y) => x.length - y.length);
	const result = lengths.map(() => 0);
	let left = Math.max(0, room);
	order.forEach(({ length, index }, i) => {
		const allowed = Math.min(length, Math.floor(left / (order.length - i)));
		result[index] = allowed;
		left -= allowed;
	});
	return result;
}

/**
 * The agent's replies during the task as the verdict reads them, oldest first, under a heading that
 * says how much of them that is (D-089, D-107): the judge takes what it is not shown for absent
 * unless it is told. The final message gets up to half of the room; a long reply keeps its start,
 * where the deliverable is, and its end, where a question to the user is.
 */
function repliesView(replies: readonly string[], room: number): { replies_label: string; replies: string } {
	const texts = replies.map((r) => r.trim()).filter(Boolean);
	if (texts.length === 0) return { replies_label: "Agent's final message", replies: "(the agent wrote no reply)" };
	const cut = (text: string, max: number) =>
		startAndEnd(text, Math.max(max, 200), {
			mark: `… (${text.length - Math.max(max, 200)} characters in the middle of this reply are not shown) …`,
			startShare: 0.75,
		});
	if (texts.length === 1) {
		const only = texts[0] ?? "";
		return {
			replies_label:
				only.length > room
					? "Agent's final message (long: its middle is not shown)"
					: "Agent's final message (all of it)",
			replies: cut(only, room),
		};
	}
	const last = texts.at(-1) ?? "";
	const earlier = texts.slice(0, -1);
	const headers = texts.map(
		(_, i) => `--- reply ${i + 1} of ${texts.length}${i === texts.length - 1 ? " (final)" : ""} ---`,
	);
	const space = room - headers.join("\n").length - texts.length;
	const lastRoom = Math.min(last.length, Math.floor(space / 2));
	const earlierRooms = shares(
		earlier.map((t) => t.length),
		space - lastRoom,
	);
	const finalRoom = space - earlierRooms.reduce((sum, n) => sum + n, 0);
	const shown = [...earlier.map((t, i) => cut(t, earlierRooms[i] ?? 0)), cut(last, finalRoom)];
	const anyCut = shown.some((text, i) => text !== texts[i]);
	return {
		replies_label: `The agent's replies to the developer during this task, oldest first; the last is its final message${anyCut ? " (long ones have their middle not shown)" : ""}`,
		replies: shown.map((text, i) => `${headers[i]}\n${text}`).join("\n"),
	};
}

/** `git diff <args>`. Only the end of a very long one is kept: it then starts at a file, and says what is gone. */
async function gitDiff(ctx: ModuleContext, args: string, signal: AbortSignal): Promise<GitResult> {
	const diff = await git(ctx, `diff ${args}`, { signal, tailChars: GIT_OUTPUT_CHARS });
	if (!diff.ok || diff.out.length < GIT_OUTPUT_CHARS) return diff;
	const firstWhole = diff.out.indexOf("\ndiff --git ");
	return {
		ok: true,
		out: `(the diff is very long: the files at its start are not shown)\n${firstWhole === -1 ? "" : diff.out.slice(firstWhole + 1)}`,
	};
}
