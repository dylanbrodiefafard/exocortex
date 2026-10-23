import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Dialog } from "@exocortex/core";
import { cacheReport, cacheSummary } from "./cache-stats.ts";
import { type DoctorFinding, doctorReport, runDoctor } from "./doctor.ts";
import type { ForkTracker } from "./fork.ts";
import { OVERRIDES_ENTRY } from "./modules.ts";
import { problemLines } from "./problems.ts";
import type { Runtime } from "./runtime.ts";

const COMMANDS = ["status", "doctor", "cache", "review", "add", "on", "off"];
/** Modes some modules accept besides on/off. */
const MODULE_MODES: Readonly<Record<string, readonly string[]>> = { supervisor: ["suggest", "auto"] };

/**
 * `/exo` slash command:
 * - `/exo` or `/exo status`: config state, modules and sidecar pool statistics;
 * - `/exo cache`: how much of each prompt the engine served from its prefix cache, for the main
 *   agent and each module's sidecar calls (D-095);
 * - `/exo review`: the supervisor reviews the changes made so far for bugs, and puts what it finds
 *   in the editor (D-097); `/exo supervisor review` is the same;
 * - `/exo add`: adds a follow-up that arrived while the user was typing below their draft (D-097);
 * - `/exo doctor`: checks the engine against what the profile says it can do (D-099);
 * - `/exo off` / `/exo on`: kill switch for every module (brief §5.3), this session only;
 *   toggles are kept in the session (an `exo.overrides` entry), so `/reload` and `/resume` keep them;
 * - `/exo <module> on|off`: toggle one module, e.g. `/exo trimmer on`;
 * - `/exo supervisor suggest|auto`: also switch the supervisor's mode;
 * - `/exo memory preferences` / `/exo memory forget <id>` / `/exo memory restore <id>`: list, retire or
 *   bring back learned preferences;
 * - `/exo memory cards` / `/exo memory forget card <id>`: list or retire learned cards (D-081);
 * - `/exo memory interview`: a few questions whose answers become preferences (D-066).
 */
export function registerExoCommand(
	pi: ExtensionAPI,
	runtime: Runtime,
	options: { readonly fork?: ForkTracker } = {},
): void {
	/** What `/exo doctor thinking` found this session (D-100): it is not probed twice. */
	let thinking: DoctorFinding | undefined;
	const thinkingFound = { get: () => thinking, set: (found: DoctorFinding) => (thinking = found) };
	pi.on("session_start", () => {
		thinking = undefined;
		return undefined;
	});
	const subcommands = () => [...COMMANDS, ...runtime.moduleIds()];
	pi.registerCommand("exo", {
		description:
			"Exocortex: status | doctor | cache | review | add | on | off | <module> on|off | supervisor suggest|auto",
		getArgumentCompletions: (prefix) =>
			subcommands()
				.filter((name) => name.startsWith(prefix.trim()))
				.map((name) => ({ value: name, label: name })),
		handler: async (args, ctx) => {
			const [sub = "status", arg, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const own: Readonly<Record<string, () => void | Promise<void>>> = {
				doctor: () => doctor(runtime, ctx, options.fork, arg === "thinking", thinkingFound),
				status: () => say(ctx, status(runtime)),
				cache: () => say(ctx, runtime.config?.enabled ? cacheReport(runtime.cacheStats) : "Exocortex: disabled"),
				review: () => review(runtime, ctx),
				add: () => {
					if (!runtime.addOffer(ctx)) say(ctx, "Nothing to add: no follow-up is waiting.");
				},
				on: () => switchAll(pi, runtime, ctx, "on"),
				off: () => switchAll(pi, runtime, ctx, "off"),
			};
			try {
				const run = Object.hasOwn(own, sub) ? own[sub] : undefined;
				if (run) await run();
				else if (runtime.moduleIds().includes(sub)) await moduleCommand(pi, runtime, ctx, sub, arg, rest);
				else say(ctx, `Unknown /exo subcommand "${sub}". Try: ${subcommands().join(", ")}`, "warning");
			} catch (error) {
				say(ctx, `/exo failed: ${String(error)}`, "error");
			}
		},
	});
}

/** `/exo on` / `/exo off`: the kill switch for every module, kept in the session. */
function switchAll(pi: ExtensionAPI, runtime: Runtime, ctx: ExtensionCommandContext, sub: "on" | "off"): void {
	runtime.overrides.allOff = sub === "off";
	runtime.rebuildModules();
	persistOverrides(pi, runtime);
	say(ctx, `Exocortex modules ${sub === "off" ? "off" : "back on"} for this session.`);
}

/** `/exo review`: the supervisor's review of the changes so far (D-097), when the agent is not working. */
async function review(runtime: Runtime, ctx: ExtensionCommandContext): Promise<void> {
	if (!runtime.config?.enabled || runtime.overrides.allOff) return say(ctx, "Exocortex: disabled", "warning");
	if (!runtime.moduleStatus().some((s) => s.startsWith("supervisor"))) {
		return say(ctx, "/exo review needs the supervisor: /exo supervisor on", "warning");
	}
	if (!ctx.isIdle()) return say(ctx, "The agent is working. Run /exo review once it stops.", "warning");
	const reply = await runtime.moduleCommand("supervisor", "review", dialogFor(ctx));
	say(ctx, reply ?? "The review did not run.");
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
	lines.push(cacheSummary(runtime.cacheStats));
	lines.push(...problemLines(runtime.problems, Date.now()));
	return lines.join("\n");
}

/** `/exo doctor`: a few tiny calls that show where the engine and the profile disagree (D-099). */
async function doctor(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	fork: ForkTracker | undefined,
	probeThinking: boolean,
	found: { readonly get: () => DoctorFinding | undefined; readonly set: (f: DoctorFinding) => void } | undefined,
): Promise<void> {
	if (!runtime.config?.enabled) return say(ctx, "Exocortex: disabled", "warning");
	// A fork while the agent works would compete with it, and there is no answered request to fork.
	if (!ctx.isIdle()) return say(ctx, "The agent is working. Run /exo doctor once it stops.", "warning");
	say(ctx, "Exocortex doctor: asking the engine…");
	const findings = await runDoctor({
		engine: runtime.engine,
		profile: runtime.config.engine.profile,
		pool: runtime.pool,
		embedder: runtime.embedder,
		fork: async () => (fork ? fork.prefix(ctx) : undefined),
		probeThinking,
		...(found ? { thinkingFound: found } : {}),
	});
	say(ctx, doctorReport(findings), findings.some((f) => f.status === "fail") ? "warning" : "info");
}

/** Notifies in UI modes; prints to stderr in print/json mode, where the UI is a no-op. */
function say(ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(text, level);
	else process.stderr.write(`${text}\n`);
}
