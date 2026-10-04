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
	readonly runCommand: (command: string, options: { readonly timeoutMs: number }) => Promise<CommandOutput>;
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
 * - `notify`: just tell the user.
 */
export type SettleAction =
	| { readonly kind: "suggest"; readonly text: string; readonly summary: string }
	| { readonly kind: "continue"; readonly text: string; readonly summary: string }
	| { readonly kind: "notify"; readonly summary: string };

/** One module instance per harness session; hooks are optional and must never throw. */
export interface ExoModule {
	readonly id: string;
	onUserTurn?(turn: UserTurn): void;
	onToolResult?(tool: ToolOutcome): void;
	/** Awaited by the harness before it settles, within a time budget. */
	onSettle?(info: SettleInfo, signal: AbortSignal): Promise<SettleAction | undefined>;
	/** Short status for `/exo status` and the status line. */
	status?(): string;
}

export type ModuleFactory = (settings: Readonly<Record<string, unknown>>, context: ModuleContext) => ExoModule;
