import { ungroundedReferences } from "@exocortex/core";
import { keywords, type StoredPreference, type TaskKind } from "./store.ts";
import { inert } from "./text.ts";

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
/**
 * Words that turn a rule into its opposite (M7). "Use tabs" and "Never use tabs" share every other
 * word, so a rule's polarity is read apart from what it is about.
 */
const NEGATION = /\b(not|never|no|avoid|stop|refrain|cannot|dont|doesnt)\b|n['’]t\b/i;
const NEGATION_WORDS: ReadonlySet<string> = new Set([
	...["not", "never", "avoid", "stop", "refrain", "cannot", "dont", "doesnt"],
	// What `keywords` leaves of "don't", "doesn't", "won't", "shouldn't", "isn't".
	...["don", "doesn", "won", "shouldn", "isn", "aren", "mustn", "wouldn", "couldn"],
]);
/** Words rules share without being about the same thing: no evidence that one replaces another. */
const RULE_FILLER: ReadonlySet<string> = new Set([
	...["use", "using", "always", "should", "must", "please", "want", "like", "prefer", "make", "sure", "when", "you"],
	...["your", "code", "now", "all", "any", "each", "every", "keep", "more", "less", "actually", "instead", "anymore"],
]);
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
 * - `same_as` and `replaces` count only when they point at a preference that was shown;
 * - `replaces` retires a preference only when the user's sentence or the new rule is about it
 *   (M6): they share a word that carries meaning, or the embedding model found it nearest;
 * - a rule and its opposite are never the same preference, whoever says so (M7).
 *
 * `live` is every live preference; `shownToSidecar` is the part of them the sidecar saw.
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
	const rule = inert(proposal.rule);
	const pointedAt = isLive(shownToSidecar[proposal.replaces - 1]);
	const replaced =
		pointedAt && (similar?.id === pointedAt.id || isAbout(`${sentence} ${rule}`, pointedAt.rule))
			? pointedAt
			: undefined;
	const retire = replaced ? { retire: replaced.id } : {};
	if (rule.length < MIN_RULE_CHARS || rule.length > MAX_RULE_CHARS) return retire;
	if (ungroundedReferences(rule, message, cwd).length > 0) return retire;
	const others = live.filter((p) => p.id !== replaced?.id);
	const same = proposal.same_as === proposal.replaces ? undefined : isLive(shownToSidecar[proposal.same_as - 1]);
	const notReplaced = (p: StoredPreference | undefined) => (p && p.id !== replaced?.id ? p : undefined);
	const agrees = (p: StoredPreference | undefined) => (p && isNegative(p.rule) === isNegative(rule) ? p : undefined);
	const existing = notReplaced(agrees(same)) ?? notReplaced(agrees(isLive(similar))) ?? sameRule(rule, others);
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

/** Whether a rule (or a sentence) says not to do something. */
function isNegative(text: string): boolean {
	return NEGATION.test(text);
}

/** What a rule is about: its keywords without the words that only make it a "do" or a "don't". */
function topic(rule: string): string[] {
	return keywords(rule).filter((word) => !NEGATION_WORDS.has(word));
}

/** A word without its common endings, so "tests" meets "test" and "writing" meets "write". */
function stem(word: string): string {
	const cut = word.replace(/(ing|ed|es|s|e)$/, "");
	return cut.length >= 3 ? cut : word;
}

/** Whether `text` speaks about what `rule` is about: they share a word that is not filler. */
function isAbout(text: string, rule: string): boolean {
	const stems = (value: string) =>
		topic(value)
			.filter((word) => !RULE_FILLER.has(word))
			.map(stem);
	const said = new Set(stems(text));
	return stems(rule).some((word) => said.has(word));
}

/**
 * The live preference whose rule shares most of its words with `rule`, if any is close enough and
 * says it the same way round: a rule and its negation are two preferences (M7).
 */
export function sameRule(rule: string, live: readonly StoredPreference[]): StoredPreference | undefined {
	const words = new Set(topic(rule));
	const negative = isNegative(rule);
	let best: { preference: StoredPreference; similarity: number } | undefined;
	for (const preference of live) {
		if (isNegative(preference.rule) !== negative) continue;
		const other = new Set(topic(preference.rule));
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
 * - stated it in 2+ repos (D-018's promotion: it is about the user, not the repo); or
 * - chose it in the interview (D-066): asked about their work in general, so it applies in every repo.
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
			new Set(preference.sightings.map((s) => s.scope)).size >= 2 ||
			preference.sightings.some((s) => s.source === "interview");
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

/**
 * Whether the prompt states the rule itself: then adding it would only repeat the user. A prompt
 * that says the opposite ("don't add comments" for "Add comments") does not state it (M7): the
 * rule is then added, under a header that says the request wins.
 */
export function alreadySaid(prompt: string, rule: string): boolean {
	const ruleWords = topic(rule);
	if (ruleWords.length === 0) return true;
	const promptWords = new Set(keywords(prompt));
	if (ruleWords.filter((w) => promptWords.has(w)).length / ruleWords.length < ALREADY_SAID_OVERLAP) return false;
	// The sentence that carries most of the rule's words is the one that speaks about it.
	let about = { sentence: prompt, shared: 0 };
	for (const sentence of prompt.split(/(?<=[.!?;])\s+|\n+/)) {
		const words = new Set(keywords(sentence));
		const shared = ruleWords.filter((w) => words.has(w)).length;
		if (shared > about.shared) about = { sentence, shared };
	}
	return isNegative(about.sentence) === isNegative(rule);
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
