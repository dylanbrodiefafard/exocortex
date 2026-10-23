import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompactionRequest, JsonValue } from "@exocortex/core";
import { afterEach, describe, expect, it } from "vitest";
import { type MessageSerializer, registerForkTracker } from "../src/fork.ts";
import { registerModuleHost } from "../src/modules.ts";
import { type AdapterHarness, createAdapterHarness } from "./harness.ts";

let harness: AdapterHarness | undefined;
afterEach(() => {
	harness?.cleanup();
	harness = undefined;
});

const MODEL = { api: "openai-completions", id: "coding", provider: "ninfer", baseUrl: "http://127.0.0.1:8080/v1/" };
const PAYLOAD = {
	model: "coding",
	stream: true,
	tools: [{ type: "function", function: { name: "bash" } }],
	messages: [
		{ role: "system", content: "sys" },
		{ role: "user", content: "implement forth" },
	],
};
const assistant = (stopReason: string, text = "done") => ({
	message: { role: "assistant", content: [{ type: "text", text }], stopReason, timestamp: 2 },
});
const toolResult = {
	message: {
		role: "toolResult",
		toolCallId: "c1",
		toolName: "bash",
		content: [{ type: "text", text: "ok" }],
		timestamp: 3,
	},
};
/** Stands in for pi's serialization: one message per message, by role. */
const byRole: MessageSerializer = async (_ctx, messages) => messages.map((m) => ({ role: m.role }) as JsonValue);

function setup(config: Record<string, unknown> = {}, serialize: MessageSerializer | null = byRole) {
	harness = createAdapterHarness(config);
	harness.runtime.activate(harness.dir);
	const tracker = registerForkTracker(harness.pi.api, {
		runtime: harness.runtime,
		onError: harness.onError,
		...(serialize ? { serialize } : {}),
	});
	const ctx = (overrides: Record<string, unknown> = {}) =>
		(harness as AdapterHarness).pi.ctx({ model: MODEL, ...overrides }) as ExtensionContext;
	return { h: harness, tracker, ctx };
}

