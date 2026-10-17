import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SidecarCallRecord } from "@exocortex/core";
import { isRecord } from "./pi-shapes.ts";
import type { Runtime } from "./runtime.ts";

/** The status-line slot for the cache hit rate; the module host's slot is `exo`. */
const STATUS_KEY = "exo.cache";
/** Main requests with no cached token at all before the engine is said not to report them. */
const UNREPORTED_AFTER = 2;

/** Prompt tokens sent and how many of them the engine served from its cache. */
interface CacheTally {
	requests: number;
	prompt: number;
	cached: number;
	/** Requests whose engine said nothing about its cache (a sidecar's `cachedTokens: null`). */
	unreported: number;
	/** Prompt tokens of those requests: the rate leaves them out. */
	unreportedPrompt: number;
}

/** One request's prompt: its tokens and the cached share, null when the engine did not say. */
interface CacheReading {
	readonly prompt: number;
	readonly cached: number | null;
}

/**
 * Prompt-cache statistics for a pi session (D-095): how much of each prompt the engine served
 * from its prefix cache, for the main agent and for each module's sidecar calls. A broken prefix
 * (a changed system prompt, a rewritten message) shows as a drop in the main agent's rate.
 */
export interface CacheStats {
	reset(): void;
	/** Adds a main-agent request from an assistant message's `usage`; undefined when it has none. */
	addMain(usage: unknown): CacheReading | undefined;
	addSidecar(record: Pick<SidecarCallRecord, "module" | "usage">): void;
	/** The last main request, and the session's totals. */
	main(): { readonly last: CacheReading | undefined; readonly session: Readonly<CacheTally> };
	/** Session totals per module that made sidecar calls. */
	sidecars(): ReadonlyMap<string, Readonly<CacheTally>>;
}

const emptyTally = (): CacheTally => ({ requests: 0, prompt: 0, cached: 0, unreported: 0, unreportedPrompt: 0 });

