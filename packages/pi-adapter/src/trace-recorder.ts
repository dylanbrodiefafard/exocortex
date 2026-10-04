import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	fingerprintChatRequest,
	type JsonValue,
	type TraceEventInput,
	type TraceSession,
	toJsonValue,
} from "@exocortex/core";
import type { Runtime } from "./runtime.ts";

/** Prefix of `customType` on every message Exocortex injects (D-029). */
export const EXO_CUSTOM_TYPE_PREFIX = "exo.";

export interface RecorderOptions {
	readonly runtime: Runtime;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** Called with any error a hook swallowed. */
	readonly onError: (where: string, error: unknown) => void;
}

/**
 * Persists pi events to the trace store as harness-agnostic trace events. Every handler is
 * synchronous apart from an in-memory buffer push, returns `undefined` (never alters pi), and
 * swallows its own errors.
 */
export function registerTraceRecorder(pi: ExtensionAPI, options: RecorderOptions): void {
	const { runtime, onError } = options;
	let session: TraceSession | undefined;
	let turn: number | undefined;

	function record(event: Omit<TraceEventInput, "turn">): void {
		session?.append(turn === undefined ? event : { ...event, turn });
	}

	function guard<A extends unknown[]>(where: string, fn: (...args: A) => void): (...args: A) => undefined {
		return (...args) => {
			try {
				fn(...args);
			} catch (error) {
				onError(where, error);
			}
			return undefined;
		};
	}

	pi.on(
		"session_start",
		guard("session_start", (event, ctx) => {
			const { config, problems } = runtime.activate(ctx.cwd);
			if (problems.length > 0 && ctx.hasUI) {
				ctx.ui.notify(`Exocortex disabled by config problems:\n${problems.join("\n")}`, "warning");
			}
			if (!config.enabled) return;
			const store = runtime.store;
			if (!store) return;
			turn = undefined;
			const label = options.env["EXO_TRACE_LABEL"];
			session = store.startSession({
				harness: "pi",
				cwd: ctx.cwd,
				harnessSessionId: ctx.sessionManager.getSessionId(),
				...(label ? { label } : {}),
				meta: toObject({
					reason: event.reason,
					sessionFile: ctx.sessionManager.getSessionFile(),
					model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				}),
			});
			record({ kind: "session.start", data: toJsonValue({ reason: event.reason }) });
		}),
	);

	pi.on(
		"session_shutdown",
		guard("session_shutdown", (event) => {
			record({ kind: "session.end", data: toJsonValue({ reason: event.reason }) });
			session?.end();
			session = undefined;
			if (event.reason === "quit") runtime.shutdown();
			else runtime.store?.flush();
		}),
	);

	pi.on(
		"input",
		guard("input", (event) => {
			record({
				kind: "user.input",
				data: toJsonValue({ text: event.text, source: event.source, images: event.images?.length ?? 0 }),
			});
		}),
	);

	pi.on(
		"turn_start",
		guard("turn_start", (event) => {
			turn = event.turnIndex;
		}),
	);

	pi.on(
		"before_provider_request",
		guard("before_provider_request", (event) => {
			if (!session) return;
			record({ kind: "llm.request", data: fingerprintChatRequest(toJsonValue(event.payload)) });
		}),
	);

	pi.on(
		"message_end",
		guard("message_end", (event) => {
			const module = exoModuleOf(event.message);
			record({
				kind: "message",
				data: toJsonValue(event.message),
				...(module === undefined ? {} : { synthetic: true, module }),
			});
		}),
	);

	pi.on(
		"tool_call",
		guard("tool_call", (event) => {
			record({
				kind: "tool.call",
				data: toJsonValue({ toolCallId: event.toolCallId, toolName: event.toolName, input: event.input }),
			});
		}),
	);

	pi.on(
		"tool_result",
		guard("tool_result", (event) => {
			// The content here is the tool's original output; pi persists only rewritten versions (D-029).
			record({
				kind: "tool.result",
				data: toJsonValue({
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					isError: event.isError,
					exitCode: exitCodeOf(event.structuredContent),
					content: event.content,
				}),
			});
		}),
	);

	pi.on(
		"turn_end",
		guard("turn_end", (event) => {
			const message = event.message as { stopReason?: unknown; usage?: unknown };
			record({
				kind: "turn.end",
				data: toJsonValue({
					turnIndex: event.turnIndex,
					stopReason: message.stopReason,
					usage: message.usage,
					toolResults: event.toolResults.length,
				}),
			});
		}),
	);

	pi.on(
		"agent_settled",
		guard("agent_settled", () => {
			record({ kind: "agent.settled", data: {} });
			runtime.store?.flush();
		}),
	);

	pi.on(
		"session_compact",
		guard("session_compact", (event) => {
			record({
				kind: "compaction",
				data: toJsonValue({
					reason: event.reason,
					fromExtension: event.fromExtension,
					willRetry: event.willRetry,
					entry: event.compactionEntry,
				}),
			});
		}),
	);

	pi.on(
		"model_select",
		guard("model_select", (event) => {
			record({
				kind: "model.change",
				data: toJsonValue({
					model: `${event.model.provider}/${event.model.id}`,
					previous: event.previousModel ? `${event.previousModel.provider}/${event.previousModel.id}` : null,
					source: event.source,
				}),
			});
		}),
	);
}

/** Module id for messages Exocortex injected (`customType: "exo.<module>[.<detail>]"`). */
export function exoModuleOf(message: unknown): string | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const { role, customType } = message as { role?: unknown; customType?: unknown };
	if (role !== "custom" || typeof customType !== "string" || !customType.startsWith(EXO_CUSTOM_TYPE_PREFIX)) {
		return undefined;
	}
	return customType.slice(EXO_CUSTOM_TYPE_PREFIX.length).split(".")[0] || undefined;
}

/** Bash and similar tools report `{ exit_code }` in structured content. */
export function exitCodeOf(structured: unknown): number | null {
	if (typeof structured !== "object" || structured === null) return null;
	const code =
		(structured as { exit_code?: unknown; exitCode?: unknown }).exit_code ??
		(structured as { exitCode?: unknown }).exitCode;
	return typeof code === "number" ? code : null;
}

function toObject(value: Record<string, unknown>): { readonly [key: string]: JsonValue } {
	const json = toJsonValue(value);
	return isJsonObject(json) ? json : {};
}

function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
