import {
	type ChatRequest,
	createOpenAIClient,
	type Embedder,
	type EngineTarget,
	type ForkPrefix,
	type InferenceClient,
	type SidecarPool,
} from "@exocortex/core";

/** What one check found. */
export interface DoctorFinding {
	readonly status: "ok" | "warn" | "fail" | "skip";
	readonly check: string;
	readonly detail: string;
}

/** What `/exo doctor` asks about: the engine as configured, and what it can be asked through. */
export interface DoctorInput {
	readonly engine: EngineTarget | undefined;
	readonly profile: string | undefined;
	readonly pool: SidecarPool | undefined;
	readonly embedder: Embedder | undefined;
	/** The main agent's context to continue from, when there is one now (D-093). */
	readonly fork: () => Promise<ForkPrefix | undefined>;
	/** Replaces the HTTP client, for tests. */
	readonly client?: (target: EngineTarget) => InferenceClient;
	/**
	 * Whether to probe a fork without thinking (`/exo doctor thinking`, D-100). Where the answer is
	 * no it costs one full prefill of the agent's context, so it is asked for, not run by default.
	 */
	readonly probeThinking?: boolean;
	/**
	 * What that probe found earlier this session: it is not asked twice, since the first leaves the
	 * prompt it computed in the engine's cache and a second would hit it.
	 */
	readonly thinkingFound?: { readonly get: () => DoctorFinding | undefined; readonly set: (f: DoctorFinding) => void };
}

/** The user is waiting for these, and each is a few tokens: a minute means the engine is not answering. */
const PROBE_TIMEOUT_MS = 60_000;
const PONG: ChatRequest["messages"] = [{ role: "user", content: "Reply with the single word: pong" }];
/** A fork that found less than this share of its prompt in the cache paid for the context again (as the pool judges it). */
const FORK_MIN_CACHED_SHARE = 0.5;

/**
 * Checks the engine against what the profile says it can do (D-099). A wrong flag fails quietly
 * otherwise: a field the server rejects fails every sidecar call, and one it lacks makes a module
 * fall back without saying so. A few calls of a few tokens each.
 */
export async function runDoctor(input: DoctorInput): Promise<DoctorFinding[]> {
	const findings: DoctorFinding[] = [];
	const add = (status: DoctorFinding["status"], check: string, detail: string) =>
		findings.push({ status, check, detail });
	const { engine } = input;
	if (!engine) {
		add(
			"fail",
			"engine",
			"no sidecar engine: set engine.baseUrl and engine.model, or use an openai-completions main model",
		);
		return findings;
	}
	add("ok", "engine", `${engine.baseUrl} · model ${engine.model} · profile ${input.profile ?? "generic"}`);
	const client = (input.client ?? createOpenAIClient)(engine);
	const ask = (request: ChatRequest, features: Partial<EngineTarget["features"]> = {}) =>
		(input.client ?? createOpenAIClient)({ ...engine, features: { ...engine.features, ...features } }).chat(
			request,
			AbortSignal.timeout(PROBE_TIMEOUT_MS),
		);

	const started = performance.now();
	let reply: Awaited<ReturnType<InferenceClient["chat"]>>;
	try {
		reply = await client.chat(
			{ messages: PONG, maxTokens: 16, thinking: false },
			AbortSignal.timeout(PROBE_TIMEOUT_MS),
		);
	} catch (error) {
		add("fail", "answers", `no answer: ${String(error)}`);
		return findings;
	}
	add("ok", "answers", `in ${Math.round(performance.now() - started)} ms: ${reply.text.trim().slice(0, 40)}`);
	if (reply.streamed)
		add("ok", "streams", "replies arrive in pieces: a stopped engine is told from a slow one (D-098)");
	else add("warn", "streams", "answers whole: only a first-token deadline can tell a stopped engine from a slow one");
	checkUsage(reply.usage, engine, add);
	await checkReadOnlyCache(engine, ask, add);
	await checkJsonSchema(engine, ask, add);
	await checkFork(input, engine, ask, add);
	await checkEmbeddings(input.embedder, add);
	return findings;
}

type Add = (status: DoctorFinding["status"], check: string, detail: string) => void;
type Ask = (request: ChatRequest, features?: Partial<EngineTarget["features"]>) => ReturnType<InferenceClient["chat"]>;

function checkUsage(usage: { readonly cachedTokens: number | null } | null, engine: EngineTarget, add: Add): void {
	if (!usage) {
		add("warn", "usage", "no token counts: the session token budget and /exo cache see nothing");
		return;
	}
	if (usage.cachedTokens !== null) add("ok", "cached tokens", "reported, as /exo cache and forks need");
	else if (engine.features.cachedTokens) {
		add(
			"fail",
			"cached tokens",
			"the profile says they are reported, but they are not: every fork after the first is refused",
		);
	} else add("skip", "cached tokens", "not reported, and the profile does not count on them");
}

