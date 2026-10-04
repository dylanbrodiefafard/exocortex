#!/usr/bin/env node
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig, openTraceStore, TRACE_EVENT_KINDS, type TraceEventKind } from "@exocortex/core";
import { renderCalls, renderSessions, renderTimeline, resolveSession } from "./trace-view.ts";

const USAGE = `Usage: npm run trace -- [--db <path>] <command>

Inspect the Exocortex trace store (default: config trace.dbPath).

Commands:
  sessions [--label <l>] [--limit <n>]   List sessions, newest first (default limit 20)
  show <id|prefix> [--kinds a,b] [--json] One session's metrics and event timeline
  calls <id|prefix> [--json]              One session's sidecar calls and per-module totals

Event kinds: ${TRACE_EVENT_KINDS.join(", ")}`;

function main(): number {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			db: { type: "string" },
			label: { type: "string" },
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
		const sessions = store.sessions(values.label ? { label: values.label } : {});
		if (command === "sessions") {
			const limit = Number(values.limit);
			const newest = [...sessions].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
			process.stdout.write(`${values.json ? JSON.stringify(newest, null, 2) : renderSessions(newest)}\n`);
			return 0;
		}
		if ((command !== "show" && command !== "calls") || !id) {
			process.stderr.write(`${USAGE}\n`);
			return 2;
		}
		const found = resolveSession(sessions, id);
		if ("error" in found) {
			process.stderr.write(`${found.error}\n`);
			return 1;
		}
		const { session } = found;
		const calls = store.sidecarCalls(session.id);
		if (command === "calls") {
			process.stdout.write(`${values.json ? JSON.stringify(calls, null, 2) : renderCalls(calls)}\n`);
			return 0;
		}
		const kinds = parseKinds(values.kinds);
		if (kinds instanceof Error) {
			process.stderr.write(`${kinds.message}\n`);
			return 2;
		}
		const events = store.events(session.id, kinds ? { kinds } : {});
		process.stdout.write(
			`${values.json ? JSON.stringify({ session, events }, null, 2) : renderTimeline(session, events, calls)}\n`,
		);
		return 0;
	} finally {
		store.close();
	}
}

function parseKinds(value: string | undefined): TraceEventKind[] | undefined | Error {
	if (!value) return undefined;
	const kinds = value.split(",").map((k) => k.trim());
	const unknown = kinds.filter((k) => !(TRACE_EVENT_KINDS as readonly string[]).includes(k));
	if (unknown.length > 0) return new Error(`unknown event kinds: ${unknown.join(", ")}`);
	return kinds as TraceEventKind[];
}

process.exitCode = main();
