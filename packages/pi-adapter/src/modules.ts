import type {
	AgentBeforeSettleEvent,
	BoundaryResult,
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	ToolCallEvent,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import {
	type Committable,
	type CompactionRequest,
	canonicalJson,
	type ExoModule,
	hiddenRun,
	type JsonValue,
	judgeHiddenRun,
	type ModuleContext,
	type ModuleFactory,
	type RunVerdict,
	readHiddenRun,
	runShellCommand,
	type SettleAction,
	type SettleInfo,
	type ToolCall,
	type ToolOutcome,
	type ToolResultDraft,
	toJsonValue,
	type UserTurn,
	type UserTurnContext,
} from "@exocortex/core";
import { COMPACTION_ID, createCompaction } from "@exocortex/mod-compaction";
import { createMemory, MEMORY_ID } from "@exocortex/mod-memory";
import { createSupervisor, SUPERVISOR_ID } from "@exocortex/mod-supervisor";
import { createTools, TOOLS_ID } from "@exocortex/mod-tools";
import { createTriage, TRIAGE_ID } from "@exocortex/mod-triage";
import { createTrimmer, TRIMMER_ID } from "@exocortex/mod-trimmer";
import { remainingMs, withBudget } from "./budget.ts";
import type { ForkTracker } from "./fork.ts";
import { createHoldUi } from "./hold.ts";
import {
	exitCodeOf,
	fullOutputPathOf,
	isEscapeKey,
	isRecord,
	lastAssistantText,
	lastCustomEntries,
	previousCompactionDetails,
	type RewriteNote,
	rewrittenResult,
	sameText,
	serializeSpan,
	signalOf,
	statusOf,
	textOf,
	toObject,
} from "./pi-shapes.ts";
import type { Runtime } from "./runtime.ts";

/**
 * Every module Exocortex knows, by config id. Order matters: tool-result rewrites run in this
 * order (trim first, then annotate), as do settle hooks.
 */
const MODULES: Readonly<Record<string, ModuleFactory>> = {
	[TRIMMER_ID]: createTrimmer,
	[TOOLS_ID]: createTools,
	[TRIAGE_ID]: createTriage,
	[MEMORY_ID]: createMemory,
	[SUPERVISOR_ID]: createSupervisor,
	[COMPACTION_ID]: createCompaction,
};

/** Hard cap on how long settle hooks may hold pi before it settles (checks + verdict). */
const SETTLE_BUDGET_MS = 5 * 60_000;
/**
 * A module's background job (D-097). One that ended by starting a turn stays listed until that
 * turn settles, so the status line (and the eval driver reading it) never shows a gap between them.
 */
interface Job {
	readonly stop: AbortController;
	readonly label: string;
	startedTurn: boolean;
	/** `runs` when its continuation was sent: the run it started is a later one. */
	sentAtRun: number;
}

/** Widget key of a follow-up offered beside the user's draft (D-097). */
const OFFER_WIDGET_KEY = "exo.offer";
/**
 * Adds an offered follow-up to the draft. Free in pi 1.0.2: `ctrl+y` is the editor's yank
 * (`pi-tui/dist/keybindings.js:71`); no default binding uses `alt+r`.
 */
const OFFER_SHORTCUT = "alt+r";

/**
 * Pi's default `compaction.reserveTokens` (`core/compaction/compaction.js:55`): it compacts once the
 * context passes the window less this (`:173-176`). The extension API does not expose the setting.
 */
const PI_RESERVE_TOKENS = 16_384;

/** What settle hooks are told: how the run ended, its last words and how full the context is. */
function settleInfo(event: AgentBeforeSettleEvent, ctx: ExtensionContext): SettleInfo {
	const context = contextOf(ctx);
	return { outcome: event.outcome, lastAssistantText: lastAssistantText(event), ...(context ? { context } : {}) };
}

/** How full the context is and where pi compacts it, when pi knows (D-098). */
function contextOf(ctx: ExtensionContext): { readonly tokens: number; readonly compactAt: number } | undefined {
	try {
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null || !(usage.contextWindow > PI_RESERVE_TOKENS)) return undefined;
		return { tokens: usage.tokens, compactAt: usage.contextWindow - PI_RESERVE_TOKENS };
	} catch {
		return undefined;
	}
}

/** Status-line key set while a module's background job runs (D-097); the eval driver waits on it. */
const BACKGROUND_STATUS_KEY = "exo.background";
/** Hard cap on how long the rewrites of one batch of tool results may hold the agent loop, across all modules and results (D-098). */
const REWRITE_BUDGET_MS = 20_000;
/** Hard cap on how long modules may look before a tool runs, across all modules: the tool waits (D-094). */
const TOOL_CALL_BUDGET_MS = 5_000;
/** A sidecar reading a piped test run's output holds the tool result: a short reply to a short prompt. */
const HIDDEN_RUN_BUDGET_MS = 4_000;
/** The name the reading's sidecar call and trace event go under: it serves every module. */
const HIDDEN_RUN_MODULE = "runs";
/**
 * A guard against an Exocortex bug in a module-written compaction summary, not a guess at how long
 * one takes (D-098): the calls end when the engine stops answering, and pi's own abort stops them.
 * Pi's default compaction runs after it.
 */