export function createCacheStats(): CacheStats {
	let last: CacheReading | undefined;
	let main = emptyTally();
	const sidecars = new Map<string, CacheTally>();

	return {
		reset() {
			last = undefined;
			main = emptyTally();
			sidecars.clear();
		},
		addMain(usage) {
			if (!isRecord(usage)) return undefined;
			const input = count(usage["input"]);
			const cacheRead = count(usage["cacheRead"]);
			const cacheWrite = count(usage["cacheWrite"]);
			// pi's `input` leaves out the cached tokens (PI_API_NOTES §10).
			const prompt = input + cacheRead + cacheWrite;
			if (prompt === 0) return undefined;
			last = { prompt, cached: cacheRead };
			main.requests += 1;
			main.prompt += prompt;
			main.cached += cacheRead;
			return last;
		},
		addSidecar({ module, usage }) {
			if (usage.promptTokens <= 0) return;
			const tally = sidecars.get(module) ?? emptyTally();
			sidecars.set(module, tally);
			tally.requests += 1;
			tally.prompt += usage.promptTokens;
			if (usage.cachedTokens === null) {
				tally.unreported += 1;
				tally.unreportedPrompt += usage.promptTokens;
			} else tally.cached += usage.cachedTokens;
		},
		main: () => ({ last, session: main }),
		sidecars: () => sidecars,
	};
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function percent(cached: number, prompt: number): string {
	return `${Math.round((100 * cached) / prompt)}%`;
}

/**
 * Pi gives a main request's cached tokens as 0 when the engine did not report them, so no cached
 * token over several requests reads as "not reported", not as a cache that never hit.
 */
function mainUnreported(session: Readonly<CacheTally>): boolean {
	return session.requests >= UNREPORTED_AFTER && session.cached === 0;
}

/** `93% of 12,400 tokens (11,532 cached)`, or why there is no rate. */
function describe(tally: Readonly<CacheTally>, unreported: boolean): string {
	if (tally.requests === 0) return "no requests yet";
	const calls = `${tally.requests} request${tally.requests === 1 ? "" : "s"}`;
	const reported = tally.requests - tally.unreported;
	if (unreported || reported === 0) return `not reported by the engine (${calls}, ${fmt(tally.prompt)} prompt tokens)`;
	const partly = tally.unreported > 0 ? `; ${tally.unreported} did not report` : "";
	return `${percent(tally.cached, tally.prompt - tally.unreportedPrompt)} of ${fmt(tally.prompt - tally.unreportedPrompt)} prompt tokens cached (${fmt(tally.cached)} reused, ${calls}${partly})`;
}

function fmt(n: number): string {
	return n.toLocaleString("en-US");
}

/** What `/exo cache` prints. */
export function cacheReport(stats: CacheStats): string {
	const { last, session } = stats.main();
	const unreported = mainUnreported(session);
	const lastLine =
		last === undefined
			? "no requests yet"
			: unreported
				? `${fmt(last.prompt)} prompt tokens, cached tokens not reported`
				: `${percent(last.cached ?? 0, last.prompt)} of ${fmt(last.prompt)} prompt tokens cached`;
	const lines = [
		"Prompt cache (this session):",
		`main agent, last request: ${lastLine}`,
		`main agent, session: ${describe(session, unreported)}`,
	];
	const sidecars = [...stats.sidecars()].sort(([a], [b]) => a.localeCompare(b));
	if (sidecars.length === 0) lines.push("sidecars: no calls yet");
	else {
		const total = emptyTally();
		for (const [, tally] of sidecars) {
			total.requests += tally.requests;
			total.prompt += tally.prompt;
			total.cached += tally.cached;
			total.unreported += tally.unreported;
			total.unreportedPrompt += tally.unreportedPrompt;
		}
		lines.push(`sidecars, all: ${describe(total, false)}`);
		for (const [module, tally] of sidecars) lines.push(`  ${module}: ${describe(tally, false)}`);
	}
	return lines.join("\n");
}

/** One line for `/exo status`. */
export function cacheSummary(stats: CacheStats): string {
	const { session } = stats.main();
	const main =
		session.requests === 0
			? "no requests yet"
			: mainUnreported(session)
				? "not reported"
				: percent(session.cached, session.prompt);
	const total = { prompt: 0, cached: 0, reported: 0 };
	for (const tally of stats.sidecars().values()) {
		if (tally.unreported === tally.requests) continue;
		total.prompt += tally.prompt - tally.unreportedPrompt;
		total.cached += tally.cached;
		total.reported += 1;
	}
	const sidecars =
		stats.sidecars().size === 0
			? "no calls yet"
			: total.reported === 0
				? "not reported"
				: percent(total.cached, total.prompt);
	return `prompt cache: main ${main} · sidecars ${sidecars} (/exo cache for more)`;
}

/** The status-line text after a main request: the last request's rate, then the session's. */
function statusText(stats: CacheStats): string | undefined {
	const { last, session } = stats.main();
	if (!last || mainUnreported(session)) return undefined;
	return `cache ${percent(last.cached ?? 0, last.prompt)} · session ${percent(session.cached, session.prompt)}`;
}

/**
 * Counts the main agent's prompt-cache use at each `turn_end` and shows it on the status line
 * while Exocortex is on (D-095). The sidecars' calls are added by `sidecars.ts` from the pool's
 * call records. Stats start over at each `session_start`.
 */
export function registerCacheStats(
	pi: ExtensionAPI,
	runtime: Runtime,
	onError: (where: string, error: unknown) => void,
): void {
	const stats = runtime.cacheStats;
	pi.on("session_start", (_event, ctx) => {
		try {
			stats.reset();
			show(ctx, undefined);
		} catch (error) {
			onError("cache.session_start", error);
		}
		return undefined;
	});
	pi.on("turn_end", (event, ctx) => {
		try {
			stats.addMain(isRecord(event.message) ? event.message["usage"] : undefined);
			const on = runtime.config?.enabled === true && !runtime.overrides.allOff;
			show(ctx, on ? statusText(stats) : undefined);
		} catch (error) {
			onError("cache.turn_end", error);
		}
		return undefined;
	});
}

function show(ctx: ExtensionContext, text: string | undefined): void {
	if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, text);
}
