import { convertToLlm, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ForkPrefix, JsonValue } from "@exocortex/core";
import { isRecord, toObject } from "./pi-shapes.ts";
import type { Runtime } from "./runtime.ts";

type AgentMessages = Parameters<typeof convertToLlm>[0];
type LlmMessages = ReturnType<typeof convertToLlm>;

/** Serializes messages as the main agent's next request would; undefined when that cannot be had. */
export type MessageSerializer = (
	ctx: ExtensionContext,
	messages: LlmMessages,
) => Promise<readonly JsonValue[] | undefined>;

export interface ForkOptions {
	readonly runtime: Runtime;
	readonly onError: (where: string, error: unknown) => void;
	/** Replaces pi's own serialization, for tests. */
	readonly serialize?: MessageSerializer;
}

export interface ForkTracker {
	/**
	 * The main agent's context as a request body (D-093): its last request, then every message
	 * since. Undefined unless that request was answered in full and nothing has changed the
	 * context since, so that the body is a prompt the engine has cached up to the answer's end.
	 * Never rejects.
	 */
	prefix(ctx: ExtensionContext): Promise<ForkPrefix | undefined>;
}

/** How long pi may take to serialize a few messages; it looks up the model's key first. */
const SERIALIZE_TIMEOUT_MS = 2_000;
/**
 * An assistant message that ended this way left the engine's cache holding the request before it.
 * A reply cut off at `max_tokens` is one (D-103): measured on ninfer, the next request found the
 * whole earlier prompt cached after one, as after a reply that stopped. One that failed or was
 * interrupted may have stopped anywhere.
 */
const ANSWERED = new Set(["stop", "toolUse", "length"]);

/**
 * Follows the main agent's requests so a sidecar call can continue from its context (D-093).
 *
 * The request body is pi's own, taken in `before_provider_request` (D-029), so the system prompt,
 * tools and thinking settings are the main agent's by construction. The messages since are
 * serialized by pi as well: any difference from what the main agent would send next ends the
 * shared prefix there, and the engine then computes the rest again.
 */
export function registerForkTracker(pi: ExtensionAPI, options: ForkOptions): ForkTracker {
	const { runtime, onError } = options;
	const serialize = options.serialize ?? serializeWithPi;
	/** The last request and what followed it; undefined while the context is not known to be cached. */
	let last:
		| { readonly body: { readonly [key: string]: JsonValue }; since: AgentMessages; answered: boolean }
		| undefined;
	/**
	 * The last fork made, and the messages it was made from: asked again before the context moved
	 * on (a triage hint, then compaction, then doctor), it is not serialized again (D-100).
	 */
	let made: { readonly since: AgentMessages; readonly fork: ForkPrefix } | undefined;

	const guarded =
		<A extends unknown[]>(where: string, fn: (...args: A) => void) =>
		(...args: A): undefined => {
			try {
				fn(...args);
			} catch (error) {
				last = undefined;
				onError(where, error);
			}
			return undefined;
		};
	const forget = guarded("fork.forget", () => {
		last = undefined;
		made = undefined;
	});

	pi.on(
		"before_provider_request",
		guarded("fork.before_provider_request", (event) => {
			const body = toObject(event.payload);
			last = Array.isArray(body["messages"]) ? { body, since: [], answered: false } : undefined;
		}),
	);
	pi.on(
		"message_end",
		guarded("fork.message_end", (event) => {
			if (!last) return;
			const message = event.message;
			if (message.role === "assistant") {
				// A reply that failed or was interrupted leaves the cache somewhere this cannot know.
				if (last.answered || !ANSWERED.has(message.stopReason)) {
					last = undefined;
					return;
				}
				last.answered = true;
			}
			last.since = [...last.since, message];
		}),
	);
	// The context is another one after any of these.
	pi.on("session_start", forget);
	pi.on("session_compact", forget);
	pi.on("session_tree", forget);
	pi.on("model_select", forget);
	pi.on("session_shutdown", forget);

	return {
		async prefix(ctx) {
			try {
				const at = last;
				if (!at?.answered || !sameEngine(ctx, runtime, at.body)) return undefined;
				// `since` is replaced, not changed, as messages arrive: the same array is the same context.
				if (made?.since === at.since) return made.fork;
				const sinceThen = at.since;
				const since = await serialize(ctx, convertToLlm(sinceThen));
				// A request that started meanwhile owns the cache now.
				if (!since || last !== at || at.since !== sinceThen) return undefined;
				const messages = Array.isArray(at.body["messages"]) ? at.body["messages"] : [];
				const fork = { body: { ...at.body, messages: [...messages, ...since] } };
				made = { since: sinceThen, fork };
				return fork;
			} catch (error) {
				onError("fork.prefix", error);
				return undefined;
			}
		},
	};
}

/** Whether sidecar calls go to the server and model the main agent's request went to. */
function sameEngine(ctx: ExtensionContext, runtime: Runtime, body: { readonly [key: string]: JsonValue }): boolean {
	const model = ctx.model;
	const engine = runtime.config?.engine;
	if (model?.api !== "openai-completions" || !engine) return false;
	const bare = (url: string) => url.replace(/\/+$/, "");
	return (
		body["model"] === model.id &&
		(engine.model ?? model.id) === model.id &&
		bare(engine.baseUrl ?? model.baseUrl) === bare(model.baseUrl)
	);
}

class Captured extends Error {}

/**
 * Has pi build the request it would send for `messages` and takes the messages from it. Nothing
 * is sent: `onPayload` runs before the HTTP call (PI_API_NOTES §10) and ends the attempt there.
 */
const serializeWithPi: MessageSerializer = async (ctx, messages) => {
	const model = ctx.model;
	if (!model) return undefined;
	const stop = new AbortController();
	let captured: unknown;
	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			ctx.modelRegistry.complete(
				model,
				{ messages },
				{
					signal: stop.signal,
					onPayload: (payload: unknown) => {
						captured = payload;
						stop.abort();
						throw new Captured();
					},
				},
			),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, SERIALIZE_TIMEOUT_MS).unref();
			}),
		]);
	} catch {
		// `Captured`, or pi could not build the request: `captured` says which.
	} finally {
		clearTimeout(timer);
		stop.abort();
	}
	const serialized = isRecord(captured) ? toObject(captured)["messages"] : undefined;
	// Pi put something before them (a system message): they are not the continuation alone.
	return Array.isArray(serialized) && serialized.length >= messages.length && !hasSystem(serialized)
		? serialized
		: undefined;
};

function hasSystem(messages: readonly JsonValue[]): boolean {
	return messages.some((m) => isRecord(m) && (m["role"] === "system" || m["role"] === "developer"));
}
