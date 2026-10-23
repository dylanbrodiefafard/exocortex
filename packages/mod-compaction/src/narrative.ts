import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
	type CompactionRequest,
	type ForkPrefix,
	loadPrompt,
	type ModuleContext,
	SIDECAR_THINKING_TOKENS,
	type SidecarCall,
	ungroundedReferences,
} from "@exocortex/core";
import { FACTS_HEADING } from "./render.ts";
import type { CompactionSettings } from "./settings.ts";

/** The sidecar's part of a summary: the handover in opencode's structure (D-067), and the gate on it (D-061, D-085). */

const SYSTEM_PROMPT = loadPrompt(new URL("../prompts/summarize-system.v2.md", import.meta.url));
const SUMMARIZE_PROMPT = loadPrompt(new URL("../prompts/summarize.v2.md", import.meta.url));
const UPDATE_PROMPT = loadPrompt(new URL("../prompts/summarize-update.v2.md", import.meta.url));
const FORK_PROMPT = loadPrompt(new URL("../prompts/summarize-fork.v1.md", import.meta.url));
const TEMPLATE = loadPrompt(new URL("../prompts/summary-template.v2.md", import.meta.url));

/** The template's top-level sections, in order. */
const SECTIONS = ["## Objective", "## Important Details", "## Work State", "## Next Move", "## Relevant Files"];
/** A reply without these cannot hand the work over: it is not used. */
const REQUIRED_SECTIONS = ["## Objective", "## Work State", "## Next Move"];
/** The section whose steps may name a file that does not exist yet. */
const NEXT_MOVE = "## Next Move";
/** Where the sidecar's part began in summaries written before D-067. */
const V1_NARRATIVE_HEADING = "## Current work";
/**
 * Characters of a previous summary handed back per token a summary may have. Prose runs at about
 * four; twice that never cuts a summary this module's sidecar wrote within `maxSummaryTokens`.
 */
const PRIOR_CHARS_PER_TOKEN = 8;
const CUT_MARK = "[… the rest was cut …]";
/**
 * Characters per token assumed when fitting a transcript into the context window (D-111): below
 * the ~4 of prose, since code, paths and JSON run denser, so the estimate errs toward fitting.
 */
const TRANSCRIPT_CHARS_PER_TOKEN = 3;
/** Tokens of a prompt's own words and the template, with a margin. */
const PROMPT_TOKENS = 2_000;
/** No transcript is cut below this, however small the window: a call that overflows fails and falls back. */
const MIN_TRANSCRIPT_CHARS = 20_000;
const UNVERIFIED_MARK = /\s*\[unverified: ([^\]]*)\]/g;
/** Follows a handover that has marked names, so the agent knows what the mark means. */
export const UNVERIFIED_NOTE =
	"Names marked [unverified] were not found in the summarized conversation or in the workspace: check that they exist before relying on them.";

/** The sidecar's handover after the gate, and the names it could not verify. */
export interface Narrative {
	readonly text: string;
	readonly unverified: readonly string[];
}

/** A handover the sidecar wrote for this compaction. */
export interface WrittenNarrative extends Narrative {
	/** A previous summary was merged into it. */
	readonly updated: boolean;
	/** Built on a summary written before compaction was due (D-098): used as written, or updated with what followed. */
	readonly early?: "as_written" | "updated";
}

/** A summary written before compaction was due (D-098): what it says, what its fork read, and when. */
export interface EarlySummary {
	readonly summary: string;
	readonly read: string;
	/** When its fork was taken (ms since the epoch): messages after this are not in it. */
	readonly at: number;
	/** Context tokens when it was written. */
	readonly tokens: number;
	/** The messages its fork continued from, as a fingerprint: the context must still begin with them. */
	readonly prefix: { readonly length: number; readonly hash: string };
}

