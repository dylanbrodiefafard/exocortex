import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fingerprintChatRequest, type TraceEventInput, type TraceSession, toJsonValue } from "@exocortex/core";
import { exitCodeOf, exoModuleOf, toObject } from "./pi-shapes.ts";
import type { Runtime } from "./runtime.ts";

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

	function record(event: Omit<TraceEventInput, "turn">): void {
		if (session) runtime.record(event);
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
			const { config, problems, ignored } = runtime.activate(ctx.cwd);
			if (problems.length > 0 && ctx.hasUI) {
				ctx.ui.notify(`Exocortex disabled by config problems:\n${problems.join("\n")}`, "warning");
			}
			if (ignored.length > 0 && ctx.hasUI) {
				ctx.ui.notify(
					`Exocortex left out settings this project's config may not set (${ignored.join(", ")}). Put them in your own config if you want them.`,
					"warning",
				);
			}
			if (!config.enabled) return;
			const store = runtime.store;
			if (!store) return;
			runtime.turn = undefined;
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
			runtime.traceSession = session;
			record({ kind: "session.start", data: toJsonValue({ reason: event.reason }) });
		}),
	);

	pi.on(
		"session_shutdown",
		guard("session_shutdown", (event) => {
			record({ kind: "session.end", data: toJsonValue({ reason: event.reason }) });
			session?.end();
			session = undefined;
			runtime.traceSession = undefined;
			// Every session end, not only quit: pi runs the extension factory again for the next
			// session (PI_API_NOTES §14), so a store left open here would never be closed.
			runtime.shutdown();
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
			runtime.turn = event.turnIndex;
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
		"session_compact_failed",
		guard("session_compact_failed", (event) => {
			record({
				kind: "compaction.failed",
				data: toJsonValue({
					reason: event.reason,
					errorMessage: event.errorMessage,
					aborted: event.aborted,
					willRetry: event.willRetry,
					fromExtension: event.fromExtension,
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
