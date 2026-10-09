import type { Dialog } from "@exocortex/core";
import type { MemoryDeps } from "./deps.ts";
import type { PreferenceSession } from "./preference-session.ts";
import type { TaskKind } from "./store.ts";

/**
 * The interview (D-066): a few questions that seed preference cards on a new install, so the
 * user does not wait for two sessions of corrections before anything applies.
 * - Each option carries a rule written here, so no model reads the answer or words the card.
 * - Expectations that are hard to state in the abstract are asked as a situation to decide;
 *   habits people can state readily are asked directly.
 * - "No preference" stores nothing.
 */

interface InterviewOption {
	readonly label: string;
	/** The card this answer stores; none for "no preference". */
	readonly rule?: string;
	readonly kind?: TaskKind;
}

interface InterviewQuestion {
	readonly ask: string;
	readonly options: readonly InterviewOption[];
}

const NO_PREFERENCE: InterviewOption = { label: "No preference" };

export const INTERVIEW: readonly InterviewQuestion[] = [
	{
		ask: "You ask for a bug fix. While fixing it, the agent sees that the function next to it is messy and has a second, unrelated bug. What should it do?",
		options: [
			{
				label: "Fix only what I asked for, and tell me about the rest",
				rule: "Change only what the fix needs. Report other problems you notice instead of fixing them.",
				kind: "fix",
			},
			{
				label: "Fix the second bug too, but leave the mess",
				rule: "Also fix other bugs you find in the code you are changing, and say that you did. Do not refactor it.",
				kind: "fix",
			},
			{
				label: "Fix both and clean the function up",
				rule: "Fix and tidy the code around the bug as well, and say what you changed beyond the request.",
				kind: "fix",
			},
			NO_PREFERENCE,
		],
	},
	{
		ask: "The agent is about to fix a bug. The existing tests pass, so none of them covers it. What should happen with tests?",
		options: [
			{
				label: "Write a failing test first, then fix",
				rule: "Write a failing test that reproduces the bug before changing the code.",
				kind: "fix",
			},
			{
				label: "Fix it, then add a regression test",
				rule: "Add a regression test that fails without the fix.",
				kind: "fix",
			},
			{ label: "Add no tests unless I ask", rule: "Do not add tests unless asked.", kind: "any" },
			NO_PREFERENCE,
		],
	},
	{
		ask: "You ask for a feature, and the request leaves a choice open that the code cannot answer, such as what to do on invalid input. What should the agent do?",
		options: [
			{
				label: "Stop and ask me",
				rule: "When a request leaves open a choice the code cannot answer, ask before building.",
				kind: "any",
			},
			{
				label: "Pick the most reasonable option and tell me what it assumed",
				rule: "When a request leaves a choice open, pick the most reasonable option, keep going, and list your assumptions at the end.",
				kind: "any",
			},
			NO_PREFERENCE,
		],
	},
	{
		ask: "The agent has made the change you asked for, and the repo's full checks take a few minutes. When may it say the work is done?",
		options: [
			{
				label: "After the repo's tests and checks pass",
				rule: "Before saying a change is done, run the repo's tests and checks and report the result.",
				kind: "any",
			},
			{
				label: "After the tests for what it changed pass",
				rule: "Before saying a change is done, run the tests that cover what changed and report the result.",
				kind: "any",
			},
			{
				label: "Right away: I run the checks myself",
				rule: "Do not run the test suite unless asked. Say what you did not verify.",
				kind: "any",
			},
			NO_PREFERENCE,
		],
	},
	{
		ask: "A feature would be quicker to build with a library the project does not use yet. What should the agent do?",
		options: [
			{
				label: "Ask me before adding any dependency",
				rule: "Do not add a new dependency without asking first.",
				kind: "any",
			},
			{
				label: "Add it if it is well known, and tell me",
				rule: "You may add a well-known dependency when it clearly saves work. Say which one and why.",
				kind: "any",
			},
			{
				label: "Build it without the library",
				rule: "Do not add dependencies. Build with what the project already uses.",
				kind: "any",
			},
			NO_PREFERENCE,
		],
	},
	{
		ask: "When a change is finished, should the agent commit it?",
		options: [
			{
				label: "No, I commit myself",
				rule: "Do not commit. Leave the changes in the working tree.",
				kind: "any",
			},
			{
				label: "Yes, in small commits",
				rule: "Commit finished work in small commits, one change each, with a clear message.",
				kind: "any",
			},
			NO_PREFERENCE,
		],
	},
	{
		ask: "How should the agent report back when it has finished a task?",
		options: [
			{
				label: "A few lines: what changed and what I should check",
				rule: "Report back in a few lines: what changed and what to check.",
				kind: "any",
			},
			{
				label: "A walkthrough of each change and the reason for it",
				rule: "Report back with a walkthrough of each change and the reason for it.",
				kind: "any",
			},
			NO_PREFERENCE,
		],
	},
	{
		ask: "You ask a question about the code, without asking for a change. How should the agent answer?",
		options: [
			{
				label: "The answer first, in brief; I will ask for more",
				rule: "Answer the question first and briefly. Add detail only when asked.",
				kind: "explain",
			},
			{
				label: "A thorough explanation with the files and lines it rests on",
				rule: "Explain thoroughly and cite the files and lines the answer rests on.",
				kind: "explain",
			},
			NO_PREFERENCE,
		],
	},
];