const COMPACT_BUDGET_MS = 15 * 60_000;
/** Hard cap on how long modules may hold a new user prompt before the agent starts on it. */
const USER_TURN_BUDGET_MS = 6_000;
/** Hard cap on how long modules' `dispose` may hold a session's end. */
const DISPOSE_BUDGET_MS = 2_000;
/**
 * How many times in a row modules may continue the agent before the user speaks again. Modules
 * keep their own, lower limits (the supervisor's `maxContinuations`); this one holds if theirs fails.
 */
const MAX_CONSECUTIVE_CONTINUATIONS = 20;
/** A module's saved state is one line in pi's session file: keep it far from the megabytes. */
const MAX_STATE_CHARS = 256 * 1024;
/** `customType` of the session entry that keeps `/exo` toggles (see `command.ts`). */
export const OVERRIDES_ENTRY = "exo.overrides";
/** `customType` of a user-turn message more than one module contributed to. */
const SHARED_CONTEXT_TYPE = "exo.context";

const stateEntryOf = (id: string): string => `exo.${id}.state`;

export interface ModuleHostOptions {
	readonly runtime: Runtime;
	readonly onError: (where: string, error: unknown) => void;
	readonly log: (message: string) => void;
	/** Module factories by config id; defaults to every module Exocortex ships. */
	readonly modules?: Readonly<Record<string, ModuleFactory>>;
	/** Overrides the hold-the-loop budgets (tests). */
	readonly budgetsMs?: {
		readonly rewrite?: number;
		readonly toolCall?: number;
		readonly hiddenRun?: number;
		readonly settle?: number;
		readonly compact?: number;
		readonly userTurn?: number;
		readonly dispose?: number;
	};
	/** Overrides {@link MAX_CONSECUTIVE_CONTINUATIONS} (tests). */
	readonly maxContinuations?: number;
	/** Gives a compaction the main agent's context to continue from (D-093); none without it. */
	readonly fork?: ForkTracker;
}

/** A module instance, the settings it was built from, and the switch that turns its context off. */
interface Slot {
	readonly id: string;
	readonly module: ExoModule;
	/** Canonical JSON of the merged settings: an instance is kept while this does not change. */
	readonly settingsKey: string;
	readonly life: { over: boolean };
}

/**
 * Runs Exocortex modules inside pi (brief §5.4): builds the enabled modules per session from
 * config and `/exo` overrides, translates pi events into harness-agnostic module hooks, and
 * applies their settle actions:
 * - `suggest` → pre-fill the editor (Enter sends it); RPC clients receive `set_editor_text`;
 * - `continue` → a persisted `exo.<module>` custom message plus `continue: true` (D-029);
 * - `notify` → status line, and a notification for warnings.
 *
 * Every hook that holds pi runs under `withBudget`: a module that hangs, throws or ignores its
 * signal costs the user at most the hook's budget and never an unhandled rejection (D-078).
 */
