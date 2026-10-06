import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { JsonValue } from "../trace/store.ts";
import type { ChatMessage, ChatRequest, ChatResponse, InferenceClient } from "./client.ts";
import type { EngineTarget } from "./engine.ts";

export interface StructuredResult<S extends TSchema> {
	readonly value: Static<S>;
	/** Every model response used, including a repair attempt. */
	readonly responses: readonly ChatResponse[];
}

export class StructuredOutputError extends Error {
	readonly responses: readonly ChatResponse[];
	/**
	 * `truncated`: the reply hit `max_tokens` before it held a valid answer, so no repair turn was
	 * made (the cure is a higher limit, not another try). `invalid`: the repair turn failed too.
	 */
	readonly reason: "invalid" | "truncated";

	constructor(message: string, responses: readonly ChatResponse[], reason: "invalid" | "truncated" = "invalid") {
		super(message);
		this.name = "StructuredOutputError";
		this.responses = responses;
		this.reason = reason;
	}
}

/**
 * Asks for JSON matching `schema` (brief §5.2): grammar-enforced via `json_schema` when the
 * engine supports it, otherwise by instruction. The reply is validated; one repair attempt
 * follows an invalid reply, then it gives up with {@link StructuredOutputError}. A reply cut off
 * at `max_tokens` gets no repair attempt.
 *
 * `onResponse` is called with each response as it arrives, so a caller that is cut short during
 * the repair turn has still seen the first response's token usage.
 */
export async function completeStructured<S extends TSchema>(
	client: InferenceClient,
	target: EngineTarget,
	request: Omit<ChatRequest, "jsonSchema">,
	schema: S,
	name: string,
	signal?: AbortSignal,
	onResponse?: (response: ChatResponse) => void,
): Promise<StructuredResult<S>> {
	const schemaJson = JSON.parse(JSON.stringify(schema)) as JsonValue;
	const messages: ChatMessage[] = target.features.jsonSchema
		? [...request.messages]
		: [...request.messages, { role: "user", content: jsonInstruction(schemaJson) }];
	const responses: ChatResponse[] = [];

	for (let attempt = 0; attempt < 2; attempt++) {
		const response = await client.chat({ ...request, messages, jsonSchema: { name, schema: schemaJson } }, signal);
		responses.push(response);
		onResponse?.(response);
		const parsed = extractJson(response.text, (value) => Value.Check(schema, value));
		const problem = parsed.ok ? firstSchemaError(schema, parsed.value) : parsed.error;
		if (parsed.ok && problem === undefined) return { value: parsed.value as Static<S>, responses };
		if (response.finishReason === "length") {
			throw new StructuredOutputError(
				`the reply was cut off at max_tokens (${request.maxTokens}) before a valid answer: ${problem}`,
				responses,
				"truncated",
			);
		}
		messages.push(
			{ role: "assistant", content: response.text },
			{
				role: "user",
				content: `That reply is not valid: ${problem}. Reply again with only the corrected JSON, nothing else.`,
			},
		);
	}
	throw new StructuredOutputError("model did not produce valid JSON after one repair attempt", responses);
}

function jsonInstruction(schema: JsonValue): string {
	return `Reply with only a JSON value that matches this JSON Schema. No prose, no code fences.\n${JSON.stringify(schema)}`;
}

function firstSchemaError(schema: TSchema, value: unknown): string | undefined {
	if (Value.Check(schema, value)) return undefined;
	const [error] = Value.Errors(schema, value);
	return error ? `${error.instancePath || "/"} ${error.message}` : "does not match the schema";
}

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";
/**
 * Characters the bracket scan may read for one reply, and how far it looks inside a span that is
 * not JSON. Together they bound the time a hostile or broken reply (thousands of unbalanced or
 * nested brackets) can hold the event loop.
 */
const MAX_SCAN_CHARS = 1_000_000;
const MAX_NESTING = 8;

interface ScanBudget {
	chars: number;
}

/**
 * Pulls the answer's JSON value out of a model reply (D-080).
 *
 * - **Reasoning is not an answer.** Everything up to the last `</think>` is dropped, with or
 *   without an opening tag (templates that open the block in the prompt leave only the closing
 *   one in the reply). Text after an unclosed `<think>` is reasoning that never finished, so a
 *   draft in it is not returned.
 * - **Candidates** are the whole remaining text, then each balanced `{…}` or `[…]` value in it,
 *   from the end backwards: when a reply restates its answer, the last one is the one it settled on.
 *   Last comes a fenced block holding a bare string or number.
 * - **`accept`** (a schema check) picks the first candidate it passes. When none passes, the
 *   candidate nearest the end is returned so the caller can say what is wrong with it.
 */
