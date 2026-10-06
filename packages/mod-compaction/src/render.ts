import { type CommandRecord, commandKey, FACTS_VERSION, oneLine, type StoredFacts } from "./facts.ts";
import type { CompactionSettings } from "./settings.ts";

/**
 * The tracked facts as the text the agent reads, and that text read back (D-085): the fallback
 * for a previous summary whose compaction carries no usable details.
 */

/** The first section rendered from tracked facts: everything before it in a summary is the sidecar's. */
export const FACTS_HEADING = "## User requests (verbatim, oldest first)";
const MODIFIED_HEADING = "## Files modified";
const READ_HEADING = "## Files read";
const FAILED_HEADING = "## Commands whose last run failed";
const PASSED_HEADING = "## Commands that last succeeded (no need to re-run unless something changed)";
const HEADINGS = [FACTS_HEADING, MODIFIED_HEADING, READ_HEADING, FAILED_HEADING, PASSED_HEADING];

const SHORTENED_NOTE = "(The first and the newest request are whole; those between are cut to their first line.)";
/** Paths listed per heading. */
export const MAX_FILES = 40;
/** Test and build runs listed per heading, and other commands beside them: the newest of each. */
const MAX_RUNS = 15;
const MAX_OTHER_FAILED = 5;
const MAX_OTHER_PASSED = 10;
const STALE_FAILED = ", before later file edits";
const STALE_PASSED = " (passed before later file edits: run it again)";
const HIDDEN = "errors in the output (exit code hidden by the pipe)";

/** A list cut for the summary: the lines shown and how many were left out. */
export interface Shown {
	readonly lines: readonly string[];
	readonly more: number;
}

/** The facts of one summary. */
export interface FactsView {
	readonly requests: readonly string[];
	readonly requestsOmitted: number;
	/** Files modified, each with what git says of it. */
	readonly modified: Shown;
	readonly read: readonly string[];
	readonly commands: readonly CommandRecord[];
	readonly lastEditAt: number;
}

/** Sorted, and cut to what a summary lists. */
function shown(lines: readonly string[]): Shown {
	return { lines: [...lines].sort().slice(0, MAX_FILES), more: Math.max(0, lines.length - MAX_FILES) };
}

/** Renders the summary: the sidecar's handover (and any note on it), then tracked facts verbatim. */
export function renderSummary(
	facts: FactsView,
	narrative: readonly string[],
	settings: Pick<CompactionSettings, "maxRequestsChars">,
): string {
	const sections = [
		...narrative,
		FACTS_HEADING,
		renderRequests(facts.requests, facts.requestsOmitted, settings.maxRequestsChars),
	];
	if (facts.modified.lines.length > 0) sections.push(MODIFIED_HEADING, list(facts.modified));
	if (facts.read.length > 0) sections.push(READ_HEADING, list(shown(facts.read)));
	const stale = (c: CommandRecord) => c.kind !== "other" && c.at < facts.lastEditAt;
	const failed = pick(facts.commands, "failed", MAX_OTHER_FAILED);
	if (failed.records.length > 0) {
		sections.push(
			FAILED_HEADING,
			commands(
				failed,
				(c) =>
					`\`${c.command}\` → ${c.masked ? HIDDEN : `exit ${c.exitCode ?? "error"}`}${stale(c) ? STALE_FAILED : ""}${c.firstError ? `: ${c.firstError}` : ""}`,
			),
		);
	}
	const passed = pick(facts.commands, "passed", MAX_OTHER_PASSED);
	if (passed.records.length > 0) {
		sections.push(
			PASSED_HEADING,
			commands(passed, (c) => `\`${c.command}\`${stale(c) ? STALE_PASSED : ""}`),
		);
	}
	return sections.join("\n\n");
}

/**
 * The requests within `budget` characters. Over it, the first and the newest stay whole and those
 * between are cut to their first line; over it still, the oldest of those are left out and counted.
 * Each keeps its number in the session.
 */
function renderRequests(requests: readonly string[], omitted: number, budget: number): string {
	if (requests.length === 0) return "(none recorded)";
	const numbered = (text: string, index: number) => `${index === 0 ? 1 : index + 1 + omitted}. ${text}`;
	const whole = requests.map(numbered);
	if (omitted === 0 && whole.reduce((sum, line) => sum + line.length + 1, 0) <= budget) return whole.join("\n");
	const last = requests.length - 1;
	const first = whole[0] ?? "";
	const newest = last > 0 ? [whole[last] ?? ""] : [];
	const between = requests.slice(1, Math.max(last, 1)).map((r, i) => numbered(oneLine(r), i + 1));
	let left = budget - SHORTENED_NOTE.length - first.length - (newest[0]?.length ?? 0);
	let from = between.length;
	while (from > 0 && (between[from - 1]?.length ?? 0) + 1 <= left) {
		from -= 1;
		left -= (between[from]?.length ?? 0) + 1;
	}
	const leftOut = omitted + from;
	return [
		SHORTENED_NOTE,
		first,
		...(leftOut > 0 ? [`(… ${leftOut} requests left out …)`] : []),
		...between.slice(from),
		...newest,
	].join("\n");
}

