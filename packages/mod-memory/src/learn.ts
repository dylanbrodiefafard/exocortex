import { fenced, loadPrompt, SIDECAR_MAX_TOKENS, type ToolOutcome, ungroundedReferences } from "@exocortex/core";
import { Type } from "typebox";
import { refusalOf } from "./admission.ts";
import { MEMORY_ID, type MemoryDeps } from "./deps.ts";
import { createEpisodeTracker, editsOf, type FixEpisode } from "./episodes.ts";
import { sameProblem } from "./problem.ts";
import { embedCards } from "./recall.ts";
import type { Card } from "./store.ts";
import { clip, inert, oneLine } from "./text.ts";

const LESSON_PROMPT = loadPrompt(new URL("../prompts/lesson.v3.md", import.meta.url));

const LessonSchema = Type.Object({
	lesson: Type.String({ maxLength: 800 }),
	applies_when: Type.String({ maxLength: 200 }),
});

const LESSON_CHARS = 400;
/** Edited files named on a card. */
const MAX_CARD_FILES = 6;
/** Times the lesson sidecar is asked about one fix before the fix is let go. */
const MAX_LESSON_ATTEMPTS = 3;
/** Fixes kept waiting for a lesson; beyond this the oldest is let go. */
const MAX_WAITING = 8;

/** What came of asking for a lesson. */
type Lesson =
	| { readonly kind: "written"; readonly text: string; readonly distilled: boolean }
	/** The sidecar read the fix and found nothing worth remembering: no card, not even a deterministic one. */
	| { readonly kind: "not_reusable" }
	/** The sidecar did not answer: nothing has judged the fix yet. */
	| { readonly kind: "unanswered" };

/** An admitted episode with what a card is made of. */
interface Fix {
	readonly episode: FixEpisode;
	readonly repo: string;
	/** Every file edited on the route. */
	readonly files: readonly string[];
	readonly evidence: string;
}

interface Waiting {
	readonly episode: FixEpisode;
	attempts: number;
}

export interface Learner {
	/** Watches a tool result; a verified fix becomes a card in the background. */
	observe(tool: ToolOutcome): void;
	/** A new task: fixes are not followed across the user's messages. */
	reset(): void;
	/** The agent stopped: fixes whose lesson the sidecar did not deliver are asked about again. */
	settled(): void;
	/** Cards added by this instance. */
	learned(): number;
}

/**
 * Learning (D-049, D-072): a verified error→fix pair (same command fails, files change, it passes)
 * may become a card. The model proposes, code verifies (D-062):
 * - code refuses what it can see is not a fix (`admission.ts`);
 * - with a sidecar, the sidecar must have read the route and found the fix worth keeping. Until
 *   it answers there is no card: the fix waits for the next settle (M2). Only a lesson that was
 *   written and then failed the grounding check is replaced by the deterministic summary;
 * - without a sidecar (none configured, or `distill` off) the deterministic summary is the card.
 *
 * Fixing a known problem again with the same files merges into its card; with other files it
 * replaces the card (M4): what the card said was not what fixed it this time. Fixes are handled
 * one at a time, so two passes for one problem cannot both add a card.
 */
