import {
	cleanTerminalOutput,
	type ExoModule,
	errorSignature,
	firstErrorLine,
	loadPrompt,
	type ModuleContext,
	type ToolResultDraft,
	ungroundedReferences,
} from "@exocortex/core";
import { Type } from "typebox";
import { parseSettings, type TriageSettings } from "./settings.ts";

export const TRIAGE_ID = "triage";

const DIAGNOSE_PROMPT = loadPrompt(new URL("../prompts/diagnose.v1.md", import.meta.url));

const DiagnosisSchema = Type.Object({
	diagnosis: Type.String({ maxLength: 400 }),
	next_action: Type.String({ maxLength: 400 }),
});

const GOAL_CHARS = 1_000;
const RECENT_COMMANDS = 6;
const EXCERPT_CONTEXT_LINES = 12;
const EXCERPT_TAIL_LINES = 8;
const EXCERPT_CHARS = 4_000;
const MAX_LINE_CHARS = 300;

interface TaskState {
	readonly counts: Map<string, number>;
	readonly hints: Map<string, number>;
	readonly recent: string[];
}

/**
 * Error triage (brief §6.3, gated as research R3.1 recommends): on a first failure only surface a
 * buried first error (deterministic); on a repeat of the same normalized failure append a
 * runtime notice and, optionally, a grounded two-sentence sidecar diagnosis; past the loop
 * threshold the notice becomes a stronger, still advisory, warning. Never blocks a tool call.
 */
export function createTriage(raw: Readonly<Record<string, unknown>>, ctx: ModuleContext): ExoModule {
	const { settings, problems } = parseSettings(raw);
	for (const problem of problems) ctx.log(problem);
	let goal = "";
	let task: TaskState = newTask();
	let repeats = 0;
	let hintsGiven = 0;

	return {
		id: TRIAGE_ID,

		onUserTurn(turn) {
			if (turn.origin !== "user") return;
			goal = turn.text.slice(0, GOAL_CHARS);
			task = newTask();
		},

		onToolResult(tool) {
			const command = commandOf(tool.input, tool.toolName);
			task.recent.push(
				`${command} → ${tool.isError || (tool.exitCode ?? 0) !== 0 ? `exit ${tool.exitCode ?? "error"}` : "ok"}`,
			);
			if (task.recent.length > RECENT_COMMANDS) task.recent.shift();
		},

		async rewriteToolResult(draft, signal) {
			if (!isFailure(draft) || isBenign(draft, settings)) return undefined;
			const signature = errorSignature(draft.toolName, draft.exitCode, draft.output);
			const count = (task.counts.get(signature) ?? 0) + 1;
			task.counts.set(signature, count);
			// Signature from the original output; position from what the model will see (maybe trimmed).
			const first = firstErrorLine(draft.output);
			if (count === 1) {
				const shown = firstErrorLine(draft.current);
				if (!shown || shown.index < settings.buriedAfterLines) return undefined;
				return {
					text: `[exo triage: first error (line ${shown.index + 1} below): ${clip(shown.line)}]\n${draft.current}`,
					note: "surfaced the first error",
				};
			}
			repeats += 1;
			const notice = repeatNotice(count, first?.line, settings.loopThreshold);
			const hint = await diagnose(signature, count, draft, signal);
			if (hint) hintsGiven += 1;
			return {
				text: `${draft.current}\n${notice}${hint ? `\n[exo triage hint: ${hint}]` : ""}`,
				note: `repeat ${count}${hint ? " + hint" : ""}`,
			};
		},

		status() {
			return repeats === 0 ? TRIAGE_ID : `${TRIAGE_ID} (${repeats} repeats, ${hintsGiven} hints)`;
		},
	};

	async function diagnose(signature: string, count: number, draft: ToolResultDraft, signal: AbortSignal) {
		const given = task.hints.get(signature) ?? 0;
		const pool = ctx.pool();
		if (!settings.sidecar || !pool || given >= settings.maxHintsPerSignature) return undefined;
		task.hints.set(signature, given + 1);
		const result = await pool.run({
			module: TRIAGE_ID,
			priority: "interactive",
			timeoutMs: settings.hintTimeoutMs,
			signal,
			schema: DiagnosisSchema,
			schemaName: "diagnosis",
			request: {
				messages: [
					{
						role: "user",
						content: DIAGNOSE_PROMPT.render({
							count: String(count),
							goal: goal || "(unknown)",
							recent: task.recent.map((r) => `- ${r}`).join("\n") || "(none)",
							command: commandOf(draft.input, draft.toolName),
							exit_code: draft.exitCode === null ? "unknown" : String(draft.exitCode),
							excerpt: errorExcerpt(draft.output),
						}),
					},
				],
				maxTokens: 300,
				thinking: settings.thinking,
			},
		});
		if (!result.ok) {
			ctx.log(`diagnosis ${result.outcome}: ${result.error}`);
			return undefined;
		}
		const hint = [result.value.diagnosis, result.value.next_action]
			.map((s) => s.trim())
			.filter(Boolean)
			.join(" ");
		if (hint === "") return undefined;
		const ungrounded = ungroundedReferences(hint, `${draft.output}\n${goal}\n${task.recent.join("\n")}`, ctx.cwd);
		if (ungrounded.length > 0) {
			ctx.log(`dropped a hint naming unknown ${ungrounded.join(", ")}`);
			return undefined;
		}
		return clip(hint, 600);
	}
}

