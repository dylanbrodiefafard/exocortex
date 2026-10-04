import type { AgentBeforeSettleEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type ExoModule,
	type JsonValue,
	type ModuleContext,
	type ModuleFactory,
	runShellCommand,
	type SettleAction,
	toJsonValue,
} from "@exocortex/core";
import { createSupervisor, SUPERVISOR_ID } from "@exocortex/mod-supervisor";
import type { Runtime } from "./runtime.ts";
import { exitCodeOf } from "./trace-recorder.ts";

/** Every module Exocortex knows, by config id. */
const MODULES: Readonly<Record<string, ModuleFactory>> = {
	[SUPERVISOR_ID]: createSupervisor,
};

/** Hard cap on how long settle hooks may hold pi before it settles (checks + verdict). */
const SETTLE_BUDGET_MS = 5 * 60_000;
const STATUS_KEY = "exo";

export interface ModuleHostOptions {
	readonly runtime: Runtime;
	readonly onError: (where: string, error: unknown) => void;
	readonly log: (message: string) => void;
	/** Module factories by config id; defaults to every module Exocortex ships. */
	readonly modules?: Readonly<Record<string, ModuleFactory>>;
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
	let modules: ExoModule[] = [];
	let cwd = process.cwd();

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

	function moduleContext(id: string): ModuleContext {
		return {
			cwd,
			pool: () => runtime.pool,
			record: (event) => runtime.traceSession?.append({ ...event, module: id, synthetic: true }),
			runCommand: (command, opts) => runShellCommand(command, { cwd, ...opts }),
			log: (message) => options.log(`${id}: ${message}`),
		};
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
		each("onUserTurn", (m) =>
			m.onUserTurn?.({ text: event.text, origin: event.source === "extension" ? "extension" : "user" }),
		);
		return undefined;
	});

	pi.on("tool_result", (event) => {
		each("onToolResult", (m) =>
			m.onToolResult?.({
				toolName: event.toolName,
				input: toObject(event.input),
				isError: event.isError,
				exitCode: exitCodeOf(event.structuredContent),
				output: textOf(event.content),
			}),
		);
		return undefined;
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		try {
			return await settle(event, ctx);
		} catch (error) {
			onError("modules.agent_before_settle", error);
			return undefined;
		}
	});

	pi.on("session_shutdown", () => {
		modules = [];
		return undefined;
	});

	async function settle(event: AgentBeforeSettleEvent, ctx: ExtensionContext) {
		const settling = modules.filter((m) => m.onSettle);
		if (settling.length === 0) return undefined;
		const info = { outcome: event.outcome, lastAssistantText: lastAssistantText(event) };
		const controller = new AbortController();
		const budget = setTimeout(() => controller.abort(), SETTLE_BUDGET_MS);
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, "exo: checking the work…");
		try {
			for (const module of settling) {
				const action = await module.onSettle?.(info, controller.signal).catch((error: unknown) => {
					onError(`${module.id}.onSettle`, error);
					return undefined;
				});
				if (!action) continue;
				const result = apply(module.id, action, ctx);
				if (action.kind !== "notify") return result; // one actionable result per settle
			}
			return undefined;
		} finally {
			clearTimeout(budget);
		}
	}

	function apply(moduleId: string, action: SettleAction, ctx: ExtensionContext) {
		const status = (text: string | undefined) => {
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, text);
		};
		switch (action.kind) {
			case "suggest":
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