/** F10: is `ninfer.cache_write: false` accepted? Sent whatever the profile says, to see. */
async function checkReadOnlyCache(engine: EngineTarget, ask: Ask, add: Add): Promise<void> {
	const on = engine.features.cacheReadOnly;
	try {
		await ask({ messages: PONG, maxTokens: 16, thinking: false, cacheWrite: false }, { cacheReadOnly: true });
		// A server that drops fields it does not know (vLLM, llama.cpp) accepts it too: only refusal is telling.
		if (on) add("ok", "read-only cache", "ninfer.cache_write: false is accepted (D-093)");
		else {
			add(
				"skip",
				"read-only cache",
				"the server does not refuse ninfer.cache_write, which may only mean it ignores fields it does not know. Only a ninfer build with it honours it (profile dylanbrodiefafard/ninfer); the profile leaves it off",
			);
		}
	} catch (error) {
		if (on) {
			add(
				"fail",
				"read-only cache",
				`the profile sends ninfer.cache_write and the server refuses it, so every sidecar call fails: ${String(error).slice(0, 160)}. Run a build that has it, or set engine.features.cacheReadOnly: false`,
			);
		} else add("skip", "read-only cache", "not supported, and the profile does not send it");
	}
}

/** F3: is `response_format: json_schema` honoured? */
async function checkJsonSchema(engine: EngineTarget, ask: Ask, add: Add): Promise<void> {
	const on = engine.features.jsonSchema;
	// The prompt asks for prose and does not show the shape: only an engine that applies the schema replies with it.
	const schema = {
		type: "object",
		properties: { greeting: { type: "string" } },
		required: ["greeting"],
		additionalProperties: false,
	};
	let honoured: boolean;
	let why = "";
	try {
		const reply = await ask(
			{
				messages: [{ role: "user", content: "Say hello in one short sentence." }],
				maxTokens: 64,
				thinking: false,
				jsonSchema: { name: "probe", schema },
			},
			{ jsonSchema: true },
		);
		const value = parseObject(reply.text);
		honoured = typeof value?.["greeting"] === "string";
		why = honoured ? "" : `the reply was not the JSON asked for: ${reply.text.trim().slice(0, 60)}`;
	} catch (error) {
		honoured = false;
		why = `refused: ${String(error).slice(0, 120)}`;
	}
	if (honoured && on) add("ok", "json schema", "replies follow the schema asked for");
	else if (honoured)
		add(
			"warn",
			"json schema",
			"the server honours json_schema but the profile has it off: set engine.features.jsonSchema: true",
		);
	else if (on)
		add(
			"fail",
			"json schema",
			`the profile asks for json_schema and the server does not honour it (${why}). Set engine.features.jsonSchema: false`,
		);
	else
		add(
			"skip",
			"json schema",
			"not supported, and the profile does not ask for it: replies are validated and repaired",
		);
}

/** D-093: does a sidecar that continues the agent's context find it in the cache? */
async function checkFork(input: DoctorInput, engine: EngineTarget, ask: Ask, add: Add): Promise<void> {
	const fork = await input.fork().catch(() => undefined);
	if (!fork) {
		add("skip", "fork", "nothing to continue from yet: run /exo doctor again after the agent has answered once");
		return;
	}
	const result = await input.pool?.run({
		module: "exo.doctor",
		kind: "pick",
		priority: "interactive",
		timeoutMs: PROBE_TIMEOUT_MS,
		// A miss here must not turn forks off for the session, as a module's would.
		probe: true,
		request: {
			fork,
			messages: [{ role: "user", content: "Reply with the single word: ok. Do not call a tool." }],
			maxTokens: 16,
		},
	});
	if (!result) {
		add("skip", "fork", "no sidecar pool");
		return;
	}
	if (!result.ok) {
		add(result.error.startsWith("fork refused") ? "warn" : "fail", "fork", result.error);
		return;
	}
	const { promptTokens, cachedTokens } = result.usage;
	const share = cachedTokens === null || promptTokens === 0 ? 0 : cachedTokens / promptTokens;
	const counts = `${cachedTokens ?? "?"} of ${promptTokens} prompt tokens came from the cache`;
	if (share >= FORK_MIN_CACHED_SHARE) add("ok", "fork", counts);
	else {
		add("fail", "fork", `${counts}: the fork computed the agent's context again, so modules' forks will miss too`);
		return;
	}
	if (!input.probeThinking) {
		add(
			"skip",
			"fork without thinking",
			"not checked: where the answer is no it costs one full prefill of the conversation. /exo doctor thinking checks it",
		);
		return;
	}
	const earlier = input.thinkingFound?.get();
	if (earlier) {
		findings(add, earlier, "(found earlier this session)");
		return;
	}
	await checkThinkingToggle(fork, engine, ask, (status, check, detail) => {
		add(status, check, detail);
		input.thinkingFound?.set({ status, check, detail });
	});
}

