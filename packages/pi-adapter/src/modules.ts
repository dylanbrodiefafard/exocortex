import {
	type AgentBeforeSettleEvent,
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	serializeConversation,
	type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import {
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
	type ToolOutcome,
	type ToolResultDraft,
	toJsonValue,
	type UserTurn,
} from "@exocortex/core";
import { COMPACTION_ID, createCompaction } from "@exocortex/mod-compaction";
import { createMemory, MEMORY_ID } from "@exocortex/mod-memory";
import { createSupervisor, SUPERVISOR_ID } from "@exocortex/mod-supervisor";
import { createTriage, TRIAGE_ID } from "@exocortex/mod-triage";
import { createTrimmer, TRIMMER_ID } from "@exocortex/mod-trimmer";
import type { Runtime } from "./runtime.ts";
import { exitCodeOf } from "./trace-recorder.ts";

/**
 * Every module Exocortex knows, by config id. Order matters: tool-result rewrites run in this
 * order (trim first, then annotate), as do settle hooks.
 */
const MODULES: Readonly<Record<string, ModuleFactory>> = {
	[TRIMMER_ID]: createTrimmer,
	[TRIAGE_ID]: createTriage,
	[MEMORY_ID]: createMemory,
	[SUPERVISOR_ID]: createSupervisor,
	[COMPACTION_ID]: createCompaction,
};

/** Hard cap on how long settle hooks may hold pi before it settles (checks + verdict). */
const SETTLE_BUDGET_MS = 5 * 60_000;
/** Hard cap on how long tool-result rewrites may hold the agent loop, across all modules. */
const REWRITE_BUDGET_MS = 20_000;
/** A sidecar reading a piped test run's output holds the tool result: a short reply to a short prompt. */
const HIDDEN_RUN_BUDGET_MS = 4_000;
/** The name the reading's sidecar call and trace event go under: it serves every module. */
const HIDDEN_RUN_MODULE = "runs";
/** Hard cap on a module-written compaction summary; pi's default compaction runs after it. */
const COMPACT_BUDGET_MS = 120_000;
/** Hard cap on how long modules may hold a new user prompt before the agent starts on it. */
const USER_TURN_BUDGET_MS = 6_000;
const STATUS_KEY = "exo";

export interface ModuleHostOptions {
	readonly runtime: Runtime;
	readonly onError: (where: string, error: unknown) => void;
	readonly log: (message: string) => void;
	/** Module factories by config id; defaults to every module Exocortex ships. */
	readonly modules?: Readonly<Record<string, ModuleFactory>>;
	/** Overrides the hold-the-loop budgets (tests). */
	readonly budgetsMs?: {
		readonly rewrite?: number;
		readonly hiddenRun?: number;
		readonly settle?: number;
		readonly compact?: number;
		readonly userTurn?: number;
	};
}

/**
 * Runs Exocortex modules inside pi (brief §5.4): builds the enabled modules per session from
 * config and `/exo` overrides, translates pi events into harness-agnostic module hooks, and
 * applies their settle actions:
 * - `suggest` → pre-fill the editor (Enter sends it); RPC clients receive `set_editor_text`;
 * - `continue` → a persisted `exo.<module>` custom message plus `continue: true` (D-029);
 * - `notify` → status line, and a notification for warnings.
 */
export function registerModuleHost(pi: ExtensionAPI, options: ModuleHostOptions): void {
	const { runtime, onError } = options;
	const factories = options.modules ?? MODULES;
	const rewriteBudgetMs = options.budgetsMs?.rewrite ?? REWRITE_BUDGET_MS;
	const hiddenRunBudgetMs = options.budgetsMs?.hiddenRun ?? HIDDEN_RUN_BUDGET_MS;
	const settleBudgetMs = options.budgetsMs?.settle ?? SETTLE_BUDGET_MS;
	const compactBudgetMs = options.budgetsMs?.compact ?? COMPACT_BUDGET_MS;
	const userTurnBudgetMs = options.budgetsMs?.userTurn ?? USER_TURN_BUDGET_MS;
	let modules: ExoModule[] = [];
	let cwd = process.cwd();
	/** The follow-up a module last put in the editor: sent unchanged, it is not the user's wording. */
	let suggested: string | undefined;
	let turn: UserTurn | undefined;
	/** The UI of the hooks now holding pi, how many there are, and whether one of them reported progress. */
	let holding: { ui: ExtensionContext["ui"]; hooks: number; shown: boolean } | undefined;
	/** The status the last settle left on the status line: progress replaces it only for a while. */
	let settledStatus: string | undefined;

	/**
	 * Runs a hook that holds pi, letting modules say what they are waiting on (`ctx.progress`):
	 * the message goes on the status line and next to pi's working spinner, and both are restored
	 * when the last such hook returns.
	 */
	async function whileHolding<T>(ctx: ExtensionContext, hook: () => Promise<T>): Promise<T> {
		if (!ctx.hasUI) return hook();
		holding = holding ?? { ui: ctx.ui, hooks: 0, shown: false };
		const held = holding;
		held.hooks += 1;
		try {
			return await hook();
		} finally {
			held.hooks -= 1;
			if (held.hooks === 0) {
				if (held.shown) {
					held.ui.setStatus(STATUS_KEY, settledStatus);
					held.ui.setWorkingMessage();
				}
				if (holding === held) holding = undefined;
			}
		}
	}

	function progress(message: string): void {
		if (!holding) return;
		holding.shown = true;
		holding.ui.setStatus(STATUS_KEY, `exo: ${message}`);
		holding.ui.setWorkingMessage(message);
	}

	function build(): void {
		modules = [];
		const config = runtime.config;
		if (!config?.enabled || runtime.overrides.allOff) return;
		for (const [id, factory] of Object.entries(factories)) {
			const settings = { ...config.modules[id], ...runtime.overrides.modules[id] };
			if (settings.enabled !== true) continue;
			try {
				modules.push(factory(settings, moduleContext(id)));
			} catch (error) {
				onError(`module ${id}`, error);
			}
		}
	}
	runtime.rebuildModules = build;
	runtime.moduleStatus = () => modules.map((m) => m.status?.() ?? m.id);
	runtime.moduleIds = () => Object.keys(factories);
	runtime.moduleCommand = async (id, args, dialog) => {
		try {
			return await modules.find((m) => m.id === id)?.command?.(args, dialog);
		} catch (error) {
			onError(`${id}.command`, error);
			return undefined;
		}
	};

	function moduleContext(id: string): ModuleContext {
		return {
			cwd,
			pool: () => runtime.pool,
			embedder: () => runtime.embedder,
			record: (event) => runtime.traceSession?.append({ ...event, module: id, synthetic: true }),
			runCommand: (command, opts) => runShellCommand(command, { cwd, ...opts }),
			progress: (message) => {
				try {
					progress(message);
				} catch (error) {
					onError(`${id}.progress`, error);
				}
			},
			log: (message) => options.log(`${id}: ${message}`),
		};
	}

	/**
	 * For a test or build run whose exit code a pipe hid, what its output shows (D-075): read once
	 * here, so every module acts on the same answer. A sidecar is asked only about a test run the
	 * output grammar cannot read, within its own deadline; modules get `unknown` if it fails.
	 */
	async function readHidden(tool: ToolOutcome, toolCallId: string): Promise<RunVerdict | undefined> {
		if (modules.length === 0 || !hiddenRun(tool)) return undefined;
		const controller = new AbortController();
		const budget = setTimeout(() => controller.abort(), hiddenRunBudgetMs);
		try {
			if (readHiddenRun(tool) === "unknown" && runtime.pool) progress("Reading the test run's result…");
			const reading = await judgeHiddenRun(
				tool,
				{ pool: runtime.pool, module: HIDDEN_RUN_MODULE, timeoutMs: hiddenRunBudgetMs },
				controller.signal,
			);
			if (!reading) return undefined;
			runtime.traceSession?.append({
				kind: "exo.run",
				module: HIDDEN_RUN_MODULE,
				synthetic: true,
				data: { toolCallId, ...reading },
			});
			return reading.verdict;
		} catch (error) {
			onError("modules.readHidden", error);
			return undefined;
		} finally {
			clearTimeout(budget);
		}
	}

	function each(where: string, fn: (module: ExoModule) => void): void {
		for (const module of modules) {
			try {
				fn(module);
			} catch (error) {
				onError(`${module.id}.${where}`, error);
			}
		}
	}

	pi.on("session_start", (_event, ctx) => {
		try {
			cwd = ctx.cwd;
			runtime.activate(ctx.cwd);
			build();
		} catch (error) {
			onError("modules.session_start", error);
		}
		return undefined;
	});

	pi.on("input", (event) => {
		const accepted = suggested !== undefined && sameText(suggested, event.text);
		suggested = undefined;
		const current: UserTurn = {
			text: event.text,
			origin: event.source === "extension" ? "extension" : accepted ? "suggestion" : "user",
		};
		turn = current;
		each("onUserTurn", (m) => m.onUserTurn?.(current));
		return undefined;
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		try {
			return await whileHolding(ctx, userTurnContext);
		} catch (error) {
			onError("modules.before_agent_start", error);
			return undefined;
		}
	});

	pi.on("session_compact", () => {
		each("onCompacted", (m) => m.onCompacted?.());
		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		const reported: ToolOutcome = {
			toolName: event.toolName,
			input: toObject(event.input),
			isError: event.isError,
			exitCode: exitCodeOf(event.structuredContent),
			output: textOf(event.content),
		};
		try {
			return await whileHolding(ctx, async () => {
				const hidden = await readHidden(reported, event.toolCallId);
				const outcome: ToolOutcome = hidden ? { ...reported, hidden } : reported;
				each("onToolResult", (m) => m.onToolResult?.(outcome));
				return rewrite(event, outcome);
			});
		} catch (error) {
			onError("modules.tool_result", error);
			return undefined;
		}
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		try {
			return await settle(event, ctx);
		} catch (error) {
			onError("modules.agent_before_settle", error);
			return undefined;
		}
	});

	pi.on("session_before_compact", async (event, ctx) => {
		try {
			return await whileHolding(ctx, () => compact(event));
		} catch (error) {
			onError("modules.session_before_compact", error);
			return undefined;
		}
	});

	pi.on("session_shutdown", () => {
		modules = [];
		return undefined;
	});

	/**
	 * Lets modules add context to a new user prompt (D-029): their texts become one persisted
	 * `exo.<module>` custom message right after the user's message. `before_agent_start` fires once
	 * per prompt, so each `input` is offered once.
	 */
	async function userTurnContext() {
		const current = turn;
		turn = undefined;
		const providers = modules.filter((m) => m.contextForUserTurn);
		if (!current || providers.length === 0) return undefined;
		const controller = new AbortController();
		const budget = setTimeout(() => controller.abort(), userTurnBudgetMs);
		try {
			const parts: { module: string; text: string }[] = [];
			for (const module of providers) {
				if (controller.signal.aborted) break;
				const text = await untilAborted(
					module.contextForUserTurn?.(current, controller.signal),
					controller.signal,
				).catch((error: unknown) => {
					onError(`${module.id}.contextForUserTurn`, error);
					return undefined;
				});
				if (text?.trim()) parts.push({ module: module.id, text: text.trim() });
			}
			const [first] = parts;
			if (!first) return undefined;
			return {
				message: {
					customType: `exo.${first.module}`,
					content: parts.map((p) => p.text).join("\n\n"),
					display: true,
					details: { exo: { module: first.module, modules: parts.map((p) => p.module) } },
				},
			};
		} finally {
			clearTimeout(budget);
		}
	}

	/**
	 * Lets modules rewrite a text-only tool result in turn. The original stays in the trace (the
	 * recorder's `tool.result` runs first); each rewrite is traced as `exo.rewrite` and noted in
	 * merged `details.exo.rewrites` (D-029).
	 */
	async function rewrite(event: ToolResultEvent, outcome: ToolOutcome) {
		const rewriters = modules.filter((m) => m.rewriteToolResult);
		if (rewriters.length === 0 || !event.content.every((part) => part.type === "text")) return undefined;
		const controller = new AbortController();
		const budget = setTimeout(() => controller.abort(), rewriteBudgetMs);
		const draft = {
			...outcome,
			toolCallId: event.toolCallId,
			current: outcome.output,
			fullOutputPath: fullOutputPathOf(event.details, event.structuredContent),
			status: statusOf(outcome.output),
		};
		try {
			const { text, notes } = await applyRewrites(rewriters, draft, controller.signal);
			return notes.length === 0 ? undefined : rewrittenResult(event, text, notes);
		} finally {
			clearTimeout(budget);
		}
	}

	async function applyRewrites(rewriters: readonly ExoModule[], draft: ToolResultDraft, signal: AbortSignal) {
		const notes: RewriteNote[] = [];
		let current = draft.current;
		for (const module of rewriters) {
			if (signal.aborted) break;
			const result = await untilAborted(module.rewriteToolResult?.({ ...draft, current }, signal), signal).catch(
				(error: unknown) => {
					onError(`${module.id}.rewriteToolResult`, error);
					return undefined;
				},
			);
			if (!result || result.text === current) continue;
			current = result.text;
			notes.push({ module: module.id, note: result.note });
			runtime.traceSession?.append({
				kind: "exo.rewrite",
				synthetic: true,
				module: module.id,
				data: { ...result.details, toolCallId: draft.toolCallId, note: result.note, chars: result.text.length },
			});
		}
		return { text: current, notes };
	}

	/**
	 * Offers compaction to modules (D-017): the first summary wins and is traced as
	 * `exo.compaction`; otherwise (or on any failure) pi compacts as usual.
	 */
	async function compact(event: SessionBeforeCompactEvent) {
		const compactors = modules.filter((m) => m.compact);
		if (compactors.length === 0) return undefined;
		const { preparation } = event;
		const span = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
		const modified = new Set([...preparation.fileOps.written, ...preparation.fileOps.edited]);
		const request = {
			reason: event.reason,
			conversation: serializeConversation(convertToLlm(span)),
			userMessages: span.filter((m) => m.role === "user").map((m) => textOf(m.content)),
			previousSummary: preparation.previousSummary ?? null,
			filesRead: [...preparation.fileOps.read].filter((f) => !modified.has(f)),
			filesModified: [...modified],
			tokensBefore: preparation.tokensBefore,
			customInstructions: event.customInstructions ?? null,
		};
		const controller = new AbortController();
		const abort = () => controller.abort();
		event.signal.addEventListener("abort", abort, { once: true });
		const budget = setTimeout(abort, compactBudgetMs);
		try {
			for (const module of compactors) {
				const summary = await untilAborted(module.compact?.(request, controller.signal), controller.signal).catch(
					(error: unknown) => {
						onError(`${module.id}.compact`, error);
						return undefined;
					},
				);
				if (!summary) continue;
				return {
					compaction: {
						summary,
						firstKeptEntryId: preparation.firstKeptEntryId,
						tokensBefore: preparation.tokensBefore,
						details: { exo: { module: module.id } },
					},
				};
			}
			return undefined;
		} finally {
			clearTimeout(budget);
			event.signal.removeEventListener("abort", abort);
		}
	}

	async function settle(event: AgentBeforeSettleEvent, ctx: ExtensionContext) {
		const settling = modules.filter((m) => m.onSettle);
		if (settling.length === 0) return undefined;
		const info = { outcome: event.outcome, lastAssistantText: lastAssistantText(event) };
		const controller = new AbortController();
		const budget = setTimeout(() => controller.abort(), settleBudgetMs);
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, "exo: checking the work…");
		let acted = false;
		try {
			for (const module of settling) {
				const action = await module.onSettle?.(info, controller.signal).catch((error: unknown) => {
					onError(`${module.id}.onSettle`, error);
					return undefined;
				});
				if (!action) continue;
				acted = true;
				const result = apply(module.id, action, ctx);
				if (action.kind !== "notify") return result; // one actionable result per settle
			}
			return undefined;
		} finally {
			// Nothing to report: don't leave "checking the work…" on the status line.
			if (!acted) settledStatus = undefined;
			if (!acted && ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
			clearTimeout(budget);
		}
	}

	function apply(moduleId: string, action: SettleAction, ctx: ExtensionContext) {
		const status = (text: string | undefined) => {
			settledStatus = text;
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, text);
		};
		switch (action.kind) {
			case "suggest":
				suggested = action.text;
				status(`exo: ${action.summary} (suggestion in editor)`);
				if (ctx.hasUI) {
					ctx.ui.setEditorText(action.text);
					ctx.ui.notify(`${action.summary}. Suggested follow-up is in the editor: Enter sends it.`, "info");
				}
				return undefined;
			case "continue":
				status(`exo: ${action.summary} (continuing)`);
				// Boundary entries skip pi's message_end, so record the injection here (brief §9).
				runtime.traceSession?.append({
					kind: "message",
					synthetic: true,
					module: moduleId,
					data: { role: "custom", customType: `exo.${moduleId}`, content: action.text },
				});
				return {
					entries: [
						{
							type: "custom_message" as const,
							customType: `exo.${moduleId}`,
							content: action.text,
							display: true,
							details: { exo: { module: moduleId } },
						},
					],
					continue: true,
				};
			case "notify":
				status(`exo: ${action.summary}`);
				if (action.level === "warning" && ctx.hasUI) ctx.ui.notify(action.summary, "warning");
				return undefined;
		}
	}
}

