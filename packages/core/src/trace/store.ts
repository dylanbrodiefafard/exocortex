import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { SidecarCallRecord } from "../inference/pool.ts";
import { migrate } from "./schema.ts";
import { openDatabase } from "./sqlite.ts";

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * Harness-agnostic event kinds. Adapters map their harness's events onto these; anything the
 * kind can't express goes in `data`.
 */
export const TRACE_EVENT_KINDS = [
	"session.start",
	"session.end",
	"user.input",
	"llm.request",
	"message",
	"tool.call",
	"tool.result",
	"turn.end",
	"agent.settled",
	"compaction",
	"model.change",
	/** A module's extracted task goals (e.g. the supervisor's goal ledger). */
	"exo.ledger",
	/** A module's judgement of the agent's work: the labels memory learns from (brief §6.1). */
	"exo.verdict",
	/** A module acting on the session: suggestion, continuation, acceptance, or a deliberate skip. */
	"exo.action",
] as const;

export type TraceEventKind = (typeof TRACE_EVENT_KINDS)[number];

export interface TraceEventInput {
	readonly kind: TraceEventKind;
	readonly data: JsonValue;
	readonly turn?: number;
	/** True for content Exocortex produced (injections, rewrites), so it is never learned from as if the model or user produced it. */
	readonly synthetic?: boolean;
	/** Exocortex module responsible, for synthetic content. */
	readonly module?: string;
	/** Epoch ms; defaults to the store clock. */
	readonly ts?: number;
}

export interface StoredTraceEvent {
	readonly id: number;
	readonly sessionId: string;
	readonly seq: number;
	readonly ts: number;
	readonly kind: TraceEventKind;
	readonly turn: number | null;
	readonly synthetic: boolean;
	readonly module: string | null;
	readonly data: JsonValue;
}

export interface SessionInfo {
	readonly harness: string;
	readonly cwd: string;
	readonly harnessSessionId?: string;
	/** Free-form label, e.g. the eval run/task id. */
	readonly label?: string;
	readonly meta?: { readonly [key: string]: JsonValue };
}

export interface StoredSession {
	readonly id: string;
	readonly harness: string;
	readonly harnessSessionId: string | null;
	readonly cwd: string;
	readonly label: string | null;
	readonly startedAt: number;
	readonly endedAt: number | null;
	readonly meta: JsonValue;
}

export interface TraceSession {
	readonly id: string;
	/** Buffers the event; it is written on the next flush. Never throws. */
	append(event: TraceEventInput): void;
	/** Buffers one sidecar call record (brief §5.2 `sidecar_calls`). Never throws. */
	recordSidecarCall(record: SidecarCallRecord): void;
	end(): void;
}

export interface TraceStore {
	startSession(info: SessionInfo): TraceSession;
	sessions(filter?: { readonly label?: string }): StoredSession[];
	events(sessionId: string, filter?: { readonly kinds?: readonly TraceEventKind[] }): StoredTraceEvent[];
	sidecarCalls(sessionId: string): SidecarCallRecord[];
	/** Writes buffered operations in one transaction. Never throws; failures go to `onError`. */
	flush(): void;
	/** Flushes and closes. Further appends are dropped. */
	close(): void;
}

export interface TraceStoreOptions {
	/** SQLite file path, or `:memory:`. Parent directories are created. */
	readonly path: string;
	readonly now?: () => number;
	/** Delay before a buffered write is flushed. */
	readonly flushIntervalMs?: number;
	/** Flush immediately once this many operations are buffered. */
	readonly maxBuffered?: number;
	readonly onError?: (error: unknown) => void;
}

type PendingOp =
	| { readonly op: "session"; readonly id: string; readonly info: SessionInfo; readonly ts: number }
	| {
			readonly op: "event";
			readonly sessionId: string;
			readonly seq: number;
			readonly event: TraceEventInput;
			readonly ts: number;
	  }
	| { readonly op: "end"; readonly id: string; readonly ts: number }
	| { readonly op: "sidecar"; readonly sessionId: string; readonly record: SidecarCallRecord };

const DEFAULT_FLUSH_INTERVAL_MS = 50;
const DEFAULT_MAX_BUFFERED = 256;

