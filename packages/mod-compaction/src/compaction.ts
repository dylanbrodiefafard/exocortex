import {
	type CompactionRequest,
	type ExoModule,
	firstErrorLine,
	loadPrompt,
	type ModuleContext,
	maskedFailure,
	outcomeOf,
	type ToolOutcome,
	ungroundedReferences,
} from "@exocortex/core";
import { type CompactionSettings, parseSettings } from "./settings.ts";

export const COMPACTION_ID = "compaction";

const SYSTEM_PROMPT = loadPrompt(new URL("../prompts/summarize-system.v2.md", import.meta.url));
const SUMMARIZE_PROMPT = loadPrompt(new URL("../prompts/summarize.v2.md", import.meta.url));
const UPDATE_PROMPT = loadPrompt(new URL("../prompts/summarize-update.v2.md", import.meta.url));
const TEMPLATE = loadPrompt(new URL("../prompts/summary-template.v2.md", import.meta.url));

/** The template's top-level sections, in order. */
const SECTIONS = ["## Objective", "## Important Details", "## Work State", "## Next Move", "## Relevant Files"];
/** A reply without these cannot hand the work over: it is not used. */
const REQUIRED_SECTIONS = ["## Objective", "## Work State", "## Next Move"];
/** The first section rendered from tracked facts: everything before it in a summary is the sidecar's. */
const FACTS_HEADING = "## User requests (verbatim, oldest first)";
/** Where the sidecar's part began in summaries written before D-067. */
const V1_NARRATIVE_HEADING = "## Current work";
const MAX_PRIOR_CHARS = 12_000;
const MAX_COMMANDS = 25;
const MAX_FILES = 40;
const GIT_TIMEOUT_MS = 5_000;

/** The last run of one command. */
export interface CommandRecord {
	readonly command: string;
	readonly ok: boolean;
	readonly exitCode: number | null;
	/** A test or build run that failed behind a pipe: the exit code was the pipe's last command's (D-074). */
	readonly masked: boolean;
	readonly firstError: string | null;
	readonly runs: number;
}

/** Facts tracked across the session, rendered verbatim into every summary. */
export interface Facts {
	readonly userMessages: readonly string[];
	readonly filesModified: readonly string[];
	readonly filesRead: readonly string[];
	/** `git diff --numstat` per path, when the workspace is a git repo. */
	readonly diffStats: ReadonlyMap<string, string>;
	readonly commands: readonly CommandRecord[];
}

/**
 * Compaction summaries in two parts (D-067, amends D-044):
 * - a sidecar writes the handover in opencode's structure (objective, important details, work
 *   state, next move, relevant files), merging the previous summary into it on later compactions;
 * - tracked facts follow verbatim, because summarizers lose them (research R4.1): the user's
 *   requests, files changed, and which commands last failed or passed.
 */
export function createCompaction(raw: Readonly<Record<string, unknown>>, ctx: ModuleContext): ExoModule {
	const { settings, problems } = parseSettings(raw);
	for (const problem of problems) ctx.log(problem);
	const userMessages: string[] = [];
	const commands = new Map<string, CommandRecord>();
	let compactions = 0;

	return {
		id: COMPACTION_ID,

		onUserTurn(turn) {
			// An accepted suggestion is part of the task's history too: it lists what was still missing.
			if (turn.origin !== "extension") userMessages.push(turn.text);
		},

		onToolResult(tool) {
			const record = commandRecord(tool, commands);
			if (!record) return;
			commands.delete(record.command); // re-insert: most recent last
			// A run behind a pipe whose output does not show how it ended is listed nowhere (D-075).
			if (outcomeOf(tool) !== "unknown") commands.set(record.command, record);
		},

		async compact(request, signal) {
			const facts: Facts = {
				userMessages: mergeUserMessages(userMessages, request.userMessages),
				filesModified: request.filesModified,
				filesRead: request.filesRead.filter((f) => !request.filesModified.includes(f)),
				diffStats: await diffStats(ctx),
				commands: [...commands.values()],
			};
			const summary = await writeSummary(ctx, settings, request, signal);
			if (!summary && settings.fallback === "harness") return undefined;
			compactions += 1;
			ctx.record({
				kind: "exo.compaction",
				data: {
					reason: request.reason,
					tokensBefore: request.tokensBefore,
					narrative: summary !== undefined,
					updated: summary !== undefined && priorOf(request.previousSummary) !== "",
					userMessages: facts.userMessages.length,
					commands: facts.commands.length,
				},
			});
			return { summary: renderSummary(facts, summary, settings) };
		},

		status() {
			return compactions === 0 ? COMPACTION_ID : `${COMPACTION_ID} (${compactions} summaries)`;
		},
	};
}

function commandRecord(tool: ToolOutcome, commands: ReadonlyMap<string, CommandRecord>): CommandRecord | undefined {
	const command = tool.input["command"];
	if (tool.toolName !== "bash" || typeof command !== "string") return undefined;
	const key = command.replace(/\s+/g, " ").trim().slice(0, 300);
	const masked = maskedFailure(tool);
	const ok = outcomeOf(tool) === "passed";
	return {
		command: key,
		ok,
		exitCode: tool.exitCode,
		masked,
		firstError: ok ? null : (firstErrorLine(tool.output)?.line.slice(0, 300) ?? null),
		runs: (commands.get(key)?.runs ?? 0) + 1,
	};
}

/** Tracked requests plus any from the summarized span this module did not see (e.g. after a reload). */
function mergeUserMessages(tracked: readonly string[], fromSpan: readonly string[]): string[] {
	const missing = fromSpan.filter((m) => !tracked.includes(m));
	return [...missing, ...tracked];
}