function findings(add: Add, found: DoctorFinding, note: string): void {
	add(found.status, found.check, `${found.detail} ${note}`);
}

/**
 * F4 for forks (D-100): does turning thinking off for the fork's new turn keep the cached prefix?
 * Where it does, a fork answers without first writing out its reasoning. On ninfer it depends on
 * the template: Qwen3.8's effort template puts the reasoning instructions in the system block, so
 * turning thinking off changes the prompt from its start (ninfer `chat_template.cpp:626-651`).
 * Asked of the engine directly, so a miss changes nothing for the session.
 */
async function checkThinkingToggle(fork: ForkPrefix, engine: EngineTarget, ask: Ask, add: Add): Promise<void> {
	const kwargs = fork.body["chat_template_kwargs"];
	const switchedOff =
		typeof kwargs === "object" && kwargs !== null && !Array.isArray(kwargs)
			? (kwargs as { readonly [key: string]: unknown })["enable_thinking"] === false
			: false;
	const off = fork.body["reasoning_effort"] === "none" || switchedOff;
	if (off) {
		add("skip", "fork without thinking", "the agent runs without thinking, so its forks do too");
		return;
	}
	const on = engine.features.thinkingToggle;
	let share = 0;
	let counts = "";
	try {
		const reply = await ask(
			{
				fork,
				messages: [{ role: "user", content: "Reply with the single word: ok. Do not call a tool." }],
				maxTokens: 16,
				thinking: false,
				cacheWrite: false,
			},
			{ thinkingToggle: true, cacheReadOnly: true },
		);
		const usage = reply.usage;
		share =
			usage && usage.cachedTokens !== null && usage.promptTokens > 0 ? usage.cachedTokens / usage.promptTokens : 0;
		counts = `${usage?.cachedTokens ?? "?"} of ${usage?.promptTokens ?? "?"} prompt tokens came from the cache`;
	} catch (error) {
		counts = `refused: ${String(error).slice(0, 120)}`;
	}
	if (share >= FORK_MIN_CACHED_SHARE && on)
		add("ok", "fork without thinking", `${counts}: forks answer without reasoning first`);
	else if (share >= FORK_MIN_CACHED_SHARE) {
		add(
			"warn",
			"fork without thinking",
			`${counts} with thinking off: set engine.features.thinkingToggle: true, and forks answer without writing out their reasoning first`,
		);
	} else if (on) {
		add(
			"fail",
			"fork without thinking",
			`${counts}: turning thinking off changes the prompt before the fork, so every fork computes the agent's context again. Set engine.features.thinkingToggle: false`,
		);
	} else add("skip", "fork without thinking", `${counts}: forks keep the agent's thinking, as the profile has it`);
}

async function checkEmbeddings(embedder: Embedder | undefined, add: Add): Promise<void> {
	if (!embedder) {
		add("skip", "embeddings", "none configured: memory matches by keywords");
		return;
	}
	const started = performance.now();
	const vectors = await embedder.embed(["ping"], { timeoutMs: PROBE_TIMEOUT_MS }).catch(() => undefined);
	const ms = Math.round(performance.now() - started);
	if (vectors?.[0]) add("ok", "embeddings", `${embedder.model}: ${vectors[0].length} dimensions in ${ms} ms`);
	else add("warn", "embeddings", `${embedder.model} did not answer: memory falls back to keywords`);
}

function parseObject(text: string): Readonly<Record<string, unknown>> | undefined {
	try {
		const answer = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
		const value: unknown = JSON.parse(answer.replace(/^```(?:json)?\s*|\s*```$/g, ""));
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

/** The findings as `/exo doctor` shows them, worst first in the summary line. */
export function doctorReport(findings: readonly DoctorFinding[]): string {
	const mark = { ok: "✓", warn: "!", fail: "✗", skip: "–" } as const;
	const lines = findings.map((f) => `${mark[f.status]} ${f.check}: ${f.detail}`);
	const failed = findings.filter((f) => f.status === "fail").length;
	const warned = findings.filter((f) => f.status === "warn").length;
	const summary =
		failed > 0
			? `Exocortex doctor: ${failed} problem(s)${warned > 0 ? ` and ${warned} warning(s)` : ""}`
			: warned > 0
				? `Exocortex doctor: no problems, ${warned} warning(s)`
				: "Exocortex doctor: all good";
	return [summary, ...lines].join("\n");
}
