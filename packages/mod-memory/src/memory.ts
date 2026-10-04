import {
	type ExoModule,
	errorSignature,
	firstErrorLine,
	loadPrompt,
	type ModuleContext,
	type ToolOutcome,
	ungroundedReferences,
} from "@exocortex/core";
import { Type } from "typebox";
import { createEpisodeTracker, type FixEpisode } from "./episodes.ts";
import { type MemorySettings, parseSettings } from "./settings.ts";
import { type Card, type MemoryStore, openMemoryStore } from "./store.ts";

export const MEMORY_ID = "memory";

const LESSON_PROMPT = loadPrompt(new URL("../prompts/lesson.v1.md", import.meta.url));

const LessonSchema = Type.Object({
	lesson: Type.String({ maxLength: 600 }),
	applies_when: Type.String({ maxLength: 200 }),
});

const LESSON_CHARS = 300;
const GIT_TIMEOUT_MS = 5_000;

/** Stores stay open for the process: modules are rebuilt on `/exo` toggles. */
const stores = new Map<string, MemoryStore>();

interface TaskState {
	/** Card id → the signature it was injected for. */
	readonly injected: Map<number, string>;
	readonly hurt: Set<number>;
	readonly credited: Set<number>;
}

/**
 * Memory, Phase 5 v1 (brief §6.4 narrowed by research R5.1–R5.5): pitfall cards only.
 * - Learn: a verified error→fix pair (same command fails, files change, it passes) becomes a card,
 *   phrased by a background sidecar (grounded) or summarized deterministically.
 * - Recall: a failing tool result whose signature (or error keywords) matches a card gets the
 *   lesson appended, within ~400 tokens. No LLM on the hot path.
 * - Utility: a card is credited `helped` when its error does not recur in the task, `hurt` when it
 *   does; cards that hurt more than they help retire. Cards are superseded, never deleted.
 */
export function createMemory(raw: Readonly<Record<string, unknown>>, ctx: ModuleContext): ExoModule {
	const { settings, problems } = parseSettings(raw);
	for (const problem of problems) ctx.log(problem);
	const store = storeFor(settings.dbPath);
	const scope = repoScope(ctx);
	const tracker = createEpisodeTracker();
	let task = newTask();
	let learned = 0;
	let recalled = 0;

	function finishTask(): void {
		for (const id of task.injected.keys()) {
			if (task.credited.has(id) || task.hurt.has(id)) continue;
			store.credit(id, "helped");
			task.credited.add(id);
		}
		store.retireUnhelpful();
	}

	return {
		id: MEMORY_ID,

		onUserTurn(turn) {
			if (turn.origin !== "user") return;
			finishTask();
			task = newTask();
			tracker.reset();
		},

		onToolResult(tool) {
			const signature = failureSignature(tool);
			if (signature) {
				for (const [id, injectedFor] of task.injected) {
					if (injectedFor === signature && !task.hurt.has(id)) {
						task.hurt.add(id);
						store.credit(id, "hurt");
					}
				}
			}
			const episode = settings.learn ? tracker.observe(tool) : undefined;
			if (episode) {
				learn(episode).catch((error: unknown) => ctx.log(`learning failed: ${String(error)}`));
			}
		},

		async rewriteToolResult(draft) {
			const signature = failureSignature(draft);
			if (!settings.inject || !signature) return undefined;
			const cards = recall(store, await scope, signature, draft.output, settings).filter(
				(c) => !task.injected.has(c.id),
			);
			if (cards.length === 0) return undefined;
			for (const card of cards) {
				task.injected.set(card.id, signature);
				store.markInjected(card.id);
			}
			recalled += cards.length;
			ctx.record({ kind: "exo.memory", data: { action: "recalled", cards: cards.map((c) => c.id), signature } });
			return {
				text: `${draft.current}\n${renderCards(cards, settings.maxInjectChars)}`,
				note: `recalled ${cards.length} card(s)`,
			};
		},

		async onSettle(info) {
			if (info.outcome === "completed") finishTask();
			return undefined;
		},

		status() {
			return `${MEMORY_ID} (${store.cards().filter((c) => c.validTo === null).length} cards · ${learned} learned · ${recalled} recalled)`;
		},
	};

	async function learn(episode: FixEpisode): Promise<void> {
		const repo = await scope;
		const existing = store.bySignature(repo, episode.signature).find((c) => c.scope === repo);
		const evidence = evidenceOf(episode);
		if (existing) {
			store.upsert({
				scope: repo,
				signature: episode.signature,
				trigger: episode.errorLine,
				lesson: existing.lesson,
				evidence,
			});
			ctx.record({ kind: "exo.memory", data: { action: "merged", card: existing.id } });
			return;
		}
		const lesson = (settings.distill ? await distill(episode) : undefined) ?? deterministicLesson(episode);
		const { id } = store.upsert({
			scope: repo,
			signature: episode.signature,
			trigger: episode.errorLine,
			lesson,
			evidence,
		});
		learned += 1;
		ctx.record({ kind: "exo.memory", data: { action: "learned", card: id, signature: episode.signature, lesson } });
	}

	async function distill(episode: FixEpisode): Promise<string | undefined> {
		const pool = ctx.pool();
		if (!pool) return undefined;
		const result = await pool.run({
			module: MEMORY_ID,
			priority: "background",
			timeoutMs: settings.distillTimeoutMs,
			schema: LessonSchema,
			schemaName: "lesson",
			request: {
				messages: [
					{
						role: "user",
						content: LESSON_PROMPT.render({
							command: episode.command,
							excerpt: episode.excerpt,
							edits: renderEdits(episode),
						}),
					},
				],
				maxTokens: 300,
				thinking: settings.thinking,
			},
		});
		if (!result.ok) {
			ctx.log(`lesson ${result.outcome}: ${result.error}`);
			return undefined;
		}
		const lesson = result.value.lesson.trim();
		if (lesson === "") return undefined;
		const evidence = `${episode.command}\n${episode.excerpt}\n${renderEdits(episode)}`;
		if (ungroundedReferences(lesson, evidence, ctx.cwd).length > 0) return undefined;
		const when = result.value.applies_when.trim();
		return clip(when ? `${lesson} (when: ${when})` : lesson, LESSON_CHARS + 120);
	}
}