function list(items: Shown): string {
	const lines = items.lines.map((item) => `- ${item}`);
	if (items.more > 0) lines.push(`- … and ${items.more} more`);
	return lines.join("\n");
}

interface Picked {
	readonly records: readonly CommandRecord[];
	readonly earlier: number;
}

/** The commands that last ended one way, oldest first: the newest test and build runs, and the newest few others. */
function pick(all: readonly CommandRecord[], outcome: CommandRecord["outcome"], maxOther: number): Picked {
	const records = all.filter((c) => c.outcome === outcome).sort((a, b) => a.at - b.at);
	const runs = new Set(records.filter((c) => c.kind !== "other").slice(-MAX_RUNS));
	const others = new Set(records.filter((c) => c.kind === "other").slice(-maxOther));
	const kept = records.filter((c) => runs.has(c) || others.has(c));
	return { records: kept, earlier: records.length - kept.length };
}

function commands(picked: Picked, line: (c: CommandRecord) => string): string {
	const lines = picked.records.map((c) => `- ${line(c)}`);
	return (picked.earlier > 0 ? [`- … and ${picked.earlier} earlier`, ...lines] : lines).join("\n");
}

const LEFT_OUT = /^\(… (\d+) requests left out …\)$/;
const FAILED_LINE =
	/^- `(.+)` → (?:exit (\d+|error)|(errors in the output \(exit code hidden by the pipe\)))(, before later file edits)?(?:: (.*))?$/;
const PASSED_LINE = /^- `(.+)`( \(passed before later file edits: run it again\))?$/;

/**
 * The facts sections of a summary this module wrote, read back from its text. Less exact than the
 * details kept with the compaction: a request that was cut stays cut, and commands lose their
 * order beyond "failed, then passed". Undefined when the text has no facts sections.
 */
export function factsFromSummary(summary: string): StoredFacts | undefined {
	const start = summary.split("\n").indexOf(FACTS_HEADING);
	if (start === -1) return undefined;
	const sections = new Map<string, string[]>(HEADINGS.map((heading) => [heading, []]));
	let open: string[] = [];
	for (const line of summary.split("\n").slice(start)) {
		const section = sections.get(line);
		if (section) open = section;
		else open.push(line);
	}
	const requests: string[] = [];
	let requestsOmitted = 0;
	for (const line of sections.get(FACTS_HEADING) ?? []) {
		const leftOut = LEFT_OUT.exec(line);
		const item = /^(\d+)\. (.*)$/.exec(line);
		if (leftOut) requestsOmitted += Number(leftOut[1]);
		else if (item && Number(item[1]) === (requests.length === 0 ? 1 : requests.length + requestsOmitted + 1)) {
			requests.push(item[2] ?? "");
		} else if (requests.length > 0) requests[requests.length - 1] += `\n${line}`;
	}
	const paths = (heading: string) =>
		(sections.get(heading) ?? []).flatMap((line) => {
			const path = /^- (.+?)(?: \([^()]*\))?$/.exec(line)?.[1];
			return path === undefined || /^… and \d+ more$/.test(path) ? [] : [path];
		});
	const record = (command: string, rest: Omit<CommandRecord, "key" | "kind" | "command">): CommandRecord => ({
		...commandKey(command),
		command,
		...rest,
	});
	const failed = (sections.get(FAILED_HEADING) ?? []).flatMap((line) => {
		const match = FAILED_LINE.exec(line);
		if (!match?.[1]) return [];
		const exitCode = match[2] !== undefined && match[2] !== "error" ? Number(match[2]) : null;
		return [
			record(match[1], {
				outcome: "failed",
				exitCode: match[3] ? 0 : exitCode,
				masked: match[3] !== undefined,
				firstError: match[5] ?? null,
				at: match[4] ? -1 : 0,
			}),
		];
	});
	const passed = (sections.get(PASSED_HEADING) ?? []).flatMap((line) => {
		const match = PASSED_LINE.exec(line);
		if (!match?.[1]) return [];
		return [
			record(match[1], { outcome: "passed", exitCode: 0, masked: false, firstError: null, at: match[2] ? -1 : 0 }),
		];
	});
	return {
		v: FACTS_VERSION,
		requests: requests.map((r) => r.trimEnd()),
		requestsOmitted,
		filesModified: paths(MODIFIED_HEADING),
		filesRead: paths(READ_HEADING),
		commands: [...failed, ...passed],
		lastEditAt: 0,
		clock: 0,
	};
}