export function registerModuleHost(pi: ExtensionAPI, options: ModuleHostOptions): void {
	const { runtime, onError } = options;
	const factories = options.modules ?? MODULES;
	const rewriteBudgetMs = options.budgetsMs?.rewrite ?? REWRITE_BUDGET_MS;
	const toolCallBudgetMs = options.budgetsMs?.toolCall ?? TOOL_CALL_BUDGET_MS;
	const hiddenRunBudgetMs = options.budgetsMs?.hiddenRun ?? HIDDEN_RUN_BUDGET_MS;
	const settleBudgetMs = options.budgetsMs?.settle ?? SETTLE_BUDGET_MS;
	const compactBudgetMs = options.budgetsMs?.compact ?? COMPACT_BUDGET_MS;
	const userTurnBudgetMs = options.budgetsMs?.userTurn ?? USER_TURN_BUDGET_MS;
	const disposeBudgetMs = options.budgetsMs?.dispose ?? DISPOSE_BUDGET_MS;
	const maxContinuations = options.maxContinuations ?? MAX_CONSECUTIVE_CONTINUATIONS;
	const hold = createHoldUi(onError);
	let slots: Slot[] = [];
	let cwd = process.cwd();
	let sessionId = "";
	/** Each module's last saved state in this session, as it was written (see `ModuleContext.saveState`). */
	const savedStates = new Map<string, { readonly value: JsonValue; readonly json: string }>();
	/** The follow-up a module last put in the editor: sent unchanged, it is not the user's wording. */
	let suggested: string | undefined;
	let turn: UserTurn | undefined;
	/** Continuations applied since the user last spoke. */
	let continuations = 0;
	/** Aborts the settle hook now running: the user interrupted it or is leaving the session. */
	let settling: AbortController | undefined;
	/** Tool results are handled one after another: each waits for the one before it. */
	let toolResults: Promise<unknown> = Promise.resolve();
	/**
	 * When the rewrites of the current batch of tool results must be done (D-098). A rewrite holds
	 * the agent only once every tool of the batch has finished: before that, the other tools are
	 * still running and it costs nothing, so it gets its own {@link REWRITE_BUDGET_MS}. The rewrites
	 * that start after the last tool finished share one, set by the first of them. Each result had
	 * its own before, so a batch of N could hold the agent N times that. Cleared when the turn ends.
	 */
	let batchDeadline: number | undefined;
	/** The current batch's tool calls and the results in so far (calls made by tools not counted). */
	let batchCalls = 0;
	let batchResults = 0;
	const newBatch = () => {
		batchDeadline = undefined;
		batchCalls = 0;
		batchResults = 0;
	};
	/** Runs (`agent_start`) so far: a job's continuation is over once a run after it settles. */
	let runs = 0;
	/** Each module's background job now running (D-097), by module id. */
	const jobs = new Map<string, Job>();
	/** The session's latest context: where a background job's result is shown. */
	let lastCtx: ExtensionContext | undefined;
	/**
	 * A follow-up that arrived while the user was typing (D-097): kept beside their draft until they
	 * add it ({@link OFFER_SHORTCUT}, `/exo add`) or send a message. Its action is committed only
	 * when added, so a module can tell a follow-up the user never took.
	 */
	let offer: { readonly id: string; readonly action: SettleAction & { readonly kind: "suggest" } } | undefined;

	const modules = (): ExoModule[] => slots.map((slot) => slot.module);
	const reporter = (where: string) => (error: unknown) => onError(where, error);

	function build(): void {
		const config = runtime.config;
		const on = config?.enabled === true && !runtime.overrides.allOff;
		const previous = new Map(slots.map((slot) => [slot.id, slot]));
		const next: Slot[] = [];
		for (const [id, factory] of Object.entries(factories)) {
			const settings = { ...config?.modules[id], ...runtime.overrides.modules[id] };
			if (!on || settings.enabled !== true) continue;
			const settingsKey = canonicalJson(toJsonValue(settings));
			const kept = previous.get(id);
			if (kept?.settingsKey === settingsKey) {
				// Unchanged: the instance keeps what it has learned this session.
				previous.delete(id);
				next.push(kept);
				continue;
			}
			if (kept) {
				// Before its replacement is built: the two may share a file or a database.
				previous.delete(id);
				void retire(kept);
			}
			const life = { over: false };
			try {
				next.push({ id, module: factory(settings, moduleContext(id, life)), settingsKey, life });
			} catch (error) {
				onError(`module ${id}`, error);
			}
		}
		for (const dropped of previous.values()) void retire(dropped);
		slots = next;
	}

	/** Disposes one instance and turns its context off. Never rejects. */
	async function retire(slot: Slot): Promise<void> {
		jobs.get(slot.id)?.stop.abort();
		try {
			await slot.module.dispose?.();
		} catch (error) {
			onError(`${slot.id}.dispose`, error);
		} finally {
			slot.life.over = true;
		}
	}

	async function disposeAll(): Promise<void> {
		settling?.abort();
		stopJobs();
		const retiring = slots;
		slots = [];
		if (retiring.length === 0) return;
		await withBudget(disposeBudgetMs, undefined, () => Promise.all(retiring.map(retire)), reporter("modules.dispose"));
		// A dispose still running has had its time: its instance may not write into the next session.
		for (const slot of retiring) slot.life.over = true;
	}

	runtime.rebuildModules = build;
	runtime.disposeModules = disposeAll;
	runtime.moduleStatus = () => modules().map((m) => m.status?.() ?? m.id);
	runtime.moduleIds = () => Object.keys(factories);
	runtime.addOffer = (ctx) => addOffer(ctx);
	try {
		pi.registerShortcut(OFFER_SHORTCUT, {
			description: "Exocortex: add the offered follow-up below your message",
			handler: (ctx) => {
				try {
					addOffer(ctx);
				} catch (error) {
					onError("modules.addOffer", error);
				}
			},
		});
	} catch (error) {
		onError("modules.registerShortcut", error);
	}
	runtime.moduleCommand = async (id, args, dialog) => {
		try {
			return await modules()
				.find((m) => m.id === id)
				?.command?.(args, dialog);
		} catch (error) {
			onError(`${id}.command`, error);
			return undefined;
		}
	};

	function moduleContext(id: string, life: { readonly over: boolean }): ModuleContext {
		return {
			cwd,
			sessionId,
			savedState: savedStates.get(id)?.value,
			saveState: (value) => {
				if (life.over) return;
				try {
					saveState(id, value);
				} catch (error) {
					onError(`${id}.saveState`, error);
				}
			},
			pool: () => runtime.pool,
			embedder: () => runtime.embedder,
			record: (event) => runtime.record({ ...event, module: id, synthetic: true }),
			runCommand: (command, opts) => runShellCommand(command, { cwd, ...opts }),
			progress: (message) => {
				if (life.over) return;
				try {
					hold.progress(message);
				} catch (error) {
					onError(`${id}.progress`, error);
				}
			},
			log: (message) => options.log(`${id}: ${message}`),
			background: (label, job) => startJob(id, life, label, job),
			deliverLate: (text) => deliverLate(id, life, text),
			forkPrefix: async () => {
				const ctx = lastCtx;
				if (life.over || !ctx || !options.fork) return undefined;
				return options.fork.prefix(ctx);
			},
		};
	}

	/**
	 * Steers a module's late help into the running agent (D-098): pi takes it after the current
	 * tool batch, before the next model call (`pi-agent-core/dist/agent-loop.js:186`), and an agent
	 * about to stop takes one more turn for it. Nothing is sent while the agent is idle.
	 */
	function deliverLate(id: string, life: { readonly over: boolean }, text: string): boolean {
		const ctx = lastCtx;
		if (life.over || !ctx) return false;
		try {
			if (ctx.isIdle()) return false;
			pi.sendMessage(
				{ customType: `exo.${id}`, content: text, display: true, details: { exo: { module: id, late: true } } },
				{ deliverAs: "steer" },
			);
			return true;
		} catch (error) {
			onError(`${id}.deliverLate`, error);
			return false;
		}
	}

	/**
	 * Runs a module's background job (D-097): no time limit, stopped by a message, Escape, or the
	 * session or module going away. Its action is applied when it ends, unless it was stopped.
	 */
	function startJob(
		id: string,
		life: { readonly over: boolean },
		label: string,
		job: (signal: AbortSignal) => Promise<SettleAction | undefined>,
	): boolean {
		const ctx = lastCtx;
		if (life.over || !ctx?.hasUI) return false;
		jobs.get(id)?.stop.abort();
		const entry: Job = { stop: new AbortController(), label, startedTurn: false, sentAtRun: 0 };
		jobs.set(id, entry);
		showJobs(ctx);
		const unwatch = watchEscape(ctx, () => entry.stop.abort());
		void (async () => {
			try {
				const action = await job(entry.stop.signal);
				if (action && !entry.stop.signal.aborted && !life.over) {
					entry.sentAtRun = runs;
					entry.startedTurn = deliver(id, action, ctx);
				}
			} catch (error) {
				onError(`${id}.background`, error);
			} finally {
				unwatch();
				if (jobs.get(id) === entry && !entry.startedTurn) jobs.delete(id);
				showJobs(ctx);
			}
		})();
		return true;
	}

	/** Shows a follow-up above the editor, with how to add it; undefined takes the last one away. */
	function showOffer(ctx: ExtensionContext, next: typeof offer): void {
		offer = next;
		try {
			const lines = next && [
				`exo: ${next.action.summary}`,
				`${OFFER_SHORTCUT} (or /exo add) adds the follow-up below your message · sending without it drops it`,
			];
			ctx.ui.setWidget(OFFER_WIDGET_KEY, lines, { placement: "aboveEditor" });
		} catch (error) {
			onError("modules.showOffer", error);
		}
	}

	/**
	 * Adds the offered follow-up below the user's draft, which stays as they wrote it. One undo
	 * (`ctrl+-`) takes it back out (`setEditorText`, `pi-tui/dist/components/editor.js:921-933`).
	 * False when nothing is offered.
	 */
	function addOffer(ctx: ExtensionContext): boolean {
		const taken = offer;
		if (!taken || !ctx.hasUI) return false;
		const draft = ctx.ui.getEditorText().trimEnd();
		ctx.ui.setEditorText(draft === "" ? taken.action.text : `${draft}\n\n${taken.action.text}`);
		showOffer(ctx, undefined);
		commit(taken.id, taken.action);
		return true;
	}

	/** The user sent a message or the session changed: an offer not taken is dropped. */
	function dropOffer(ctx: ExtensionContext | undefined): void {
		if (offer && ctx) showOffer(ctx, undefined);
		offer = undefined;
	}

	/** The turn a job started has ended: the job is no longer waited on. */
	function endStartedTurns(ctx: ExtensionContext): void {
		// Only a run that began after the job's continuation was sent can have been that continuation.
		const ended = [...jobs].filter(([, job]) => job.startedTurn && runs > job.sentAtRun);
		for (const [id] of ended) jobs.delete(id);
		if (ended.length > 0) showJobs(ctx);
	}

	/** Stops every job, and forgets those whose turn started: what they read is about to change. */
	function stopJobs(): void {
		if (jobs.size === 0) return;
		for (const [id, job] of jobs) {
			job.stop.abort();
			if (job.startedTurn) jobs.delete(id);
		}
		if (lastCtx) showJobs(lastCtx);
	}

	/** The jobs on the status line (`exo.background`); the eval driver waits while it is set. */
	function showJobs(ctx: ExtensionContext): void {
		try {
			if (!ctx.hasUI) return;
			const running = [...jobs.values()].filter((j) => !j.startedTurn).map((j) => j.label);
			const continued = [...jobs.values()].filter((j) => j.startedTurn).map((j) => j.label);
			const text =
				running.length > 0
					? `exo: ${running.join(", ")}… (Esc stops)`
					: continued.length > 0
						? `exo: continuing after ${continued.join(", ")}`
						: undefined;
			ctx.ui.setStatus(BACKGROUND_STATUS_KEY, text);
		} catch (error) {
			// A context from a session that was replaced: there is nothing to show it on.
			onError("modules.showJobs", error);
		}
	}

	/**
	 * A background job's action, applied as a settle action is. A continuation starts a new turn,
	 * since the boundary that could carry one has passed; with the agent busy it is offered instead.
	 * True when it started a turn.
	 */
	function deliver(id: string, action: SettleAction, ctx: ExtensionContext): boolean {
		// Pi is not idle while it settles; a continuation sent then is still taken (it steers into the
		// ending run, `core/agent-session.js:1427`). Only a run the user started makes it a suggestion.
		const busy = !ctx.isIdle() && settling === undefined;
		const now = action.kind === "continue" && busy ? { ...action, kind: "suggest" as const } : action;
		const applied = apply(id, now, ctx);
		if (!applied.used || applied.offered) return false;
		const entry = applied.result?.entries?.[0];
		let started = false;
		if (now.kind === "continue" && entry?.type === "custom_message") {
			pi.sendMessage(
				{ customType: entry.customType, content: entry.content, display: entry.display, details: entry.details },
				{ triggerTurn: true },
			);
			started = true;
		}
		commit(id, action);
		return started;
	}

	/** Writes a module's state as an `exo.<module>.state` session entry (never sent to the model). */
	function saveState(id: string, value: JsonValue): void {
		const json = JSON.stringify(value);
		if (json === undefined) throw new Error("state is not JSON");
		if (json === savedStates.get(id)?.json) return;
		if (json.length > MAX_STATE_CHARS) {
			throw new Error(`state of ${json.length} characters is over the ${MAX_STATE_CHARS} limit: not saved`);
		}
		const stored = JSON.parse(json) as JsonValue;
		pi.appendEntry(stateEntryOf(id), stored);
		savedStates.set(id, { value: stored, json });
	}

	/** Reads what this session's entries hold for Exocortex: `/exo` toggles and each module's state. */
	function restore(ctx: ExtensionContext): void {
		runtime.overrides.allOff = false;
		runtime.overrides.modules = {};
		savedStates.clear();
		const stateEntries = new Map(Object.keys(factories).map((id) => [stateEntryOf(id), id]));
		const entries = lastCustomEntries(ctx, new Set([OVERRIDES_ENTRY, ...stateEntries.keys()]));
		for (const [customType, data] of entries) {
			const id = stateEntries.get(customType);
			if (id === undefined) restoreOverrides(data);
			else if (data !== undefined) {
				const value = toJsonValue(data);
				savedStates.set(id, { value, json: JSON.stringify(value) });
			}
		}
	}

	/** Applies persisted toggles, ignoring anything that is not the shape `command.ts` writes. */
	function restoreOverrides(data: unknown): void {
		if (!isRecord(data) || typeof data["allOff"] !== "boolean" || !isRecord(data["modules"])) return;
		runtime.overrides.allOff = data["allOff"];
		for (const [id, override] of Object.entries(data["modules"])) {
			if (id in factories && isRecord(override)) runtime.overrides.modules[id] = { ...override };
		}
	}

	/** Tells a module its result was used. A throwing `commit` must not undo the result. */
	function commit(id: string, result: Committable): void {
		try {
			result.commit?.();
		} catch (error) {
			onError(`${id}.commit`, error);
		}
	}

	function each(where: string, fn: (module: ExoModule) => void): void {
		for (const module of modules()) {
			try {
				fn(module);
			} catch (error) {
				onError(`${module.id}.${where}`, error);
			}
		}
	}

	/** Registers a handler that reports its own errors and resolves undefined instead of throwing. */
	function guarded<E, R>(where: string, handler: (event: E, ctx: ExtensionContext) => R | Promise<R>) {
		return async (event: E, ctx: ExtensionContext): Promise<R | undefined> => {
			try {
				return await handler(event, ctx);
			} catch (error) {
				onError(`modules.${where}`, error);
				return undefined;
			}
		};
	}

	pi.on(
		"session_start",
		guarded("session_start", async (_event, ctx) => {
			// A new session, or the same one reloaded: modules start over from what the session holds.
			stopJobs();
			dropOffer(lastCtx);
			newBatch();
			lastCtx = ctx;
			await disposeAll();
			cwd = ctx.cwd;
			sessionId = ctx.sessionManager.getSessionId();
			suggested = undefined;
			turn = undefined;
			continuations = 0;
			toolResults = Promise.resolve();
			runtime.activate(ctx.cwd);
			try {
				restore(ctx);
			} catch (error) {
				onError("modules.restore", error);
			}
			build();
			return undefined;
		}),
	);

	pi.on(
		"input",
		guarded("input", (event) => {
			// What a background job read, and what an offered follow-up was about, is about to change.
			stopJobs();
			dropOffer(lastCtx);
			newBatch();
			const accepted = suggested !== undefined && sameText(suggested, event.text);
			suggested = undefined;
			if (event.source !== "extension") continuations = 0;
			const current: UserTurn = {
				text: event.text,
				origin: event.source === "extension" ? "extension" : accepted ? "suggestion" : "user",
			};
			turn = current;
			each("onUserTurn", (m) => m.onUserTurn?.(current));
			return undefined;
		}),
	);

	pi.on(
		"before_agent_start",
		guarded("before_agent_start", (_event, ctx) => {
			lastCtx = ctx;
			return hold.whileHolding(ctx, () => userTurnContext(ctx));
		}),
	);

	pi.on(
		"session_compact",
		guarded("session_compact", () => {
			each("onCompacted", (m) => m.onCompacted?.());
			return undefined;
		}),
	);

	// Never returns a result: a module may look before a tool runs, never block or change it.
	pi.on(
		"tool_call",
		guarded("tool_call", async (event: ToolCallEvent, ctx) => {
			if (event.parentToolCallId === undefined) batchCalls += 1;
			await hold.whileHolding(ctx, () => beforeToolCall(event, signalOf(ctx)));
			return undefined;
		}),
	);

	pi.on(
		"tool_result",
		guarded("tool_result", (event, ctx) => {
			lastCtx = ctx;
			if ((event as { parentToolCallId?: string }).parentToolCallId === undefined) batchResults += 1;
			return hold.whileHolding(ctx, () => inOrder(() => toolResult(event, signalOf(ctx))));
		}),
	);

	// Pi ends a turn after its whole batch of tool results: the next batch has its own budget.
	pi.on(
		"turn_end",
		guarded("turn_end", () => {
			newBatch();
			return undefined;
		}),
	);
	pi.on(
		"agent_start",
		guarded("agent_start", () => {
			runs += 1;
			return undefined;
		}),
	);
	// A run that settles ends a job's continuation, also one aborted before its settle hook (pi
	// skips `agent_before_settle` then, `core/agent-session.js:1362`).
	pi.on(
		"agent_settled",
		guarded("agent_settled", (_event, ctx) => {
			endStartedTurns(ctx);
			return undefined;
		}),
	);

	pi.on(
		"agent_before_settle",
		guarded("agent_before_settle", (event, ctx) => hold.whileHolding(ctx, () => settle(event, ctx))),
	);

	pi.on(
		"session_before_compact",
		guarded("session_before_compact", (event, ctx) => hold.whileHolding(ctx, () => compact(event, ctx))),
	);

	// The user is leaving the session: pi waits for a running settle hook before it switches
	// (PI_API_NOTES §5), so stop it now. If another extension then cancels the switch, the cost is
	// one settle check that reported nothing.
	const stopSettling = guarded("stop_settling", () => {
		settling?.abort();
		return undefined;
	});
	pi.on("session_before_switch", stopSettling);
	pi.on("session_before_fork", stopSettling);

	pi.on(
		"session_shutdown",
		guarded("session_shutdown", async () => {
			await disposeAll();
			return undefined;
		}),
	);

	/** Runs `fn` after every tool result before it has been handled, whether those succeeded or not. */
	function inOrder<T>(fn: () => Promise<T>): Promise<T> {
		const run = toolResults.then(fn, fn);
		toolResults = run.catch(() => undefined);
		return run;
	}

	/**
	 * Lets modules look before a tool runs (D-094), each with an equal share of what is left of the
	 * budget. A call another tool made (`parentToolCallId`) is not offered: it has no result of its
	 * own in the conversation.
	 */
	async function beforeToolCall(event: ToolCallEvent, parent: AbortSignal | undefined): Promise<void> {
		const lookers = modules().filter((m) => m.beforeToolCall);
		if (lookers.length === 0 || event.parentToolCallId !== undefined) return;
		const call: ToolCall = { toolName: event.toolName, toolCallId: event.toolCallId, input: toObject(event.input) };
		const deadline = Date.now() + toolCallBudgetMs;
		for (const [index, module] of lookers.entries()) {
			await withBudget(
				remainingMs(deadline) / (lookers.length - index),
				parent,
				(signal) => module.beforeToolCall?.(call, signal),
				reporter(`${module.id}.beforeToolCall`),
			);
		}
	}

	/**
	 * One finished tool call: reads a hidden exit code, tells every module, then offers the result
	 * for rewriting. Pi runs tools in parallel and fires `tool_result` as each finishes, so without
	 * `inOrder` two results' hooks would interleave (PI_API_NOTES §2).
	 */
	async function toolResult(event: ToolResultEvent, parent: AbortSignal | undefined) {
		const reported: ToolOutcome = {
			toolName: event.toolName,
			input: toObject(event.input),
			isError: event.isError,
			exitCode: exitCodeOf(event.structuredContent),
			output: textOf(event.content),
		};
		const hidden = await readHidden(reported, event.toolCallId, parent);
		const outcome: ToolOutcome = hidden ? { ...reported, hidden } : reported;
		each("onToolResult", (m) => m.onToolResult?.(outcome));
		return rewrite(event, outcome, parent);
	}

	/**
	 * For a test or build run whose exit code a pipe hid, what its output shows (D-075): read once
	 * here, so every module acts on the same answer. A sidecar is asked only about a test run the
	 * output grammar cannot read, within its own deadline; modules get `unknown` if it fails.
	 */
	async function readHidden(
		tool: ToolOutcome,
		toolCallId: string,
		parent: AbortSignal | undefined,
	): Promise<RunVerdict | undefined> {
		if (slots.length === 0 || !hiddenRun(tool)) return undefined;
		const reading = await withBudget(
			hiddenRunBudgetMs,
			parent,
			(signal) => {
				if (readHiddenRun(tool) === "unknown" && runtime.pool) hold.progress("Reading the test run's result…");
				return judgeHiddenRun(
					tool,
					{ pool: runtime.pool, module: HIDDEN_RUN_MODULE, timeoutMs: hiddenRunBudgetMs },
					signal,
				);
			},
			reporter("modules.readHidden"),
		);
		if (!reading) return undefined;
		runtime.record({
			kind: "exo.run",
			module: HIDDEN_RUN_MODULE,
			synthetic: true,
			data: { toolCallId, ...reading },
		});
		return reading.verdict;
	}

	/**
	 * Lets modules add context to a new user prompt (D-029): their texts become one persisted
	 * custom message right after the user's message, `exo.<module>` or, from several modules,
	 * `exo.context`. `before_agent_start` fires once per prompt, so each `input` is offered once.
	 */
	async function userTurnContext(ctx: ExtensionContext) {
		const current = turn;
		turn = undefined;
		const providers = modules().filter((m) => m.contextForUserTurn);
		if (!current || providers.length === 0) return undefined;
		const parent = signalOf(ctx);
		const deadline = Date.now() + userTurnBudgetMs;
		const parts: { readonly module: string; readonly text: string; readonly result: UserTurnContext }[] = [];
		for (const [index, module] of providers.entries()) {
			const result = await withBudget(
				remainingMs(deadline) / (providers.length - index),
				parent,
				(signal) => module.contextForUserTurn?.(current, signal),
				reporter(`${module.id}.contextForUserTurn`),
			);
			const text = typeof result?.text === "string" ? result.text.trim() : "";
			if (result && text !== "") parts.push({ module: module.id, text, result });
		}
		const [first] = parts;
		if (!first) return undefined;
		for (const part of parts) commit(part.module, part.result);
		const contributors = parts.map((p) => p.module);
		return {
			message: {
				customType: parts.length === 1 ? `exo.${first.module}` : SHARED_CONTEXT_TYPE,
				content: parts.map((p) => p.text).join("\n\n"),
				// Shown to the user (D-060): text added on their behalf should be visible.
				display: true,
				details: {
					exo: parts.length === 1 ? { module: first.module, modules: contributors } : { modules: contributors },
				},
			},
		};
	}

	/**
	 * Lets modules rewrite a text-only tool result in turn. The original stays in the trace (the
	 * recorder's `tool.result` runs first); each rewrite is traced as `exo.rewrite` and noted in
	 * merged `details.exo.rewrites` (D-029).
	 */
	async function rewrite(event: ToolResultEvent, outcome: ToolOutcome, parent: AbortSignal | undefined) {
		const rewriters = modules().filter((m) => m.rewriteToolResult);
		if (rewriters.length === 0 || !event.content.every((part) => part.type === "text")) return undefined;
		const draft: ToolResultDraft = {
			...outcome,
			toolCallId: event.toolCallId,
			current: outcome.output,
			fullOutputPath: fullOutputPathOf(event.details, event.structuredContent),
			status: statusOf(outcome.output),
		};
		const deadline = rewriteDeadline();
		const notes: RewriteNote[] = [];
		const applied: { readonly module: string; readonly result: Committable }[] = [];
		let current = draft.current;
		for (const [index, module] of rewriters.entries()) {
			// An equal share of what is left: a slow module cannot use up the time of the ones after it.
			const result = await withBudget(
				remainingMs(deadline) / (rewriters.length - index),
				parent,
				(signal) => module.rewriteToolResult?.({ ...draft, current }, signal),
				reporter(`${module.id}.rewriteToolResult`),
			);
			if (!result || typeof result.text !== "string" || result.text === current) continue;
			current = result.text;
			notes.push({ module: module.id, note: result.note });
			applied.push({ module: module.id, result });
			runtime.record({
				kind: "exo.rewrite",
				synthetic: true,
				module: module.id,
				data: { ...result.details, toolCallId: draft.toolCallId, note: result.note, chars: result.text.length },
			});
		}
		if (notes.length === 0) return undefined;
		for (const { module, result } of applied) commit(module, result);
		return rewrittenResult(event, current, notes);
	}

	/**
	 * Offers compaction to modules (D-017): the first summary wins and is traced as
	 * `exo.compaction`; otherwise (or on any failure) pi compacts as usual.
	 */
	async function compact(event: SessionBeforeCompactEvent, ctx: ExtensionContext) {
		const compactors = modules().filter((m) => m.compact);
		if (compactors.length === 0) return undefined;
		const { preparation } = event;
		const span = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
		const modified = new Set([...preparation.fileOps.written, ...preparation.fileOps.edited]);
		const request: Omit<CompactionRequest, "previousDetails"> = {
			reason: event.reason,
			conversation: serializeSpan(span),
			userMessages: span.filter((m) => m.role === "user").map((m) => textOf(m.content)),
			previousSummary: preparation.previousSummary ?? null,
			filesRead: [...preparation.fileOps.read].filter((f) => !modified.has(f)),
			filesModified: [...modified],
			tokensBefore: preparation.tokensBefore,
			customInstructions: event.customInstructions ?? null,
			// After an overflow the last request was never answered: there is nothing to continue from.
			fork: (event.reason === "overflow" ? undefined : await options.fork?.prefix(ctx)) ?? null,
			conversationSince: (timestamp) => serializeSpan(span.filter((m) => (m.timestamp ?? 0) > timestamp)),
		};
		const deadline = Date.now() + compactBudgetMs;
		for (const module of compactors) {
			if (event.signal.aborted) break;
			const previousDetails = previousCompactionDetails(event.branchEntries, module.id);
			const result = await withBudget(
				remainingMs(deadline),
				event.signal,
				(signal) => module.compact?.({ ...request, previousDetails }, signal),
				reporter(`${module.id}.compact`),
			);
			if (!result || typeof result.summary !== "string" || result.summary === "") continue;
			commit(module.id, result);
			return {
				compaction: {
					summary: result.summary,
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					details: { exo: { ...result.details, module: module.id } },
				},
			};
		}
		return undefined;
	}

	/**
	 * Asks modules what to do now that the agent has stopped. Pi waits for this hook, also when the
	 * user presses Escape or leaves the session, and gives no abort signal for it (PI_API_NOTES §5):
	 * so the hook stops itself on its budget, on Escape, and when the session is being replaced.
	 * Nothing is applied after that: pi would persist a continuation and then not continue.
	 */
	async function settle(event: AgentBeforeSettleEvent, ctx: ExtensionContext) {
		lastCtx = ctx;
		endStartedTurns(ctx);
		const asked = modules().filter((m) => m.onSettle);
		if (asked.length === 0) return undefined;
		const info = settleInfo(event, ctx);
		const stop = new AbortController();
		settling = stop;
		const unwatch = watchEscape(ctx, () => stop.abort());
		const deadline = Date.now() + settleBudgetMs;
		hold.progress("checking the work…");
		// Nothing to report leaves nothing on the status line.
		hold.settled(ctx, undefined);
		try {
			for (const module of asked) {
				const action = await withBudget(
					remainingMs(deadline),
					stop.signal,
					(signal) => module.onSettle?.(info, signal),
					reporter(`${module.id}.onSettle`),
				);
				if (stop.signal.aborted) break;
				if (!action) continue;
				const applied = apply(module.id, action, ctx);
				if (applied.used && !applied.offered) commit(module.id, action);
				if (action.kind !== "notify") return applied.result; // one actionable result per settle
			}
			return undefined;
		} finally {
			unwatch();
			if (settling === stop) settling = undefined;
		}
	}

	/** Calls `onEscape` when the user presses Escape (the TUI's interrupt key) until the returned function is called. */
	function watchEscape(ctx: ExtensionContext, onEscape: () => void): () => void {
		try {
			if (!ctx.hasUI || typeof ctx.ui.onTerminalInput !== "function") return () => {};
			const unsubscribe = ctx.ui.onTerminalInput((data) => {
				if (isEscapeKey(data)) onEscape();
				return undefined;
			});
			return () => {
				try {
					unsubscribe();
				} catch (error) {
					onError("modules.watchEscape", error);
				}
			};
		} catch (error) {
			onError("modules.watchEscape", error);
			return () => {};
		}
	}

	/** When this result's rewrites must be done: its own budget while other tools of its batch still run, else the batch's. */
	function rewriteDeadline(): number {
		if (batchResults < batchCalls) return Date.now() + rewriteBudgetMs;
		batchDeadline ??= Date.now() + rewriteBudgetMs;
		return batchDeadline;
	}

	/** Puts a follow-up in the editor, or, beside a draft the user is typing, offers it (D-097). */
	function suggest(
		moduleId: string,
		action: SettleAction & { readonly kind: "suggest" },
		ctx: ExtensionContext,
	): { readonly used: boolean; readonly offered?: boolean } {
		// Nothing can show it: the module is not told it was used.
		if (!ctx.hasUI) return { used: false };
		suggested = action.text;
		if (ctx.ui.getEditorText().trim() !== "") {
			showOffer(ctx, { id: moduleId, action });
			hold.settled(ctx, `exo: ${action.summary} (${OFFER_SHORTCUT} adds it to your message)`);
			return { used: true, offered: true };
		}
		// A follow-up offered earlier is about an older state: this one replaces it.
		if (offer) showOffer(ctx, undefined);
		hold.settled(ctx, `exo: ${action.summary} (suggestion in editor)`);
		ctx.ui.setEditorText(action.text);
		ctx.ui.notify(`${action.summary}. Suggested follow-up is in the editor: Enter sends it.`, "info");
		return { used: true };
	}

	/** Carries out a settle action. `used` is false when the action was dropped instead. */
	function apply(
		moduleId: string,
		action: SettleAction,
		ctx: ExtensionContext,
	): { readonly used: boolean; readonly offered?: boolean; readonly result?: BoundaryResult } {
		switch (action.kind) {
			case "suggest":
				return suggest(moduleId, action, ctx);
			case "continue": {
				if (continuations >= maxContinuations) {
					const refusal = `${action.summary}: not continuing, the agent was continued ${continuations} times in a row`;
					hold.settled(ctx, `exo: ${refusal}`);
					if (ctx.hasUI) ctx.ui.notify(refusal, "warning");
					runtime.record({
						kind: "exo.action",
						synthetic: true,
						module: moduleId,
						data: { action: "continue_refused", continuations },
					});
					return { used: false };
				}
				continuations += 1;
				hold.settled(ctx, `exo: ${action.summary} (continuing)`);
				// Boundary entries skip pi's message_end, so record the injection here (brief §9).
				runtime.record({
					kind: "message",
					synthetic: true,
					module: moduleId,
					data: { role: "custom", customType: `exo.${moduleId}`, content: action.text },
				});
				return {
					used: true,
					result: {
						entries: [
							{
								type: "custom_message",
								customType: `exo.${moduleId}`,
								content: action.text,
								display: true,
								details: { exo: { module: moduleId } },
							},
						],
						continue: true,
					},
				};
			}
			case "notify":
				hold.settled(ctx, `exo: ${action.summary}`);
				if (action.level === "warning" && ctx.hasUI) ctx.ui.notify(action.summary, "warning");
				return { used: true };
		}
	}
}