/** A fingerprint of a request body's first `length` messages (all when left out). */
function messagesPrefix(body: ForkPrefix["body"], length?: number): { readonly length: number; readonly hash: string } {
	const messages = Array.isArray(body["messages"]) ? body["messages"] : [];
	const taken = messages.slice(0, length ?? messages.length);
	return { length: taken.length, hash: createHash("sha256").update(JSON.stringify(taken)).digest("hex") };
}

/**
 * The summary written early, from a fork, at background priority (D-098): it runs while the agent
 * is idle and nobody waits for it. Undefined when there is no engine or the reply cannot be used;
 * `log` hears why.
 */
export async function writeEarlySummary(
	ctx: ModuleContext,
	settings: CompactionSettings,
	fork: ForkPrefix,
	signal: AbortSignal,
	log: (problem: string, message: string) => void,
): Promise<Omit<EarlySummary, "at" | "tokens"> | undefined> {
	const reply = await ask(
		ctx,
		settings,
		{
			module: "compaction",
			kind: "judge",
			priority: "background",
			signal,
			request: {
				fork,
				messages: [
					{ role: "user", content: FORK_PROMPT.render({ template: TEMPLATE.text.trim(), instructions: "" }).trim() },
				],
			},
		},
		"early summary",
		null,
		log,
	);
	if (reply === undefined) return undefined;
	const summary = parseSummary(reply);
	if (!summary) log("template", "early summary did not follow the template: not kept");
	return summary
		? { summary, read: texts(fork.body["messages"]).join("\n"), prefix: messagesPrefix(fork.body) }
		: undefined;
}

/** A summary call as the module makes it: everything but the limit, which {@link ask} sets. */
type SummaryCall = Omit<SidecarCall, "request"> & { readonly request: Omit<SidecarCall["request"], "maxTokens"> };

/**
 * Runs a summary call and returns its reply; undefined without an engine or on a failed call,
 * with the reason logged. A reply cut off at its limit is never used (D-111): the call is asked
 * again once at twice the limit, unless the context window has no room for that, and is then given
 * up. Room is what an engine that refuses `prompt + max_tokens > window` (vLLM) needs: the prompt,
 * the larger limit and the pool's whole thinking room. A fork at compaction never has it.
 */
async function ask(
	ctx: ModuleContext,
	settings: CompactionSettings,
	call: SummaryCall,
	what: string,
	contextWindow: number | null,
	log: (problem: string, message: string) => void = (_, message) => ctx.log(message),
): Promise<string | undefined> {
	const pool = ctx.pool();
	if (!pool) return undefined;
	let maxTokens = settings.maxSummaryTokens;
	for (;;) {
		const result = await pool.run({ ...call, request: { ...call.request, maxTokens } });
		if (!result.ok) {
			log(result.outcome, `${what} ${result.outcome}: ${result.error}`);
			return undefined;
		}
		if (result.finishReason !== "length") return result.value;
		const { promptTokens, completionTokens } = result.usage;
		const fits = contextWindow === null || promptTokens + 2 * maxTokens + SIDECAR_THINKING_TOKENS <= contextWindow;
		if (maxTokens > settings.maxSummaryTokens || !fits) {
			log("length", `${what} was cut off at ${completionTokens} tokens: not used`);
			return undefined;
		}
		maxTokens *= 2;
	}
}

/**
 * The characters of transcript a summary prompt may hold (D-111): what the context window leaves
 * after the prompt, the previous summary, and the most the call may ask for. That is the limit
 * of a second try at twice `maxSummaryTokens`, plus the thinking room the pool adds
 * (`SIDECAR_THINKING_TOKENS`), so an engine that refuses `prompt + max_tokens > window` takes it.
 * ninfer accepts such a request and stops at the window (checked 2026-10-23). Unbounded when the
 * window is not known.
 */
function transcriptRoom(contextWindow: number | null, settings: CompactionSettings, prior: string): number {
	if (contextWindow === null) return Number.POSITIVE_INFINITY;
	const tokens =
		contextWindow -
		PROMPT_TOKENS -
		2 * settings.maxSummaryTokens -
		SIDECAR_THINKING_TOKENS -
		Math.ceil(prior.length / TRANSCRIPT_CHARS_PER_TOKEN);
	return Math.max(MIN_TRANSCRIPT_CHARS, tokens * TRANSCRIPT_CHARS_PER_TOKEN);
}

