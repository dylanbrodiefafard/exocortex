import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDebugLog, type DebugLog } from "@exocortex/core";
import { HIGH_FREQUENCY_EVENTS, PI_EVENT_NAMES, type PiEventName } from "./pi-events.ts";
import { summarizePiEvent } from "./summarize.ts";

const DEBUG_FLAG = "exo-debug";

type DebugLevel = "off" | "events" | "verbose";

/**
 * Exocortex pi extension entrypoint. Phase 0: an event tracer. With `--exo-debug=1` or
 * `EXO_DEBUG=1` it writes one line per pi event to stderr (or to `EXO_DEBUG_FILE`);
 * `EXO_DEBUG=verbose` also logs per-token events. Otherwise it does nothing.
 */
export default function exocortex(pi: ExtensionAPI): void {
	pi.registerFlag(DEBUG_FLAG, {
		type: "boolean",
		default: false,
		description: "Exocortex: log every pi event (see also EXO_DEBUG, EXO_DEBUG_FILE)",
	});

	const log = createDebugLog({ enabled: true, write: createWriter(process.env["EXO_DEBUG_FILE"]) });
	// Flags are parsed after extensions load, so the level is resolved per event, not here.
	const level = (): DebugLevel => resolveDebugLevel(process.env["EXO_DEBUG"], pi.getFlag(DEBUG_FLAG));

	// `pi.on` is a set of per-event overloads; registering one tracer for all names needs a
	// single erased signature. Handlers return `undefined` so they never alter pi's behavior.
	const on = pi.on.bind(pi) as unknown as (event: PiEventName, handler: (event: unknown) => undefined) => void;
	for (const name of PI_EVENT_NAMES) {
		on(name, (event) => trace(log, level(), name, event));
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
