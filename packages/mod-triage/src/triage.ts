import { createHash } from "node:crypto";
import {
	callKey,
	cleanTerminalOutput,
	type ExoModule,
	type FileEdit,
	type ForkPrefix,
	failingItems,
	failureKey,
	fileEdits,
	firstErrorLine,
	isBenignExit,
	isFileReference,
	type JsonValue,
	loadPrompt,
	loopHistoryLength,
	type ModuleContext,
	maskedFailure,
	outcomeOf,
	SIDECAR_MAX_TOKENS,
	startAndEnd,
	type ToolOutcome,
	type ToolResultDraft,
	type ToolRewrite,
	trailingLoop,
	ungroundedReferences,
	verifyingRun,
	withToolResult,
} from "@exocortex/core";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { isNarrowed, namesAll, ranNoTests } from "./passes.ts";
import { parseSettings } from "./settings.ts";
import { errorSites, renderSites } from "./sites.ts";

export const TRIAGE_ID = "triage";

const DIAGNOSE_PROMPT = loadPrompt(new URL("../prompts/diagnose.v5.md", import.meta.url));
const DIAGNOSE_FORK_PROMPT = loadPrompt(new URL("../prompts/diagnose-fork.v2.md", import.meta.url));

/** Hints sharing more of their words than this are the same advice. */
const DUPLICATE_SIMILARITY = 0.6;

const DiagnosisSchema = Type.Object({
	diagnosis: Type.String({ maxLength: 600 }),
	next_action: Type.String({ maxLength: 400 }),
});

/**
 * Failing runs of one command, since it last passed, in which none of its failing tests (or
 * error sites) went away, before triage says the run is not converging (D-108). Three would fire
 * on most ordinary debugging: in the 2026-10-23 eval 11 of 18 sessions had three failing test
 * runs in a row. Four is three attempts in a row that fixed nothing, and at the median 13 s
 * between runs a diagnosis (~19 s) lands before the sixth.
 */
const NOT_CONVERGING_RUNS = 4;

/** The request is where the expected behaviour is written down: a diagnosis reads most of it. */
const GOAL_CHARS = 6_000;
/** The user's latest messages are the goal (D-082): the request, and what they said about it since. */
const MAX_GOAL_MESSAGES = 6;
/** An older message is left out when less than this is left for it. */
const MIN_GOAL_PART = 200;
const RECENT_COMMANDS = 12;
/**
 * What the isolated diagnosis reads (D-108): the model is strong and its context large, so it
 * gets the output, the code and the edits rather than excerpts of them. The output keeps its end,
 * where runners put their summaries, and a quarter for its start, where the first error often is.
 */
const OUTPUT_CHARS = 30_000;
const OUTPUT_START_SHARE = 0.25;
const CODE_CHARS = 30_000;
const EDITS_CHARS = 20_000;
const MAX_SITES = 8;
/** Edits kept, with this much of each one's text. */
const MAX_EDITS = 60;
const EDIT_TEXT_CHARS = 2_000;
/** How long the grounding gate's search of the workspace for one name may take. */
const GREP_TIMEOUT_MS = 2_000;
/**
 * Failures and commands remembered at once. No user message ends the counting (D-082), and all
 * of it is saved with the session, so the ones not seen for longest are dropped.
 */
const MAX_FAILURES = 64;
const MAX_COMMANDS = 64;
/** Commands remembered as having reported one failure. */
const MAX_FAILURE_COMMANDS = 8;
/** Hints remembered per failure, whatever the cap on calls is set to. */
const MAX_KEPT_HINTS = 16;
const MAX_ITEMS = 64;
/** Failing items kept in memory per stretch: enough for any suite, bounded against a runaway output. */
const MAX_KEPT_ITEMS = 5_000;

/** What is kept of one failure, by what it reported ({@link failureIdentity}). Saved with the session. */
const FailureSchema = Type.Object({
	id: Type.String({ minLength: 1, maxLength: 64 }),
	/** Times it was seen since it was first seen, or since a command that reported it last passed. */
	count: Type.Integer({ minimum: 1 }),
	/** Edits made when its current unbroken run of sightings began: it outlived every later one. */
	since: Type.Integer({ minimum: 0 }),
	/** Edits made when it was last seen. */
	seen: Type.Integer({ minimum: 0 }),
	/** Its count when the user last spoke: a hand-over is asked for again only after more failures. */
	atUser: Type.Integer({ minimum: 0 }),
	/** Diagnoses asked that answered or are still running (the cap counts calls, shown or not). */
	hintCalls: Type.Integer({ minimum: 0 }),
	/** Hints the agent was sent and that are still in its context. */
	hints: Type.Array(Type.String({ maxLength: 1_000 }), { maxItems: MAX_KEPT_HINTS }),
	/** The commands that reported it ({@link commandIdentity}). */
	by: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: MAX_FAILURE_COMMANDS }),
});
type Failure = Static<typeof FailureSchema>;

/**
 * One command's failing runs since it last passed, by what fails in them ({@link failingItems}),
 * for telling a run that is not converging (D-108). Saved with the session.
 */
