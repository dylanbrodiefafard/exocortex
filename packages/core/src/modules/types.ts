import type { ForkPrefix } from "../inference/client.ts";
import type { Embedder } from "../inference/embeddings.ts";
import type { SidecarPool } from "../inference/pool.ts";
import type { JsonValue, TraceEventInput } from "../trace/store.ts";
import type { CommandOutput } from "./command.ts";

/**
 * Everything a module may use. Harness-agnostic: adapters build it from their own events
 * (brief §5.4). Modules never touch the harness directly.
 */
export interface ModuleContext {
	readonly cwd: string;
	/**
	 * The harness's id for the session this module serves. It stays the same when the session is
	 * reloaded or resumed and when the module is rebuilt, so it identifies "the same session" where
	 * an id made up at creation would not.
	 */
	readonly sessionId: string;
	/**
	 * What this module last passed to {@link ModuleContext.saveState} in this session, or undefined
	 * if it never did. Read it once, in the factory, to pick up where the previous instance left
	 * off (after a reload, a resume, or a settings change that rebuilt the module).
	 *
	 * Treat it as untrusted input: it may have been written by an older version of the module.
	 */
	readonly savedState: JsonValue | undefined;
	/**
	 * Keeps `value` with the session, replacing what was saved before: the next instance of this
	 * module in this session gets it as {@link ModuleContext.savedState}. The model never sees it.
	 *
	 * - Pass the whole state each time, not a change to it.
	 * - Each call that changes the value adds a line to the session file, so save when the state
	 *   changes in a way worth keeping (a new ledger, a count), not on every hook. A value equal to
	 *   the last one saved is not written again.
	 * - A value over 256 KB as JSON is dropped (and reported), and so is anything saved after the
	 *   session ended. Never throws.
	 */
	readonly saveState: (value: JsonValue) => void;
	/** Sidecar pool; undefined when no engine is configured (modules then do nothing). */
	readonly pool: () => SidecarPool | undefined;
	/** Text embeddings for similarity search; undefined when no embeddings server is configured. */
	readonly embedder: () => Embedder | undefined;
	/** Appends to the current session's trace; a no-op when tracing is off. */
	readonly record: (event: Omit<TraceEventInput, "module" | "synthetic">) => void;
	/** Runs a shell command in `cwd` (process group killed on timeout). */
	readonly runCommand: (
		command: string,
		options: { readonly timeoutMs: number; readonly tailChars?: number; readonly signal?: AbortSignal },
	) => Promise<CommandOutput>;
	/**
	 * Tells the user what a hook is waiting on ("Diagnosing the repeated failure…"). Call it just
	 * before a wait they would notice; the harness clears it when the hook returns. A no-op
	 * without a UI.
	 */
	readonly progress: (message: string) => void;
	/** Debug log (no-op unless the harness's debug output is on). */
	readonly log: (message: string) => void;
	/**
	 * Runs work that would hold the session too long, without holding it (D-097). It has no time
	 * limit: `job`'s signal is aborted when the user sends a message, presses Escape, or the
	 * session or this module instance goes away. The action it returns is then applied as a settle
	 * action is (a `continue` starts a new turn if the agent is still idle); none is applied after
	 * an abort. One job per module: starting another aborts the one running. False when it cannot
	 * run (no UI to stop it from, or the module is gone).
	 */
	readonly background: (label: string, job: (signal: AbortSignal) => Promise<SettleAction | undefined>) => boolean;
	/**
	 * Adds `text` for the model to read before its next call, while the agent is still working
	 * (D-098): for help that was not ready when the tool result it belongs to went back. Sent as an
	 * `exo.<module>` custom message, appended after the current tool batch (D-029). False, and
	 * nothing sent, when the agent is idle: help for a run that ended is stale.
	 */
	readonly deliverLate: (text: string) => boolean;
	/**
	 * The main agent's context as a request body to continue from (D-093), when there is one now:
	 * its last request was answered and nothing has changed the context since. Never rejects.
	 */
	readonly forkPrefix: () => Promise<ForkPrefix | undefined>;
}