export function extractJson(
	text: string,
	accept: (value: unknown) => boolean = () => true,
): { ok: true; value: unknown } | { ok: false; error: string } {
	const close = text.lastIndexOf(THINK_CLOSE);
	const answer = (close === -1 ? text : text.slice(close + THINK_CLOSE.length)).trim();
	const whole = parse(answer);
	// A reply that is one JSON value is the answer, valid or not: no part of it is a better one.
	if (whole.ok) return whole;

	const budget: ScanBudget = { chars: MAX_SCAN_CHARS };
	const spans = balancedSpans(answer, 0, answer.length, budget);
	const unclosed = unclosedThink(answer, spans);
	const answered = spans.filter((span) => span.start < unclosed).reverse();
	let fallback: { ok: true; value: unknown } | undefined;
	for (const candidate of candidates(answer, answered, budget, 0)) {
		if (accept(candidate.value)) return candidate;
		fallback ??= candidate;
	}
	if (fallback) return fallback;
	// A fenced value that is not an object or array (`"yes"`, `42`).
	const fenced = parse((/```(?:json)?\s*([\s\S]*?)```/.exec(answer.slice(0, unclosed))?.[1] ?? "").trim());
	if (fenced.ok) return fenced;
	if (unclosed < answer.length) return { ok: false, error: "the reply ended inside its reasoning, before any answer" };
	return { ok: false, error: "no parseable JSON found" };
}

interface Span {
	readonly start: number;
	/** Exclusive. */
	readonly end: number;
}

function parse(text: string): { ok: true; value: unknown } | { ok: false } {
	if (text === "") return { ok: false };
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch {
		return { ok: false };
	}
}

/** Each span's value, or when a span is not JSON (`{see: {"a":1}}`), the values inside it. */
function* candidates(
	text: string,
	spans: readonly Span[],
	budget: ScanBudget,
	depth: number,
): Generator<{ ok: true; value: unknown }> {
	for (const span of spans) {
		const parsed = parse(text.slice(span.start, span.end));
		if (parsed.ok) {
			yield parsed;
		} else if (depth < MAX_NESTING) {
			const inner = balancedSpans(text, span.start + 1, span.end - 1, budget).reverse();
			yield* candidates(text, inner, budget, depth + 1);
		}
	}
}

/** Index of the first `<think>` that is not inside a JSON string of a candidate; the text's length when there is none. */
function unclosedThink(text: string, spans: readonly Span[]): number {
	for (let at = text.indexOf(THINK_OPEN); at !== -1; at = text.indexOf(THINK_OPEN, at + 1)) {
		const position = at;
		if (!spans.some((span) => span.start < position && position < span.end)) return position;
	}
	return text.length;
}

/** Outermost balanced `{…}` and `[…]` spans in `text[from, to)`, left to right, reading strings as JSON does. */
function balancedSpans(text: string, from: number, to: number, budget: ScanBudget): Span[] {
	const spans: Span[] = [];
	for (let i = from; i < to && budget.chars > 0; i++) {
		if (text[i] !== "{" && text[i] !== "[") continue;
		const end = matchingClose(text, i, to);
		// A failed scan may have read to the end of the text.
		budget.chars -= (end === -1 ? to : end) - i;
		if (end === -1) continue;
		spans.push({ start: i, end: end + 1 });
		i = end;
	}
	return spans;
}

function matchingClose(text: string, start: number, to: number): number {
	const closers: string[] = [];
	for (let i = start; i < to; i++) {
		const ch = text[i];
		if (ch === '"') {
			i = stringEnd(text, i, to);
		} else if (ch === "{") {
			closers.push("}");
		} else if (ch === "[") {
			closers.push("]");
		} else if (ch === "}" || ch === "]") {
			if (closers.pop() !== ch) return -1;
			if (closers.length === 0) return i;
		}
	}
	return -1;
}

/** Index of the quote closing the JSON string that opens at `start`; `to` when it never closes. */
function stringEnd(text: string, start: number, to: number): number {
	for (let i = start + 1; i < to; i++) {
		if (text[i] === "\\") i += 1;
		else if (text[i] === '"') return i;
	}
	return to;
}