/** Asks the sidecar for the handover. Undefined without an engine, on a failed call, or for a reply off the template. */
export async function writeNarrative(
	ctx: ModuleContext,
	settings: CompactionSettings,
	request: CompactionRequest,
	signal: AbortSignal,
	early?: EarlySummary,
): Promise<WrittenNarrative | undefined> {
	if (!ctx.pool()) return undefined;
	const prior = priorOf(request.previousSummary, settings);
	const room = transcriptRoom(request.contextWindow, settings, prior);
	const shared = {
		conversation: tail(request.conversation, room),
		template: TEMPLATE.text.trim(),
		instructions: request.customInstructions
			? `\n\nThe user asked this summary to focus on: ${request.customInstructions}`
			: "",
	};
	// A name the previous summary only carries as unverified is not evidence for itself.
	const carried = prior
		.split("\n")
		.filter((line) => !line.includes("[unverified:"))
		.join("\n");
	const evidence = `${request.conversation}\n${carried}\n${request.customInstructions ?? ""}`;
	ctx.progress("Writing the compaction summary…");
	const progress = summaryProgress(ctx);
	// A summary written early already holds the previous one and everything up to its fork: only
	// what came after it is added (D-098). Not with the user's own instructions, which it never had,
	// nor once the context no longer begins with what its fork read (a branch switched with /tree).
	if (early && !request.customInstructions && stillApplies(early, request)) {
		const built = await fromEarly(ctx, settings, request, early, signal, progress.of("early"));
		if (built) {
			return {
				...grounded(built.summary, `${evidence}\n${early.read}`, ctx),
				updated: true,
				early: built.updated ? "updated" : "as_written",
			};
		}
	}
	// No deadline (D-098): the user is waiting either way, and a call ends when it is done, the
	// engine stops answering, or pi aborts the compaction. The transcript is asked only after the
	// fork fails, not beside it: forks exist only on ninfer, where its long prefill would stall the
	// fork's decode (D-023), and the fork usually succeeds.
	const forked = await writeFromFork(ctx, settings, request, shared, signal, progress.of("fork"));
	// The fork also read the messages the harness keeps, which the span does not have.
	if (forked) return { ...grounded(forked.summary, `${evidence}\n${forked.read}`, ctx), updated: prior !== "" };
	if (request.conversation.length > room) {
		ctx.log(
			`summary from the transcript: its oldest ${request.conversation.length - room} characters left out to fit the context window`,
		);
	}
	const reply = await ask(
		ctx,
		settings,
		{
			module: "compaction",
			kind: "judge",
			priority: "critical",
			signal,
			onProgress: progress.of("transcript"),
			request: {
				messages: [
					{ role: "system", content: SYSTEM_PROMPT.text.trim() },
					{
						role: "user",
						content: (prior ? UPDATE_PROMPT.render({ ...shared, prior }) : SUMMARIZE_PROMPT.render(shared)).trim(),
					},
				],
			},
		},
		"summary",
		request.contextWindow,
	);
	if (reply === undefined) return undefined;
	const summary = parseSummary(reply);
	if (!summary) {
		ctx.log("summary did not follow the template: not used");
		return undefined;
	}
	return { ...grounded(summary, evidence, ctx), updated: prior !== "" };
}

/**
 * The handover written as a continuation of the main agent's own context (D-093): the engine has
 * that context cached, so only the instruction is new, and the sidecar reads the conversation as
 * the agent did, not a transcript of it. Undefined when there is no fork to be had or the reply
 * cannot be used; the caller then asks with the transcript.
 */