/**
 * Questions a module's own command may put to the user (D-066). Only commands get one: a dialog
 * waits on the user for as long as they take, which no hook may do.
 */
export interface Dialog {
	/** The option the user picked, or undefined when they cancelled. `title` may span lines. */
	readonly select: (title: string, options: readonly string[]) => Promise<string | undefined>;
	/** The text the user typed, or undefined when they cancelled. */
	readonly input: (title: string, placeholder?: string) => Promise<string | undefined>;
	/** Tells the user something while the command is still running. */
	readonly notify: (message: string) => void;
}

/** A user (or harness-extension) prompt that starts or continues a task. */
export interface UserTurn {
	readonly text: string;
	/**
	 * - `user`: typed by the user.
	 * - `extension`: sent programmatically by some extension.
	 * - `suggestion`: a module's suggested follow-up that the user sent unchanged. It continues the
	 *   same task and is not the user's own wording.
	 */
	readonly origin: "user" | "extension" | "suggestion";
}

/** A tool call the model made, about to run. */
export interface ToolCall {
	readonly toolName: string;
	readonly toolCallId: string;
	readonly input: { readonly [key: string]: JsonValue };
}

/** A finished tool call, as the harness reported it (original output, before any rewrite). */
export interface ToolOutcome {
	readonly toolName: string;
	readonly input: { readonly [key: string]: JsonValue };
	readonly isError: boolean;
	readonly exitCode: number | null;
	readonly output: string;
	/**
	 * For a test or build run whose exit code a pipe hid (`cargo test | tail`): what its output
	 * shows (D-075). Set by the harness adapter; read it through `outcomeOf`.
	 */
	readonly hidden?: "passed" | "failed" | "unknown";
}

/** A tool result offered to modules for rewriting, before the main model sees it. */
export interface ToolResultDraft extends ToolOutcome {
	readonly toolCallId: string;
	/** The text so far: the original output, or an earlier module's rewrite of it. */
	readonly current: string;
	/** Where the harness saved the untruncated output, if it did. */
	readonly fullOutputPath: string | null;
	/**
	 * What the harness appended to the output to say how the command ended (its exit status), if
	 * anything. It is the end of {@link ToolResultDraft.current} but not in the full-output file.
	 */
	readonly status: string | null;
}

/**
 * What every hook result may carry so the module learns whether the result was used.
 *
 * A hook can lose its time budget, be aborted, or lose to another module, after it has already
 * returned. So a module must not change state on the assumption that its result reached the model
 * or the user ("this preference was shown", "this hint was given") before returning: it does that
 * in `commit`.
 */
export interface Committable {
	/**
	 * Called once, synchronously, when the harness adapter hands this result to the harness. Not
	 * called for a result that was dropped: one that arrived after the budget or an abort, a
	 * rewrite that changed nothing, a summary that lost to an earlier module's, a suggestion with
	 * no UI to show it, a continuation the host refused. Must not throw.
	 *
	 * "Handed to the harness" is as far as the adapter can see: a harness that then discards the
	 * result (the user aborted in the same instant) does not say so.
	 */
	readonly commit?: () => void;
}

/** A module's text for the context right after the user's message. */
export interface UserTurnContext extends Committable {
	readonly text: string;
}

/** A module's replacement for a tool result's text. */
export interface ToolRewrite extends Committable {
	/** The new text the main model sees (replaces {@link ToolResultDraft.current}). */
	readonly text: string;
	/** Short description for the trace and status, e.g. "trimmed 1200→140 lines". */
	readonly note: string;
	/** Extra fields for the rewrite's trace event (e.g. where the full output was saved). */
	readonly details?: { readonly [key: string]: JsonValue };
}