function sameText(a: string, b: string): boolean {
	return a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
}

function lastAssistantText(event: AgentBeforeSettleEvent): string {
	const messages = event.context.llmMessages;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role === "assistant") return textOf(message.content);
	}
	return "";
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part: unknown) => typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text",
		)
		.map((part: { text?: unknown }) => String(part.text ?? ""))
		.join("\n");
}

function toObject(value: unknown): { readonly [key: string]: JsonValue } {
	const json = toJsonValue(value);
	return isJsonObject(json) ? json : {};
}

function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface RewriteNote {
	readonly module: string;
	readonly note: string;
}

/** The pi `tool_result` patch for rewritten text: merged `details.exo`, structuredContent kept. */
function rewrittenResult(event: ToolResultEvent, text: string, notes: readonly RewriteNote[]) {
	const details = isRecord(event.details) ? event.details : {};
	const exo = isRecord(details["exo"]) ? details["exo"] : {};
	return {
		content: [{ type: "text" as const, text }],
		details: { ...details, exo: { ...exo, rewrites: notes } },
		// Replacing content without structuredContent would drop it (PI_API_NOTES §4).
		...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Bash reports where it saved untruncated output in `details` and `structuredContent`. */
function fullOutputPathOf(details: unknown, structured: unknown): string | null {
	const fromDetails = isRecord(details) ? details["fullOutputPath"] : undefined;
	const fromStructured = isRecord(structured) ? structured["full_output_path"] : undefined;
	const path = fromDetails ?? fromStructured;
	return typeof path === "string" && path !== "" ? path : null;
}

/** Bash ends a failing command's text with its exit status, after the output (PI_API_NOTES, `bash`). */
function statusOf(text: string): string | null {
	return /\n\n(Command exited with code \d+)$/.exec(text)?.[1] ?? null;
}

/** Resolves with `promise`, or with undefined once `signal` aborts (a module that ignores its signal cannot hold pi). */
function untilAborted<T>(promise: Promise<T | undefined> | undefined, signal: AbortSignal): Promise<T | undefined> {
	if (!promise) return Promise.resolve(undefined);
	return new Promise((resolve, reject) => {
		const onAbort = () => resolve(undefined);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}