export function createLearner({ ctx, settings, store, scope }: MemoryDeps): Learner {
	const tracker = createEpisodeTracker({ cwd: ctx.cwd, minDetail: settings.minDetail });
	const waiting: Waiting[] = [];
	let queue: Promise<void> = Promise.resolve();
	let learned = 0;

	function enqueue(item: Waiting): void {
		queue = queue.then(() => learn(item)).catch((error: unknown) => ctx.log(`learning failed: ${String(error)}`));
	}

	function skipped(episode: FixEpisode, reason: string): void {
		ctx.record({ kind: "exo.memory", data: { action: "skipped", reason, signature: episode.signature } });
	}

	async function learn(item: Waiting): Promise<void> {
		const { episode } = item;
		const repo = await scope;
		if (!repo.known) return;
		const refusal = refusalOf(episode);
		if (refusal) return skipped(episode, refusal);
		const fix: Fix = {
			episode,
			repo: repo.id,
			files: [...new Set(editsOf(episode).map((e) => e.path))],
			evidence: evidenceOf(episode),
		};
		if (mergedIntoKnown(fix)) return;
		const lesson = await lessonFor(episode);
		if (lesson.kind === "not_reusable") return skipped(episode, "not_reusable");
		if (lesson.kind === "unanswered") return wait(item);
		// Read again: another session may have stored this problem while the sidecar was writing.
		if (mergedIntoKnown(fix)) return;
		await embedCards(ctx, store, [{ id: write(fix, lesson), trigger: episode.errorLine }]);
	}

	/** The live card for a fix's problem, and whether the fix is the one the card describes. */
	function known({ episode, repo, files }: Fix): { card: Card; sameFix: boolean } | undefined {
		const card = store
			.bySignature(episode.signature)
			.find((c) => c.scope === repo && sameProblem(c, episode, settings.minDetail));
		return card && { card, sameFix: card.files.some((file) => files.includes(file)) };
	}

	/** MERGE when the problem has a card whose files this fix touched again. */
	function mergedIntoKnown(fix: Fix): boolean {
		const found = known(fix);
		if (!found?.sameFix) return false;
		store.merge(found.card.id, fix.evidence);
		ctx.record({ kind: "exo.memory", data: { action: "merged", card: found.card.id } });
		return true;
	}

	/** Nothing has judged the fix yet: it is asked about again at the next settle, a few times. */
	function wait(item: Waiting): void {
		item.attempts += 1;
		const givenUp = item.attempts >= MAX_LESSON_ATTEMPTS;
		if (!givenUp) waiting.push(item);
		const dropped = givenUp ? item : waiting.length > MAX_WAITING ? waiting.shift() : undefined;
		if (dropped) skipped(dropped.episode, "no_lesson");
	}

	/** ADD, or SUPERSEDE the problem's card when this fix went through other files (M4). */
	function write(fix: Fix, lesson: { readonly text: string; readonly distilled: boolean }): number {
		const { episode } = fix;
		const replaced = known(fix)?.card;
		const card = {
			scope: fix.repo,
			signature: episode.signature,
			detail: episode.detail,
			files: fix.files.slice(0, MAX_CARD_FILES),
			trigger: episode.errorLine,
			lesson: inert(lesson.text),
			distilled: lesson.distilled,
			evidence: fix.evidence,
		};
		const id = replaced ? store.supersede(replaced.id, card) : store.add(card);
		learned += 1;
		ctx.record({
			kind: "exo.memory",
			data: {
				action: replaced ? "superseded" : "learned",
				card: id,
				...(replaced ? { replaces: replaced.id } : {}),
				signature: episode.signature,
				lesson: card.lesson,
			},
		});
		const retired = store.trim(fix.repo, settings.maxCardsPerRepo);
		if (retired > 0) ctx.record({ kind: "exo.memory", data: { action: "trimmed", retired } });
		return id;
	}

	async function lessonFor(episode: FixEpisode): Promise<Lesson> {
		const deterministic = { kind: "written", text: deterministicLesson(episode), distilled: false } as const;
		const pool = settings.distill ? ctx.pool() : undefined;
		if (!pool) return deterministic;
		const route = renderRoute(episode);
		const result = await pool.run({
			module: MEMORY_ID,
			priority: "background",
			timeoutMs: settings.distillTimeoutMs,
			schema: LessonSchema,
			schemaName: "lesson",
			request: {
				messages: [{ role: "user", content: LESSON_PROMPT.render({ command: episode.command, route }) }],
				maxTokens: SIDECAR_MAX_TOKENS,
				thinking: settings.thinking,
			},
		});
		if (!result.ok) {
			ctx.log(`lesson ${result.outcome}: ${result.error}`);
			return { kind: "unanswered" };
		}
		const lesson = result.value.lesson.trim();
		// The prompt asks for "" when the edits do not explain the pass, or teach nothing reusable.
		if (lesson === "") return { kind: "not_reusable" };
		// It judged the fix worth keeping but named things the route does not: keep the fix, not its words.
		if (ungroundedReferences(lesson, `${episode.command}\n${route}`, ctx.cwd).length > 0) return deterministic;
		const when = result.value.applies_when.trim();
		return {
			kind: "written",
			text: clip(when ? `${lesson} (when: ${when})` : lesson, LESSON_CHARS + 120),
			distilled: true,
		};
	}

	return {
		observe(tool) {
			for (const episode of tracker.observe(tool)) enqueue({ episode, attempts: 0 });
		},
		reset: () => tracker.reset(),
		settled() {
			for (const item of waiting.splice(0)) enqueue(item);
		},
		learned: () => learned,
	};
}

/**
 * The card's text when no sidecar wrote one: the files, and the change that was in place when the
 * command passed. A file that was written whole has no "before" to show, so only its name is given.
 */
export function deterministicLesson(episode: FixEpisode): string {
	const edits = editsOf(episode);
	const paths = [...new Set(edits.map((e) => e.path))];
	// The last edit is the one in place when the command passed.
	const last = edits.at(-1);
	if (edits.every((e) => e.before === REWRITTEN))
		return clip(`Fixed before by rewriting ${paths.join(", ")}`, LESSON_CHARS);
	const change = last && last.before !== REWRITTEN ? `: \`${oneLine(last.before)}\` → \`${oneLine(last.after)}\`` : "";
	return clip(`Fixed before by editing ${paths.join(", ")}${change}`, LESSON_CHARS);
}

/** What core's `fileEdits` gives as the "before" of a file written whole. */
const REWRITTEN = "(file rewritten)";

function evidenceOf(episode: FixEpisode): string {
	return JSON.stringify({ command: episode.command, error: episode.errorLine, edits: editsOf(episode).slice(-3) });
}

/**
 * The route from the error to the pass, as the lesson sidecar reads it. What came from the
 * session sits inside `<<<` … `>>>` and cannot close them (M8).
 */
function renderRoute(episode: FixEpisode): string {
	const parts = episode.steps.map((step, i) => {
		const edits = step.edits.map((e) => `${e.path}:\n- ${e.before}\n+ ${e.after}`).join("\n\n");
		const retries =
			step.retries > 0
				? `\n(The command failed with this same error ${step.retries} more time(s) during these edits.)`
				: "";
		const heading = i === 0 ? "The command failed:" : "The command then failed with a different error:";
		return `${i + 1}. ${heading}\n<<<\n${fenced(step.excerpt)}\n>>>\nEdits made next:\n<<<\n${fenced(edits)}\n>>>${retries}`;
	});
	const shell =
		episode.shell.length > 0
			? `\n\nOther commands run on the way, which may have changed files too:\n${episode.shell.map((line) => `- ${fenced(line)}`).join("\n")}`
			: "";
	return `${parts.join("\n\n")}${shell}\n\n${episode.steps.length + 1}. The command passed.`;
}
