import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import {
	cosineSimilarity,
	createEmbedder,
	decodeVector,
	encodeVector,
	resolveEmbeddings,
} from "../src/inference/embeddings.ts";

const target = { baseUrl: "http://embed.test/v1", model: "small-embed", apiKey: "k", timeoutMs: 1_000 };

function fakeFetch(reply: (body: { model: string; input: string[] }) => unknown, status = 200) {
	const calls: { url: string; headers: Record<string, string>; body: { model: string; input: string[] } }[] = [];
	const fetchImpl = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
		const body = JSON.parse(init.body) as { model: string; input: string[] };
		calls.push({ url, headers: init.headers, body });
		return new Response(JSON.stringify(reply(body)), { status });
	}) as unknown as typeof fetch;
	return { calls, fetchImpl };
}

describe("resolveEmbeddings", () => {
	const config = (embeddings: object) =>
		loadConfig({
			cwd: "/x",
			env: { EXO_CONFIG: "/x/c.jsonc" },
			readFile: (p) => (p === "/x/c.jsonc" ? JSON.stringify({ embeddings }) : undefined),
		}).config.embeddings;

	it("is undefined until both a base URL and a model are set", () => {
		expect(resolveEmbeddings(config({}))).toBeUndefined();
		expect(resolveEmbeddings(config({ baseUrl: "http://localhost:8081/v1" }))).toBeUndefined();
		expect(
			resolveEmbeddings(config({ baseUrl: "http://localhost:8081/v1/", model: "m", apiKey: "$EMBED_KEY" }), {
				EMBED_KEY: "secret",
			}),
		).toEqual({ baseUrl: "http://localhost:8081/v1", model: "m", apiKey: "secret", timeoutMs: 2_000 });
	});
});

describe("createEmbedder", () => {
	it("posts the texts and returns unit vectors in input order", async () => {
		const { calls, fetchImpl } = fakeFetch(() => ({
			data: [
				{ index: 1, embedding: [0, 2] },
				{ index: 0, embedding: [3, 4] },
			],
		}));
		const embedder = createEmbedder(target, { fetchImpl });
		const vectors = await embedder.embed(["first", "second"]);
		expect(calls[0]).toMatchObject({
			url: "http://embed.test/v1/embeddings",
			headers: { authorization: "Bearer k" },
			body: { model: "small-embed", input: ["first", "second"] },
		});
		expect(Array.from(vectors?.[0] ?? [])).toEqual([Math.fround(0.6), Math.fround(0.8)]);
		expect(Array.from(vectors?.[1] ?? [])).toEqual([0, 1]);
		expect(embedder.model).toBe("small-embed");
		expect(await embedder.embed([])).toEqual([]);
		expect(calls).toHaveLength(1);
	});

	it("returns undefined instead of throwing on errors, bad bodies and timeouts", async () => {
		const errors: string[] = [];
		const onError = (message: string) => errors.push(message);
		const broken = createEmbedder(target, { fetchImpl: fakeFetch(() => ({}), 500).fetchImpl, onError });
		expect(await broken.embed(["a"])).toBeUndefined();
		for (const body of [{ data: [] }, { data: [{ embedding: [] }] }, { data: [{ embedding: ["x"] }] }, null]) {
			const odd = createEmbedder(target, { fetchImpl: fakeFetch(() => body).fetchImpl, onError });
			expect(await odd.embed(["a"])).toBeUndefined();
		}
		const duplicate = fakeFetch(() => ({
			data: [
				{ index: 0, embedding: [1] },
				{ index: 0, embedding: [1] },
			],
		}));
		expect(await createEmbedder(target, { fetchImpl: duplicate.fetchImpl, onError }).embed(["a", "b"])).toBeUndefined();
		const hanging = ((_url: string, init: { signal: AbortSignal }) =>
			new Promise((_resolve, reject) => {
				if (init.signal.aborted) reject(new Error("aborted"));
				init.signal.addEventListener("abort", () => reject(new Error("aborted")));
			})) as unknown as typeof fetch;
		expect(
			await createEmbedder(target, { fetchImpl: hanging, onError }).embed(["a"], { timeoutMs: 10 }),
		).toBeUndefined();
		const cancelled = new AbortController();
		cancelled.abort();
		expect(
			await createEmbedder({ ...target, apiKey: undefined }, { fetchImpl: hanging }).embed(["a"], {
				signal: cancelled.signal,
			}),
		).toBeUndefined();
		expect(errors[0]).toBe("embeddings: Error: HTTP 500");
		expect(errors).toHaveLength(7);
	});
});

describe("createEmbedder never rejects (D10)", () => {
	it("takes any timeout: a huge one is clamped, a negative or NaN one means no time at all", async () => {
		const { fetchImpl } = fakeFetch(() => ({ data: [{ embedding: [1] }] }));
		const embedder = createEmbedder(target, { fetchImpl });
		expect(await embedder.embed(["a"], { timeoutMs: 1e15 })).toHaveLength(1);
		expect(await embedder.embed(["a"], { timeoutMs: Number.POSITIVE_INFINITY })).toHaveLength(1);
		const hanging = ((_url: string, init: { signal: AbortSignal }) =>
			new Promise((_resolve, reject) => {
				init.signal.addEventListener("abort", () => reject(new Error("aborted")));
			})) as unknown as typeof fetch;
		const slow = createEmbedder(target, { fetchImpl: hanging });
		for (const timeoutMs of [-1, Number.NaN]) {
			await expect(slow.embed(["a"], { timeoutMs })).resolves.toBeUndefined();
		}
	});

	it("ignores an error handler that throws", async () => {
		const embedder = createEmbedder(target, {
			fetchImpl: fakeFetch(() => ({}), 500).fetchImpl,
			onError: () => {
				throw new Error("handler exploded");
			},
		});
		await expect(embedder.embed(["a"])).resolves.toBeUndefined();
	});
});

describe("vectors", () => {
	it("compares unit vectors and survives a round trip through bytes", () => {
		const a = Float32Array.from([0.6, 0.8]);
		expect(cosineSimilarity(a, a)).toBeCloseTo(1);
		expect(cosineSimilarity(a, Float32Array.from([0.8, -0.6]))).toBeCloseTo(0);
		expect(cosineSimilarity(a, Float32Array.from([1, 0, 0]))).toBe(0);
		const padded = new Float32Array([9, 0.6, 0.8]).subarray(1);
		expect(Array.from(decodeVector(encodeVector(padded)))).toEqual(Array.from(a));
	});
});
