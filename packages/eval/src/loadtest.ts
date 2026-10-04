import {
	createOpenAIClient,
	createSidecarPool,
	type EngineTarget,
	type SidecarPool,
	type SidecarPriority,
} from "@exocortex/core";

export interface LoadTestOptions {
	readonly target: EngineTarget;
	readonly maxConcurrent: number;
	readonly reservedForMain: number;
	/** Main-agent requests per phase, run one after another (like a real agent loop). */
	readonly mainRequests: number;
	/** Approximate size of the main agent's shared context, in tokens. */
	readonly mainContextTokens: number;
	readonly mainMaxTokens: number;
	/** Sidecar calls kept queued/running during the loaded phase. */
	readonly sidecarBacklog: number;
	readonly sidecarPromptTokens: number;
	readonly sidecarMaxTokens: number;
	readonly sidecarTimeoutMs: number;
	readonly log?: (line: string) => void;
}

interface LatencySample {
	readonly ttftMs: number;
	readonly totalMs: number;
	readonly completionTokens: number | null;
	readonly cachedTokens: number | null;
}

interface PhaseSummary {
	readonly samples: readonly LatencySample[];
	readonly ttftP50: number;
	readonly ttftP95: number;
	readonly totalP50: number;
	readonly totalP95: number;
	/** Median decode rate after the first token (completion tokens / (total - ttft)). */
	readonly decodeTokPerSecP50: number | null;
}

export interface LoadTestReport {
	readonly alone: PhaseSummary;
	readonly loaded: PhaseSummary;
	readonly sidecars: {
		readonly completed: number;
		readonly failed: number;
		readonly latencyP50: number;
		readonly maxRunningObserved: number;
		readonly slots: number;
	};
	/** loaded / alone − 1, for p50 and p95 of main time-to-first-token and total latency. */
	readonly regression: {
		readonly ttftP50: number;
		readonly ttftP95: number;
		readonly totalP50: number;
		readonly totalP95: number;
	};
}

const PRIORITIES: readonly SidecarPriority[] = ["interactive", "critical"];

/**
 * Brief §8 Phase 2 acceptance: measures main-agent latency alone, then while the sidecar pool is
 * kept saturated, and reports the regression. Main requests bypass the pool (they are the main
 * agent) and share a long, stable prefix, as a real agent loop does.
 */
export async function runLoadTest(options: LoadTestOptions): Promise<LoadTestReport> {
	const log = options.log ?? (() => {});
	const context = filler(options.mainContextTokens, "main");

	log(`warm-up: priming the main prefix (${options.mainContextTokens} tokens)`);
	await mainRequest(options, context, -1);

	log(`phase 1/2: ${options.mainRequests} main requests alone`);
	const alone = await mainPhase(options, context);

	const pool = createSidecarPool({
		client: createOpenAIClient(options.target),
		target: options.target,
		config: {
			maxConcurrent: options.maxConcurrent,
			reservedForMain: options.reservedForMain,
			timeoutMs: options.sidecarTimeoutMs,
			sessionTokenBudget: 0,
			backgroundWhenIdleOnly: true,
		},
		moduleLimits: () => ({ maxCallsPerTurn: Number.MAX_SAFE_INTEGER, maxTokensPerCall: options.sidecarMaxTokens }),
	});
	pool.setMainActive(true);
	log(`phase 2/2: ${options.mainRequests} main requests with ${options.sidecarBacklog} sidecars kept in flight`);
	const load = keepSaturated(pool, options);
	const loaded = await mainPhase(options, context);
	const sidecarResults = await load.stop();
	const stats = pool.stats();
	pool.close();

	const ok = sidecarResults.filter((r) => r.ok);
	return {
		alone,
		loaded,
		sidecars: {
			completed: ok.length,
			failed: sidecarResults.length - ok.length,
			latencyP50: percentile(
				ok.map((r) => r.latencyMs),
				0.5,
			),
			maxRunningObserved: stats.maxRunningObserved,
			slots: options.maxConcurrent - options.reservedForMain,
		},
		regression: {
			ttftP50: ratio(loaded.ttftP50, alone.ttftP50),
			ttftP95: ratio(loaded.ttftP95, alone.ttftP95),
			totalP50: ratio(loaded.totalP50, alone.totalP50),
			totalP95: ratio(loaded.totalP95, alone.totalP95),
		},
	};
}

async function mainPhase(options: LoadTestOptions, context: string): Promise<PhaseSummary> {
	const samples: LatencySample[] = [];
	for (let i = 0; i < options.mainRequests; i++) samples.push(await mainRequest(options, context, i));
	const decodeRates = samples.flatMap((s) =>
		s.completionTokens && s.totalMs > s.ttftMs ? [(s.completionTokens * 1000) / (s.totalMs - s.ttftMs)] : [],
	);
	return {
		samples,
		ttftP50: percentile(
			samples.map((s) => s.ttftMs),
			0.5,
		),
		ttftP95: percentile(
			samples.map((s) => s.ttftMs),
			0.95,
		),
		totalP50: percentile(
			samples.map((s) => s.totalMs),
			0.5,
		),
		totalP95: percentile(
			samples.map((s) => s.totalMs),
			0.95,
		),
		decodeTokPerSecP50: decodeRates.length > 0 ? percentile(decodeRates, 0.5) : null,
	};
}

