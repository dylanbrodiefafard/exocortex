import { describe, expect, it } from "vitest";
import { canonicalJson, fingerprintChatRequest, sharedPrefix } from "../src/fingerprint.ts";
import { toJsonValue } from "../src/json.ts";

describe("toJsonValue", () => {
	it("drops undefined/functions, stringifies bigints and non-finite numbers", () => {
		expect(toJsonValue({ a: undefined, b: () => 1, c: 10n, d: Number.NaN, e: [undefined, 1] })).toEqual({
			c: "10",
			d: "NaN",
			e: [null, 1],
		});
	});

	it("breaks cycles but keeps shared non-cyclic references", () => {
		const shared = { x: 1 };
		const cyclic: Record<string, unknown> = { shared, again: shared };
		cyclic["self"] = cyclic;
		expect(toJsonValue(cyclic)).toEqual({ shared: { x: 1 }, again: { x: 1 }, self: "[circular]" });
	});

	it("omits large inline binary payloads only under binary keys", () => {
		const big = "A".repeat(2000);
		expect(toJsonValue({ type: "image", data: big, text: big }, { maxBinaryChars: 100 })).toEqual({
			type: "image",
			data: { omitted: "binary", chars: 2000 },
			text: big,
		});
	});
});

describe("fingerprintChatRequest", () => {
	const base = {
		model: "qwen",
		messages: [
			{ role: "system", content: "sys" },
			{ role: "user", content: "hi" },
		],
		tools: [{ type: "function", function: { name: "bash" } }],
		temperature: 0.6,
		stream: true,
	};

	it("hashes messages and tools, keeps params", () => {
		const fp = fingerprintChatRequest(base);
		expect(fp.model).toBe("qwen");
		expect(fp.messageHashes).toHaveLength(2);
		expect(fp.toolsHash).toMatch(/^[0-9a-f]{12}$/);
		expect(fp.params).toEqual({ temperature: 0.6, stream: true });
		expect(fp.messageChars).toBeGreaterThan(0);
	});

	it("is insensitive to key order", () => {
		const reordered = { ...base, messages: [{ content: "sys", role: "system" }, base.messages[1] ?? null] };
		expect(fingerprintChatRequest(reordered).messageHashes).toEqual(fingerprintChatRequest(base).messageHashes);
	});

	it("measures shared prefixes between consecutive requests", () => {
		const first = fingerprintChatRequest(base);
		const appended = fingerprintChatRequest({
			...base,
			messages: [...base.messages, { role: "assistant", content: "yo" }],
		});
		expect(sharedPrefix(first, appended)).toEqual({ messages: 2, toolsMatch: true, fullPrefixKept: true });

		const mutated = fingerprintChatRequest({
			...base,
			messages: [{ role: "system", content: "sys v2" }, ...base.messages.slice(1)],
		});
		expect(sharedPrefix(first, mutated)).toEqual({ messages: 0, toolsMatch: true, fullPrefixKept: false });

		const newTools = fingerprintChatRequest({ ...base, tools: [] });
		expect(sharedPrefix(first, newTools).fullPrefixKept).toBe(false);
	});

	it("tolerates non-chat bodies", () => {
		expect(fingerprintChatRequest("nope")).toMatchObject({ model: null, messageHashes: [], toolsHash: null });
	});

	it("canonicalJson sorts keys recursively", () => {
		expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 0 }], c: null } })).toBe(
			'{"a":{"c":null,"d":[2,{"y":0,"z":1}]},"b":1}',
		);
	});
});