describe("fork tracker (D-093)", () => {
	it("gives the last request with every message since, once the request was answered", async () => {
		const { h, tracker, ctx } = setup();
		expect(await tracker.prefix(ctx())).toBeUndefined();
		await h.pi.emit("before_provider_request", { payload: PAYLOAD });
		// Still generating: the main agent owns its cached context.
		expect(await tracker.prefix(ctx())).toBeUndefined();
		await h.pi.emit("message_end", assistant("toolUse"));
		await h.pi.emit("message_end", toolResult);
		expect(await tracker.prefix(ctx())).toEqual({
			body: { ...PAYLOAD, messages: [...PAYLOAD.messages, { role: "assistant" }, { role: "toolResult" }] },
		});
		expect(h.errors).toEqual([]);
	});

	it("continues after a reply cut off at max_tokens: the engine cached the request before it (D-103)", async () => {
		const { h, tracker, ctx } = setup();
		await h.pi.emit("before_provider_request", { payload: PAYLOAD });
		await h.pi.emit("message_end", assistant("length"));
		expect(await tracker.prefix(ctx())).toBeDefined();
		h.cleanup();
	});

	it("gives none when the cache cannot be known to end where the messages do", async () => {
		const answered = async (h: AdapterHarness, stopReason = "stop") => {
			await h.pi.emit("before_provider_request", { payload: PAYLOAD });
			await h.pi.emit("message_end", assistant(stopReason));
		};
		// A reply that failed or was interrupted.
		for (const stopReason of ["error", "aborted"]) {
			const { h, tracker, ctx } = setup();
			await answered(h, stopReason);
			expect(await tracker.prefix(ctx())).toBeUndefined();
			h.cleanup();
		}
		// The context was replaced.
		for (const event of ["session_compact", "session_tree", "model_select", "session_start"]) {
			const { h, tracker, ctx } = setup();
			await answered(h);
			await h.pi.emit(event);
			expect(await tracker.prefix(ctx())).toBeUndefined();
			h.cleanup();
		}
		// Sidecar calls go to another server or model than the main agent's.
		for (const engine of [{ baseUrl: "http://other:1/v1" }, { model: "other" }]) {
			const { h, tracker, ctx } = setup({ engine });
			await answered(h);
			expect(await tracker.prefix(ctx())).toBeUndefined();
			h.cleanup();
		}
		const { h, tracker, ctx } = setup({ engine: { baseUrl: "http://127.0.0.1:8080/v1" } });
		await answered(h);
		expect(await tracker.prefix(ctx({ model: { ...MODEL, api: "anthropic-messages" } }))).toBeUndefined();
		expect(await tracker.prefix(ctx({ model: { ...MODEL, id: "other" } }))).toBeUndefined();
		expect(await tracker.prefix(ctx())).toBeDefined();
	});

	it("gives none when a request starts while the messages are being serialized", async () => {
		let release: (() => void) | undefined;
		const slow: MessageSerializer = async (ctx, messages) => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return byRole(ctx, messages);
		};
		const { h, tracker, ctx } = setup({}, slow);
		await h.pi.emit("before_provider_request", { payload: PAYLOAD });
		await h.pi.emit("message_end", assistant("stop"));
		const prefix = tracker.prefix(ctx());
		await h.pi.emit("before_provider_request", { payload: PAYLOAD });
		release?.();
		expect(await prefix).toBeUndefined();
	});

	it("has pi serialize the messages without sending a request", async () => {
		const { h, tracker, ctx } = setup({}, null);
		await h.pi.emit("before_provider_request", { payload: PAYLOAD });
		await h.pi.emit("message_end", assistant("stop", "all done"));
		let stopped = false;
		const complete = async (
			_model: unknown,
			context: { messages: { role: string }[] },
			options: { signal: AbortSignal; onPayload: (payload: unknown) => unknown },
		) => {
			try {
				await options.onPayload({
					messages: context.messages.map((m) => ({ role: m.role, content: "as pi writes it" })),
				});
			} catch {
				stopped = options.signal.aborted;
			}
			return {};
		};
		const prefix = await tracker.prefix(ctx({ modelRegistry: { complete } }));
		expect(stopped).toBe(true);
		expect(prefix?.body["messages"]).toEqual([...PAYLOAD.messages, { role: "assistant", content: "as pi writes it" }]);
		// Asked again before the context moved on, the same fork is handed out: pi is not asked again (D-100).
		const fails = { complete: async () => Promise.reject(new Error("no key")) };
		expect(await tracker.prefix(ctx({ modelRegistry: fails }))).toBe(prefix);
		// A new request: pi could not build it, or put a system message before the messages.
		await h.pi.emit("before_provider_request", { payload: PAYLOAD });
		await h.pi.emit("message_end", assistant("stop", "done again"));
		expect(await tracker.prefix(ctx({ modelRegistry: fails }))).toBeUndefined();
		const withSystem = {
			complete: async (_m: unknown, _c: unknown, options: { onPayload: (payload: unknown) => unknown }) =>
				options.onPayload({ messages: [{ role: "system" }, { role: "assistant" }] }),
		};
		expect(await tracker.prefix(ctx({ modelRegistry: withSystem }))).toBeUndefined();
		expect(h.errors).toEqual([]);
	});

	it("hands a compaction the fork, and none after an overflow", async () => {
		const { h, tracker, ctx } = setup({ modules: { writer: { enabled: true } } });
		const requests: CompactionRequest[] = [];
		registerModuleHost(h.pi.api, {
			runtime: h.runtime,
			onError: h.onError,
			log: () => {},
			fork: tracker,
			modules: {
				writer: () => ({
					id: "writer",
					compact: async (request) => {
						requests.push(request);
						return { summary: "s" };
					},
				}),
			},
		});
		await h.pi.emit("session_start");
		await h.pi.emit("before_provider_request", { payload: PAYLOAD });
		await h.pi.emit("message_end", assistant("stop"));
		const event = (reason: string) => ({
			reason,
			willRetry: false,
			signal: new AbortController().signal,
			branchEntries: [],
			preparation: {
				firstKeptEntryId: "e",
				tokensBefore: 1,
				isSplitTurn: false,
				messagesToSummarize: [],
				turnPrefixMessages: [],
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
			},
		});
		await h.pi.emit("session_before_compact", event("overflow"), ctx());
		await h.pi.emit("session_before_compact", event("threshold"), ctx());
		expect(requests.map((r) => r.fork?.body["messages"])).toEqual([
			undefined,
			[...PAYLOAD.messages, { role: "assistant" }],
		]);
	});
});