/** The harness is about to compact the conversation: a module may write the summary. */
export interface CompactionRequest {
	readonly reason: "manual" | "threshold" | "overflow";
	/** The span being summarized away, serialized by the harness with role labels. */
	readonly conversation: string;
	/** User messages in that span, verbatim, oldest first. */
	readonly userMessages: readonly string[];
	/** The summary from the previous compaction, if any (to update rather than rewrite). */
	readonly previousSummary: string | null;
	/**
	 * The `details` this module returned with the previous compaction's summary
	 * ({@link CompactionSummary.details}), or null when that summary was not this module's or
	 * carried none. Unlike module state, it belongs to that compaction: it survives a reload and
	 * follows the conversation's branch.
	 */
	readonly previousDetails: { readonly [key: string]: JsonValue } | null;
	readonly filesRead: readonly string[];
	readonly filesModified: readonly string[];
	readonly tokensBefore: number;
	/**
	 * The main model's context window in tokens, or null when the harness does not know it. A
	 * sidecar on the same engine has the same window: a transcript is cut only past it (D-111).
	 */
	readonly contextWindow: number | null;
	/** Extra instructions the user gave (e.g. `/compact focus on the parser`). */
	readonly customInstructions: string | null;
	/**
	 * The main agent's whole context, for a sidecar call that continues from it (D-093): the span
	 * above and the recent messages the harness keeps. Null when the harness cannot give one, as
	 * after a context overflow.
	 */
	readonly fork: ForkPrefix | null;
	/**
	 * The span's messages newer than `timestamp` (ms since the epoch), serialized as
	 * `conversation` is; "" when there are none. For a summary written earlier that only needs what
	 * came after it (D-098).
	 */
	readonly conversationSince: (timestamp: number) => string;
}

/** A module's compaction summary. */
export interface CompactionSummary extends Committable {
	/** The text that replaces the summarized span in the context. */
	readonly summary: string;
	/**
	 * `facts`: the module could not write the handover, and `summary` holds only what it tracked
	 * (the user's requests, files, commands). The harness then writes its own summary and puts
	 * this after it, so those facts are not lost with the module's summary (D-111). A module's
	 * summary is whole when left out.
	 */
	readonly part?: "facts";
	/**
	 * Structured data to keep with the compaction (the facts behind the summary). The model never
	 * sees it; the module gets it back as {@link CompactionRequest.previousDetails} next time.
	 * A `module` key is reserved for the harness adapter.
	 */
	readonly details?: { readonly [key: string]: JsonValue };
}

/** The main agent has stopped and is about to hand control back to the user. */
export interface SettleInfo {
	readonly outcome: "completed" | "aborted" | "error";
	/** Text of the final assistant message (empty if none). */
	readonly lastAssistantText: string;
	/**
	 * The text of every assistant message since the user's last message, oldest first; the last is
	 * {@link SettleInfo.lastAssistantText}. A module's own follow-ups and late notes do not end the
	 * span: they are not the user's. Only text parts, no reasoning, and messages with no text are
	 * left out. Absent when the harness cannot tell.
	 */
	readonly assistantTexts?: readonly string[];
	/** The main model's context window in tokens, when the harness knows: what budgets may be sized from. */
	readonly contextWindow?: number;
	/**
	 * How full the context is, when the harness knows: its tokens, and the count at which the
	 * harness compacts on its own (D-098).
	 */
	readonly context?: { readonly tokens: number; readonly compactAt: number };
}

/**
 * What a module wants done when the agent settles.
 * - `suggest`: offer `text` as the user's next message (the user sends or edits it).
 * - `continue`: send `text` as a synthetic follow-up and keep the agent going.
 * - `notify`: just tell the user (`info` goes to the status line, `warning` also notifies).
 */