const StretchSchema = Type.Object({
	kind: Type.Union([Type.Literal("tests"), Type.Literal("sites")]),
	/**
	 * What failed when this stretch began: a run in which one of them is gone made progress. Kept
	 * whole while the session runs; only the first {@link MAX_ITEMS} are saved, with `total`.
	 */
	items: Type.Array(Type.String({ maxLength: 300 }), { maxItems: MAX_ITEMS }),
	/** How many items there were: after a reload with fewer saved, a run with fewer failing is progress. */
	total: Type.Integer({ minimum: 0 }),
	/** Failing runs in this stretch, the first included. */
	runs: Type.Integer({ minimum: 1 }),
	/** Edits made when it began. */
	since: Type.Integer({ minimum: 0 }),
	/** Whether the agent was told: once per stretch. */
	told: Type.Boolean(),
});
type Stretch = Static<typeof StretchSchema>;

/** What `saveState` is given (T6): enough to go on counting after a reload. Edits' text and loops are not kept. */
const SavedSchema = Type.Object({
	v: Type.Literal(2),
	edited: Type.Integer({ minimum: 0 }),
	failures: Type.Array(FailureSchema, { maxItems: MAX_FAILURES }),
	last: Type.Array(Type.Tuple([Type.String({ maxLength: 64 }), Type.String({ maxLength: 64 })]), {
		maxItems: MAX_COMMANDS,
	}),
	stretches: Type.Array(Type.Tuple([Type.String({ maxLength: 64 }), StretchSchema]), { maxItems: MAX_COMMANDS }),
});

interface State {
	/** Every failure being counted, the one seen longest ago first. */
	readonly failures: Map<string, Failure>;
	/** The failure each command last reported. A failure stands while it is some command's latest. */
	readonly last: Map<string, string>;
	/** Each test or build command's failing runs since it last passed. */
	readonly stretches: Map<string, Stretch>;
	readonly recent: string[];
	/** The latest file edits, each with its number in the session. */
	readonly edits: { readonly seq: number; readonly edit: FileEdit }[];
	/** Edits made so far. */
	edited: number;
	/** Tool calls since the user last spoke, each with its result, as far back as a loop can reach. */
	calls: { readonly key: string; readonly label: string }[];
	/** Notices given for the loop the calls now end in: 0 none, 1 the warning, 2 the hand-over. */
	loopLevel: number;
}

/** What `onToolResult` made of the latest result; the rewrite speaks only for that one. */
interface Observation {
	readonly key: string;
	readonly command: string;
	readonly sighting: Sighting | undefined;
	/** Set when this run is the one at which its command stops converging. */
	readonly stalled: Stretch | undefined;
}

/** One sighting of a failure. */
interface Sighting {
	readonly id: string;
	readonly count: number;
	/**
	 * Whether the failure stood until now: it was the last thing one of its commands reported. If
	 * not, the command reported other errors in between and these are back.
	 */
	readonly standing: boolean;
	/** The edits numbered above this came between the sightings the notice compares. */
	readonly editsFrom: number;
	readonly masked: boolean;
}

/** Why a diagnosis was asked for: what the hint is introduced with, and what the sidecar is told. */
interface Occasion {
	/** For the agent: "the same errors 2 times". */
	readonly label: string;
	/** For the sidecar: the history sentence of the prompt. */
	readonly history: string;
	readonly editsHeading: string;
	readonly editsFrom: number;
	/**
	 * Whether the failure's allowance (`maxHintsPerSignature`) applies: to a repeat, not to a stretch
	 * that stopped converging, which is told once and whose failures change from run to run.
	 */
	readonly capped: boolean;
}

/** A diagnosis still being worked out, by the command whose failure it is about. */
interface LateWork {
	readonly command: string;
	readonly stop: AbortController;
}

/**
 * Error triage (brief §6.3, D-108). It reads every failing result and says something only when
 * it is worth the agent's attention:
 * - **A repeat** is a failure that reports the same errors as one seen earlier (D-073): fewer
 *   failing tests or another message is a new failure. At the second sighting a diagnosis is
 *   asked, silently; from `loopThreshold` the result says the approach is not working, and from
 *   twice that it asks for a hand-over to the user.
 * - **Not converging:** a test or build command that fails {@link NOT_CONVERGING_RUNS} times in a
 *   row without one of its failing tests (or error sites) going away is told so once, and a
 *   diagnosis is asked. A strong model rarely repeats a failure exactly: the messages change while
 *   nothing gets fixed.
 * - **A diagnosis** never holds the agent. It is asked of a fork of the agent's own context when
 *   the engine forks for free (D-099), else of a prompt with the evidence, and arrives as late help
 *   (D-098). It is stopped only when it can no longer help: the command passed, the user spoke, or
 *   the context was compacted. A rerun does not stop it; a rerun that fails the same way waits for it.
 *
 * What it says is what it can know (D-082):
 * - A failure is forgotten when a command that reported it passes, and a passing test run forgets
 *   the failures of every test command (D-108): `pytest -x` passing after `pytest tests/` failed.
 * - "The edits made since did not change it" is said only of a failure that stood: one that was
 *   the last thing its command reported. One that went away and came back is described as that.
 * - Counts are saved with the session; hints are forgotten when a compaction removes them.
 *
 * It also notices going round in circles without an error (D-069): the same call returning the
 * same result, or a short cycle of calls ending the same way each round. One notice when the loop
 * is established, one more that tells the agent to hand over to the user if it goes on.
 */
