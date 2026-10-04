#!/usr/bin/env node
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig, openTraceStore, TRACE_EVENT_KINDS, type TraceEventKind, type TraceStore } from "@exocortex/core";
import { renderCalls, renderSessions, renderStats, renderTimeline, resolveSession } from "./trace-view.ts";

const USAGE = `Usage: npm run trace -- [--db <path>] <command>

Inspect the Exocortex trace store (default: config trace.dbPath).

Commands:
  sessions [--label <l>] [--limit <n>]   List sessions, newest first (default limit 20)
  show <id|prefix> [--kinds a,b] [--json] One session's metrics and event timeline
  calls <id|prefix> [--json]              One session's sidecar calls and per-module totals
  stats [--since <7d|24h>] [--label <l>]  What the modules did across sessions (suggestions accepted,
                                          rewrites, memory, sidecar cost)

Event kinds: ${TRACE_EVENT_KINDS.join(", ")}`;

function main(): number {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			db: { type: "string" },
			label: { type: "string" },
			since: { type: "string" },
			limit: { type: "string", default: "20" },
			kinds: { type: "string" },
			json: { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
	});
	const [command, id] = positionals;
	if (values.help || !command) {
		process.stdout.write(`${USAGE}\n`);
		return values.help ? 0 : 2;
	}
	const path = values.db ?? loadConfig({ cwd: process.cwd() }).config.trace.dbPath;
	if (!existsSync(path)) {
		process.stderr.write(`no trace store at ${path}\n`);
		return 1;
	}
	const store = openTraceStore({ path });
	try {
		return run(store, command, id, values);
	} finally {
		store.close();
	}
}

interface Options {
	readonly label?: string | undefined;
	readonly limit: string;
	readonly kinds?: string | undefined;
	readonly since?: string | undefined;
	readonly json: boolean;
}

function run(store: TraceStore, command: string, id: string | undefined, values: Options): number {
	const sessions = store.sessions(values.label ? { label: values.label } : {});
	if (command === "sessions") {
		const newest = [...sessions].sort((a, b) => b.startedAt - a.startedAt).slice(0, Number(values.limit));
		return print(values.json ? newest : renderSessions(newest));
	}
	if (command === "stats") {
		const since = parseSince(values.since);
		if (since instanceof Error) return fail(since.message, 2);
		const data = sessions
			.filter((session) => session.startedAt >= since)
			.map((session) => ({ session, events: store.events(session.id), calls: store.sidecarCalls(session.id) }));
		return print(values.json ? data.map((d) => ({ id: d.session.id, events: d.events.length })) : renderStats(data));
	}
	if ((command !== "show" && command !== "calls") || !id) return fail(USAGE, 2);
	const found = resolveSession(sessions, id);
	if ("error" in found) return fail(found.error, 1);
	const { session } = found;
	const calls = store.sidecarCalls(session.id);
	if (command === "calls") return print(values.json ? calls : renderCalls(calls));
	const kinds = parseKinds(values.kinds);
	if (kinds instanceof Error) return fail(kinds.message, 2);
	const events = store.events(session.id, kinds ? { kinds } : {});
	return print(values.json ? { session, events } : renderTimeline(session, events, calls));
}

function print(output: unknown): number {
	process.stdout.write(`${typeof output === "string" ? output : JSON.stringify(output, null, 2)}\n`);
	return 0;
}

function fail(message: string, code: number): number {
	process.stderr.write(`${message}\n`);
	return code;
}

/** `7d`, `24h`, `30m` → epoch ms lower bound; no value → everything. */
function parseSince(value: string | undefined): number | Error {
	if (!value) return 0;
	const match = /^(\d+)([dhm])$/.exec(value);
	if (!match) return new Error(`--since takes e.g. 7d, 24h or 30m, not "${value}"`);
	const unit = { d: 86_400_000, h: 3_600_000, m: 60_000 }[match[2] as "d" | "h" | "m"];
	return Date.now() - Number(match[1]) * unit;
}

function parseKinds(value: string | undefined): TraceEventKind[] | undefined | Error {
	if (!value) return undefined;
	const kinds = value.split(",").map((k) => k.trim());
	const unknown = kinds.filter((k) => !(TRACE_EVENT_KINDS as readonly string[]).includes(k));
	if (unknown.length > 0) return new Error(`unknown event kinds: ${unknown.join(", ")}`);
	return kinds as TraceEventKind[];
}

process.exitCode = main();
