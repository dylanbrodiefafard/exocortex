import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "./runtime.ts";

const PING_TIMEOUT_MS = 30_000;

const SUBCOMMANDS = ["status", "ping", "on", "off", "supervisor"];

/**
 * `/exo` slash command:
 * - `/exo` or `/exo status`: config state, modules and sidecar pool statistics;
 * - `/exo ping`: one tiny sidecar call, to check the sidecar engine is reachable;
 * - `/exo off` / `/exo on`: kill switch for every module (brief §5.3), this session only;
 * - `/exo supervisor on|off|suggest|auto`: toggle the supervisor or switch its mode.
 */
export function registerExoCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("exo", {
		description: "Exocortex: status | ping | on | off | supervisor on|off|suggest|auto",
		getArgumentCompletions: (prefix) =>
			SUBCOMMANDS.filter((name) => name.startsWith(prefix.trim())).map((name) => ({ value: name, label: name })),
		handler: async (args, ctx) => {
			try {
				const [sub = "status", arg] = args.trim().split(/\s+/).filter(Boolean);
				if (sub === "ping") await ping(runtime, ctx);
				else if (sub === "status") say(ctx, status(runtime));
				else if (sub === "on" || sub === "off") {
					runtime.overrides.allOff = sub === "off";
					runtime.rebuildModules();
					say(ctx, `Exocortex modules ${sub === "off" ? "off" : "back on"} for this session.`);
				} else if (sub === "supervisor") toggleSupervisor(runtime, ctx, arg);
				else say(ctx, `Unknown /exo subcommand "${sub}". Try: ${SUBCOMMANDS.join(", ")}`, "warning");
			} catch (error) {
				say(ctx, `/exo failed: ${String(error)}`, "error");
			}
		},
	});
}

function toggleSupervisor(runtime: Runtime, ctx: ExtensionCommandContext, arg: string | undefined): void {
	const override = runtime.overrides.modules["supervisor"] ?? {};
	runtime.overrides.modules["supervisor"] = override;
	if (arg === "on" || arg === "off") override["enabled"] = arg === "on";
	else if (arg === "suggest" || arg === "auto") {
		override["enabled"] = true;
		override["mode"] = arg;
	} else {
		say(ctx, "Usage: /exo supervisor on|off|suggest|auto", "warning");
		return;
	}
	runtime.rebuildModules();
	say(
		ctx,
		`Supervisor: ${override["enabled"] ? `on (${String(override["mode"] ?? "configured mode")})` : "off"} for this session.`,
	);
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
}

/** Notifies in UI modes; prints to stderr in print/json mode, where the UI is a no-op. */
function say(ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(text, level);
	else process.stderr.write(`${text}\n`);
}
