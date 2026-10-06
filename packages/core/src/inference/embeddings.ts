import { clampTimeoutMs, type ExoConfig } from "../config.ts";
import { expandEnv } from "./engine.ts";

/** Where text embeddings come from: any OpenAI-compatible `/embeddings` server (D-026, D-062). */
export interface EmbeddingTarget {
	readonly baseUrl: string;
	readonly model: string;
	readonly apiKey: string | undefined;
	readonly timeoutMs: number;
}

/**
 * Turns texts into unit vectors for similarity search. It never throws: a missing, slow or broken
 * server yields undefined, and callers fall back to keyword matching.
 */
export interface Embedder {
	/** Vectors from different models are not comparable, so stored vectors are keyed by this. */
	readonly model: string;
	embed(
		texts: readonly string[],
		options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
	): Promise<Float32Array[] | undefined>;
}

/** The embeddings endpoint from config, or undefined when none is configured. */
export function resolveEmbeddings(
	config: ExoConfig["embeddings"],
	env: Readonly<Record<string, string | undefined>> = process.env,
): EmbeddingTarget | undefined {
	if (!config.baseUrl || !config.model) return undefined;
	const apiKey = config.apiKey === undefined ? undefined : expandEnv(config.apiKey, env);
	return {
		baseUrl: config.baseUrl.replace(/\/+$/, ""),
		model: config.model,
		apiKey: apiKey === "" ? undefined : apiKey,
		timeoutMs: config.timeoutMs,
	};
}

export function createEmbedder(
	target: EmbeddingTarget,
	options: { readonly fetchImpl?: typeof fetch; readonly onError?: (message: string) => void } = {},
): Embedder {
	const fetchImpl = options.fetchImpl ?? fetch;
	return {
		model: target.model,
		async embed(texts, call = {}) {
			if (texts.length === 0) return [];
			try {
				// Inside the `try`: `AbortSignal.timeout` throws on a delay it does not accept.
				const timeout = AbortSignal.timeout(clampTimeoutMs(call.timeoutMs ?? target.timeoutMs));
				const signal = call.signal ? AbortSignal.any([call.signal, timeout]) : timeout;
				const response = await fetchImpl(`${target.baseUrl}/embeddings`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						...(target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {}),
					},
					body: JSON.stringify({ model: target.model, input: texts }),
					signal,
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				return parseEmbeddings(await response.json(), texts.length);
			} catch (error) {
				try {
					options.onError?.(`embeddings: ${String(error)}`);
				} catch {
					// A broken error handler must not turn "no vectors" into a rejection.
				}
				return undefined;
			}
		},
	};
}

/** `data[].embedding` in input order (by `index` when given), each scaled to unit length. */
function parseEmbeddings(body: unknown, expected: number): Float32Array[] {
	const data = (body as { data?: unknown } | null)?.data;
	if (!Array.isArray(data) || data.length !== expected) throw new Error("unexpected embeddings response");
	const vectors = new Array<Float32Array>(expected);
	data.forEach((item: { index?: unknown; embedding?: unknown }, position) => {
		const values = item?.embedding;
		if (!Array.isArray(values) || values.length === 0 || values.some((v) => typeof v !== "number")) {
			throw new Error("unexpected embeddings response");
		}
		vectors[typeof item.index === "number" ? item.index : position] = normalize(Float32Array.from(values as number[]));
	});
	if (vectors.includes(undefined as never)) throw new Error("unexpected embeddings response");
	return vectors;
}

function normalize(vector: Float32Array): Float32Array {
	let sum = 0;
	for (const v of vector) sum += v * v;
	const length = Math.sqrt(sum);
	return length === 0 ? vector : vector.map((v) => v / length);
}

/** Cosine similarity of two unit vectors (as {@link Embedder} returns them); 0 when their sizes differ. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	if (a.length !== b.length) return 0;
	let dot = 0;
	for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
	return dot;
}

/** A vector as bytes for a SQLite BLOB column, and back. */
export function encodeVector(vector: Float32Array): Uint8Array {
	return new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
}

export function decodeVector(bytes: Uint8Array): Float32Array {
	return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