/** Exact signature first; otherwise cards whose trigger shares most of this error's keywords. */
export function recall(
	store: MemoryStore,
	scope: string,
	signature: string,
	output: string,
	settings: Pick<MemorySettings, "maxCards" | "minOverlap">,
): Card[] {
	const exact = store.bySignature(scope, signature);
	if (exact.length > 0) return rank(exact).slice(0, settings.maxCards);
	const line = firstErrorLine(output)?.line;
	if (!line) return [];
	return rank(
		store
			.search(scope, line, settings.maxCards * 2)
			.filter((m) => m.overlap >= settings.minOverlap)
			.map((m) => m.card),
	).slice(0, settings.maxCards);
}

/** Proven cards first: helped − hurt, then how often the lesson was seen. */
function rank(cards: readonly Card[]): Card[] {
	return [...cards].sort((a, b) => b.helped - b.hurt - (a.helped - a.hurt) || b.seen - a.seen);
}

export function renderCards(cards: readonly Card[], maxChars: number): string {
	const lines = cards.map((c) => `- ${c.lesson}${c.seen > 1 ? ` (seen ${c.seen}×)` : ""}`);
	const text = `[exo memory: this error was fixed before in this repo]\n${lines.join("\n")}`;
	return clip(text, maxChars);
}

export function deterministicLesson(episode: FixEpisode): string {
	const paths = [...new Set(episode.edits.map((e) => e.path))];
	const first = episode.edits[0];
	const change = first ? `: \`${oneLine(first.before)}\` → \`${oneLine(first.after)}\`` : "";
	return clip(`Fixed before by editing ${paths.join(", ")}${change}`, LESSON_CHARS);
}

function failureSignature(tool: ToolOutcome): string | undefined {
	const failed = tool.isError || (tool.exitCode !== null && tool.exitCode !== 0);
	if (!failed || typeof tool.input["command"] !== "string") return undefined;
	return errorSignature(tool.toolName, tool.exitCode, tool.output);
}

function evidenceOf(episode: FixEpisode): string {
	return JSON.stringify({ command: episode.command, error: episode.errorLine, edits: episode.edits.slice(0, 3) });
}

function renderEdits(episode: FixEpisode): string {
	return episode.edits.map((e) => `${e.path}:\n- ${e.before}\n+ ${e.after}`).join("\n\n");
}

/** Repo identity (D-018): the origin remote, else the root commit's tree (stable across copies), else the path. */
async function repoScope(ctx: ModuleContext): Promise<string> {
	const run = async (command: string) => {
		const out = await ctx.runCommand(command, { timeoutMs: GIT_TIMEOUT_MS }).catch(() => undefined);
		return out?.exitCode === 0 ? out.outputTail.trim() : "";
	};
	const remote = await run("git remote get-url origin 2>/dev/null");
	if (remote) return `remote:${remote}`;
	const tree = await run('git rev-parse "$(git rev-list --max-parents=0 HEAD | tail -n 1)^{tree}" 2>/dev/null');
	if (tree) return `tree:${tree}`;
	return `path:${ctx.cwd}`;
}

function storeFor(path: string): MemoryStore {
	const existing = stores.get(path);
	if (existing) return existing;
	const store = openMemoryStore(path);
	stores.set(path, store);
	return store;
}

function newTask(): TaskState {
	return { injected: new Map(), hurt: new Set(), credited: new Set() };
}

function oneLine(text: string): string {
	return clip(text.replace(/\s+/g, " ").trim(), 80);
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
