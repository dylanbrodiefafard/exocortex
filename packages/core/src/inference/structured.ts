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

	constructor(message: string, responses: readonly ChatResponse[]) {
		super(message);
		this.name = "StructuredOutputError";
		this.responses = responses;
	}
}

/**
 * Asks for JSON matching `schema` (brief §5.2): grammar-enforced via `json_schema` when the
 * engine supports it, otherwise by instruction. The reply is validated; one repair attempt
 * follows an invalid reply, then it gives up with {@link StructuredOutputError}.
 */
export async function completeStructured<S extends TSchema>(
	client: InferenceClient,
	target: EngineTarget,
	request: Omit<ChatRequest, "jsonSchema">,
	schema: S,
	name: string,
	signal?: AbortSignal,
): Promise<StructuredResult<S>> {
	const schemaJson = JSON.parse(JSON.stringify(schema)) as JsonValue;
	const messages: ChatMessage[] = target.features.jsonSchema
		? [...request.messages]
		: [...request.messages, { role: "user", content: jsonInstruction(schemaJson) }];
	const responses: ChatResponse[] = [];

	for (let attempt = 0; attempt < 2; attempt++) {
		const response = await client.chat({ ...request, messages, jsonSchema: { name, schema: schemaJson } }, signal);
		responses.push(response);
		const parsed = extractJson(response.text);
		const problem = parsed.ok ? firstSchemaError(schema, parsed.value) : parsed.error;
		if (parsed.ok && problem === undefined) return { value: parsed.value as Static<S>, responses };
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

/**
 * Pulls a JSON value out of a model reply: the whole text, a fenced block, or the outermost
 * `{…}` / `[…]` span. Thinking blocks (`<think>…</think>`) are ignored.
 */
export function extractJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
	const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(cleaned)?.[1];
	const candidates = [cleaned, fenced, outermost(cleaned, "{", "}"), outermost(cleaned, "[", "]")];
	for (const candidate of candidates) {
		if (candidate === undefined || candidate.trim() === "") continue;
		try {
			return { ok: true, value: JSON.parse(candidate) };
		} catch {
			// try the next candidate
		}
	}
	return { ok: false, error: "no parseable JSON found" };
}

function outermost(text: string, open: string, close: string): string | undefined {
	const start = text.indexOf(open);
	const end = text.lastIndexOf(close);
	return start !== -1 && end > start ? text.slice(start, end + 1) : undefined;
}
