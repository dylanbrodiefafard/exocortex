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
import { isCommitId, newFileDiffs, untrackedFiles, workspaceFingerprint } from "./workspace.ts";

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
	 * The commit the task started from (`git rev-parse HEAD`), so diffs cover commits made during
	 * the task. A message that continues a task takes the earlier one's, once its ledger says so.
	 */
	startRef: Promise<string | undefined>;
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
}

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
	let task: Task | undefined = restoreTask(ctx.savedState);
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
			});
		} catch (error) {
			ctx.log(`supervisor state not saved: ${String(error)}`);
		}
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
			const head = gitHead(ctx);
			const next: Task = {
				ledger: Promise.resolve(undefined),
				startRef: head,
				ownRef: head,
				tools: [],
				continuations: 0,
				pending: undefined,
				lastContinuationDiff: undefined,
				noProgressStreak: 0,
				verifyAsked: false,
				snapshots: new Map(),
			};
			next.ledger = Promise.resolve(earlier?.ledger)
				.then((previous) => extractLedger(ctx, settings, turn, previous))
				.then((result) => {
					if (!result) return undefined;
					// The same task goes on: its starting commit, and what the supervisor already spent on it.
					if (result.follows && earlier) {
						next.startRef = earlier.startRef;
						next.continuations += earlier.continuations;
						next.lastContinuationDiff ??= earlier.lastContinuationDiff;
						next.noProgressStreak = earlier.noProgressStreak;
						next.verifyAsked ||= earlier.verifyAsked;
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
			const skip = (reason: string): undefined => {
				ctx.record({ kind: "exo.action", data: { action: "skipped", reason } });
				return undefined;
			};
			// The agent ran without a message this module saw (it was switched on mid-run, say).
			if (!current) return skip("no_task");
			current.pending = undefined;

			const ledger = await withTimeout(current.ledger, settings.ledgerTimeoutMs);
			if (!ledger || ledger.criteria.length === 0) return skip("no_ledger");
			if (current.continuations >= settings.maxContinuations) return skip("max_continuations");

			// Asked at most once per settle, and only if something needs it.
			let asked: Promise<Reading | undefined> | undefined;
			const reading = () => {
				asked ??= readFinalMessage(ctx, settings, info.lastAssistantText, signal);
				return asked;
			};
			const evidence = await gatherEvidence(ctx, settings, current, ledger, reading, signal);
			if (stalled(current, evidence.diffHash)) {
				await persist(current);
				return skip("no_progress");
			}

			const verdict = await decide(ctx, settings, ledger, evidence, info.lastAssistantText, reading, signal);
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
						outcome: checkOutcome(c.output),
					})),
				},
			});
			const action = act(ctx, settings, current, verdict, evidence);
			await persist(current);
			return action;
		},

		status() {
			if (!task) return `supervisor (${settings.mode}): idle`;
			return `supervisor (${settings.mode}): ${lastVerdict ?? "watching"} · ${task.continuations}/${settings.maxContinuations} continuations`;
		},
	};
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
function restoreTask(saved: unknown): Task | undefined {
	if (!Value.Check(SavedSchema, saved)) return undefined;
	const requests = saved.ledger.requests.map((request) => startAndEnd(request, REQUEST_CHARS, REQUEST_CUT));
	const ledger: Ledger = {
		requests,
		criteria: saved.ledger.criteria.slice(0, MAX_CRITERIA),
		checkCommands: saved.ledger.checkCommands.filter((command) =>
			requests.some((request) => acceptRequestCheck(command, request).ok),
		),
	};
	const startRef = Promise.resolve(isCommitId(saved.startRef) ? saved.startRef : undefined);
	return {
		ledger: Promise.resolve(ledger),
		startRef,
		ownRef: startRef,
		tools: [],
		continuations: saved.continuations,
		pending: saved.pending ?? undefined,
		lastContinuationDiff: saved.lastContinuationDiff ?? undefined,
		noProgressStreak: saved.noProgressStreak,
		verifyAsked: saved.verifyAsked,
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
function stalled(task: Task, diffHash: string): boolean {
	if (task.lastContinuationDiff === undefined) return false;
	task.noProgressStreak = diffHash === task.lastContinuationDiff ? task.noProgressStreak + 1 : 0;
	return task.noProgressStreak >= 2;
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
		timeoutMs: settings.ledgerTimeoutMs,
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
		timeoutMs: settings.verdictTimeoutMs,
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
	const newFiles = untracked ?? [];
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
			output: await ctx.runCommand(command, { timeoutMs: settings.checkTimeoutMs, signal }),
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

async function gitHead(ctx: ModuleContext): Promise<string | undefined> {
	try {
		const head = (await git(ctx, "rev-parse --verify HEAD"))?.trim();
		return isCommitId(head) ? head : undefined;
	} catch {
		return undefined;
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
	return Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms).unref())]);
}