/** One streaming main-agent request: shared context, then a short per-request suffix. */
async function mainRequest(options: LoadTestOptions, context: string, index: number): Promise<LatencySample> {
	const { target } = options;
	const started = performance.now();
	const response = await fetch(`${target.baseUrl}/chat/completions`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {}),
		},
		body: JSON.stringify({
			model: target.model,
			stream: true,
			stream_options: { include_usage: true },
			max_tokens: options.mainMaxTokens,
			chat_template_kwargs: { enable_thinking: false },
			messages: [
				{ role: "system", content: context },
				{ role: "user", content: `Request ${index}: count from 1 upward, separated by spaces, and keep going.` },
			],
		}),
	});
	if (!response.ok || !response.body) throw new Error(`main request failed: HTTP ${response.status}`);

	const state: StreamState = { ttftMs: undefined, completionTokens: null, cachedTokens: null };
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of response.body) {
		buffer += decoder.decode(chunk as Uint8Array, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) applySseLine(line.trim(), state, started);
	}
	const totalMs = performance.now() - started;
	return { ...state, ttftMs: state.ttftMs ?? totalMs, totalMs };
}

interface StreamState {
	ttftMs: number | undefined;
	completionTokens: number | null;
	cachedTokens: number | null;
}

/** Updates time-to-first-token and usage from one server-sent-events line. */
function applySseLine(line: string, state: StreamState, started: number): void {
	if (!line.startsWith("data:") || line === "data: [DONE]") return;
	const event = JSON.parse(line.slice(5)) as {
		choices?: { delta?: { content?: string; reasoning_content?: string } }[];
		usage?: { completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
	};
	const delta = event.choices?.[0]?.delta;
	if (state.ttftMs === undefined && (delta?.content || delta?.reasoning_content)) {
		state.ttftMs = performance.now() - started;
	}
	if (event.usage) {
		state.completionTokens = event.usage.completion_tokens ?? null;
		state.cachedTokens = event.usage.prompt_tokens_details?.cached_tokens ?? null;
	}
}

/** Keeps `sidecarBacklog` sidecar calls submitted at all times until stopped. */
function keepSaturated(pool: SidecarPool, options: LoadTestOptions) {
	let stopped = false;
	let submitted = 0;
	const results: Awaited<ReturnType<SidecarPool["run"]>>[] = [];
	const inFlight = new Set<Promise<void>>();

	const submit = (): void => {
		if (stopped) return;
		const n = submitted++;
		const promise = pool
			.run({
				module: "loadtest",
				priority: PRIORITIES[n % PRIORITIES.length] ?? "interactive",
				request: {
					messages: [
						{
							role: "user",
							content: `${filler(options.sidecarPromptTokens, `sidecar-${n}`)}\n\nSummarize the text above in two sentences.`,
						},
					],
					maxTokens: options.sidecarMaxTokens,
					thinking: false,
				},
			})
			.then((result) => {
				results.push(result);
				inFlight.delete(promise);
				submit();
			});
		inFlight.add(promise);
	};
	for (let i = 0; i < options.sidecarBacklog; i++) submit();

	return {
		async stop() {
			stopped = true;
			await Promise.all(inFlight);
			return results;
		},
	};
}

/** Deterministic text of roughly `tokens` tokens (~4 chars each), unique per `seed`. */
function filler(tokens: number, seed: string): string {
	const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
	const parts: string[] = [`[${seed}]`];
	let chars = 0;
	for (let i = 0; chars < tokens * 4; i++) {
		const word = `${words[i % words.length]}${i % 97}`;
		parts.push(word);
		chars += word.length + 1;
	}
	return parts.join(" ");
}

export function percentile(values: readonly number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
	return sorted[index] ?? 0;
}

function ratio(loaded: number, alone: number): number {
	return alone > 0 ? loaded / alone - 1 : 0;
}

export function renderLoadTestMarkdown(report: LoadTestReport, title: string): string {
	const row = (name: string, s: PhaseSummary) =>
		`| ${name} | ${ms(s.ttftP50)} | ${ms(s.ttftP95)} | ${ms(s.totalP50)} | ${ms(s.totalP95)} | ${s.decodeTokPerSecP50 === null ? "—" : s.decodeTokPerSecP50.toFixed(1)} | ${s.samples.at(-1)?.cachedTokens ?? "—"} |`;
	const pct = (x: number) => `${x >= 0 ? "+" : ""}${Math.round(x * 100)}%`;
	return [
		`# ${title}`,
		"",
		"| main agent | TTFT p50 | TTFT p95 | total p50 | total p95 | decode tok/s p50 | cached tokens (last) |",
		"|---|---|---|---|---|---|---|",
		row("alone", report.alone),
		row("with sidecar load", report.loaded),
		`| **regression** | ${pct(report.regression.ttftP50)} | ${pct(report.regression.ttftP95)} | ${pct(report.regression.totalP50)} | ${pct(report.regression.totalP95)} | | |`,
		"",
		`Sidecars: ${report.sidecars.completed} completed, ${report.sidecars.failed} failed, p50 latency ${ms(report.sidecars.latencyP50)}, max running ${report.sidecars.maxRunningObserved} of ${report.sidecars.slots} slots.`,
		"",
	].join("\n");
}

function ms(value: number): string {
	return `${Math.round(value)} ms`;
}