function newTask(): TaskState {
	return { counts: new Map(), hints: new Map(), recent: [] };
}

function isFailure(draft: ToolResultDraft): boolean {
	return draft.isError || (draft.exitCode !== null && draft.exitCode !== 0);
}

/** `grep` finding nothing (exit 1) is an answer, not a failure. Looks at the last `&&`/`;` step. */
export function isBenign(
	draft: Pick<ToolResultDraft, "exitCode" | "input" | "toolName">,
	settings: TriageSettings,
): boolean {
	if (draft.exitCode !== 1) return false;
	const command = commandOf(draft.input, draft.toolName);
	const last =
		command
			.split(/&&|;|\|\|/)
			.at(-1)
			?.trim() ?? "";
	const words = last.replace(/^(\w+=\S*\s+)+/, "");
	return settings.benignCommands.some((benign) => words === benign || words.startsWith(`${benign} `));
}

function commandOf(input: ToolResultDraft["input"], toolName: string): string {
	const command = input["command"];
	return typeof command === "string" ? clip(command.replace(/\s+/g, " ").trim(), 200) : toolName;
}

/**
 * Describes the repeat at runtime instead of echoing the failed call back (research R3.3), and
 * escalates at the loop threshold (R3.4).
 */
function repeatNotice(count: number, errorLine: string | undefined, loopThreshold: number): string {
	const same = errorLine ? ` with the same error (${clip(errorLine)})` : " the same way";
	if (count >= loopThreshold) {
		return `[exo triage: this has now failed ${count} times${same}. The current approach is not working: stop retrying it, re-read the code around the error and question the assumption behind the last changes before the next attempt.]`;
	}
	return `[exo triage: this failed again${same}; it is the ${ordinal(count)} time this task. Repeating the same fix is unlikely to help: change something first.]`;
}

/** The first error with context plus the output's tail: what a diagnosis needs, bounded. */
export function errorExcerpt(output: string): string {
	const lines = cleanTerminalOutput(output).split("\n");
	const first = firstErrorLine(output);
	const keep = new Set<number>();
	const from = first ? first.index - 2 : 0;
	for (let i = Math.max(0, from); i < Math.min(lines.length, from + EXCERPT_CONTEXT_LINES); i++) keep.add(i);
	for (let i = Math.max(0, lines.length - EXCERPT_TAIL_LINES); i < lines.length; i++) keep.add(i);
	const out: string[] = [];
	let previous = -1;
	for (const i of [...keep].sort((a, b) => a - b)) {
		if (previous !== -1 && i > previous + 1) out.push("[…]");
		out.push(clip(lines[i] ?? "", MAX_LINE_CHARS));
		previous = i;
	}
	return out.join("\n").slice(0, EXCERPT_CHARS);
}

function ordinal(n: number): string {
	const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
	return `${n}${suffix}`;
}

function clip(text: string, max = 200): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