async function diffStats(ctx: ModuleContext): Promise<Map<string, string>> {
	const stats = new Map<string, string>();
	const out = await ctx
		.runCommand("git diff --numstat HEAD 2>/dev/null", { timeoutMs: GIT_TIMEOUT_MS, tailChars: 20_000 })
		.catch(() => undefined);
	if (out?.exitCode !== 0) return stats;
	for (const line of out.outputTail.split("\n")) {
		const [added, removed, path] = line.split("\t");
		if (path && added !== undefined && removed !== undefined) {
			stats.set(path, added === "-" ? "binary" : `+${added} −${removed}`);
		}
	}
	return stats;
}

async function writeSummary(
	ctx: ModuleContext,
	settings: CompactionSettings,
	request: CompactionRequest,
	signal: AbortSignal,
): Promise<string | undefined> {
	const pool = ctx.pool();
	if (!pool) return undefined;
	const prior = priorOf(request.previousSummary);
	const shared = {
		conversation: tail(request.conversation, settings.maxConversationChars),
		template: TEMPLATE.text.trim(),
		instructions: request.customInstructions
			? `\n\nThe user asked this summary to focus on: ${request.customInstructions}`
			: "",
	};
	ctx.progress("Writing the compaction summary…");
	const result = await pool.run({
		module: COMPACTION_ID,
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
	return grounded(summary, `${request.conversation}\n${prior}\n${request.customInstructions ?? ""}`, ctx);
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
 * The guidance gate for summaries (research R3.5, D-061): once the transcript is gone the agent
 * cannot check a name, so bullets naming files or symbols found nowhere in the transcript, the
 * previous summary or the workspace are dropped. A section left empty says "(none)". The
 * objective is left alone: it restates the user's request, and losing it costs more than a wrong name.
 */
export function grounded(summary: string, evidence: string, ctx: Pick<ModuleContext, "cwd" | "log">): string {
	const kept: string[] = [];
	/** Bullets kept and dropped under the heading now open, and where that heading is in `kept`. */
	let open = { at: -1, items: 0, dropped: 0 };
	let dropped = 0;
	let gated = false;
	const close = () => {
		if (open.dropped > 0 && open.items === 0) kept.splice(open.at + 1, 0, "- (none)");
	};
	for (const line of summary.split("\n")) {
		if (line.startsWith("#")) {
			close();
			open = { at: kept.length, items: 0, dropped: 0 };
			if (line.startsWith("## ")) gated = line !== SECTIONS[0];
		} else if (gated && /^\s*(-|\d+\.)\s/.test(line)) {
			if (ungroundedReferences(line, evidence, ctx.cwd).length > 0) {
				open.dropped += 1;
				dropped += 1;
				continue;
			}
			open.items += 1;
		}
		kept.push(line);
	}
	close();
	if (dropped > 0) ctx.log(`dropped ${dropped} ungrounded item(s)`);
	return kept.join("\n");
}

/**
 * What the sidecar wrote in the previous summary: the part to merge into the new one. The facts
 * after it are rendered again from what was tracked. A summary Exocortex did not write (the
 * harness's own) is carried whole.
 */
function priorOf(summary: string | null): string {
	if (!summary) return "";
	const facts = summary.indexOf(FACTS_HEADING);
	if (facts > 0) return summary.slice(0, facts).trim().slice(0, MAX_PRIOR_CHARS);
	if (facts === -1) return summary.trim().slice(0, MAX_PRIOR_CHARS);
	const v1 = summary.indexOf(V1_NARRATIVE_HEADING);
	return v1 === -1 ? "" : summary.slice(v1).trim().slice(0, MAX_PRIOR_CHARS);
}

function tail(text: string, max: number): string {
	return text.length <= max ? text : `[… earlier transcript omitted …]\n${text.slice(text.length - max)}`;
}

/** Renders the summary: the sidecar's handover, then tracked facts verbatim. */
export function renderSummary(facts: Facts, summary: string | undefined, settings: CompactionSettings): string {
	const sections: string[] = summary ? [summary] : [];
	sections.push(
		"## User requests (verbatim, oldest first)",
		facts.userMessages.length === 0
			? "(none recorded)"
			: facts.userMessages.map((m, i) => `${i + 1}. ${clip(m, settings.maxUserMessageChars)}`).join("\n"),
	);
	const modified = [...new Set([...facts.filesModified, ...facts.diffStats.keys()])].sort();
	if (modified.length > 0) {
		sections.push(
			"## Files modified",
			list(modified.map((f) => (facts.diffStats.has(f) ? `${f} (${facts.diffStats.get(f)})` : f))),
		);
	}
	if (facts.filesRead.length > 0) sections.push("## Files read", list([...facts.filesRead].sort()));
	const failing = facts.commands.filter((c) => !c.ok);
	if (failing.length > 0) {
		sections.push(
			"## Commands whose last run failed",
			list(
				failing.map(
					(c) =>
						`\`${c.command}\` → ${c.masked ? "errors in the output (exit code hidden by the pipe)" : `exit ${c.exitCode ?? "error"}`}${c.firstError ? `: ${c.firstError}` : ""}`,
				),
			),
		);
	}
	const passing = facts.commands.filter((c) => c.ok);
	if (passing.length > 0) {
		sections.push(
			"## Commands that last succeeded (no need to re-run unless something changed)",
			list(passing.slice(-MAX_COMMANDS).map((c) => `\`${c.command}\``)),
		);
	}
	return sections.join("\n\n");
}

function list(items: readonly string[]): string {
	const shown = items.slice(0, MAX_FILES).map((item) => `- ${item}`);
	if (items.length > MAX_FILES) shown.push(`- … and ${items.length - MAX_FILES} more`);
	return shown.join("\n");
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}… [truncated]` : text;
}