async function writeFromFork(
	ctx: ModuleContext,
	settings: CompactionSettings,
	request: CompactionRequest,
	shared: { readonly template: string; readonly instructions: string },
	signal: AbortSignal,
	onProgress: (chars: number) => void,
): Promise<{ readonly summary: string; readonly read: string } | undefined> {
	if (!request.fork || !settings.fork) return undefined;
	const reply = await ask(
		ctx,
		settings,
		{
			module: "compaction",
			kind: "judge",
			priority: "critical",
			signal,
			onProgress,
			request: { fork: request.fork, messages: [{ role: "user", content: FORK_PROMPT.render(shared).trim() }] },
		},
		"summary from a fork",
		request.contextWindow,
	);
	if (reply === undefined) return undefined;
	const summary = parseSummary(reply);
	if (!summary) {
		ctx.log("summary from a fork did not follow the template: asking with the transcript");
		return undefined;
	}
	return { summary, read: texts(request.fork.body["messages"]).join("\n") };
}

/** Whether the context being compacted still begins with what the early summary's fork read; without a fork to compare, it is taken to. */
function stillApplies(early: EarlySummary, request: CompactionRequest): boolean {
	if (!request.fork) return true;
	const now = messagesPrefix(request.fork.body, early.prefix.length);
	return now.length === early.prefix.length && now.hash === early.prefix.hash;
}

/**
 * The early summary brought up to date: as it is when nothing in the span came after its fork,
 * else merged with what did by the update prompt. Undefined when that call fails.
 */
async function fromEarly(
	ctx: ModuleContext,
	settings: CompactionSettings,
	request: CompactionRequest,
	early: EarlySummary,
	signal: AbortSignal,
	onProgress: (chars: number) => void,
): Promise<{ readonly summary: string; readonly updated: boolean } | undefined> {
	const since = request.conversationSince(early.at);
	if (since.trim() === "") return { summary: early.summary, updated: false };
	const reply = await ask(
		ctx,
		settings,
		{
			module: "compaction",
			kind: "judge",
			priority: "critical",
			signal,
			onProgress,
			request: {
				messages: [
					{ role: "system", content: SYSTEM_PROMPT.text.trim() },
					{
						role: "user",
						content: UPDATE_PROMPT.render({
							conversation: tail(since, transcriptRoom(request.contextWindow, settings, early.summary)),
							template: TEMPLATE.text.trim(),
							instructions: "",
							prior: early.summary,
						}).trim(),
					},
				],
			},
		},
		"update of the early summary",
		request.contextWindow,
	);
	if (reply === undefined) return undefined;
	const summary = parseSummary(reply);
	if (!summary) ctx.log("update of the early summary did not follow the template: writing it whole");
	return summary ? { summary, updated: true } : undefined;
}

/** Characters per token, roughly: progress is shown in tokens. */
const CHARS_PER_TOKEN = 4;

/**
 * A progress line for a summary being written (D-098): the reply so far, in tokens, so the user
 * waiting on compaction sees it move instead of a fixed deadline counting down.
 */
function summaryProgress(ctx: ModuleContext): { readonly of: (key: string) => (chars: number) => void } {
	const sizes = new Map<string, number>();
	let shown = 0;
	return {
		of: (key) => (chars) => {
			sizes.set(key, chars);
			const tokens = Math.round(Math.max(...sizes.values()) / CHARS_PER_TOKEN);
			// Every 50 tokens is enough to see it move.
			if (tokens - shown < 50) return;
			shown = tokens;
			ctx.progress(`Writing the compaction summary… ${tokens} tokens`);
		},
	};
}

/** Every string in a JSON value: what a request's messages say, without the JSON around it. */
function texts(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (typeof value !== "object" || value === null) return [];
	return Object.values(value).flatMap(texts);
}

/**
 * The sidecar's reply as a summary: from the first section on, without the template's tags or a
 * code fence around it. Undefined when a section the agent cannot do without is missing, as when
 * the reply was cut off or the model answered the conversation instead.
 */
