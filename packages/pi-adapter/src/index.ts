import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDebugLog, type DebugFields, type DebugLog } from "@exocortex/core";
import { registerExoCommand } from "./command.ts";
import { MODULE_SETTINGS } from "./module-settings.ts";
import { registerModuleHost } from "./modules.ts";
import { HIGH_FREQUENCY_EVENTS, PI_EVENT_NAMES, type PiEventName } from "./pi-events.ts";
import { createRuntime } from "./runtime.ts";
import { registerSidecars } from "./sidecars.ts";
import { summarizePiEvent } from "./summarize.ts";
import { registerTraceRecorder } from "./trace-recorder.ts";

const DEBUG_FLAG = "exo-debug";

type DebugLevel = "off" | "events" | "verbose";

/**
 * Exocortex pi extension entrypoint.
 *
 * - Sidecar pool: one per pi session, for modules' sidecar calls (config `engine`, `pool`).
 * - Trace recorder: persists pi events to the SQLite trace store (config `trace`).
 * - Module host: runs enabled modules (config `modules`), e.g. the supervisor.
 * - `/exo` command: status, toggles, and a sidecar connectivity check.
 * - Debug tracer: with `--exo-debug=1` or `EXO_DEBUG=1`, one line per pi event to stderr (or
 *   `EXO_DEBUG_FILE`); `EXO_DEBUG=verbose` adds per-token events. Swallowed hook errors are
 *   logged here as `exo.error`.
 */
export default function exocortex(pi: ExtensionAPI): void {
	const env = process.env;
	pi.registerFlag(DEBUG_FLAG, {
		type: "boolean",
		default: false,
		description: "Exocortex: log every pi event (see also EXO_DEBUG, EXO_DEBUG_FILE)",
	});

	const log = createDebugLog({ enabled: true, write: createWriter(env["EXO_DEBUG_FILE"]) });
	// Flags are parsed after extensions load, so the level is resolved per event, not here.
	let lastLevel: DebugLevel = resolveDebugLevel(env["EXO_DEBUG"], undefined);
	/**
	 * Never throws. Once the session is replaced or reloaded, `pi` is stale and `getFlag` throws
	 * (PI_API_NOTES §14); work still running from that session keeps the last level it read.
	 */
	const level = (): DebugLevel => {
		try {
			lastLevel = resolveDebugLevel(env["EXO_DEBUG"], pi.getFlag(DEBUG_FLAG));
		} catch {
			// Stale: keep the last value.
		}
		return lastLevel;
	};
	/** Writes one debug line; never throws, since it runs inside `catch` blocks and background work. */
	const emit = (name: string, fields: () => DebugFields): void => {
		try {
			if (level() !== "off") log.event(name, fields());
		} catch {
			// Nowhere left to report a failure to log (an unwritable EXO_DEBUG_FILE).
		}
	};
	const onError = (where: string, error: unknown): void => emit("exo.error", () => ({ where, error: String(error) }));

	const runtime = createRuntime({ env, onError, moduleSettings: MODULE_SETTINGS });
	// The order at shutdown (D-078, D-086), all inside the sidecars' handler, which is the first:
	// 1. background sidecar calls get a bounded time to finish, with the modules still alive to
	//    write down what they return (memory's lessons);
	// 2. modules are disposed while the pool and the trace session they may still write to are open;
	// 3. the pool closes, recording the calls it cuts off.
	// Then the recorder, registered after it, ends the trace session.
	registerSidecars(pi, { runtime, env, onError, beforeClose: () => runtime.disposeModules() });
	registerTraceRecorder(pi, { runtime, env, onError });
	registerModuleHost(pi, {
		runtime,
		onError,
		log: (message) => emit("exo.log", () => ({ message })),
	});
	registerExoCommand(pi, runtime);

	// `pi.on` is a set of per-event overloads; registering one tracer for all names needs a
	// single erased signature. Handlers return `undefined` so they never alter pi's behavior.
	const on = pi.on.bind(pi) as unknown as (event: PiEventName, handler: (event: unknown) => undefined) => void;
	for (const name of PI_EVENT_NAMES) {
		on(name, (event) => {
			try {
				return trace(log, level(), name, event);
			} catch {
				return undefined;
			}
		});
	}
}

function trace(log: DebugLog, level: DebugLevel, name: PiEventName, event: unknown): undefined {
	if (level === "off") return undefined;
	if (level === "events" && HIGH_FREQUENCY_EVENTS.has(name)) return undefined;
	log.event(name, summarizePiEvent(event));
	return undefined;
}

export function resolveDebugLevel(env: string | undefined, flag: boolean | string | undefined): DebugLevel {
	const value = (env ?? "").trim().toLowerCase();
	if (value === "verbose") return "verbose";
	if (value === "1" || value === "true" || value === "events") return "events";
	return flag === true || flag === "true" ? "events" : "off";
}

function createWriter(file: string | undefined): (line: string) => void {
	if (file) return (line) => appendFileSync(file, line);
	return (line) => {
		process.stderr.write(line);
	};
}
