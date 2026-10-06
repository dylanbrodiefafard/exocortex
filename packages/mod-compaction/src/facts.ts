import {
	firstErrorLine,
	isBenignExit,
	type JsonValue,
	maskedFailure,
	outcomeOf,
	shellCommands,
	type ToolOutcome,
	verifyingRun,
} from "@exocortex/core";

/**
 * The tracked facts as data (D-085): what is kept with a compaction (`details.exo.facts`) and in
 * the module's saved state, read back as untrusted input, and how the facts of two sources merge.
 */

export const FACTS_VERSION = 1;
const MAX_COMMAND_CHARS = 300;
const MAX_ERROR_CHARS = 300;
const MAX_PATH_CHARS = 1_024;
/** Records kept of test and build runs, and of other commands: the newest of each. */
const MAX_RUN_RECORDS = 40;
const MAX_OTHER_RECORDS = 40;
/** Paths kept per list: the newest. */
export const MAX_PATHS = 300;
/** Characters of requests kept with a compaction; over it the ones between the first and the newest shrink. */
const MAX_KEPT_REQUEST_CHARS = 60_000;
const MAX_ONE_LINE_CHARS = 160;
/** A request longer than any setting would keep is not one this module wrote. */
const MAX_REQUEST_CHARS = 100_000;

/** The last run of one command. */
export interface CommandRecord {
	/** What makes two command lines the same run (see {@link commandKey}). */
	readonly key: string;
	/** The line as it was last typed. */
	readonly command: string;
	readonly kind: "test" | "build" | "other";
	/** `unlisted`: its last run says nothing either way (the exit code was a pipe's, or an answer like `grep`'s 1). */
	readonly outcome: "passed" | "failed" | "unlisted";
	readonly exitCode: number | null;
	/** A test or build run that failed behind a pipe: the exit code was the pipe's last command's (D-074). */
	readonly masked: boolean;
	readonly firstError: string | null;
	/** The module's clock when it ran: orders the records, and against {@link StoredFacts.lastEditAt}. */
	readonly at: number;
}

/** The facts kept with a compaction, and (with more beside them) in the module's saved state. */
export interface StoredFacts {
	readonly v: typeof FACTS_VERSION;
	/** Every user request summarized away so far, oldest first. */
	readonly requests: readonly string[];
	/** Requests no longer kept: they came after the first one. */
	readonly requestsOmitted: number;
	readonly filesModified: readonly string[];
	readonly filesRead: readonly string[];
	readonly commands: readonly CommandRecord[];
	/** The clock at the last successful `edit` or `write`; 0 when there was none. */
	readonly lastEditAt: number;
	/** The clock when these were written: no stamp in them is later. */
	readonly clock: number;
}

/**
 * What makes two command lines the same run. A test or build run is its kind, the directory it
 * `cd`s into and its words without options, however its output was piped or cut: `cargo test`,
 * `cargo test -- --nocapture` and `cargo test 2>&1 | tail` are one run, `cargo test parser` and
 * `cd fuzz && cargo test` are others. Any other command is its text.
 */
export function commandKey(command: string): { readonly key: string; readonly kind: CommandRecord["kind"] } {
	const run = verifyingRun(command);
	if (!run) return { key: clean(command), kind: "other" };
	const dir =
		shellCommands(command)
			?.findLast((c) => c.words[0] === "cd")
			?.words.at(-1) ?? "";
	const words = run.bare.split(" ").filter((word) => !word.startsWith("-"));
	return { key: `${run.kind}\n${dir}\n${words.join(" ")}`, kind: run.kind };
}

function clean(command: string): string {
	return command.replace(/\s+/g, " ").trim().slice(0, MAX_COMMAND_CHARS);
}

/** A finished `bash` call as a record of its command's last run; undefined for any other call. */
export function commandRecord(tool: ToolOutcome, at: number): CommandRecord | undefined {
	const command = tool.input["command"];
	if (tool.toolName !== "bash" || typeof command !== "string") return undefined;
	const verdict = outcomeOf(tool);
	// A run behind a pipe whose output does not show how it ended is listed nowhere (D-075), and
	// neither is an exit code that is an answer (`grep` finding nothing, D-077).
	const outcome = verdict === "unknown" || isBenignExit(command, tool.exitCode) ? "unlisted" : verdict;
	return {
		...commandKey(command),
		command: clean(command),
		outcome,
		exitCode: tool.exitCode,
		masked: maskedFailure(tool),
		firstError: outcome === "failed" ? (firstErrorLine(tool.output)?.line.slice(0, MAX_ERROR_CHARS) ?? null) : null,
		at,
	};
}

