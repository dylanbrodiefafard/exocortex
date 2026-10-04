import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "./runtime.ts";

const PING_TIMEOUT_MS = 30_000;

/**
 * `/exo` slash command. Phase 2 subcommands:
 * - `/exo` or `/exo status`: config state and sidecar pool statistics;
 * - `/exo ping`: one tiny sidecar call, to check the sidecar engine is reachable.
 */
export function registerExoCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("exo", {
		description: "Exocortex: status | ping",
		getArgumentCompletions: (prefix) =>
			["status", "ping"].filter((name) => name.startsWith(prefix.trim())).map((name) => ({ value: name, label: name })),
		handler: async (args, ctx) => {
			try {
				const sub = args.trim() || "status";
				if (sub === "ping") await ping(runtime, ctx);
				else if (sub === "status") say(ctx, status(runtime));
				else say(ctx, `Unknown /exo subcommand "${sub}". Try: status, ping`, "warning");
			} catch (error) {
				say(ctx, `/exo failed: ${String(error)}`, "error");
			}
		},
	});
}

function status(runtime: Runtime): string {
	const config = runtime.config;
	if (!config) return "Exocortex: not activated yet";
	if (!config.enabled) return "Exocortex: disabled";
	const lines = [
		`Exocortex: enabled · trace ${config.trace.enabled ? config.trace.dbPath : "off"}`,
		`modules: ${
			Object.entries(config.modules)
				.filter(([, m]) => m.enabled)
				.map(([id]) => id)
				.join(", ") || "none"
		}`,
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
