import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Dialog } from "@exocortex/core";
import { OVERRIDES_ENTRY } from "./modules.ts";
import type { Runtime } from "./runtime.ts";

const PING_TIMEOUT_MS = 30_000;

const COMMANDS = ["status", "ping", "on", "off"];
/** Modes some modules accept besides on/off. */
const MODULE_MODES: Readonly<Record<string, readonly string[]>> = { supervisor: ["suggest", "auto"] };

/**
 * `/exo` slash command:
 * - `/exo` or `/exo status`: config state, modules and sidecar pool statistics;
 * - `/exo ping`: one tiny sidecar call (and one embedding, if configured), to check the servers are reachable;
 * - `/exo off` / `/exo on`: kill switch for every module (brief §5.3), this session only;
 *   toggles are kept in the session (an `exo.overrides` entry), so `/reload` and `/resume` keep them;
 * - `/exo <module> on|off`: toggle one module, e.g. `/exo trimmer on`;
 * - `/exo supervisor suggest|auto`: also switch the supervisor's mode;
 * - `/exo memory preferences` / `/exo memory forget <id>`: list or retire learned preferences;
 * - `/exo memory interview`: a few questions whose answers become preferences (D-066).
 */
export function registerExoCommand(pi: ExtensionAPI, runtime: Runtime): void {
	const subcommands = () => [...COMMANDS, ...runtime.moduleIds()];
	pi.registerCommand("exo", {
		description: "Exocortex: status | ping | on | off | <module> on|off | supervisor suggest|auto",
		getArgumentCompletions: (prefix) =>
			subcommands()
				.filter((name) => name.startsWith(prefix.trim()))
				.map((name) => ({ value: name, label: name })),
		handler: async (args, ctx) => {
			try {
				const [sub = "status", arg, ...rest] = args.trim().split(/\s+/).filter(Boolean);
				if (sub === "ping") await ping(runtime, ctx);
				else if (sub === "status") say(ctx, status(runtime));
				else if (sub === "on" || sub === "off") {
					runtime.overrides.allOff = sub === "off";
					runtime.rebuildModules();
					persistOverrides(pi, runtime);
					say(ctx, `Exocortex modules ${sub === "off" ? "off" : "back on"} for this session.`);
				} else if (runtime.moduleIds().includes(sub)) await moduleCommand(pi, runtime, ctx, sub, arg, rest);
				else say(ctx, `Unknown /exo subcommand "${sub}". Try: ${subcommands().join(", ")}`, "warning");
			} catch (error) {
				say(ctx, `/exo failed: ${String(error)}`, "error");
			}
		},
	});
}

/** A module answers its own subcommands (`/exo memory preferences`); anything else is a toggle. */
async function moduleCommand(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	id: string,
	arg: string | undefined,
	rest: readonly string[],
): Promise<void> {
	const reply =
		arg === undefined ? undefined : await runtime.moduleCommand(id, [arg, ...rest].join(" "), dialogFor(ctx));
	if (reply !== undefined) say(ctx, reply);
	else if (toggleModule(runtime, ctx, id, arg)) persistOverrides(pi, runtime);
}

/**
 * Writes the toggles into the session, where the module host finds them at the next
 * `session_start`: pi runs the extension again on `/reload` and `/resume`, which would otherwise
 * forget them. The entry is never sent to the model (PI_API_NOTES §8).
 */
function persistOverrides(pi: ExtensionAPI, runtime: Runtime): void {
	const { allOff, modules } = runtime.overrides;
	pi.appendEntry(OVERRIDES_ENTRY, { allOff, modules: structuredClone(modules) });
}

/** Pi's dialogs, where there is a UI to show them (TUI and RPC; `docs/PI_API_NOTES.md` §6). */
function dialogFor(ctx: ExtensionCommandContext): Dialog | undefined {
	if (!ctx.hasUI) return undefined;
	return {
		select: (title, options) => ctx.ui.select(title, [...options]),
		input: (title, placeholder) => ctx.ui.input(title, placeholder),
		notify: (message) => ctx.ui.notify(message, "info"),
	};
}