/** The last run of each command across both lists, oldest first, cut to the newest of each sort. */
export function mergeCommands(a: readonly CommandRecord[], b: readonly CommandRecord[]): CommandRecord[] {
	const byKey = new Map<string, CommandRecord>();
	for (const record of [...a, ...b]) {
		const known = byKey.get(record.key);
		if (!known || record.at >= known.at) byKey.set(record.key, record);
	}
	const sorted = [...byKey.values()].sort((x, y) => x.at - y.at);
	const runs = sorted.filter((r) => r.kind !== "other").slice(-MAX_RUN_RECORDS);
	const others = sorted.filter((r) => r.kind === "other").slice(-MAX_OTHER_RECORDS);
	return [...runs, ...others].sort((x, y) => x.at - y.at);
}

/** Both lists' paths, each once, cut to the newest. */
export function mergePaths(...lists: readonly (readonly string[])[]): string[] {
	return [...new Set(lists.flat())].slice(-MAX_PATHS);
}

/** A request cut to its first line, marked when anything was cut. */
export function oneLine(request: string): string {
	const trimmed = request.trim();
	const first = (trimmed.split("\n")[0] ?? "").trimEnd();
	const line = first.slice(0, MAX_ONE_LINE_CHARS).trimEnd();
	return line.length < trimmed.length ? `${line} …` : line;
}

/**
 * The requests as kept with a compaction, within {@link MAX_KEPT_REQUEST_CHARS}: over it the ones
 * between the first and the newest are cut to their first line, oldest first, and then left out
 * and counted.
 */
export function boundRequests(
	requests: readonly string[],
	omitted: number,
): { readonly requests: string[]; readonly requestsOmitted: number } {
	const kept = [...requests];
	let total = kept.reduce((sum, r) => sum + r.length, 0);
	for (let i = 1; i < kept.length - 1 && total > MAX_KEPT_REQUEST_CHARS; i++) {
		const short = oneLine(kept[i] ?? "");
		total -= (kept[i] ?? "").length - short.length;
		kept[i] = short;
	}
	let requestsOmitted = omitted;
	let drop = 0;
	while (total > MAX_KEPT_REQUEST_CHARS && drop < kept.length - 2) {
		total -= (kept[1 + drop] ?? "").length;
		drop += 1;
	}
	if (drop > 0) {
		kept.splice(1, drop);
		requestsOmitted += drop;
	}
	return { requests: kept, requestsOmitted };
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The strings of a list that are no longer than `maxChars`; anything else in it is skipped. */
export function strings(value: unknown, maxChars: number, maxCount: number): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is string => typeof item === "string" && item !== "" && item.length <= maxChars)
		.slice(-maxCount);
}

function count(value: unknown, min = 0): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= min ? value : 0;
}

function parseCommand(value: unknown): CommandRecord[] {
	if (!isRecord(value)) return [];
	const { command, outcome, exitCode, firstError, at } = value;
	if (typeof command !== "string" || command === "" || command.length > MAX_COMMAND_CHARS) return [];
	if (outcome !== "passed" && outcome !== "failed" && outcome !== "unlisted") return [];
	return [
		{
			// The key and the kind are read from the command again: an older version may have keyed it otherwise.
			...commandKey(command),
			command,
			outcome,
			exitCode: typeof exitCode === "number" && Number.isSafeInteger(exitCode) ? exitCode : null,
			masked: value["masked"] === true,
			firstError: typeof firstError === "string" ? firstError.slice(0, MAX_ERROR_CHARS) : null,
			at: count(at, -1),
		},
	];
}

/**
 * Facts read back from a compaction's details or from saved state. Both are untrusted (an older
 * version, another tool or a hand may have written them): what has the right shape is taken, the
 * rest is skipped. Undefined when the value is not this version's facts at all.
 */
export function parseFacts(value: unknown): StoredFacts | undefined {
	if (!isRecord(value) || value["v"] !== FACTS_VERSION) return undefined;
	const commands = Array.isArray(value["commands"]) ? value["commands"].flatMap(parseCommand) : [];
	return {
		v: FACTS_VERSION,
		...boundRequests(strings(value["requests"], MAX_REQUEST_CHARS, 10_000), count(value["requestsOmitted"])),
		filesModified: strings(value["filesModified"], MAX_PATH_CHARS, MAX_PATHS),
		filesRead: strings(value["filesRead"], MAX_PATH_CHARS, MAX_PATHS),
		commands: mergeCommands(commands, []),
		lastEditAt: count(value["lastEditAt"]),
		clock: Math.max(count(value["clock"]), ...commands.map((c) => c.at)),
	};
}

/** Facts as a JSON value, for details and saved state. */
export function factsJson(facts: StoredFacts): { [key: string]: JsonValue } {
	return {
		v: facts.v,
		requests: [...facts.requests],
		requestsOmitted: facts.requestsOmitted,
		filesModified: [...facts.filesModified],
		filesRead: [...facts.filesRead],
		commands: facts.commands.map((c) => ({ ...c })),
		lastEditAt: facts.lastEditAt,
		clock: facts.clock,
	};
}