export function parseSummary(reply: string): string | undefined {
	const lines = reply.replace(/<\/?template>/g, "").split("\n");
	const start = lines.findIndex((line) => line.trim() === SECTIONS[0]);
	if (start === -1) return undefined;
	const body = lines.slice(start).map((line) => line.trimEnd());
	while (body.length > 0 && /^(```)?$/.test(body.at(-1) ?? "")) body.pop();
	const headings = new Set(body);
	return REQUIRED_SECTIONS.every((section) => headings.has(section)) ? body.join("\n") : undefined;
}

/**
 * The guidance gate for summaries (research R3.5, D-061; D-085): once the transcript is gone the
 * agent cannot check a name, so a file or symbol found nowhere in the transcript, the previous
 * summary or the workspace is marked `[unverified: name]` on its bullet and loses its backticks.
 * The bullet stays: it may be the next step. The names go to the trace, not the user's problem
 * log: a mark is the gate working, not Exocortex failing (D-111).
 * - Under "Next Move" a path whose directory exists is taken as a file to create.
 * - The objective is left alone: it restates the user's request.
 */
export function grounded(summary: string, evidence: string, ctx: Pick<ModuleContext, "cwd">): Narrative {
	const unverified = new Set<string>();
	let section = SECTIONS[0];
	const lines = summary.split("\n").map((marked) => {
		if (marked.startsWith("## ")) section = marked;
		if (section === SECTIONS[0] || !/^\s*(-|\d+\.)\s/.test(marked)) return marked;
		// A mark the sidecar carried over from the previous summary is checked again, not trusted.
		const carried = [...marked.matchAll(UNVERIFIED_MARK)].flatMap((match) => (match[1] ?? "").split(", "));
		const line = marked.replace(UNVERIFIED_MARK, "");
		const missing = [
			...new Set([
				...ungroundedReferences(line, evidence, ctx.cwd),
				...carried.filter((name) => ungroundedReferences(`\`${name}\``, evidence, ctx.cwd).length > 0),
			]),
		].filter((name) => !(section === NEXT_MOVE && creatable(name, ctx.cwd)));
		if (missing.length === 0) return line;
		for (const name of missing) unverified.add(name);
		return `${missing.reduce((text, name) => text.replaceAll(`\`${name}\``, name), line)} [unverified: ${missing.join(", ")}]`;
	});
	return { text: lines.join("\n"), unverified: [...unverified] };
}

/** Whether a name is a path inside the workspace whose directory exists: a file a next step may create. */
function creatable(name: string, cwd: string): boolean {
	if (!/^[\w./-]+$/.test(name) || !(name.includes("/") || /\.\w{1,5}$/.test(name))) return false;
	const path = resolve(cwd, name);
	const inside = relative(cwd, path);
	if (inside.startsWith("..") || isAbsolute(inside)) return false;
	try {
		return existsSync(dirname(path));
	} catch {
		return false;
	}
}

/**
 * What the sidecar wrote in the previous summary: the part to merge into the new one. The facts
 * after it are rendered again from what was tracked. A summary Exocortex did not write (the
 * harness's own) is carried whole. Cut, at a line, only past what `maxSummaryTokens` can produce.
 */
function priorOf(summary: string | null, settings: Pick<CompactionSettings, "maxSummaryTokens">): string {
	if (!summary) return "";
	const facts = summary.indexOf(FACTS_HEADING);
	const v1 = summary.indexOf(V1_NARRATIVE_HEADING);
	const narrative = facts > 0 ? summary.slice(0, facts) : facts === -1 ? summary : v1 === -1 ? "" : summary.slice(v1);
	const text = narrative
		.split("\n")
		.filter((line) => line !== UNVERIFIED_NOTE)
		.join("\n")
		.trim();
	const max = settings.maxSummaryTokens * PRIOR_CHARS_PER_TOKEN;
	if (text.length <= max) return text;
	const cut = text.slice(0, max);
	return `${cut.slice(0, Math.max(cut.lastIndexOf("\n"), 0)) || cut}\n${CUT_MARK}`;
}

function tail(text: string, max: number): string {
	return text.length <= max ? text : `[… earlier transcript omitted …]\n${text.slice(text.length - max)}`;
}