/** Applies `/exo <module> on|off|<mode>`; false when `arg` is none of those. */
function toggleModule(runtime: Runtime, ctx: ExtensionCommandContext, id: string, arg: string | undefined): boolean {
	const modes = MODULE_MODES[id] ?? [];
	const override = runtime.overrides.modules[id] ?? {};
	runtime.overrides.modules[id] = override;
	if (arg === "on" || arg === "off") override["enabled"] = arg === "on";
	else if (arg !== undefined && modes.includes(arg)) {
		override["enabled"] = true;
		override["mode"] = arg;
	} else {
		say(ctx, `Usage: /exo ${id} ${["on", "off", ...modes].join("|")}`, "warning");
		return false;
	}
	runtime.rebuildModules();
	const name = id.charAt(0).toUpperCase() + id.slice(1);
	const mode = modes.length > 0 ? ` (${String(override["mode"] ?? "configured mode")})` : "";
	say(ctx, `${name}: ${override["enabled"] ? `on${mode}` : "off"} for this session.`);
	return true;
}

function status(runtime: Runtime): string {
	const config = runtime.config;
	if (!config) return "Exocortex: not activated yet";
	if (!config.enabled) return "Exocortex: disabled";
	const active = runtime.moduleStatus();
	const lines = [
		`Exocortex: enabled · trace ${config.trace.enabled ? config.trace.dbPath : "off"}`,
		runtime.overrides.allOff
			? "modules: off (/exo on to re-enable)"
			: `modules: ${active.join(" · ") || "none enabled"}`,
	];
	const pool = runtime.pool;
	if (!pool) {
		lines.push("sidecars: no engine configured");
	} else {
		const s = pool.stats();
		const outcomes = Object.entries(s.outcomes)
			.filter(([, n]) => n > 0)
			.map(([o, n]) => `${o} ${n}`)
			.join(", ");
		lines.push(
			`sidecars: ${s.running} running · queued ${s.queued.critical}/${s.queued.interactive}/${s.queued.background} (crit/int/bg) · ${s.sessionTokensUsed} tokens · ${outcomes || "no calls yet"}`,
		);
	}
	return lines.join("\n");
}

async function ping(runtime: Runtime, ctx: ExtensionCommandContext): Promise<void> {
	const pool = runtime.pool;
	if (!pool) {
		say(ctx, "Exocortex: no sidecar engine configured", "warning");
		return;
	}
	const result = await pool.run({
		module: "exo.ping",
		priority: "interactive",
		timeoutMs: PING_TIMEOUT_MS,
		request: {
			messages: [{ role: "user", content: "Reply with the single word: pong" }],
			maxTokens: 16,
			thinking: false,
		},
	});
	if (result.ok) {
		const cached = result.usage.cachedTokens === null ? "" : `, ${result.usage.cachedTokens} cached`;
		say(
			ctx,
			`Exocortex sidecar OK in ${result.latencyMs} ms (${result.usage.promptTokens} prompt tokens${cached}): ${result.value.trim().slice(0, 60)}`,
		);
	} else {
		say(ctx, `Exocortex sidecar ${result.outcome}: ${result.error}`, "error");
	}
	await pingEmbeddings(runtime, ctx);
}

/** Also checks the embeddings server, when one is configured. */
async function pingEmbeddings(runtime: Runtime, ctx: ExtensionCommandContext): Promise<void> {
	const embedder = runtime.embedder;
	if (!embedder) return;
	const started = performance.now();
	const vectors = await embedder.embed(["ping"], { timeoutMs: PING_TIMEOUT_MS });
	const ms = Math.round(performance.now() - started);
	if (vectors?.[0])
		say(ctx, `Exocortex embeddings OK in ${ms} ms (${embedder.model}, ${vectors[0].length} dimensions)`);
	else say(ctx, `Exocortex embeddings (${embedder.model}) did not answer: modules fall back to keywords`, "warning");
}

/** Notifies in UI modes; prints to stderr in print/json mode, where the UI is a no-op. */
function say(ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(text, level);
	else process.stderr.write(`${text}\n`);
}
