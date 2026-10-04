# Exocortex

> An exocortex for small models. Make a weak local LLM behave like a much stronger coding agent by spending cheap, parallel sidecar calls around it — supervision, context hygiene, error triage, parallel attempts, and learned memory — without adding cognitive load to the main model.

This document is the project brief for the agent bootstrapping this repo. Read it fully before writing code. When this spec and the actual pi API disagree, **the installed pi source wins** — note the discrepancy in `docs/DECISIONS.md` and adapt.

---

## 1. Context and goals

- **Host harness:** [pi coding agent](https://github.com/badlogic/pi-mono) (`@mariozechner/pi-coding-agent`). Chosen for its tiny system prompt (<1k tokens), TypeScript extension API, session trees (branching), and RPC mode.
- **Model:** a local LLM served via an OpenAI-compatible endpoint (llama.cpp server / vLLM / similar). The machine can run **~6 concurrent requests** quickly.
- **Core thesis:** the main model is already at its capability limit on the task. Every feature here must *reduce* the main model's burden or *add* outside verification — never ask the main model to do memory, planning, or bookkeeping work.

### Hard constraints

1. **Never ask the main model to save/load memories or call Exocortex tools.** No new tools registered for the main model unless a module explicitly justifies it.
2. **No LLM calls on the hot path that block the main agent**, except where a module is explicitly opt-in and budgeted (e.g. supervisor verdict at `agent_end`).
3. **Prompt-cache stability.** Never mutate earlier messages or the system prompt turn-to-turn. Inject into the *current* user turn or tool result, and once injected, that content is frozen. Local servers (llama.cpp) reuse KV cache by prefix; breaking the prefix is a major latency cost.
4. **Every module is independently toggleable** and measurable via the eval harness.
5. **Precision over recall** for anything injected into context. Injecting nothing is always an acceptable outcome.
6. Local-first. No cloud services required. An optional remote "strong model" for background-only work is allowed via config.

### Non-goals (for now)

- UI beyond pi's built-in status/notify primitives.
- Support for harnesses other than pi (but keep the core harness-agnostic — see §3).
- Knowledge graphs, Neo4j, or multi-call-per-episode extraction pipelines.

---

## 2. Concepts

| Term | Meaning |
|---|---|
| **Main agent** | The pi agent loop the user is talking to. |
| **Sidecar** | A separate, short-lived LLM call made by Exocortex (judging, summarizing, extracting). Never visible as a tool to the main agent. |
| **Pool** | The scheduler that owns the concurrency slots and decides which sidecar calls run. |
| **Trace** | Append-only record of everything that happened in a session: prompts, tool calls, results, injections, verdicts, branches. |
| **Goal ledger** | Acceptance criteria extracted from the user's original request at task start. |
| **Verdict** | A supervisor judgment: `complete` / `incomplete(missing: [...])` / `failed(reason)` / `uncertain`. |
| **Memory card** | A distilled, reusable lesson (pitfall, procedure, fact, preference) with triggers and utility stats. |

---

## 3. Architecture

```
            ┌──────────────────────── pi process ────────────────────────┐
 user ───▶  │  main agent loop                                            │
            │     │ events (before_agent_start, context, tool_call,       │
            │     │         tool_result, agent_end, session_*)            │
            │     ▼                                                       │
            │  @exocortex/pi-adapter  (thin; translates pi events)        │
            │     │                                                       │
            │     ▼                                                       │
            │  @exocortex/core                                            │
            │   ├─ trace store (SQLite)                                   │
            │   ├─ sidecar pool (concurrency, priority, budgets)          │
            │   ├─ config + module registry + kill switches               │
            │   └─ modules: supervisor | trimmer | triage | memory | ...  │
            └─────────────────────────────────────────────────────────────┘
                         │ OpenAI-compatible HTTP
                         ▼
                  local LLM server (N slots)

 background worker (separate process, runs when idle): memory extraction/curation
 eval harness (separate process): drives pi via RPC mode, replays tasks, A/B modules
```

**Rule:** `@exocortex/core` must not import pi. All pi-specific code lives in `@exocortex/pi-adapter`. This keeps a future OpenCode (or other) adapter cheap and keeps the core unit-testable without pi.

### Repo layout

```
exocortex/
  packages/
    core/            # trace store, pool, config, module interfaces, shared prompts
    pi-adapter/      # the pi extension entrypoint; maps pi events -> core
    modules/
      supervisor/
      trimmer/
      triage/
      memory/
      branches/      # parallel attempts (later)
    worker/          # background sleep-time process (memory curation)
    eval/            # RPC-mode replay harness + metrics
  tasks/             # eval task fixtures (repo snapshot + prompt + check command)
  docs/
    DECISIONS.md     # ADR-style log; record every API discrepancy & design choice
    PI_API_NOTES.md  # what you verified in pi's source, with file paths + version
  exocortex.config.example.jsonc
```

Tooling: TypeScript (strict), npm or bun workspaces (match whatever runtime pi itself uses), vitest for tests. SQLite via the runtime's built-in SQLite if available, otherwise `better-sqlite3`. Keep dependencies minimal.

---

## 4. Pi integration — verify first

Before Phase 1, read pi's extension docs and types in the installed package (`packages/coding-agent/docs/extensions.md`, `docs/compaction.md`, and `src/core/extensions/types.ts` in pi-mono) and write `docs/PI_API_NOTES.md` with the exact signatures you'll rely on, plus the pi version.

Events/APIs this design expects to use (confirm each — names may differ):

| Need | Expected pi hook |
|---|---|
| Observe/annotate user turn | `before_agent_start` (can inject messages / alter system prompt), `input` |
| Modify messages before each LLM call | `context` |
| Observe/rewrite tool results | `tool_result` (and `tool_call` for args) |
| Detect "agent finished" | `agent_end` / `turn_end` |
| Continue without user | `pi.sendUserMessage(...)` or `pi.sendMessage(...)`, plus `ctx.isIdle` |
| Session lifecycle | `session_start`, `session_shutdown`, `session_switch` |
| Compaction | `session_before_compact` (custom summary), `session_compact` |
| Branching | session tree APIs / `session_before_tree`, `session_tree` |
| Headless driving | RPC mode |
| Status to user | `ctx.ui` notify/status helpers (check availability in non-interactive modes) |

Also determine: where pi stores session files and their format (believed to be JSONL under a `.pi/sessions`-style directory), and whether injected messages can be marked so they're excluded from Exocortex's own trace-based extraction.

---

## 5. Core components

### 5.1 Trace store
- SQLite, one DB per user (`~/.exocortex/exocortex.db`), WAL mode.
- Tables (starting point; refine): `sessions`, `turns`, `events` (type, payload JSON, ts, branch_id), `injections` (what was injected, where, by which module, tokens), `verdicts`, `sidecar_calls` (module, prompt hash, latency, tokens in/out, outcome).
- Writes must be async/batched; never block the pi event handler on disk I/O longer than a few ms.
- Synthetic content created by Exocortex must be tagged so it is never re-learned as if the model or user produced it.

### 5.2 Sidecar pool
- Config: `endpoint`, `model`, `maxConcurrent` (default 6), `reservedForMain` (default 2), per-module `maxCallsPerTurn` and `maxTokensPerCall`, per-session budget.
- Priority queue: `critical` (blocking verdicts) > `interactive` (trimmer/triage, must finish fast) > `background`.
- Per-call timeout; on timeout the module must degrade to a no-op, never stall the main agent.
- Optional second endpoint (`strongModel`) used only by `background` jobs.
- Structured outputs: request JSON, validate with a schema, one repair retry max, then give up gracefully.
- Record every call to `sidecar_calls` for cost/latency analysis.

### 5.3 Config & kill switches
- `exocortex.config.jsonc` (global) + optional per-project override.
- Each module: `enabled`, budgets, thresholds. A slash command (e.g. `/exo`) to show status and toggle modules live; `/exo off` disables everything instantly.
- "Supervised mode" = supervisor enabled. Off by default.

### 5.4 Module interface (sketch)
```ts
interface ExoModule {
  id: string;
  init(core: Core): Promise<void>;
  // each hook optional; return value describes injections/rewrites, never mutates history directly
  onUserTurn?(e: UserTurnEvent): Promise<Injection | void>;
  onToolResult?(e: ToolResultEvent): Promise<ToolResultRewrite | void>;
  onAgentEnd?(e: AgentEndEvent): Promise<Continuation | void>;
  onSessionEnd?(e: SessionEndEvent): Promise<void>;
}
```
The adapter composes module outputs, enforces a global per-turn injection token budget, and logs every injection.

---

## 6. Modules

### 6.1 Supervisor (supervised mode) — first module to ship
**Goal:** when the main agent stops and claims completion, verify against the original goal and auto-continue if work is missing.

1. **Goal ledger** (at first user turn of a task): sidecar extracts 1–7 concrete acceptance criteria + any explicit check commands (tests, build) from the user prompt. Stored, not injected.
2. **Evidence gathering** (at `agent_end`): deterministic first — git diff summary, exit codes of the last test/build/lint runs seen in the trace, whether files mentioned in criteria were touched. Optionally run configured check commands.
3. **Verdict:** sidecar sees *only* the ledger + compact evidence (not the full transcript). Output: `complete | incomplete(missing[]) | failed | uncertain`.
4. **Continuation:** on `incomplete`, send a short, specific user-role message listing the missing criteria. On `uncertain`, do nothing (or notify the user).
5. **Guards:** max continuations per task (default 3); stop if two consecutive continuations produce no new diff; stop immediately if the user types anything; never continue when the agent asked the user a question (detect question-to-user endings — sidecar or heuristic).
6. Optional: N-way verdict voting across parallel sidecar calls for robustness (budgeted).

Every verdict is written to the trace — **these are the success/failure labels the memory module will learn from.**

### 6.2 Context trimmer
- On `tool_result` where output exceeds a threshold (e.g. > 2k tokens): sidecar extracts the lines relevant to the current goal/step; replace or prefix the result with the trimmed version plus a note that full output is saved (path in trace or temp file the agent can `read` if needed).
- Must be fast (interactive priority, tight timeout); on timeout fall back to deterministic truncation (head/tail + error-line grep).
- Never trim outputs the agent explicitly asked to read in full (e.g. `read` of a file it's editing) — make the policy configurable per tool.

### 6.3 Error triage
- On failing `tool_result` (non-zero exit, error flag, stack trace patterns): sidecar produces a ≤2-sentence diagnosis/hint, appended to the tool result.
- Later: also query memory for pitfall cards matching the error signature (deterministic signature: normalized error message + tool + file type).

### 6.4 Memory
Follow the design already agreed (summary):
- **Cards:** `type` (pitfall|procedure|fact|preference), `trigger` (keywords, file globs, error signatures), `content` (1–2 sentences + concrete example), `scope` (global/project/repo), `evidence` (trace refs), `valid_from`/`valid_to` (supersede, don't delete), utility stats (`injected`, `helped`, `hurt`).
- **Hot path:** hybrid retrieval (SQLite FTS5 BM25 + small local embedding model) with scope filters; inject ≤ ~400 tokens into the current user turn only if above threshold. Target < 50 ms, no LLM call.
- **Background worker (sleep-time):** runs only when no session is active. Reflector extracts candidates from strong signals (error→fix pairs, user corrections, supervisor verdicts, branch success/failure contrasts). Curator applies **incremental delta ops only** (ADD / MERGE / SUPERSEDE / RETIRE) — never wholesale rewrites (avoid context collapse).
- **Utility feedback:** after injection, credit/debit based on the turn's outcome and supervisor verdict; retire persistently low-utility cards.

### 6.5 Parallel attempts (later)
- On a hard step (repeated failures, or user command), fork session branches and run K attempts concurrently; select by deterministic checks, then by verdict. Record contrasting pairs for memory.
- Requires confirming pi's branch APIs support programmatic forking; otherwise drive extra pi instances via RPC mode.

---

## 7. Eval harness (build early)
- Drives pi in RPC mode, headless, against fixtures in `tasks/`: each task = repo snapshot (or git ref) + prompt + check command + optional max turns.
- Runs the same task set across configs (all off, each module on, all on), N repeats.
- Metrics: success rate (check command), turns to success, main-model tokens in/out, sidecar tokens, wall-clock, repeated-error rate, injection count, continuation count.
- Output: JSON results + a markdown summary table. Must be runnable as one command, e.g. `npm run eval -- --config all-off,supervisor`.
- Seed with ~10 small real tasks; grow from the user's own sessions later.

---

## 8. Build phases & acceptance criteria

**Phase 0 — Scaffold & verify**
- Monorepo skeleton per §3, lint/test/typecheck scripts green.
- `docs/PI_API_NOTES.md` written from the actual pi source.
- Minimal pi extension that logs every event to stdout behind a debug flag, loaded from `~/.pi/agent/extensions/` or settings.
- ✅ Done when: running pi with the extension prints the event sequence for a simple task, and the notes file documents real signatures.

**Phase 1 — Trace store + eval harness**
- All events persisted to SQLite; synthetic-content tagging.
- RPC-mode harness runs a task fixture and records metrics with Exocortex fully off.
- ✅ Done when: `npm run eval` produces a baseline table for ≥5 tasks.

**Phase 2 — Sidecar pool**
- Concurrency, reservation, priorities, timeouts, budgets, structured-output validation, call logging.
- ✅ Done when: a load test with 20 queued sidecar jobs never exceeds configured concurrency, and main-agent latency regression is measured and reported.

**Phase 3 — Supervisor**
- Goal ledger, evidence, verdict, continuation, guards, `/exo` toggle.
- ✅ Done when: eval shows supervisor-on vs off on the task set, with no runaway loops across all runs.

**Phase 4 — Trimmer + triage**
- ✅ Done when: eval shows main-model token reduction with no drop in success rate.

**Phase 5 — Memory**
- Card store, retrieval, injection, worker, utility feedback.
- ✅ Done when: replaying a task set twice (second pass with memory learned from the first) shows improvement over memory-off.

**Phase 6 — Parallel attempts.**

Do not start a phase until the previous phase's acceptance check passes. Commit small; keep `main` green.

---

## 9. Engineering rules for the implementing agent

- Read pi's source before using an API; never guess signatures. Log findings in `PI_API_NOTES.md`.
- Every module must fail closed to a no-op. An Exocortex bug must never break or stall a pi session.
- All sidecar prompts live in versioned files under `packages/*/prompts/`, not inline strings, so they can be tuned and A/B'd.
- Every injection/rewrite visible in the trace with module id and token count.
- Prefer deterministic signals over LLM judgment wherever possible; the sidecar model shares the main model's blind spots.
- Keep sidecar prompts short; the sidecar is also a small model.
- Record design decisions and deviations from this spec in `docs/DECISIONS.md`.
- Run pi inside a container or sandbox during development and eval — pi has no permission system.

## 10. Open questions (resolve and record in DECISIONS.md)
1. Exact pi mechanism for injecting into the current user turn without altering prior messages.
2. Can `tool_result` rewrites preserve the original output for the trace?
3. Programmatic session branching from an extension vs. multiple RPC-mode instances.
4. Local embedding model choice and runtime (in-process vs. separate server).
5. How to reliably detect "agent asked the user a question" vs. "agent claims done."