export type SettleAction = (
	| { readonly kind: "suggest"; readonly text: string; readonly summary: string }
	| { readonly kind: "continue"; readonly text: string; readonly summary: string }
	| { readonly kind: "notify"; readonly summary: string; readonly level: "info" | "warning" }
) & {
	/**
	 * As {@link Committable.commit}, told how the action was delivered: a `continue` that arrives
	 * while the user has started the agent again is offered as a `suggest` instead, and is committed
	 * as one (the user may still send it). Left out, it was delivered as its own kind.
	 */
	readonly commit?: (delivered?: SettleAction["kind"]) => void;
};

/**
 * One module instance per harness session; hooks are optional and must never throw.
 *
 * The instance is rebuilt when its settings change (`/exo <module> …`) and when the session is
 * reloaded, so anything that must survive that goes through {@link ModuleContext.saveState}.
 */
export interface ExoModule {
	readonly id: string;
	onUserTurn?(turn: UserTurn): void;
	/**
	 * Text to add to the context right after the user's message, before the agent starts on it
	 * (D-029: persisted as its own message, so the prompt cache is untouched). Awaited within a
	 * short budget shared by the modules; the agent waits on it.
	 */
	contextForUserTurn?(turn: UserTurn, signal: AbortSignal): Promise<UserTurnContext | undefined>;
	/**
	 * Called before a tool runs, to look at what it is about to change (the file before an edit).
	 * It cannot change or stop the call. Awaited within a short budget shared by the modules, since
	 * the tool waits on it; a hook that runs out of time simply has nothing (D-094).
	 */
	beforeToolCall?(call: ToolCall, signal: AbortSignal): Promise<void>;
	/** Called for every finished tool call, one at a time, in the order the results came in. */
	onToolResult?(tool: ToolOutcome): void;
	/**
	 * Rewrites a tool result before it enters the context (D-029: cache-safe, it is new content).
	 * Awaited within a short budget, since it holds the agent loop; modules run in order, each
	 * seeing earlier rewrites in `current` and each getting an equal share of the time left. One
	 * tool result is offered at a time, even when the harness runs tools in parallel.
	 */
	rewriteToolResult?(draft: ToolResultDraft, signal: AbortSignal): Promise<ToolRewrite | undefined>;
	/**
	 * The agent stopped: told to every module, before any `onSettle` and whatever they return
	 * (D-106). For work that reacts to the stop without acting on the session (an early summary,
	 * bookkeeping). Must return at once; anything slow runs in the background.
	 */
	onSettled?(info: SettleInfo): void;
	/**
	 * Awaited by the harness before it settles, within a time budget. `signal` also aborts when
	 * the user interrupts or leaves the session; a result returned after that is dropped.
	 */
	onSettle?(info: SettleInfo, signal: AbortSignal): Promise<SettleAction | undefined>;
	/**
	 * Writes the compaction summary (brief §6.5). The first whole summary wins; without one, the
	 * first `part: "facts"` summary follows the harness's own (D-111); undefined leaves compaction
	 * to the harness's default.
	 */
	compact?(request: CompactionRequest, signal: AbortSignal): Promise<CompactionSummary | undefined>;
	/** The harness compacted the conversation: text added earlier may no longer be in the context. */
	onCompacted?(): void;
	/**
	 * Handles `/exo <module> <args>` beyond on/off; returns the reply, or undefined for unknown args.
	 * `dialog` is there when the harness can ask the user questions.
	 */
	command?(args: string, dialog?: Dialog): string | undefined | Promise<string | undefined>;
	/** Short status for `/exo status` and the status line. */
	status?(): string;
	/**
	 * The session is ending, or this instance is being replaced or switched off: release what it
	 * holds (files, database handles) and stop background work. It may still save state and
	 * record. No hook is called afterwards, and once it returns `saveState` and `progress` do
	 * nothing; at a session's end the pool, the embedder and the trace go away right after.
	 * Awaited briefly at session end; must not throw.
	 */
	dispose?(): void | Promise<void>;
}

export type ModuleFactory = (settings: Readonly<Record<string, unknown>>, context: ModuleContext) => ExoModule;