/**
 * Append-only SQLite trace store (brief §5.1). Appends are buffered in memory and written in
 * batched transactions off the caller's path, so harness event handlers pay only an array push.
 */
export function openTraceStore(options: TraceStoreOptions): TraceStore {
	if (options.path !== ":memory:") mkdirSync(dirname(options.path), { recursive: true });
	const db = openDatabase(options.path);
	migrate(db);

	const now = options.now ?? Date.now;
	const onError = options.onError ?? (() => {});
	const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
	const maxBuffered = options.maxBuffered ?? DEFAULT_MAX_BUFFERED;
	const statements = prepare(db);
	let buffer: PendingOp[] = [];
	let timer: NodeJS.Timeout | undefined;
	let closed = false;

	function enqueue(op: PendingOp): void {
		if (closed) return;
		buffer.push(op);
		if (buffer.length >= maxBuffered) {
			flush();
		} else if (!timer) {
			timer = setTimeout(flush, flushIntervalMs);
			timer.unref();
		}
	}

	function flush(): void {
		if (timer) clearTimeout(timer);
		timer = undefined;
		if (buffer.length === 0 || !db.isOpen) return;
		const batch = buffer;
		buffer = [];
		try {
			db.exec("BEGIN");
			for (const op of batch) write(statements, op);
			db.exec("COMMIT");
		} catch (error) {
			if (db.isTransaction) db.exec("ROLLBACK");
			onError(error);
		}
	}

	return {
		startSession(info) {
			const id = randomUUID();
			let seq = 0;
			let ended = false;
			enqueue({ op: "session", id, info, ts: now() });
			return {
				id,
				append(event) {
					if (ended) return;
					seq += 1;
					enqueue({ op: "event", sessionId: id, seq, event, ts: event.ts ?? now() });
				},
				recordSidecarCall(record) {
					if (ended) return;
					enqueue({ op: "sidecar", sessionId: id, record });
				},
				end() {
					if (ended) return;
					ended = true;
					enqueue({ op: "end", id, ts: now() });
				},
			};
		},
		sessions(filter = {}) {
			flush();
			const rows =
				filter.label === undefined
					? statements.allSessions.all()
					: statements.sessionsByLabel.all({ label: filter.label });
			return (rows as unknown as SessionRow[]).map(toSession);
		},
		events(sessionId, filter = {}) {
			flush();
			const rows = statements.eventsBySession.all({ session_id: sessionId }) as unknown as EventRow[];
			const kinds = filter.kinds ? new Set<string>(filter.kinds) : undefined;
			return rows.filter((row) => !kinds || kinds.has(row.kind)).map(toEvent);
		},
		sidecarCalls(sessionId) {
			flush();
			const rows = statements.sidecarCallsBySession.all({ session_id: sessionId }) as unknown as SidecarRow[];
			return rows.map(toSidecarCall);
		},
		flush,
		close() {
			if (closed) return;
			flush();
			closed = true;
			db.close();
		},
	};
}

function prepare(db: DatabaseSync) {
	return {
		insertSession: db.prepare(
			"INSERT INTO sessions (id, harness, harness_session_id, cwd, label, started_at, meta) VALUES (:id, :harness, :harness_session_id, :cwd, :label, :started_at, :meta)",
		),
		endSession: db.prepare("UPDATE sessions SET ended_at = :ended_at WHERE id = :id"),
		insertEvent: db.prepare(
			"INSERT INTO events (session_id, seq, ts, kind, turn, synthetic, module, data) VALUES (:session_id, :seq, :ts, :kind, :turn, :synthetic, :module, :data)",
		),
		allSessions: db.prepare("SELECT * FROM sessions ORDER BY started_at, rowid"),
		sessionsByLabel: db.prepare("SELECT * FROM sessions WHERE label = :label ORDER BY started_at, rowid"),
		eventsBySession: db.prepare("SELECT * FROM events WHERE session_id = :session_id ORDER BY seq"),
		insertSidecarCall: db.prepare(
			"INSERT INTO sidecar_calls (session_id, ts, module, priority, outcome, prompt_hash, queue_ms, latency_ms, attempts, max_tokens, prompt_tokens, cached_tokens, completion_tokens, error) VALUES (:session_id, :ts, :module, :priority, :outcome, :prompt_hash, :queue_ms, :latency_ms, :attempts, :max_tokens, :prompt_tokens, :cached_tokens, :completion_tokens, :error)",
		),
		sidecarCallsBySession: db.prepare("SELECT * FROM sidecar_calls WHERE session_id = :session_id ORDER BY id"),
	};
}

