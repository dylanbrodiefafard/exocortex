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
	/** Appends to the current session's trace; a no-op when tracing is off. */
	readonly record: (event: Omit<TraceEventInput, "module" | "synthetic">) => void;
	/** Runs a shell command in `cwd` (process group killed on timeout). */
	readonly runCommand: (
		command: string,
		options: { readonly timeoutMs: number; readonly tailChars?: number; readonly signal?: AbortSignal },
	) => Promise<CommandOutput>;
	/** Debug log (no-op unless the harness's debug output is on). */
	readonly log: (message: string) => void;
}

/** A user (or harness-extension) prompt that starts or continues a task. */
export interface UserTurn {
	readonly text: string;
	/** `extension`: sent programmatically by some extension, not typed by the user. */
	readonly origin: "user" | "extension";
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
	/** Short status for `/exo status` and the status line. */
	status?(): string;
}

export type ModuleFactory = (settings: Readonly<Record<string, unknown>>, context: ModuleContext) => ExoModule;
