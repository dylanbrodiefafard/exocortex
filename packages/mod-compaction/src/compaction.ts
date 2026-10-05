import {
	type CompactionRequest,
	type ExoModule,
	firstErrorLine,
	loadPrompt,
	type ModuleContext,
	type ToolOutcome,
	ungroundedReferences,
} from "@exocortex/core";
import { type Static, Type } from "typebox";
import { type CompactionSettings, parseSettings } from "./settings.ts";

export const COMPACTION_ID = "compaction";

const SUMMARIZE_PROMPT = loadPrompt(new URL("../prompts/summarize.v1.md", import.meta.url));

const NarrativeSchema = Type.Object({
	current_work: Type.String({ maxLength: 1_200 }),
	next_step: Type.String({ maxLength: 600 }),
	dead_ends: Type.Array(Type.String({ maxLength: 400 }), { maxItems: 6 }),
	key_facts: Type.Array(Type.String({ maxLength: 400 }), { maxItems: 8 }),
});

export type Narrative = Static<typeof NarrativeSchema>;

const MAX_COMMANDS = 25;
const MAX_FILES = 40;
const GIT_TIMEOUT_MS = 5_000;
const NARRATIVE_HEADING = "## Current work";

/** The last run of one command. */
export interface CommandRecord {
	readonly command: string;
	readonly ok: boolean;
	readonly exitCode: number | null;
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
 * Compaction summaries that keep what summarizers lose (brief D-017, research R4.1/R4.2): user
 * requests verbatim, files changed, command results and open errors come from tracked facts;
 * a sidecar writes only the narrative (current work, next step, dead ends, key facts), updating
 * the previous one on later compactions.
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
			commands.set(record.command, record);
		},

		async compact(request, signal) {
			const facts: Facts = {
				userMessages: mergeUserMessages(userMessages, request.userMessages),
				filesModified: request.filesModified,
				filesRead: request.filesRead.filter((f) => !request.filesModified.includes(f)),
				diffStats: await diffStats(ctx),
				commands: [...commands.values()],
			};
			const narrative = await writeNarrative(ctx, settings, request, signal);
			if (!narrative && settings.fallback === "harness") return undefined;
			compactions += 1;
			ctx.record({
				kind: "exo.compaction",
				data: {
					reason: request.reason,
					tokensBefore: request.tokensBefore,
					narrative: narrative !== undefined,
					userMessages: facts.userMessages.length,
					commands: facts.commands.length,
				},
			});
			return renderSummary(facts, narrative, settings);
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
	const ok = !tool.isError && (tool.exitCode === null || tool.exitCode === 0);
	return {
		command: key,
		ok,
		exitCode: tool.exitCode,
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

async function writeNarrative(
	ctx: ModuleContext,
	settings: CompactionSettings,
	request: CompactionRequest,
	signal: AbortSignal,
): Promise<Narrative | undefined> {
	const pool = ctx.pool();
	if (!pool) return undefined;
	const previous = request.previousSummary ? narrativeOf(request.previousSummary) : "";
	ctx.progress("Writing the compaction summary…");
	const result = await pool.run({
		module: COMPACTION_ID,
		priority: "critical",
		timeoutMs: settings.timeoutMs,
		signal,
		schema: NarrativeSchema,
		schemaName: "compaction_summary",
		request: {
			messages: [
				{
					role: "user",
					content: SUMMARIZE_PROMPT.render({
						previous: previous
							? `\nThe previous compaction wrote the notes below. Update them with the transcript: keep what still holds, drop what is resolved.\n<<<\n${previous}\n>>>\n`
							: "",
						instructions: request.customInstructions
							? `\nThe user asked this summary to focus on: ${request.customInstructions}\n`
							: "",
						conversation: tail(request.conversation, settings.maxConversationChars),
					}),
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
	return grounded(result.value, `${request.conversation}\n${previous}\n${request.customInstructions ?? ""}`, ctx);
}

/**
 * The guidance gate for summaries (research R3.5, D-061): once the transcript is gone the agent
 * cannot check a name, so list items naming files or symbols found nowhere in the transcript or
 * the workspace are dropped, and a next step that does is left out.
 */
export function grounded(narrative: Narrative, evidence: string, ctx: Pick<ModuleContext, "cwd" | "log">): Narrative {
	const ok = (text: string) => ungroundedReferences(text, evidence, ctx.cwd).length === 0;
	const kept = {
		current_work: narrative.current_work,
		next_step: ok(narrative.next_step) ? narrative.next_step : "",
		dead_ends: narrative.dead_ends.filter(ok),
		key_facts: narrative.key_facts.filter(ok),
	};
	const dropped =
		narrative.dead_ends.length - kept.dead_ends.length + narrative.key_facts.length - kept.key_facts.length;
	if (dropped > 0 || kept.next_step !== narrative.next_step) {
		ctx.log(`dropped ${dropped} ungrounded item(s)${kept.next_step === "" ? " and the next step" : ""}`);
	}
	return kept;
}

/** The narrative part of an earlier Exocortex summary (or all of a foreign one). */
function narrativeOf(summary: string): string {
	const start = summary.indexOf(NARRATIVE_HEADING);
	return (start === -1 ? summary : summary.slice(start)).slice(0, 6_000);
}

function tail(text: string, max: number): string {
	return text.length <= max ? text : `[… earlier transcript omitted …]\n${text.slice(text.length - max)}`;
}

/** Renders the summary: tracked facts verbatim, then the sidecar's narrative. */
export function renderSummary(facts: Facts, narrative: Narrative | undefined, settings: CompactionSettings): string {
	const sections: string[] = [];
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
					(c) => `\`${c.command}\` → exit ${c.exitCode ?? "error"}${c.firstError ? `: ${c.firstError}` : ""}`,
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
	if (narrative) {
		const next = narrative.next_step.trim();
		sections.push(NARRATIVE_HEADING, `${narrative.current_work.trim()}${next ? `\nNext: ${next}` : ""}`);
		if (narrative.dead_ends.length > 0) sections.push("## Dead ends (do not retry)", list(narrative.dead_ends));
		if (narrative.key_facts.length > 0) sections.push("## Key facts", list(narrative.key_facts));
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