export function createTriage(raw: Readonly<Record<string, unknown>>, ctx: ModuleContext): ExoModule {
	const { settings, problems } = parseSettings(raw);
	for (const problem of problems) ctx.log(problem);
	/** The user's latest messages, oldest first. */
	const asked: string[] = [];
	const state = restore(ctx.savedState) ?? newState();
	let observed: Observation | undefined;
	/** Whether what is saved with the session changed since it was last saved. */
	let unsaved = false;
	let repeats = 0;
	let hintsGiven = 0;
	let loops = 0;
	let stalls = 0;
	/** Twice the threshold is where a notice becomes the hand-over. */
	const handOverAt = settings.loopThreshold * 2;
	const lateWork = new Set<LateWork>();
	/** Stops the diagnoses that can no longer help: all of them, or those on the commands given. */
	const stopLateWork = (on?: (command: string) => boolean) => {
		for (const work of lateWork) {
			if (on && !on(work.command)) continue;
			work.stop.abort();
			lateWork.delete(work);
		}
	};

	return {
		id: TRIAGE_ID,

		onUserTurn(turn) {
			if (turn.origin !== "user") return;
			// The user spoke: advice on what came before is not what they asked about now.
			stopLateWork();
			if (turn.text.trim() !== "") asked.push(startAndEnd(turn.text.trim(), GOAL_CHARS));
			if (asked.length > MAX_GOAL_MESSAGES) asked.shift();
			// A loop is the agent's own doing: a call the user asked for again is not part of one.
			state.calls = [];
			state.loopLevel = 0;
			for (const failure of state.failures.values()) {
				if (failure.atUser === failure.count) continue;
				failure.atUser = failure.count;
				unsaved = true;
			}
			save();
		},

		onToolResult(tool) {
			const command = commandIdentity(tool);
			const label = commandOf(tool.input, tool.toolName);
			const outcome = isFailure(tool)
				? `exit ${tool.exitCode ?? "error"}`
				: isMasked(tool)
					? "errors in the output (exit code hidden by a pipe)"
					: "ok";
			state.recent.push(`${label} → ${outcome}`);
			if (state.recent.length > RECENT_COMMANDS) state.recent.shift();
			for (const edit of fileEdits(tool, EDIT_TEXT_CHARS) ?? []) {
				state.edited += 1;
				state.edits.push({ seq: state.edited, edit });
				if (state.edits.length > MAX_EDITS) state.edits.shift();
			}
			const key = callKey(tool.toolName, tool.input, tool.output);
			state.calls.push({ key, label });
			if (state.calls.length > loopHistoryLength(handOverAt)) state.calls.shift();
			// The loop ended: a later one starts over with its first notice.
			if (!currentLoop()) state.loopLevel = 0;
			const sighting = sightingOf(tool, command);
			observed = { key, command, sighting, stalled: sighting ? stretchOf(tool, command) : undefined };
			save();
		},

		async rewriteToolResult(draft, signal) {
			// Only the result just counted: its count is what the notice states.
			if (observed?.key !== callKey(draft.toolName, draft.input, draft.output)) return undefined;
			const { sighting, stalled, command } = observed;
			if (!sighting) return noProgress(draft);
			const failure = state.failures.get(sighting.id);
			const rewrite = failureNotice(draft, command, sighting, failure, stalled);
			const occasion = occasionOf(sighting, stalled);
			// The fork is to read this result as the agent will, notice and all.
			const seen = { ...draft, current: rewrite?.text ?? draft.current };
			if (failure && occasion) await diagnoseLater(failure, occasion, command, seen, sighting.masked, signal);
			return rewrite;
		},

		dispose() {
			stopLateWork();
		},

		onCompacted() {
			stopLateWork();
			// Hints and loop notices were in the span that is gone: there is nothing left to repeat.
			// The failures are still failing, so the counts stay.
			state.loopLevel = 0;
			for (const failure of state.failures.values()) {
				if (failure.hints.length === 0 && failure.hintCalls === 0) continue;
				failure.hints = [];
				failure.hintCalls = 0;
				unsaved = true;
			}
			save();
		},

		status() {
			if (repeats === 0 && loops === 0 && stalls === 0) return TRIAGE_ID;
			const extra = [loops > 0 ? `${loops} loops` : "", stalls > 0 ? `${stalls} not converging` : ""].filter(Boolean);
			return `${TRIAGE_ID} (${[`${repeats} repeats`, `${hintsGiven} hints`, ...extra].join(", ")})`;
		},
	};

	/** Keeps the counts with the session (T6), when they changed. */
	function save(): void {
		if (!unsaved) return;
		unsaved = false;
		ctx.saveState({
			v: 2,
			edited: state.edited,
			failures: [...state.failures.values()].map((f) => ({ ...f, hints: [...f.hints], by: [...f.by] })),
			last: [...state.last],
			stretches: [...state.stretches].map(([command, s]) => [command, { ...s, items: s.items.slice(0, MAX_ITEMS) }]),
		});
	}

	/** Marks a command's stretch as told, as it is now: a later run may have replaced the object. */
	function tell(command: string): void {
		const stretch = state.stretches.get(command);
		if (!stretch || stretch.told) return;
		stretch.told = true;
		unsaved = true;
		save();
	}

	/**
	 * Counts a failing result, and forgets what a passing one shows to be fixed. Done here and not
	 * in the rewrite: a failure happened whether or not the host had time to ask for a notice.
	 */
	function sightingOf(tool: ToolOutcome, command: string): Sighting | undefined {
		const masked = isMasked(tool);
		if (!masked && (!isFailure(tool) || isBenign(tool))) {
			// An exit code a pipe hid, and a benign exit 1, say nothing either way.
			if (!isFailure(tool) && outcomeOf(tool) === "passed") passed(tool, command);
			return undefined;
		}
		const id = failureIdentity(tool);
		const known = state.failures.get(id);
		const standing = known?.by.some((c) => state.last.get(c) === id) ?? false;
		const now = state.edited;
		const failure: Failure = known
			? { ...known, count: known.count + 1, since: standing ? known.since : now, seen: now }
			: { id, count: 1, since: now, seen: now, atUser: 0, hintCalls: 0, hints: [], by: [] };
		if (!failure.by.includes(command)) failure.by = [...failure.by, command].slice(-MAX_FAILURE_COMMANDS);
		// Newest last, so the ones dropped are the ones not seen for longest.
		state.failures.delete(id);
		state.failures.set(id, failure);
		state.last.delete(command);
		state.last.set(command, id);
		dropOldest(state.failures, MAX_FAILURES);
		dropOldest(state.last, MAX_COMMANDS);
		unsaved = true;
		if (!known) return { id, count: 1, standing: true, editsFrom: now, masked };
		repeats += 1;
		return { id, count: failure.count, standing, editsFrom: standing ? known.since : known.seen, masked };
	}

	/**
	 * Follows a failing test or build command's stretch of failures (D-108). A run in which one of
	 * the tests (or error sites) that failed at the stretch's start is gone made progress, and starts
	 * a new stretch. Returns the stretch on the run at which it stops converging, once.
	 */
	function stretchOf(tool: ToolOutcome, command: string): Stretch | undefined {
		if (!isVerifying(command)) return undefined;
		const found = failingItems(tool.output);
		// Nothing to compare: neither progress nor its absence can be told from this run.
		if (!found) return undefined;
		// Compared whole (D-108 amendment): a fix past the first items saved is progress too.
		const items = found.items.slice(0, MAX_KEPT_ITEMS).map((item) => item.slice(0, 300));
		const stretch = state.stretches.get(command);
		state.stretches.delete(command);
		unsaved = true;
		const progress = stretch && (fixedAny(stretch.items, items) || items.length < stretch.total);
		if (!stretch || stretch.kind !== found.kind || progress) {
			const total = items.length;
			state.stretches.set(command, { kind: found.kind, items, total, runs: 1, since: state.edited, told: false });
			dropOldest(state.stretches, MAX_COMMANDS);
			return undefined;
		}
		const next = { ...stretch, runs: stretch.runs + 1 };
		state.stretches.set(command, next);
		return next.runs >= NOT_CONVERGING_RUNS && !next.told ? next : undefined;
	}

	/**
	 * The command passed (T1): what it fixed is forgotten, and seeing it again is a new failure. A
	 * diagnosis of what passed can no longer help. What a test run fixed (D-108 amendments):
	 * - a whole run of the tests: every test command's failures (`pytest -q` after `pytest tests/
	 *   2>&1 | tail` failed);
	 * - a run narrowed to some tests: its own, and those of a command whose failing tests it names;
	 * - a run that ran no test (a filter that matched nothing): nothing.
	 */
	function passed(tool: ToolOutcome, command: string): void {
		forget(fixedBy(tool, command));
	}

	/** Which commands' failures a passing run fixed (see {@link passed}). */
	function fixedBy(tool: ToolOutcome, command: string): (c: string) => boolean {
		if (!command.startsWith(TEST)) return (c) => c === command;
		if (ranNoTests(tool.output)) return () => false;
		const line = tool.input["command"];
		const bare = typeof line === "string" ? (verifyingRun(line)?.bare ?? line) : "";
		if (!isNarrowed(bare)) return (c) => c.startsWith(TEST);
		const text = `${bare}\n${cleanTerminalOutput(tool.output)}`;
		return (c) => {
			if (c === command) return true;
			const stretch = state.stretches.get(c);
			return stretch?.kind === "tests" && namesAll(stretch.items, text);
		};
	}

	/** Forgets the failures, stretches and running diagnoses of the commands `test` picks, decided first. */
	function forget(test: (command: string) => boolean): void {
		const commands = new Set([...state.last.keys(), ...state.stretches.keys(), ...[...lateWork].map((w) => w.command)]);
		for (const failure of state.failures.values()) for (const c of failure.by) commands.add(c);
		const gone = new Set([...commands].filter(test));
		const fixed = (c: string) => gone.has(c);
		stopLateWork(fixed);
		for (const c of gone) {
			if (state.last.delete(c)) unsaved = true;
			if (state.stretches.delete(c)) unsaved = true;
		}
		for (const [id, failure] of state.failures) {
			if (!failure.by.some(fixed)) continue;
			state.failures.delete(id);
			unsaved = true;
		}
	}

	function currentLoop() {
		return settings.loops
			? trailingLoop(
					state.calls.map((c) => c.key),
					settings.loopThreshold,
				)
			: undefined;
	}

	/**
	 * What a failing result says (D-108): nothing below `loopThreshold` sightings of the same errors
	 * (a diagnosis may follow as late help), that the approach is not working from there, and once
	 * that a run stopped converging.
	 */
	function failureNotice(
		draft: ToolResultDraft,
		command: string,
		sighting: Sighting,
		failure: Failure | undefined,
		stalled: Stretch | undefined,
	): ToolRewrite | undefined {
		if (sighting.count >= settings.loopThreshold) {
			const outlived = state.edits.filter((e) => e.seq > sighting.editsFrom).map((e) => e.edit.path);
			const notice = repeatNotice({
				count: sighting.count,
				sinceUser: sighting.count - (failure?.atUser ?? 0),
				errorLine: firstErrorLine(draft.output)?.line,
				edited: [...new Set(outlived)],
				standing: sighting.standing,
				masked: sighting.masked,
				handOverAt,
				loopThreshold: settings.loopThreshold,
			});
			return {
				text: `${draft.current}\n${notice}`,
				note: `repeat ${sighting.count}`,
				// A stretch told of a repeat needs no second notice that it is not converging.
				...(stalled ? { commit: () => tell(command) } : {}),
			};
		}
		if (!stalled) return undefined;
		return {
			text: `${draft.current}\n${stalledNotice(stalled, sighting.masked)}`,
			note: `not converging ×${stalled.runs}`,
			commit: () => {
				stalls += 1;
				tell(command);
			},
		};
	}

	/**
	 * A result that is not a failure, at the end of a loop: says so once, and once more at twice the
	 * threshold. Failures in a loop get their own notice, so the level only rises here.
	 */
	function noProgress(draft: ToolResultDraft): ToolRewrite | undefined {
		const loop = currentLoop();
		if (!loop) return undefined;
		const level = loop.repeats >= handOverAt ? 2 : 1;
		if (level <= state.loopLevel) return undefined;
		const cycle = state.calls.slice(-loop.period).map((c) => c.label);
		return {
			text: `${draft.current}\n${loopNotice(loop.repeats, cycle, level === 2)}`,
			note: `no progress ×${loop.repeats}${loop.period > 1 ? ` (cycle of ${loop.period})` : ""}`,
			// Each level is said once, and it has been said when the model has it.
			commit: () => {
				state.loopLevel = Math.max(state.loopLevel, level);
				loops += 1;
			},
		};
	}

	function isMasked(tool: Parameters<typeof maskedFailure>[0]): boolean {
		return settings.maskedFailures && maskedFailure(tool);
	}

	/** Why this result deserves a diagnosis, if it does: a repeat, else a stretch that stopped converging. */
	function occasionOf(sighting: Sighting, stalled: Stretch | undefined): Occasion | undefined {
		if (sighting.count >= 2) {
			return {
				label: `the same errors ${sighting.count} times`,
				history: sighting.standing
					? `the command below has now reported the same errors ${sighting.count} times, with nothing else reported in between: whatever was changed since did not change them.`
					: `the command below has reported the same errors ${sighting.count} times, but not in a row: it reported something else in between, and now these errors are back.`,
				editsHeading: sighting.standing
					? "Edits made since this run of the same failure began (it failed the same way after them)"
					: "Edits made since this failure was last seen (something else was reported in between, then these errors again)",
				editsFrom: sighting.editsFrom,
				capped: true,
			};
		}
		if (!stalled) return undefined;
		const what = stalled.kind === "tests" ? "tests" : "error sites";
		return {
			label: `${stalled.runs} failing runs, the same ${what} failing each time`,
			history: `the command below has failed ${stalled.runs} times in a row since it last passed, and none of the ${what} that failed at the first of those runs has been fixed: the messages change, the failures stay (${clip(stalled.items.join(", "), 400)}).`,
			editsHeading: "Edits made since the first of those runs (the same tests failed after them)",
			editsFrom: stalled.since,
			capped: false,
		};
	}

	/** The user's latest messages within {@link GOAL_CHARS}, the newest given the most room. */
	function goal(): string {
		const parts: string[] = [];
		let left = GOAL_CHARS;
		for (let i = asked.length - 1; i >= 0; i--) {
			// Two thirds of what is left, so there is always room for what was said before.
			const share = i > 0 ? Math.ceil((left * 2) / 3) : left;
			if (parts.length > 0 && share < MIN_GOAL_PART) break;
			const part = startAndEnd(asked[i] ?? "", share);
			parts.unshift(part);
			left -= part.length;
		}
		return parts.length > 1 ? parts.map((part, i) => `[${i + 1}] ${part}`).join("\n\n") : (parts[0] ?? "");
	}

	/** What a sidecar is given to read, and the text its answer is checked against. */
	function evidenceFor(occasion: Occasion, draft: ToolResultDraft, masked: boolean) {
		const output = startAndEnd(cleanTerminalOutput(draft.output), OUTPUT_CHARS, { startShare: OUTPUT_START_SHARE });
		const request = goal();
		const vars = {
			history: occasion.history,
			edits_heading: occasion.editsHeading,
			goal: request || "(unknown)",
			recent: state.recent.map((r) => `- ${r}`).join("\n") || "(none)",
			command: commandOf(draft.input, draft.toolName),
			exit_code: masked ? "hidden by a pipe" : draft.exitCode === null ? "unknown" : String(draft.exitCode),
			output,
			edits: renderEdits(state.edits.filter((e) => e.seq > occasion.editsFrom).map((e) => e.edit)),
			code:
				renderSites(errorSites(output, ctx.cwd, MAX_SITES), ctx.cwd, CODE_CHARS) ||
				"(the output names no line in a file of this workspace)",
		};
		return { vars, text: `${draft.output}\n${request}\n${state.recent.join("\n")}\n${vars.edits}\n${vars.code}` };
	}

	type Evidence = ReturnType<typeof evidenceFor>;

	/**
	 * Starts a diagnosis that reaches the agent as late help (D-098), without holding the result:
	 * only the fork of the agent's context is taken here, since it is the context as it is now. None
	 * is started while one on this command is running (a rerun that failed again waits for it), or
	 * for a repeat whose failure used its allowance.
	 */
	async function diagnoseLater(
		failure: Failure,
		occasion: Occasion,
		command: string,
		draft: ToolResultDraft,
		masked: boolean,
		signal: AbortSignal,
	): Promise<void> {
		const pool = ctx.pool();
		if (!settings.sidecar || !pool || signal.aborted) return;
		if ([...lateWork].some((w) => w.command === command)) return;
		if (occasion.capped && failure.hintCalls >= settings.maxHintsPerSignature) return;
		const fork = await ctx.forkPrefix();
		// The host gave up on this result meanwhile: its notice may never reach the agent.
		if (signal.aborted) return;
		// The fork ends in the agent's tool calls: this one is answered with its result as the agent sees it (D-099).
		const continued = fork && withToolResult(fork, draft.toolCallId, draft.current);
		const evidence = evidenceFor(occasion, draft, masked);
		const work: LateWork = { command, stop: new AbortController() };
		lateWork.add(work);
		failure.hintCalls += 1;
		unsaved = true;
		save();
		const previous = [...failure.hints];
		const done = (hint: string | null | undefined) => {
			lateWork.delete(work);
			if (hint === undefined || work.stop.signal.aborted) return giveBack(failure.id);
			if (hint === null) return;
			deliver(failure.id, occasion, draft, hint);
		};
		diagnose(evidence, previous, continued, fork, work.stop.signal)
			.then(done)
			.catch((error: unknown) => {
				ctx.log(`diagnosis failed: ${String(error)}`);
				done(undefined);
			});
	}

	/** A call that ended without a hint does not use up the failure's allowance (D-108). */
	function giveBack(failureId: string): void {
		const current = state.failures.get(failureId);
		if (!current || current.hintCalls === 0) return;
		current.hintCalls -= 1;
		unsaved = true;
		save();
	}

	/** Sends a hint as late help, and remembers it as given once the agent has it. */
	function deliver(failureId: string, occasion: Occasion, draft: ToolResultDraft, hint: string): void {
		const command = commandOf(draft.input, draft.toolName);
		if (!ctx.deliverLate(`[exo triage hint on \`${clip(command, 120)}\` (${occasion.label}): ${hint}]`)) {
			giveBack(failureId);
			return;
		}
		hintsGiven += 1;
		// The eval follows each hint to the failure it was about (D-057).
		ctx.record({ kind: "exo.action", data: { action: "hint", toolCallId: draft.toolCallId, reason: occasion.label } });
		// On the failure as it is now: a later sighting may have replaced the object this hint began with.
		const current = state.failures.get(failureId);
		if (!current) return;
		current.hints = [...current.hints, hint].slice(-MAX_KEPT_HINTS);
		unsaved = true;
		save();
	}

	/**
	 * The hint: from the fork of the agent's context when there is one (D-099), as it reads the
	 * whole conversation as the agent did; else, or when the fork cannot be used, from the prompt
	 * with the evidence. Null when the answer was nothing usable (empty, naming what is nowhere, or
	 * what was said before): it counts as a call. Undefined when no answer came.
	 */
	async function diagnose(
		evidence: Evidence,
		earlier: readonly string[],
		continued: ForkPrefix | undefined,
		fork: ForkPrefix | undefined,
		signal: AbortSignal,
	): Promise<string | null | undefined> {
		const answer = await ask(evidence, earlier, continued, signal);
		if (!answer) return undefined;
		const hint = [answer.value.diagnosis, answer.value.next_action]
			.map((s) => s.trim())
			.filter(Boolean)
			.join(" ");
		if (hint === "") return null;
		// A name from the conversation the fork read is evidence too.
		const read = answer.forked && fork ? texts(fork.body["messages"]).join("\n") : "";
		const unknown = await ungrounded(hint, `${evidence.text}\n${read}`, signal);
		if (unknown.length > 0) {
			ctx.log(
				`dropped a hint naming ${unknown.map((name) => `\`${name}\``).join(", ")}, found nowhere: ${clip(hint, 300)}`,
			);
			return null;
		}
		// The earlier hint did not stop the failure, so saying it again cannot help (D-061).
		if (earlier.some((h) => similarity(wordSet(h), wordSet(hint)) > DUPLICATE_SIMILARITY)) {
			ctx.log(`dropped a hint that repeats an earlier one: ${clip(hint, 300)}`);
			return null;
		}
		return clip(hint, 900);
	}

	/** The sidecar's answer: the fork's when it gives one, else the isolated prompt's. Undefined when neither does. */
	async function ask(
		evidence: Evidence,
		earlier: readonly string[],
		continued: ForkPrefix | undefined,
		signal: AbortSignal,
	): Promise<{ readonly value: Static<typeof DiagnosisSchema>; readonly forked: boolean } | undefined> {
		const pool = ctx.pool();
		if (!pool) return undefined;
		const previous = earlier.map((h) => `- ${h}`).join("\n") || "(none)";
		const run = (prompt: string, fork: ForkPrefix | undefined) =>
			pool.run({
				module: TRIAGE_ID,
				kind: "judge",
				priority: "interactive",
				signal,
				schema: DiagnosisSchema,
				schemaName: fork ? "diagnosis_fork" : "diagnosis",
				request: {
					...(fork ? { fork } : {}),
					messages: [{ role: "user", content: prompt }],
					maxTokens: SIDECAR_MAX_TOKENS,
				},
			});
		if (continued) {
			const forked = await run(DIAGNOSE_FORK_PROMPT.render({ ...evidence.vars, previous }), continued);
			if (forked.ok) return { value: forked.value, forked: true };
			if (signal.aborted) return undefined;
			ctx.log(`diagnosis from a fork ${forked.outcome}: ${forked.error}`);
		}
		const isolated = await run(DIAGNOSE_PROMPT.render({ ...evidence.vars, previous }), undefined);
		if (isolated.ok) return { value: isolated.value, forked: false };
		if (!signal.aborted) ctx.log(`diagnosis ${isolated.outcome}: ${isolated.error}`);
		return undefined;
	}

	/**
	 * The guidance gate (research R3.5, D-108): names in a hint must be in its evidence, or in the
	 * workspace. A path must exist; a code name is searched for in the workspace's files (`git
	 * grep`, bounded), since the code the agent wrote may well name it. A name that cannot be
	 * searched for is let through.
	 */
	async function ungrounded(hint: string, evidence: string, signal: AbortSignal): Promise<string[]> {
		const unknown: string[] = [];
		for (const ref of ungroundedReferences(hint, evidence, ctx.cwd)) {
			if (signal.aborted) return [];
			if (isFileReference(ref) || !(await inWorkspace(ref, signal))) unknown.push(ref);
		}
		return unknown;
	}

	async function inWorkspace(ref: string, signal: AbortSignal): Promise<boolean> {
		const name = bareName(ref);
		if (!/^[A-Za-z_~$][\w$]{2,}$/.test(name)) return true;
		const found = await ctx.runCommand(`git grep -qF --untracked -e '${name}'`, { timeoutMs: GREP_TIMEOUT_MS, signal });
		// 1 is "not found"; anything else (not a repository, a timeout) cannot tell.
		return found.exitCode !== 1;
	}
}

const TEST = "test:";

/** Whether a command identity is a test or build run's. */
function isVerifying(command: string): boolean {
	return command.startsWith(TEST) || command.startsWith("build:");
}

/** Whether any item that failed at a stretch's start is gone, or failing fewer times, now. */
function fixedAny(before: readonly string[], now: readonly string[]): boolean {
	const left = new Map<string, number>();
	for (const item of now) left.set(item, (left.get(item) ?? 0) + 1);
	for (const item of before) {
		const n = left.get(item) ?? 0;
		if (n === 0) return true;
		left.set(item, n - 1);
	}
	return false;
}

/** `ns::Type::method()` → `method`: the part a definition names. */
function bareName(ref: string): string {
	let name = ref;
	for (const suffix of [/\(\)$/, /(:\d+)+$/, /<[^<>]*>$/, /::$/]) name = name.replace(suffix, "");
	return name.split(/::|\.|->/).at(-1) ?? name;
}

/** Every string in a JSON value: what a request's messages say, without the JSON around it. */
function texts(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (typeof value !== "object" || value === null) return [];
	return Object.values(value).flatMap(texts);
}

function wordSet(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9_]+/)
			.filter((w) => w.length >= 3),
	);
}

function similarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
	const shared = [...a].filter((w) => b.has(w)).length;
	const union = new Set([...a, ...b]).size;
	return union === 0 ? 1 : shared / union;
}

function newState(): State {
	return {
		failures: new Map(),
		last: new Map(),
		stretches: new Map(),
		recent: [],
		edits: [],
		edited: 0,
		calls: [],
		loopLevel: 0,
	};
}

/** The state an earlier instance saved, if it is one this version wrote. */
function restore(saved: JsonValue | undefined): State | undefined {
	if (saved === undefined || !Value.Check(SavedSchema, saved)) return undefined;
	return {
		...newState(),
		edited: saved.edited,
		failures: new Map(saved.failures.map((f) => [f.id, { ...f, hints: [...f.hints], by: [...f.by] }])),
		last: new Map(saved.last),
		stretches: new Map(saved.stretches.map(([command, s]) => [command, { ...s, items: [...s.items] }])),
	};
}

function dropOldest(map: Map<string, unknown>, max: number): void {
	for (const key of map.keys()) {
		if (map.size <= max) return;
		map.delete(key);
	}
}

function digest(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

/**
 * What a failing call reported: core's {@link failureKey}, and for a failed `edit` also the text it
 * looked for (T2). The tool's message names only the file, so without this every failed edit to a
 * file would be the same failure, whatever was tried.
 */
function failureIdentity(tool: Pick<ToolOutcome, "toolName" | "input" | "output">): string {
	const key = failureKey(tool);
	if (tool.toolName !== "edit") return key;
	const edits = tool.input["edits"];
	const sought = [tool.input["oldText"], ...(Array.isArray(edits) ? edits.map(oldTextOf) : [])].filter(
		(text) => typeof text === "string",
	);
	return sought.length > 0 ? digest(`${key}\n${JSON.stringify(sought)}`) : key;
}

function oldTextOf(edit: unknown): unknown {
	return typeof edit === "object" && edit !== null ? (edit as { oldText?: unknown }).oldText : undefined;
}

/**
 * Names what was run, so a later pass can be matched to an earlier failure: a test or build run
 * by the run itself (`cd x && cargo test 2>&1 | tail` is `cargo test`) and its kind (`test:…`), another
 * shell command by its text, a file tool by its path, any other tool by its name.
 */
function commandIdentity(tool: Pick<ToolOutcome, "toolName" | "input">): string {
	const command = tool.input["command"];
	if (typeof command === "string") {
		const run = verifyingRun(command);
		return run ? `${run.kind}:${digest(run.bare)}` : digest(command.replace(/\s+/g, " ").trim());
	}
	const path = tool.input["path"] ?? tool.input["file_path"];
	return digest(typeof path === "string" ? `${tool.toolName} ${path}` : tool.toolName);
}

function isFailure(tool: Pick<ToolResultDraft, "isError" | "exitCode">): boolean {
	return tool.isError || (tool.exitCode !== null && tool.exitCode !== 0);
}

/** The edits a failure outlived, as before/after text per file, the newest kept within {@link EDITS_CHARS}. */
function renderEdits(edits: readonly FileEdit[]): string {
	if (edits.length === 0) return "(none made with the edit tools)";
	const shown: string[] = [];
	let left = EDITS_CHARS;
	for (const e of [...edits].reverse()) {
		const text = `${e.path}\n- ${indent(e.before)}\n+ ${indent(e.after)}`;
		if (text.length > left) break;
		shown.unshift(text);
		left -= text.length;
	}
	const earlier = edits.length - shown.length;
	return [...(earlier > 0 ? [`(${earlier} earlier edit(s) left out for length)`] : []), ...shown].join("\n\n");
}

function indent(text: string): string {
	return text.split("\n").join("\n  ");
}

/** `grep` finding nothing (exit 1) is an answer, not a failure: core's rule (D-077). */
function isBenign(tool: Pick<ToolResultDraft, "exitCode" | "input" | "toolName">): boolean {
	const command = tool.input["command"];
	return typeof command === "string" && isBenignExit(command, tool.exitCode);
}

/** The command, or for file tools the tool and its path (`edit src/lib.rs`), so hints know what was tried. */
function commandOf(input: ToolResultDraft["input"], toolName: string): string {
	const command = input["command"];
	if (typeof command === "string") return clip(command.replace(/\s+/g, " ").trim(), 200);
	const path = input["path"] ?? input["file_path"];
	return typeof path === "string" ? `${toolName} ${clip(path, 160)}` : toolName;
}

/**
 * Describes a failure seen `loopThreshold` times or more, at runtime instead of echoing the
 * failed call back (research R3.3, R3.4). It says what is known and no more (D-082): that edits
 * "did not change it" only of a failure that stood through them.
 */
function repeatNotice(repeat: {
	readonly count: number;
	/** How many of those came since the user last spoke. */
	readonly sinceUser: number;
	readonly errorLine: string | undefined;
	/** Files edited between the sightings compared. */
	readonly edited: readonly string[];
	readonly standing: boolean;
	readonly masked: boolean;
	readonly loopThreshold: number;
	readonly handOverAt: number;
}): string {
	const { count, errorLine, standing } = repeat;
	const earlier = standing ? "as before" : "as an earlier run";
	const between = standing ? "" : ", after other results in between";
	const same = `${errorLine ? ` with the same errors ${earlier} (first: ${clip(errorLine)})` : ` the same way ${earlier}`}${between}`;
	const pipe = repeat.masked ? " The exit code shown is the pipe's last command's, not this run's." : "";
	const edits =
		standing && repeat.edited.length > 0
			? ` The edits made since (${repeat.edited
					.slice(0, 4)
					.map((p) => clip(p, 80))
					.join(", ")}${repeat.edited.length > 4 ? ", …" : ""}) did not change it.`
			: "";
	// The user answers a hand-over by speaking: it is asked for again only if the failures go on.
	if (count >= repeat.handOverAt && repeat.sinceUser >= repeat.loopThreshold) {
		return `[exo triage: this has now failed ${count} times${same}.${pipe}${edits} ${HAND_OVER}]`;
	}
	return `[exo triage: this has now failed ${count} times${same}.${pipe}${edits} The current approach is not working: stop retrying it, re-read the code around the error and question the assumption behind the last changes before the next attempt.]`;
}

/** Says that a command keeps failing without any of its failures going away (D-108). */
function stalledNotice(stretch: Stretch, masked: boolean): string {
	const what = stretch.kind === "tests" ? "the same tests still fail" : "errors remain at the same places";
	const names = clip(stretch.items.join(", "), 240);
	const pipe = masked ? " The exit code shown is the pipe's last command's, not this run's." : "";
	return `[exo triage: ${stretch.runs} runs since this last passed, and ${what} (${names}): the messages change but none is fixed.${pipe} Step back and find the cause before the next edit.]`;
}

/** What a loop that survived its first warning is told: the agent cannot be stopped (D-010), so it is asked to stop. */
const HAND_OVER =
	"Stop repeating it. If you cannot find a different approach, stop and tell the user what you tried and what is blocking you.";

/** Describes a loop of calls that keep ending the same way, without an error to point at (D-069). */
function loopNotice(repeats: number, cycle: readonly string[], handOver: boolean): string {
	const what =
		cycle.length === 1
			? `this exact call has now returned the same result ${repeats} times in a row`
			: `the same ${cycle.length} calls (${cycle.map((c) => clip(c, 60)).join(" → ")}) have now run ${repeats} times in a row with the same results each time`;
	const advice =
		cycle.length === 1
			? "Running it again will not change the result: use what it already shows, or do something different."
			: "This loop is not making progress: change the approach before running them again.";
	return `[exo triage: ${what}. ${handOver ? HAND_OVER : advice}]`;
}

function clip(text: string, max = 200): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
