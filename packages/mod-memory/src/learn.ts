import {
	fenced,
	isFileReference,
	loadPrompt,
	SIDECAR_MAX_TOKENS,
	type SidecarPool,
	type ToolOutcome,
	ungroundedReferences,
} from "@exocortex/core";
import { Type } from "typebox";
import { refusalOf } from "./admission.ts";
import { MEMORY_ID, type MemoryDeps } from "./deps.ts";
import { createEpisodeTracker, editsOf, type FixEpisode } from "./episodes.ts";
import { sameProblem } from "./problem.ts";
import { embedCards } from "./recall.ts";
import type { Card } from "./store.ts";
import { clip, inert } from "./text.ts";

const LESSON_PROMPT = loadPrompt(new URL("../prompts/lesson.v4.md", import.meta.url));

const LessonSchema = Type.Object({
	lesson: Type.String({ maxLength: 800 }),
	applies_when: Type.String({ maxLength: 200 }),
});

const LESSON_CHARS = 400;
/** How long a lesson's name is searched for in the repo (`git grep`). */
const GREP_TIMEOUT_MS = 2_000;
/** Edited files named on a card. */
const MAX_CARD_FILES = 6;
/** Times the lesson sidecar is asked about one fix before the fix is let go. */
const MAX_LESSON_ATTEMPTS = 3;
/** Fixes kept waiting for a lesson; beyond this the oldest is let go. */
const MAX_WAITING = 8;

/** What came of asking for a lesson. */
type Lesson =
	/** `ungrounded`: names the lesson gave in backticks that neither the route nor the repo has; shown plain. */
	| { readonly kind: "written"; readonly text: string; readonly ungrounded: readonly string[] }
	/** The sidecar read the fix and found nothing worth remembering: no card. */
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
	/** Cards recalled in this session that the same pass showed to have helped (D-109). */
	readonly helped: readonly number[];
	attempts: number;
}

export interface Learner {
	/**
	 * Watches a tool result; a verified fix becomes a card in the background. `helped`: the cards
	 * recalled in this session that this result showed to have helped.
	 */
	observe(tool: ToolOutcome, helped?: readonly number[]): void;
	/** The agent stopped: fixes whose lesson the sidecar did not deliver are asked about again. */
	settled(): void;
	/** Cards added by this instance. */
	learned(): number;
}

