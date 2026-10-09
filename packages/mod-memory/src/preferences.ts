import { ungroundedReferences } from "@exocortex/core";
import { keywords, type StoredPreference, type TaskKind } from "./store.ts";
import { inert } from "./text.ts";

/**
 * Preference cards (D-060): how the user likes work done, learned only from the user's own
 * words and added to later prompts that leave it unsaid. With D-064 a card may be an expectation
 * of one kind of task, and may come from a correction. Pure functions; the module wires them.
 *
 * Who decides what (D-090). Anything that is a reading of language is a sidecar's: whether the
 * user stated a preference, how long they mean it to hold, and how it stands with the preferences
 * already known. Code decides only what it can check exactly: that the quote is the user's words,
 * that the rule names nothing the message does not, and that a number the sidecar answers with
 * points at something it was shown. No word list reads the user's meaning.
 */

const MIN_QUOTE_CHARS = 8;
const MIN_RULE_CHARS = 8;
const MAX_RULE_CHARS = 200;
const QUOTE_CHARS = 300;
/** A prompt that already has this share of a rule's keywords speaks about it itself. */
const ALREADY_SAID_OVERLAP = 0.6;
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

/**
 * How long the user means a statement to hold, as the sidecar reads it:
 * - `standing`: a rule for future work;
 * - `task`: an instruction for this task, with nothing said beyond it;
 * - `exception`: how they normally want things, set aside for this task.
 */
export const HOLDS = ["standing", "task", "exception"] as const;
type Holds = (typeof HOLDS)[number];

/** What the extraction sidecar read in a message for one preference (`preferences.v4`). */
export interface ProposedPreference {
	readonly rule: string;
	readonly quote: string;
	readonly holds: Holds;
	/** The kind of task the rule is about, or `any`. */
	readonly applies_to: TaskKind;
	/** Whether the user said it to correct what the agent had just done. */
	readonly correction: boolean;
}

/** A preference the user stated, as admitted from a proposal. */
export interface Statement {
	readonly rule: string;
	/** The user's words, verbatim. */
	readonly quote: string;
	readonly standing: boolean;
	readonly kind: TaskKind;
	readonly correction: boolean;
}

/**
 * Why a proposal is not a statement:
 * - `not_said`: its quote is not in the message, so nothing shows the user said it;
 * - `exception`: the user set a preference aside for one task, which states nothing and withdraws nothing;
 * - `rule_length`: the rule is empty, a fragment, or longer than a rule;
 * - `ungrounded`: the rule names a file or symbol the message does not.
 */
export type Refusal = "not_said" | "exception" | "rule_length" | "ungrounded";

/**
 * The admission gate (D-060, D-090). The sidecar reads the message; this checks its reading
 * against the message, with tests that have one answer.
 */
export function admitStatement(
	proposal: ProposedPreference,
	message: string,
	cwd: string,
): { readonly statement: Statement } | { readonly refused: Refusal } {
	if (!saidVerbatim(message, proposal.quote)) return { refused: "not_said" };
	if (proposal.holds === "exception") return { refused: "exception" };
	const rule = inert(proposal.rule);
	if (rule.length < MIN_RULE_CHARS || rule.length > MAX_RULE_CHARS) return { refused: "rule_length" };
	if (ungroundedReferences(rule, message, cwd).length > 0) return { refused: "ungrounded" };
	return {
		statement: {
			rule,
			quote: squash(proposal.quote).slice(0, QUOTE_CHARS),
			standing: proposal.holds === "standing",
			kind: proposal.applies_to,
			correction: proposal.correction,
		},
	};
}

/** Whether `quote` is in `message` word for word; case and the width of white space do not count. */
export function saidVerbatim(message: string, quote: string): boolean {
	const needle = squash(quote).toLowerCase();
	return needle.length >= MIN_QUOTE_CHARS && squash(message).toLowerCase().includes(needle);
}

/** What the relation sidecar answered (`preference-relate.v1`): numbers, 1-based, into the list it was shown. */
export interface ProposedRelation {
	readonly same: number;
	readonly contradicts: readonly number[];
}

/** How a statement stands with the known preferences. */
export interface Relation {
	/** The known preference it states again. */
	readonly same: StoredPreference | undefined;
	/** Known preferences that cannot be followed together with it. */
	readonly contradicts: readonly StoredPreference[];
}

export const UNRELATED: Relation = { same: undefined, contradicts: [] };

/**
 * The sidecar's answer as a relation (D-090). A number counts only when it points at a preference
 * that was shown. One named both the same and contradicted is neither: the answer disagrees with
 * itself about it, and a rule and its opposite are never one preference (M7).
 */
export function admitRelation(proposal: ProposedRelation, shown: readonly StoredPreference[]): Relation {
	const against = new Set(proposal.contradicts);
	return {
		same: against.has(proposal.same) ? undefined : shown[proposal.same - 1],
		contradicts: [...against].filter((n) => n !== proposal.same).flatMap((n) => shown[n - 1] ?? []),
	};
}

/**
 * The known preferences a stated rule is compared with: all of them while they fit in `max`,
 * otherwise the `max` nearest to the rule. This only chooses what the sidecar is shown; it decides
 * nothing about the rule. Nearest is by `similarity` (an embedding model's, D-062) when there is
 * one, else by shared keywords; the later preference wins a tie. Returned oldest first.
 */
export function nearestPreferences(
	rule: string,
	live: readonly StoredPreference[],
	max: number,
	similarity?: (preference: StoredPreference) => number | undefined,
): StoredPreference[] {
	if (live.length <= max) return [...live];
	const words = new Set(keywords(rule));
	const shared = (preference: StoredPreference) => {
		const other = keywords(preference.rule);
		const union = new Set([...words, ...other]).size;
		return union === 0 ? 0 : other.filter((word) => words.has(word)).length / union;
	};
	return live
		.map((preference) => ({ preference, score: similarity?.(preference) ?? shared(preference) }))
		.sort((a, b) => b.score - a.score || b.preference.id - a.preference.id)
		.slice(0, max)
		.map((scored) => scored.preference)
		.sort((a, b) => a.id - b.id);
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
 * Whether the prompt speaks about what the rule is about: it carries most of the rule's keywords.
 * The rule is then left out, whichever way the prompt puts it: said the same way it would only
 * repeat the user, and said the other way the request wins. This is the fallback for when no
 * sidecar picks the preferences (`preference-select`), which reads the request properly.
 */
export function alreadySaid(prompt: string, rule: string): boolean {
	const words = keywords(rule);
	if (words.length === 0) return true;
	const said = new Set(keywords(prompt));
	return words.filter((word) => said.has(word)).length / words.length >= ALREADY_SAID_OVERLAP;
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
