import { ungroundedReferences } from "@exocortex/core";
import { keywords, type StoredPreference, type TaskKind } from "./store.ts";

/**
 * Preference cards (D-060): how the user likes work done, learned only from the user's own
 * words and added to later prompts that leave it unsaid. With D-064 a card may be an expectation
 * of one kind of task, and may come from a correction. Pure functions; the module wires them.
 */

/** Words that make a statement a standing rule rather than an instruction for one task. */
const STANDING_CUE =
	/\b(always|never|from now on|going forward|in (the )?future|next time|every time|whenever|by default|as a rule|in general|i (really |strongly |much )?(prefer|like|love|hate|dislike|expect)|i (don't|do not) (like|want)|i want you to|remember (to|that)|stop (doing|adding|using|writing)|don't ever|do not ever)\b/i;
/** Words that limit a statement to the task at hand: never a standing rule, never a withdrawal. */
const ONE_OFF_CUE =
	/\b(this time|for now|for this (task|one|change|pr|commit)|just (this once|here|for today)|today)\b/i;
/** Rules sharing more of their words than this are the same preference. */
const SAME_RULE_SIMILARITY = 0.6;
/** A prompt that already has this share of a rule's keywords states it itself. */
const ALREADY_SAID_OVERLAP = 0.6;
const MIN_QUOTE_CHARS = 8;
const MIN_RULE_CHARS = 8;
const MAX_RULE_CHARS = 200;
const QUOTE_CHARS = 300;
/** How a rule for one kind of task is introduced to the agent and the user. */
const KIND_LABEL: Readonly<Record<TaskKind, string>> = {
	any: "",
	fix: "bug fixes",
	feature: "new features",
	refactor: "refactors",
	test: "writing tests",
	review: "code reviews",
	explain: "questions and explanations",
	docs: "documentation",
};

/** What the sidecar proposed for one preference: `same_as` and `replaces` are 1-based into the list it was shown. */
export interface ProposedPreference {
	readonly rule: string;
	readonly quote: string;
	/** The sidecar's reading of whether the user stated it as a rule for future work. */
	readonly standing: boolean;
	/** The kind of task the rule is about, or `any`. */
	readonly applies_to: TaskKind;
	/** The sidecar's reading of whether the user said it to correct what the agent had just done. */
	readonly correction: boolean;
	readonly same_as: number;
	readonly replaces: number;
}

/** What code admits from a proposal. */
export interface Admitted {
	/** A known preference the user withdrew. */
	readonly retire?: number;
	/** A preference the user stated: a known one (`existing`) or a new rule. */
	readonly stated?: {
		readonly existing: number | undefined;
		readonly rule: string;
		readonly standing: boolean;
		readonly kind: TaskKind;
		readonly correction: boolean;
		readonly quote: string;
	};
}

/**
 * The admission gate (D-060). The sidecar only proposes; this decides, from the user's words:
 * - the quote must be in the message verbatim, else nothing is admitted;
 * - a one-off ("this time", "for now") neither states nor withdraws a preference;
 * - the rule may name no file or symbol the message does not;
 * - `same_as` and `replaces` count only when they point at a preference that was shown.
 *
 * Whether it is a standing rule is the sidecar's reading of the quoted words (natural phrasing
 * such as "I'm a TDD person" has no fixed cue), or a standing cue in the sentence. `similar` is
 * the known preference nearest in meaning, when an embeddings server found one.
 */
export function admitPreference(
	proposal: ProposedPreference,
	message: string,
	live: readonly StoredPreference[],
	shownToSidecar: readonly StoredPreference[],
	cwd: string,
	similar?: StoredPreference,
): Admitted {
	const sentence = quotedSentence(message, proposal.quote);
	if (sentence === undefined || isOneOff(sentence)) return {};
	const isLive = (p: StoredPreference | undefined) => (p && live.some((l) => l.id === p.id) ? p : undefined);
	const replaced = isLive(shownToSidecar[proposal.replaces - 1]);
	const retire = replaced ? { retire: replaced.id } : {};
	const rule = proposal.rule.trim();
	if (rule.length < MIN_RULE_CHARS || rule.length > MAX_RULE_CHARS) return retire;
	if (ungroundedReferences(rule, message, cwd).length > 0) return retire;
	const others = live.filter((p) => p.id !== replaced?.id);
	const same = proposal.same_as === proposal.replaces ? undefined : isLive(shownToSidecar[proposal.same_as - 1]);
	const notReplaced = (p: StoredPreference | undefined) => (p && p.id !== replaced?.id ? p : undefined);
	const existing = notReplaced(same) ?? notReplaced(isLive(similar)) ?? sameRule(rule, others);
	const quote = proposal.quote.replace(/\s+/g, " ").trim().slice(0, QUOTE_CHARS);
	return {
		...retire,
		stated: {
			existing: existing?.id,
			rule: existing?.rule ?? rule,
			standing: proposal.standing || isStanding(sentence),
			kind: proposal.applies_to,
			correction: proposal.correction,
			quote,
		},
	};
}

/** A preference with what its sightings add up to in one repo. */
export interface ActivePreference {
	readonly id: number;
	readonly rule: string;
	readonly taskKind: TaskKind;
	/** Distinct sessions it was stated in, across repos. */
	readonly sessions: number;
	readonly lastSeenAt: number;
}

/** The sentence(s) of `message` containing `quote`, or undefined when the quote is not verbatim. */
export function quotedSentence(message: string, quote: string): string | undefined {
	const haystack = squash(message);
	const needle = squash(quote);
	if (needle.length < MIN_QUOTE_CHARS) return undefined;
	const at = haystack.toLowerCase().indexOf(needle.toLowerCase());
	if (at === -1) return undefined;
	const before = haystack.slice(0, at);
	const start = Math.max(before.lastIndexOf(". "), before.lastIndexOf("! "), before.lastIndexOf("? ")) + 1;
	const rest = haystack.slice(at + needle.length);
	const stop = rest.search(/[.!?](\s|$)/);
	return haystack.slice(start, stop === -1 ? haystack.length : at + needle.length + stop + 1).trim();
}

function isStanding(sentence: string): boolean {
	return STANDING_CUE.test(sentence) && !ONE_OFF_CUE.test(sentence);
}

function isOneOff(sentence: string): boolean {
	return ONE_OFF_CUE.test(sentence);
}

/** The live preference whose rule shares most of its words with `rule`, if any is close enough. */
function sameRule(rule: string, live: readonly StoredPreference[]): StoredPreference | undefined {
	const words = new Set(keywords(rule));
	let best: { preference: StoredPreference; similarity: number } | undefined;
	for (const preference of live) {
		const other = new Set(keywords(preference.rule));
		const shared = [...words].filter((w) => other.has(w)).length;
		const union = new Set([...words, ...other]).size;
		const similarity = union === 0 ? 0 : shared / union;
		if (similarity > SAME_RULE_SIMILARITY && similarity > (best?.similarity ?? 0)) best = { preference, similarity };
	}
	return best?.preference;
}

/**
 * Preferences that apply in `scope`, most established first. One applies when the user:
 * - stated it as a standing rule in this repo ("always…", "from now on…"); or
 * - stated it in `minSessions` separate sessions in this repo; or
 * - stated it in 2+ repos (D-018's promotion: it is about the user, not the repo).
 */
export function activePreferences(
	live: readonly StoredPreference[],
	scope: string,
	minSessions: number,
): ActivePreference[] {
	const active: ActivePreference[] = [];
	for (const preference of live) {
		const here = preference.sightings.filter((s) => s.scope === scope);
		const applies =
			here.some((s) => s.standing) ||
			new Set(here.map((s) => s.session)).size >= minSessions ||
			new Set(preference.sightings.map((s) => s.scope)).size >= 2;
		if (!applies) continue;
		active.push({
			id: preference.id,
			rule: preference.rule,
			taskKind: preference.taskKind,
			sessions: new Set(preference.sightings.map((s) => s.session)).size,
			lastSeenAt: Math.max(...preference.sightings.map((s) => s.seenAt)),
		});
	}
	return active.sort((a, b) => b.sessions - a.sessions || b.lastSeenAt - a.lastSeenAt || a.id - b.id);
}

/** Whether the prompt states the rule itself: then adding it would only repeat the user. */
export function alreadySaid(prompt: string, rule: string): boolean {
	const ruleWords = keywords(rule);
	if (ruleWords.length === 0) return true;
	const promptWords = new Set(keywords(prompt));
	return ruleWords.filter((w) => promptWords.has(w)).length / ruleWords.length >= ALREADY_SAID_OVERLAP;
}

/** The rule as the agent and the user read it: "For bug fixes: Add a regression test." */
export function withKind(preference: { readonly rule: string; readonly taskKind: TaskKind }): string {
	const label = KIND_LABEL[preference.taskKind];
	return label ? `For ${label}: ${preference.rule}` : preference.rule;
}

export function renderPreferences(preferences: readonly ActivePreference[], maxChars: number): string {
	const header =
		"[exo memory: standing preferences from this user's earlier sessions. This request does not repeat them: follow them where they apply. If the request conflicts with one, the request wins.]";
	const lines: string[] = [];
	let length = header.length;
	for (const p of preferences) {
		const line = `- ${withKind(p)}${p.sessions > 1 ? ` (said in ${p.sessions} sessions)` : ""}`;
		if (length + line.length + 1 > maxChars) break;
		lines.push(line);
		length += line.length + 1;
	}
	return lines.length === 0 ? "" : `${header}\n${lines.join("\n")}`;
}

function squash(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}
