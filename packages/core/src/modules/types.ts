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

/** A finished tool call, as the harness reported it (original output, before any rewrite). */
export interface ToolOutcome {
	readonly toolName: string;
	readonly input: { readonly [key: string]: JsonValue };
	readonly isError: boolean;
	readonly exitCode: number | null;
	readonly output: string;
}

/** A tool result offered to modules for rewriting, before the main model sees it. */
export interface ToolResultDraft extends ToolOutcome {
	readonly toolCallId: string;
	/** The text so far: the original output, or an earlier module's rewrite of it. */
	readonly current: string;
	/** Where the harness saved the untruncated output, if it did. */
	readonly fullOutputPath: string | null;
}

/** A module's replacement for a tool result's text. */
export interface ToolRewrite {
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
	readonly filesRead: readonly string[];
	readonly filesModified: readonly string[];
	readonly tokensBefore: number;
	/** Extra instructions the user gave (e.g. `/compact focus on the parser`). */
	readonly customInstructions: string | null;
}

/** The main agent has stopped and is about to hand control back to the user. */
export interface SettleInfo {
	readonly outcome: "completed" | "aborted" | "error";
	/** Text of the final assistant message (empty if none). */
	readonly lastAssistantText: string;
}

/**
 * What a module wants done when the agent settles.
 * - `suggest`: offer `text` as the user's next message (the user sends or edits it).
 * - `continue`: send `text` as a synthetic follow-up and keep the agent going.
 * - `notify`: just tell the user (`info` goes to the status line, `warning` also notifies).
 */
export type SettleAction =
	| { readonly kind: "suggest"; readonly text: string; readonly summary: string }
	| { readonly kind: "continue"; readonly text: string; readonly summary: string }
	| { readonly kind: "notify"; readonly summary: string; readonly level: "info" | "warning" };

/** One module instance per harness session; hooks are optional and must never throw. */
export interface ExoModule {
	readonly id: string;
	onUserTurn?(turn: UserTurn): void;
	/**
	 * Text to add to the context right after the user's message, before the agent starts on it
	 * (D-029: persisted as its own message, so the prompt cache is untouched). Awaited within a
	 * short budget; the agent waits on it.
	 */
	contextForUserTurn?(turn: UserTurn, signal: AbortSignal): Promise<string | undefined>;
	onToolResult?(tool: ToolOutcome): void;
	/**
	 * Rewrites a tool result before it enters the context (D-029: cache-safe, it is new content).
	 * Awaited within a short budget, since it holds the agent loop; modules run in order, each
	 * seeing earlier rewrites in `current`.
	 */
	rewriteToolResult?(draft: ToolResultDraft, signal: AbortSignal): Promise<ToolRewrite | undefined>;
	/** Awaited by the harness before it settles, within a time budget. */
	onSettle?(info: SettleInfo, signal: AbortSignal): Promise<SettleAction | undefined>;
	/**
	 * Writes the compaction summary (brief §6.5). The first module returning one wins; undefined
	 * leaves compaction to the harness's default.
	 */
	compact?(request: CompactionRequest, signal: AbortSignal): Promise<string | undefined>;
	/** The harness compacted the conversation: text added earlier may no longer be in the context. */
	onCompacted?(): void;
	/**
	 * Handles `/exo <module> <args>` beyond on/off; returns the reply, or undefined for unknown args.
	 * `dialog` is there when the harness can ask the user questions.
	 */
	command?(args: string, dialog?: Dialog): string | undefined | Promise<string | undefined>;
	/** Short status for `/exo status` and the status line. */
	status?(): string;
}

export type ModuleFactory = (settings: Readonly<Record<string, unknown>>, context: ModuleContext) => ExoModule;