/** The open question at the end; its answer goes through the same admission as a typed message. */
export const INTERVIEW_OPEN_QUESTION = "Anything else the agent should always or never do?";

export interface InterviewResult {
	/** The questions the user answered, in order, with the option they picked. */
	readonly answers: readonly { readonly question: InterviewQuestion; readonly option: InterviewOption }[];
	/** What the user typed for the open question; empty when they skipped it. */
	readonly more: string;
	/** The user cancelled before the last question: the answers so far still count. */
	readonly cancelled: boolean;
}

/** Asks every question in turn; cancelling one ends the interview and keeps the earlier answers. */
export async function runInterview(dialog: Dialog, questions: readonly InterviewQuestion[]): Promise<InterviewResult> {
	const answers: { question: InterviewQuestion; option: InterviewOption }[] = [];
	for (const [index, question] of questions.entries()) {
		const picked = await dialog.select(
			`Question ${index + 1} of ${questions.length + 1}\n${question.ask}`,
			question.options.map((o) => o.label),
		);
		const option = question.options.find((o) => o.label === picked);
		if (!option) return { answers, more: "", cancelled: true };
		answers.push({ question, option });
	}
	const more = await dialog.input(
		`Question ${questions.length + 1} of ${questions.length + 1}\n${INTERVIEW_OPEN_QUESTION}`,
		"Enter to skip",
	);
	return { answers, more: more?.trim() ?? "", cancelled: more === undefined };
}

const INTERVIEW_QUOTE_CHARS = 300;

/**
 * `/exo memory interview` (D-066): asks the questions, then stores each answer as a preference
 * that applies in every repo. Only ever started by the user.
 */
export async function interview(
	dialog: Dialog | undefined,
	{ ctx, settings, store, scope }: MemoryDeps,
	preferences: PreferenceSession,
): Promise<string> {
	if (!settings.preferences) return "Preference learning is off (memory.preferences): turn it on first.";
	if (!dialog) return "The interview needs an interactive session.";
	const result = await runInterview(dialog, INTERVIEW);
	// An answer is about the user's work in general: it applies in every repo, named or not.
	const repo = (await scope).id;
	const before = new Set(store.preferences().map((p) => p.id));
	for (const { question, option } of result.answers) applyAnswer(question, option, repo);
	let unread = false;
	if (result.more !== "") {
		if (ctx.pool()) {
			dialog.notify("Reading your last answer…");
			await preferences.learn(result.more, "", "interview");
		} else unread = true;
	}
	const after = store.preferences();
	const added = after.filter((p) => !before.has(p.id)).length;
	const retired = [...before].filter((id) => !after.some((p) => p.id === id)).length;
	ctx.record({
		kind: "exo.memory",
		data: { action: "interview", answered: result.answers.length, added, retired, cancelled: result.cancelled },
	});
	const saved = after.filter((p) =>
		p.sightings.some((s) => s.source === "interview" && s.session === preferences.session),
	);
	return [
		result.cancelled ? "Interview stopped early; the answers so far are kept." : "Interview finished.",
		saved.length === 0
			? "No preferences were saved."
			: `Preferences saved: ${saved.length} (${added} new). They apply in every repo, starting with your next prompt.`,
		...(unread ? ["Your last answer was not read: that needs a sidecar engine."] : []),
		"/exo memory preferences lists them; /exo memory forget <id> removes one.",
	].join(" ");

	/**
	 * Stores one interview answer. The latest answer to a question is the answer: whatever another
	 * option of the same question stored earlier is retired, also when the user now has no preference.
	 */
	function applyAnswer(question: InterviewQuestion, option: InterviewOption, repo: string): void {
		const others = new Set(question.options.filter((o) => o !== option).map((o) => o.rule));
		for (const earlier of store.preferences().filter((p) => others.has(p.rule))) {
			preferences.retire(earlier.id, "interview");
		}
		if (option.rule === undefined) return;
		// The rules are written here, so an answer given before is found by its text. No model is asked.
		const same = store.preferences().find((p) => p.rule === option.rule);
		preferences.stated(
			{
				rule: option.rule,
				quote: `${question.ask} → ${option.label}`.slice(0, INTERVIEW_QUOTE_CHARS),
				standing: true,
				kind: option.kind ?? "any",
				correction: false,
			},
			{ same, contradicts: [] },
			repo,
			"interview",
		);
	}
}