function write(statements: ReturnType<typeof prepare>, op: PendingOp): void {
	switch (op.op) {
		case "session":
			statements.insertSession.run({
				id: op.id,
				harness: op.info.harness,
				harness_session_id: op.info.harnessSessionId ?? null,
				cwd: op.info.cwd,
				label: op.info.label ?? null,
				started_at: op.ts,
				meta: JSON.stringify(op.info.meta ?? {}),
			});
			return;
		case "event":
			statements.insertEvent.run({
				session_id: op.sessionId,
				seq: op.seq,
				ts: op.ts,
				kind: op.event.kind,
				turn: op.event.turn ?? null,
				synthetic: op.event.synthetic ? 1 : 0,
				module: op.event.module ?? null,
				data: JSON.stringify(op.event.data),
			});
			return;
		case "end":
			statements.endSession.run({ id: op.id, ended_at: op.ts });
			return;
		case "sidecar": {
			const r = op.record;
			statements.insertSidecarCall.run({
				session_id: op.sessionId,
				ts: r.startedAt,
				module: r.module,
				priority: r.priority,
				outcome: r.outcome,
				prompt_hash: r.promptHash,
				queue_ms: Math.round(r.queueMs),
				latency_ms: Math.round(r.latencyMs),
				attempts: r.attempts,
				max_tokens: r.maxTokens,
				prompt_tokens: r.usage.promptTokens,
				cached_tokens: r.usage.cachedTokens,
				completion_tokens: r.usage.completionTokens,
				error: r.error,
			});
			return;
		}
	}
}

interface SessionRow {
	id: string;
	harness: string;
	harness_session_id: string | null;
	cwd: string;
	label: string | null;
	started_at: number;
	ended_at: number | null;
	meta: string;
}

interface EventRow {
	id: number;
	session_id: string;
	seq: number;
	ts: number;
	kind: TraceEventKind;
	turn: number | null;
	synthetic: number;
	module: string | null;
	data: string;
}

function toSession(row: SessionRow): StoredSession {
	return {
		id: row.id,
		harness: row.harness,
		harnessSessionId: row.harness_session_id,
		cwd: row.cwd,
		label: row.label,
		startedAt: row.started_at,
		endedAt: row.ended_at,
		meta: JSON.parse(row.meta) as JsonValue,
	};
}

function toEvent(row: EventRow): StoredTraceEvent {
	return {
		id: row.id,
		sessionId: row.session_id,
		seq: row.seq,
		ts: row.ts,
		kind: row.kind,
		turn: row.turn,
		synthetic: row.synthetic === 1,
		module: row.module,
		data: JSON.parse(row.data) as JsonValue,
	};
}

interface SidecarRow {
	ts: number;
	module: string;
	priority: SidecarCallRecord["priority"];
	outcome: SidecarCallRecord["outcome"];
	prompt_hash: string;
	queue_ms: number;
	latency_ms: number;
	attempts: number;
	max_tokens: number;
	prompt_tokens: number;
	cached_tokens: number | null;
	completion_tokens: number;
	error: string | null;
}

function toSidecarCall(row: SidecarRow): SidecarCallRecord {
	return {
		module: row.module,
		priority: row.priority,
		outcome: row.outcome,
		promptHash: row.prompt_hash,
		startedAt: row.ts,
		queueMs: row.queue_ms,
		latencyMs: row.latency_ms,
		attempts: row.attempts,
		maxTokens: row.max_tokens,
		usage: {
			promptTokens: row.prompt_tokens,
			cachedTokens: row.cached_tokens,
			completionTokens: row.completion_tokens,
		},
		error: row.error,
	};
}
