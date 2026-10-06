import { existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { type CompactionRequest, loadPrompt, type ModuleContext, ungroundedReferences } from "@exocortex/core";
import { FACTS_HEADING } from "./render.ts";
import type { CompactionSettings } from "./settings.ts";

/** The sidecar's part of a summary: the handover in opencode's structure (D-067), and the gate on it (D-061, D-085). */

const SYSTEM_PROMPT = loadPrompt(new URL("../prompts/summarize-system.v2.md", import.meta.url));
const SUMMARIZE_PROMPT = loadPrompt(new URL("../prompts/summarize.v2.md", import.meta.url));
const UPDATE_PROMPT = loadPrompt(new URL("../prompts/summarize-update.v2.md", import.meta.url));
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
}

/** Asks the sidecar for the handover. Undefined without an engine, on a failed call, or for a reply off the template. */
export async function writeNarrative(
	ctx: ModuleContext,
	settings: CompactionSettings,
	request: CompactionRequest,
	signal: AbortSignal,
): Promise<WrittenNarrative | undefined> {
	const pool = ctx.pool();
	if (!pool) return undefined;
	const prior = priorOf(request.previousSummary, settings);
	const shared = {
		conversation: tail(request.conversation, settings.maxConversationChars),
		template: TEMPLATE.text.trim(),
		instructions: request.customInstructions
			? `\n\nThe user asked this summary to focus on: ${request.customInstructions}`
			: "",
	};
	ctx.progress("Writing the compaction summary…");
	const result = await pool.run({
		module: "compaction",
		priority: "critical",
		timeoutMs: settings.timeoutMs,
		signal,
		request: {
			messages: [
				{ role: "system", content: SYSTEM_PROMPT.text.trim() },
				{
					role: "user",
					content: (prior ? UPDATE_PROMPT.render({ ...shared, prior }) : SUMMARIZE_PROMPT.render(shared)).trim(),
				},
			],
			maxTokens: settings.maxSummaryTokens,
			thinking: settings.thinking,
		},
	});
	if (!result.ok) {
		ctx.log(`summary ${result.outcome}: ${result.error}`);
		return undefined;
	}
	const summary = parseSummary(result.value);
	if (!summary) {
		ctx.log("summary did not follow the template: not used");
		return undefined;
	}
	// A name the previous summary only carries as unverified is not evidence for itself.
	const carried = prior
		.split("\n")
		.filter((line) => !line.includes("[unverified:"))
		.join("\n");
	const evidence = `${request.conversation}\n${carried}\n${request.customInstructions ?? ""}`;
	return { ...grounded(summary, evidence, ctx), updated: prior !== "" };
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
 * The bullet stays: it may be the next step.
 * - Under "Next Move" a path whose directory exists is taken as a file to create.
 * - The objective is left alone: it restates the user's request.
 */
export function grounded(summary: string, evidence: string, ctx: Pick<ModuleContext, "cwd" | "log">): Narrative {
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
	if (unverified.size > 0) ctx.log(`unverified in the summary: ${[...unverified].join(", ")}`);
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