/**
 * Learning (D-049, D-072, D-109): a verified error→fix pair (a run fails, files change, a run of
 * the same runner that covers it passes) may become a card. The model proposes, code verifies (D-062):
 * - code refuses what it can see is not a fix (`admission.ts`);
 * - the lesson sidecar must have read the route and found the fix worth keeping. Until it answers
 *   there is no card: the fix waits for the next settle (M2). A lesson that names, in backticks,
 *   something neither the route nor the repo has is kept with those names as plain words;
 * - without a sidecar engine nothing is learned: a fix nobody judged is not worth a card.
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
	let toldNoEngine = false;

	function enqueue(item: Waiting): void {
		queue = queue.then(() => learn(item)).catch((error: unknown) => ctx.log(`learning failed: ${String(error)}`));
	}

	function skipped(episode: FixEpisode, reason: string): void {
		ctx.record({ kind: "exo.memory", data: { action: "skipped", reason, signature: episode.signature } });
	}

	async function learn(item: Waiting): Promise<void> {
		const { episode } = item;
		const repo = await scope();
		// Said once at session start (`memory.ts`); a guessed repo name would put the card in the wrong place.
		if (!repo.known) return skipped(episode, "scope_unknown");
		const refusal = refusalOf(episode);
		if (refusal) return skipped(episode, refusal);
		const fix: Fix = {
			episode,
			repo: repo.id,
			files: [...new Set(editsOf(episode).map((e) => e.path))],
			evidence: evidenceOf(episode),
		};
		if (mergedIntoRecalled(fix, item.helped) || mergedIntoKnown(fix)) return;
		const pool = ctx.pool();
		if (!pool) {
			if (!toldNoEngine) ctx.log("no sidecar engine: fixes are not learned (a lesson needs a model to judge it)");
			toldNoEngine = true;
			return skipped(episode, "no_engine");
		}
		const lesson = await lessonFor(pool, episode);
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

	/**
	 * MERGE into a card recalled for this failure when the pass that ended the fix showed the card
	 * helped (D-109): the agent applied the card, and this is its fix again. The card may be keyed
	 * on another line of the failure than this episode, so `known` would not find it.
	 */
	function mergedIntoRecalled(fix: Fix, helped: readonly number[]): boolean {
		const card = helped
			.map((id) => store.card(id))
			.find((c) => c?.validTo === null && c.scope === fix.repo && c.files.some((file) => fix.files.includes(file)));
		if (!card) return false;
		store.merge(card.id, fix.evidence);
		ctx.record({ kind: "exo.memory", data: { action: "merged", card: card.id, recalled: true } });
		return true;
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
	function write(fix: Fix, lesson: { readonly text: string; readonly ungrounded: readonly string[] }): number {
		const { episode } = fix;
		const replaced = known(fix)?.card;
		const card = {
			scope: fix.repo,
			signature: episode.signature,
			detail: episode.detail,
			files: fix.files.slice(0, MAX_CARD_FILES),
			trigger: episode.errorLine,
			lesson: inert(lesson.text),
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
				...(lesson.ungrounded.length > 0 ? { ungrounded: [...lesson.ungrounded] } : {}),
			},
		});
		const retired = store.trim(fix.repo, settings.maxCardsPerRepo);
		if (retired > 0) ctx.record({ kind: "exo.memory", data: { action: "trimmed", retired } });
		return id;
	}

	/**
	 * Names in a lesson that neither its evidence nor the repo has (the guidance gate, R3.5). A path
	 * must exist; a code name is searched for in the repo's files (`git grep`, bounded), since the
	 * fix may well use a name its route does not show. One that cannot be searched for is let through.
	 */
	async function unknownNames(lesson: string, evidence: string): Promise<string[]> {
		const unknown: string[] = [];
		for (const ref of ungroundedReferences(lesson, evidence, ctx.cwd)) {
			if (isFileReference(ref) || !(await inRepo(ref))) unknown.push(ref);
		}
		return unknown;
	}

	async function inRepo(ref: string): Promise<boolean> {
		const name = bareName(ref);
		if (!/^[A-Za-z_~$][\w$]{2,}$/.test(name)) return true;
		const found = await ctx
			.runCommand(`git grep -qF --untracked -e '${name}'`, { timeoutMs: GREP_TIMEOUT_MS })
			.catch(() => undefined);
		// 1 is "not found"; anything else (not a repository, a timeout) cannot tell.
		return found?.exitCode !== 1;
	}

	async function lessonFor(pool: SidecarPool, episode: FixEpisode): Promise<Lesson> {
		const route = renderRoute(episode);
		const result = await pool.run({
			module: MEMORY_ID,
			kind: "judge",
			priority: "background",
			// No deadline: nobody waits for a lesson. It ends when written or the engine stops answering (D-098).
			schema: LessonSchema,
			schemaName: "lesson",
			request: {
				messages: [{ role: "user", content: LESSON_PROMPT.render({ command: episode.command, route }) }],
				maxTokens: SIDECAR_MAX_TOKENS,
			},
		});
		if (!result.ok) {
			ctx.log(`lesson ${result.outcome}: ${result.error}`);
			return { kind: "unanswered" };
		}
		const written = result.value.lesson.trim();
		// The prompt asks for "" when the edits do not explain the pass, or teach nothing reusable.
		if (written === "") return { kind: "not_reusable" };
		// It judged the fix worth keeping but named, as code, things the route does not show: the
		// judgment stands, and those names are kept as plain words, not as if they were in the code.
		const ungrounded = await unknownNames(written, `${episode.command}\n${route}`);
		const lesson = ungrounded.reduce((text, name) => text.replaceAll(`\`${name}\``, name), written);
		const when = result.value.applies_when.trim();
		return {
			kind: "written",
			text: clip(when ? `${lesson} (when: ${when})` : lesson, LESSON_CHARS + 120),
			ungrounded,
		};
	}

	return {
		observe(tool, helped = []) {
			for (const episode of tracker.observe(tool)) enqueue({ episode, helped, attempts: 0 });
		},
		settled() {
			for (const item of waiting.splice(0)) enqueue(item);
		},
		learned: () => learned,
	};
}

function evidenceOf(episode: FixEpisode): string {
	return JSON.stringify({
		command: episode.command,
		pass: episode.passCommand,
		error: episode.errorLine,
		edits: editsOf(episode).slice(-3),
		deadEnds: episode.deadEnds,
	});
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
				? `\n(The run failed with this same error ${step.retries} more time(s) during these edits.)`
				: "";
		const heading = i === 0 ? "The run failed:" : "The run then failed with a different error:";
		return `${i + 1}. ${heading}\n<<<\n${fenced(step.excerpt)}\n>>>\nEdits made next:\n<<<\n${fenced(edits)}\n>>>${retries}`;
	});
	const shell =
		episode.shell.length > 0
			? `\n\nOther commands run on the way (marked when their words say they changed files of the repo):\n${episode.shell.map(({ line, changes }) => `- ${fenced(line)}${changes ? " (changed files)" : ""}`).join("\n")}`
			: "";
	return `${parts.join("\n\n")}${shell}\n\n${episode.steps.length + 1}. Then this run passed: ${fenced(episode.passCommand)}`;
}

/** A code name without what prose adds to it (`()`, `:12`, `<T>`) and without its owner (`a::b`, `a.b`). */
function bareName(ref: string): string {
	let name = ref;
	for (const suffix of [/\(\)$/, /(:\d+)+$/, /<[^<>]*>$/, /::$/]) name = name.replace(suffix, "");
	return name.split(/::|\.|->/).at(-1) ?? name;
}
