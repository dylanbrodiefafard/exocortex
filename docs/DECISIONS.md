# Decisions

ADR-style log. `docs/BRIEF.md` is the original project brief. Where an entry here conflicts with the brief, **this file wins**. Newer entries supersede older ones; mark superseded entries rather than deleting them.

Format: **ID — title** · status · date, then Context / Decision / Consequences.

---

## Kickoff interview (2026-10-04)

Decisions made with the project owner before any code was written.

### D-001 — Purpose: daily driver + research testbed · accepted
- **Context:** Polish, generality and rigor all depend on who the user is.
- **Decision:** Exocortex is the owner's daily coding tool *and* a research testbed. A module stays on by default only after it proves itself in eval. Optimize for the owner's setup (below) over broad hardware/server support.
- **Consequences:** Install docs and multi-backend support are low priority. Eval rigor and measurability are high priority.

### D-002 — Success criteria (3-month horizon) · accepted
All four count, and each maps to modules and metrics:

| Goal | Primary modules | Metric |
|---|---|---|
| Higher task success rate | all | fixture pass rate vs. bare pi |
| Less babysitting | supervisor | user interventions per task; suggestion accept rate |
| Longer tasks survive | trimmer, compaction | success vs. session length; main-model tokens |
| Learns my codebases | memory | repeated-error rate across sessions; second-pass improvement |

### D-003 — Harness strategy: agnostic core, pi adapter only · accepted
- **Decision:** Keep the brief's rule that `@exocortex/core` never imports pi. Build only `pi-adapter`. Build an OpenCode adapter later only if wanted. No HTTP-proxy approach, because it would lose tool/event semantics.

### D-004 — Models: Qwen 3.8 27B now, Qwen 4 27B later · accepted
- **Decision:** Target Qwen 3.8 27B, and switch to Qwen 4 27B when it's released. Nothing may hard-code model-specific behaviour outside config and prompt files. The eval baseline must be re-run on every model change.

### D-005 — Inference server: owner's ninfer fork with a shared prefix cache · accepted, amended by D-023
- **Context:** The owner runs a custom server forked from ninfer. Its prefix cache is *shared across requests* (block/radix style, LRU eviction), not per slot. The owner can add server features.
- **Decision:**
  - Talk to it over the OpenAI-compatible API. Isolate server-specific extensions (cache hints, priority classes) behind a small `InferenceClient` interface in core.
  - Prompt-cache stability (brief §1 constraint 3) is critical: never mutate prior messages or the system prompt.
  - We may propose server-side features (e.g. request priority, cache-pinning for the main session) where they beat client-side workarounds. Record each one here.
- **Open:** exact concurrency limit, context length, and whether the server exposes cache-hit stats (useful for eval metrics). → Phase 0 notes.

### D-006 — Sidecars use the same model as main · accepted
- **Decision:** One loaded model (the same 27B) serves main and sidecars. The pool is the only concurrency control. Because sidecars share main's blind spots, prefer deterministic signals wherever possible (brief §9).
- **Consequences:** No separate small model to manage. Sidecar latency is 27B latency, so the trimmer/triage timeouts and fallbacks matter.

### D-007 — Sidecar context: hybrid, per module · accepted, amended by D-024
- **Context:** With a shared prefix cache, a sidecar that sends main's exact conversation and then appends an instruction gets its prefill almost free.
- **Decision:** Each module declares a context strategy:
  - `fork-prefix` (trimmer, triage, compaction): main's exact message prefix + a short appended sidecar instruction. Cheap, and it knows the current goal.
  - `isolated` (supervisor verdicts, goal ledger, memory reflection): short purpose-built prompts with only ledger + evidence, so they don't inherit main's framing or self-deception.
- **Consequences:** `fork-prefix` must reproduce main's request byte for byte (system prompt, tool schemas, message serialization), or it gets no cache benefit. The adapter must expose the exact outgoing request, which needs verifying in pi's source in Phase 0. Measure the cache-hit rate.

### D-008 — Thinking mode: configurable, undecided · open
- **Decision:** Thinking on/off and thinking budget are per-module config (main is out of scope — that's the owner's pi setting). The default for sidecars is off, with strict JSON output. Revisit with eval data and when Qwen 4 lands.

### D-009 — Strictly local · accepted (amends brief §1.6)
- **Decision:** Nothing leaves the machine. The brief's optional remote `strongModel` is **removed**. Background work (memory curation, reflection) runs on the local model while idle. Eval judging, where needed, also runs locally.

### D-010 — Supervisor: suggest, don't act; graduate to auto later · accepted (amends brief §6.1.4 and §5.3)
- **Decision:**
  - On `incomplete`, the supervisor **suggests** a continuation (the drafted message listing missing criteria) and does not send it. Preferred UX: pre-fill the editor or offer one-keypress accept, if pi's UI API allows it (verify in Phase 0). Otherwise use a notification.
  - Log every suggestion's accept/edit/reject to the trace.
  - Once accept rate is high in real use, add an **opt-in** auto-continue mode, with all brief §6.1.5 guards (max continuations, no-diff stop, stop on user input, never after a question to the user).
  - In eval (headless), the harness may auto-accept suggestions so supervisor-on vs. off can be measured.

### D-011 — Supervisor may run inferred + configured check commands · accepted
- **Decision:** Evidence can include running (a) check commands declared in per-project config and (b) check commands the goal ledger extracted from the user's prompt (e.g. "make sure `cargo test` passes").
- **Guards:** run only at `agent_end` while the agent is idle (no concurrent mutation of the working tree); per-command timeout; output goes to the trace, not the main context; inferred commands are shown in the status line when run. Commands run in the real working tree, just as if the agent had run them. No copies or worktrees.

### D-012 — Visibility: quiet status line · accepted
- **Decision:** One status line (e.g. `exo: trim 3 · triage 1 · mem 2 · sup: suggestion`). Details are available through `/exo log` and the trace. A config `verbosity: debug | normal | silent` covers development.

### D-013 — No state duplication on real work · accepted
- **Context:** The owner has found worktrees and containers unworkable on complex codebases.
- **Decision:** Exocortex never forks, copies or isolates the owner's real working tree. Anything that needs isolation happens only in the eval sandbox, against small fixture repos, and must have zero side effects on real sessions.

### D-014 — Evaluation: fixtures first, plus real-session metrics · accepted (refines brief §7)
- **Decision:**
  1. **Fixture eval** (gates module defaults): pi in RPC mode, headless, on small self-contained fixture repos copied into a temp dir per run. Configs: all-off, each module on, all-on, N repeats.
  2. **Real-session metrics** (passive): computed from the trace of daily use: verdicts, suggestion accept rate, user interventions, repeated errors, tokens. No isolation needed.
- **Fixture sources:** hand-written small tasks plus a subset of a public benchmark that fits tiny repos (Exercism / Aider-polyglot-style). Distilling fixtures from bad real sessions comes later.
- **Fixture languages:** weighted to the owner's ecosystems: **Rust, Go, C++, Python** (D-016).
- **Sandboxing:** the fixture runner uses a temp directory per run, and a container if available. Fixtures are tiny, so this is cheap.

### D-015 — Phase 6 becomes reasoning-only parallelism · accepted (amends brief §6.5)
- **Decision:** No forking of sessions or working trees. On a hard step (repeated failures or a user command), run K parallel sidecar *diagnoses/plans* (no file writes, `fork-prefix` context). A judge selects one (deterministic signals first), and it's offered to main as a suggestion, consistent with D-010. Record contrasting candidates for memory.

### D-016 — Target ecosystems: Rust, Go, C++, Python · accepted
- **Decision:** Triage heuristics, error-signature normalization (memory triggers) and fixtures prioritize `cargo`/`rustc`, `go build/test`, C++ compilers/CMake/ctest, and Python tracebacks/pytest. TS/JS is not a priority.

### D-017 — New module: compaction · accepted (amends brief §6)
- **Context:** A 27B model's effective context is far shorter than its nominal window, and "longer tasks survive" is a goal.
- **Decision:** Add `modules/compaction`. Hook pi's `session_before_compact` to provide a custom summary built from the goal ledger + trace (done, remaining, key facts, files touched, last failing check), generated with `fork-prefix` context. Pi's default compaction is the fallback on timeout or failure. Schedule it as part of Phase 4, with the trimmer.

### D-018 — Memory: repo-scoped by default · accepted
- **Decision:** Cards attach to the repo they came from. Promote one to global only when the same lesson independently appears in 2+ repos. Project/repo identity comes from the git remote URL (fallback: repo root path).

### D-019 — Embeddings served by the inference server · superseded by D-026
- **Decision:** Serve a small embedding model (e.g. a Qwen3-Embedding-class ~0.6B) as an endpoint on the owner's server, behind the same `InferenceClient`. No in-process ML dependencies in pi's process. Hybrid retrieval = FTS5 BM25 + embeddings, per the brief. Needed only from Phase 5.

### D-020 — Phase order: as in the brief · accepted
0 scaffold & verify → 1 trace + eval → 2 sidecar pool → 3 supervisor (suggest mode) → 4 trimmer + triage + compaction → 5 memory → 6 reasoning-only parallelism. A phase starts only after the previous phase's acceptance check passes.

### D-021 — Toolchain: Node + npm workspaces, strict and fast · accepted
- **Context:** pi is a Node/npm TypeScript project. The owner is new to TypeScript and wants fast, pedantic checks and fast, rigorous tests. Choices were delegated.
- **Decision:**
  - **Runtime:** Node (match pi's minimum version, verified in Phase 0) with **npm workspaces**. ESM only.
  - **TypeScript:** `strict` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`, `isolatedModules`. Project references per package.
  - **Lint + format:** **Biome** (one fast Rust-based tool) with recommended rules plus stricter opt-ins (no `any`, no non-null assertions, no floating promises where supported). Lint warnings fail CI.
  - **Unused code/deps:** **knip**.
  - **Schemas / structured output:** **TypeBox**, matching pi, so there's one schema library and JSON Schema comes for free for structured-output requests.
  - **Tests:** **vitest**. Unit tests must not need pi or a model server: core gets fakes (`FakeInferenceClient`, fake clock, in-memory SQLite). **fast-check** property tests for the pool scheduler, budget accounting and the token-budget composer. Separate, explicitly invoked integration tests against a real pi and server.
  - **SQLite:** `node:sqlite` if pi's minimum Node version ships it unflagged, else `better-sqlite3`. Decide in Phase 0.
  - **CI:** GitHub Actions: typecheck, lint, knip, unit tests on every push. Evals run locally on the owner's GPU, never in CI.
- **Consequences:** The repo should be easy to work in without TS expertise: a single `npm run check` runs everything that CI runs.

### D-022 — Branching: trunk-based on `main`, short-lived branches, phase tags · accepted
- **Context:** Solo owner plus coding agents, pre-v0, no external users yet. Choice delegated.
- **Decision:**
  - `main` is the only long-lived branch and must stay green (`npm run check` + CI).
  - Work happens on short-lived branches (one slice of a phase each, ideally < ~1 day of work), merged into `main` by PR with a **squash merge**. Agent sessions use their assigned branch names.
  - No long-lived `v0` branch. It would only collect merge debt, and nobody depends on `main` being stable yet. Unfinished features are kept safe by D-001's "default off until proven" module toggles, not by branches.
  - Tag each phase whose acceptance check passes: `phase-0`, `phase-1`, … Tag `v0.1.0` when Phase 3 (supervisor in suggest mode) is usable daily. Before 1.0, semver minor versions may break things.
  - Commit messages: Conventional Commits (`feat(core): …`, `fix(pool): …`, `docs: …`).
- **Consequences:** The owner's daily install should track a tag, not `main` HEAD.

---

## ninfer survey (2026-10-04)

Findings from reading `dylanbrodiefafard/ninfer` at `e04fad3` (paths are relative to that repo). The owner's description: 6 decode slots, prefill interleaved (or soon will be), a shared KV pool of about 700k tokens, and a model maximum of about 260k.

### D-023 — ninfer facts Exocortex designs around · accepted (amends D-005)
- **Hardware/model:** single RTX 5090. Product identity is `qwen3.8-27b/nvfp4`, with optional MTP/DFlash speculative decoding. One resident model; the `model` field is informational.
- **API:**
  - OpenAI `/v1/chat/completions`, `/v1/responses`, Anthropic `/v1/messages`, plus `count_tokens`/`input_tokens`, `/health` and `/v1/models`.
  - No `/v1/completions`, `/v1/embeddings` or `/metrics`.
- **Structured output:**
  - `response_format` must be `text`, so there's no JSON mode or `json_schema`.
  - XGrammar constrains **tool-call arguments** only (`docs/serving.md:341-396`).
  - → Sidecars that need JSON use a **forced tool call** (a single tool whose parameters are the output schema, with a named `tool_choice`). The response is validated with TypeBox, with one repair retry (brief §5.2). Whether a named `tool_choice` actually enforces the grammar is a *Phase 2 check*. Fallback: prompt for JSON and validate.
- **Prefix reuse is checkpoint-based and single-owner, not a shared radix cache** (`docs/maintainer/paged-kv-cache.md` §10, `docs/maintainer/concurrent-inference-architecture.md` §6.4-6.5):
  - The KV *pool* is shared (`--kv-capacity`), but a saved prefix ("retained bundle") is claimed by **one** request at a time.
  - There's no copy-on-write or fan-out, and no arbitrary longest-common-prefix reuse.
  - Reuse happens only at: the previous request's end frontier (exact append), a turn-closure checkpoint, a context-checkpoint ladder (MTP/DFlash only, at 24k/36k/53k/78k/102k/152k tokens) and a single turn-rollback pin.
  - Qwen3.x's hybrid linear-attention state is why: a hit needs a complete saved recurrent state at the exact boundary.
- **Template effects on prefix identity:**
  - With `preserve_thinking=false` (the default), reasoning is stripped from assistant turns before the last real user message.
  - The reasoning-effort instruction and the tool list are rendered into the leading system block. So a request with a different effort or thinking setting, a different tool list, or `tool_choice` none/named does **not** share main's prefix.
- **Scheduling:**
  - FIFO queue with backfill.
  - Admission reserves KV for prompt + `max_tokens` (the default `max_tokens` is 8192).
  - One request prefills at a time, using a "prefill-first" policy, so **a long sidecar prefill stalls main's decode**.
  - No priority, QoS or preemption (listed as non-goals in `AGENTS.md:78-84`).
  - Client disconnect cancels at the next chunk/round boundary.
- **Observability:**
  - Per-request `usage.prompt_tokens_details.cached_tokens`, plus `…ninfer.{reuse_source, prefix_reuse_path, ttft_ms, prefill, decode}`, and `reasoning_tokens`.
  - Optional `--request-log-jsonl`. The eval and trace store will record these.
- **Sampling:** the default "p-less" sampler ignores top_p/top_k/penalties, and Qwen3.8 defaults to temperature 2.0. Sidecars set their own temperature explicitly. Whether low temperature behaves well under p-less is a *Phase 2 check*.
- **Discrepancy:** the public code caps `--max-concurrency` at 1-4, but the owner runs 6 slots. Presumably that's local or unpushed work; the pool reads the concurrency limit from config and doesn't hard-code it.

### D-024 — Sidecar context under single-owner reuse · superseded by D-028 (kept as the fallback path)
- **Context:** D-007 assumed fork-prefix sidecars get main's prefix almost free. Under D-023 that's only true when the sidecar runs **while main is idle**, and even then the sidecar *claims* main's saved state. Main resumes via the turn-rollback pin or turn-closure checkpoint, but that is unverified.
- **Decision:**
  1. **Default is `isolated`**: short prompts, cold prefill, cheap because they're short. Keep them well under ~4k tokens so they don't stall main's decode.
  2. **`fork-prefix` is allowed only on idle-main hooks**, where main is waiting on us anyway: trimmer/triage at `tool_result` (before main's next request), compaction, and supervisor-free moments at `agent_end`.
     - At most **one** fork-prefix sidecar per main checkpoint at a time, serialized. There's no N-way fan-out on main's prefix, so voting/parallel diagnoses (D-015) use isolated or compact-summary prompts.
  3. A fork-prefix request must be byte-identical to main's last request up to the suffix:
     - same system prompt and tool list;
     - same thinking/effort settings;
     - no `tool_choice` none or named, so these return prompted JSON, not forced tool calls;
     - the instruction appended as a **system**-role message, which doesn't move the last-user index and so doesn't trigger reasoning stripping.
  4. **Phase 2 must measure it before any module relies on it:** sidecar `cached_tokens`, *and* main's `cached_tokens` on its next request (does main still hit after a sidecar claimed its state?). If main loses its cache, fork-prefix is disabled by default.
- **Consequences:** Sidecars usually can't see main's full context. Modules get compact, deterministic context from the trace instead (current goal, last command, error lines). That fits the "keep sidecar prompts short" rule anyway.

### D-025 — Pool policy for ninfer · amended by D-028
- Every sidecar sets an explicit small `max_tokens` (admission reserves it) and explicit sampling params.
- `reservedForMain` stays (default 2 of the configured slots). Since the server has no priority, Exocortex's own queue is the only priority mechanism. Interactive sidecars get tight client-side timeouts and abort through disconnect, which ninfer honours.
- A per-sidecar prompt-size cap protects main's decode from prefill stalls.
- Background jobs (memory reflection) run only when no main session is active (brief §6.4 already says this).

### D-026 — Embeddings: BM25 first, embeddings via a separate endpoint later · accepted (supersedes D-019)
- **Context:** ninfer has no embeddings endpoint, supports a closed model set, and lists new features as non-goals. VRAM on the single 5090 is fully used by weights + KV.
- **Decision:**
  - Phase 5 ships with FTS5 BM25 + structured triggers (file globs, normalized error signatures) only.
  - Add embeddings only if eval shows retrieval recall is the bottleneck. They'd go behind `InferenceClient.embed()` against any OpenAI-compatible `/v1/embeddings` server, e.g. a small CPU-hosted embedding model.

### D-027 — Candidate ninfer features (owner's call, not blocking) · superseded by D-032
Ranked by value to Exocortex. None of these is required for v0.
1. **Request priority classes** (main > interactive sidecar > background) in admission and prefill ordering, or at least a "low priority: don't preempt main's decode" flag.
2. **Retained-bundle fork / copy-on-write**, so a sidecar can reuse main's prefix without claiming it. This is the biggest cost lever for fork-prefix sidecars. Upstream notes say it needs a redesign (`paged-kv-cache.md:840-842`).
3. **User-supplied `json_schema` structured output**, reusing the existing XGrammar tool-argument path.
4. An `/v1/embeddings` endpoint (lowest; D-026 doesn't need it).

### D-028 — Design for the best-case ninfer; degrade by capability · superseded by D-032
- **Context:** The owner controls the fork and will implement whatever Exocortex needs. The requirements were in `docs/NINFER_REQUIREMENTS.md` (R1–R13, since removed).
- **Decision:** Exocortex's primary design assumes:
  - **fork-on-reuse** (R1), **priority classes** (R2) and **retention control** (R3);
  - **prompt-neutral `json_schema`** (R4);
  - **append-only `continue_from`** (R5), **decode-time thinking budget** (R6) and **capability discovery** (R7).
- **Consequences for Exocortex:**
  - **Sidecar context (restores D-007):**
    - `fork-prefix` is the default for trimmer, triage, compaction, reasoning-parallel diagnoses (D-015) and memory relevance checks.
    - It's implemented via `continue_from` (R5), sending only the appended instruction, or via exact-prefix fork (R1) if R5 is missing.
    - Parallel forks from one frontier are allowed.
    - The supervisor's verdict stays `isolated` *by design* (anti-bias), not for cost.
  - **Requests:** sidecars send `retain:"none"`, `priority:"interactive"|"background"`, `thinking_budget_tokens` per module config and `response_format: json_schema`. Main is tagged `retain:"session"` with a per-pi-session `session_id` (body field or `X-Ninfer-*` header — verify in Phase 0 which pi allows).
  - **Pool:** server priority does the real scheduling. Exocortex's own queue only enforces per-module budgets and caps in-flight sidecars at `maxConcurrent - reservedForMain`.
  - **Fallbacks:** at startup the `InferenceClient` reads `/v1/ninfer/capabilities`. Each missing feature switches on its fallback:
    - no R1/R5 → D-024 (isolated, or a single serialized fork);
    - no R2 → client-side queue + prompt-size cap;
    - no R4 → forced tool call, else prompted JSON + validate;
    - no R6 → thinking settings copied from main.
  - Fallbacks are tested with a fake server that advertises each capability subset.
  - **Measurement:** the Phase 2 load test doubles as the acceptance test for R1–R3, recording `cached_tokens`, main's inter-token latency and `queue_wait_ms`.

---

## Phase 0 (2026-10-04)

### D-029 — Pi integration contract · accepted (resolves open questions 1, 2, 6, 7, 13)
Based on `docs/PI_API_NOTES.md` (pi `@earendil-works/pi-coding-agent` 1.0.2, formerly `@mariozechner/*`).
- **User-turn injection:** return a `custom_message` from `before_agent_start` (`customType: "exo.<module>"`, `display: false`, provenance in `details`).
  - Pi persists it right after the user message and replays it unchanged, so the prefix stays stable.
  - Mid-run injection uses `custom_message` drafts from `turn_end`/`agent_before_settle`, or `sendMessage({deliverAs:"steer"})`.
- **Never use these for injection:**
  - the `context`/`context_with_system` events, which are ephemeral per request and would break prefix caching;
  - changes to the system prompt or active tool set mid-session (on openai-completions they're folded into the leading system message).
- **Tool-result rewrites** (trimmer, triage): rewrite in `tool_result`. Pi persists only the rewritten version, so the original goes to the trace store. Merge `details.exo = {module, originalRef}` and never replace `details`, because renderers read it.
- **Synthetic-content tagging:** `customType` prefix `exo.` for messages; `details.exo` for rewrites. Exocortex's own extraction excludes both.
- **Main-request tagging for ninfer (D-028):** the `before_provider_request` payload mutation adds the `ninfer` object (`session_id`, `retain`, `priority`); `before_provider_headers` covers header-only fallbacks. This is also where the adapter observes the exact outgoing request.
- **Completion signal:** `agent_settled`, not `agent_end`, because retries, compaction and continuations can follow `agent_end`.
- **Supervisor suggestions (D-010):** `ctx.ui.setEditorText` pre-fills the editor, so Enter accepts. In RPC it surfaces as `set_editor_text`, and in print/json mode (`hasUI=false`) as a notify/log only.
- **Handlers are awaited with no timeout, and an uncaught async error exits interactive pi.** Therefore:
  - the adapter wraps every hook in try/catch plus a per-hook time budget;
  - background sidecar work never runs as an unhandled promise.
- **Sidecar calls** use Exocortex's own `InferenceClient` (fetch), not `ctx.modelRegistry.complete()`, because they need ninfer-specific fields and must stay harness-agnostic. Endpoint and model come from Exocortex config.
- **Error triage signal:** the bash `exit_code` exists only in `tool_result.structuredContent` and isn't persisted, so the adapter copies it into the trace.

### D-030 — Repo mechanics settled in Phase 0 · accepted (refines D-021, brief §3)
- **No build step:** packages export `src/index.ts`. Pi's jiti loader runs the TypeScript directly, including across workspace symlinks (verified), and vitest does the same. `tsc` is typecheck only. That's why `erasableSyntaxOnly` is on: no enums or namespaces, only type-strippable TS.
- **One root `tsconfig.json`** covers all packages instead of project references. That's simpler while there are only a few packages; revisit if typecheck gets slow.
- **Pi version:** pinned exactly as a dev dependency of `@exocortex/pi-adapter` (a peer at runtime). Upgrades are deliberate, and `pi-events.test.ts` fails to typecheck if pi adds an event the adapter doesn't list.
- **New package `@exocortex/testkit`:** test-only fakes, starting with a scripted OpenAI-compatible server.
- **The real-pi integration test is in the default suite:** `pi-cli.integration.test.ts` spawns the actual pi CLI against the fake server in about 1 s. It runs in CI, so pi upgrades can't silently break the contract.
- **Packages are created when their phase starts** (`worker`, `eval`, modules), not as empty stubs, because knip rejects dead code. Modules will live at `packages/mod-<name>` so the `packages/*` workspace glob covers them. This deviates from the brief's `packages/modules/<name>`.
- **SQLite:** `node:sqlite` (pi requires Node ≥22.19, where it's unflagged). FTS5 is verified available. It prints an `ExperimentalWarning` on Node 22, so how to keep that out of the TUI is a Phase 1 task.
- **Lint:** Biome's `useLiteralKeys` is off because it conflicts with TypeScript's stricter `noPropertyAccessFromIndexSignature`.

### D-031 — pi ↔ ninfer provider config · proposed (verify in Phase 2); generalized by D-032
Add ninfer to `~/.pi/agent/models.json` as an `openai-completions` provider with:
- `compat: { supportsDeveloperRole: false, supportsStore: false, supportsReasoningEffort: false, maxTokensField: "max_completion_tokens", thinkingFormat: "qwen-chat-template" }`
- `contextWindow` set to the `--max-context` ninfer runs with.

`qwen-chat-template` sends `chat_template_kwargs: {enable_thinking, preserve_thinking: true}`. ninfer accepts both keys. Keeping thinking preserved means earlier turns aren't re-rendered, which helps prefix stability (D-023).

Open check: Exocortex's injected `custom_message` reaches ninfer as a second consecutive `user` message. Verify that ninfer's Qwen template renders it.

---

### D-032 — Engine-agnostic: standard OpenAI API + engine profiles; ninfer asks limited to parity · accepted (supersedes D-028, D-027; amends D-023, D-024, D-025)
- **Context:** The owner pushed back on coupling Exocortex to ninfer. ninfer will add a feature if another mainstream engine (vLLM, SGLang, llama.cpp) has it and it genuinely matters, or if it's a compelling state-of-the-art feature. Nothing Exocortex-specific.
- **Decision:**
  - Exocortex uses only the standard OpenAI Chat Completions API plus widely supported extensions. These are the F1–F9 list in `docs/INFERENCE_ENGINES.md`: prefix caching, `cached_tokens`, `json_schema`, `chat_template_kwargs`, `priority`, `logprobs`, `n`.
  - No `ninfer` body fields, no custom endpoints, no session or retention APIs.
  - An **engine profile** in config states which features the deployed engine supports. Modules take documented fallbacks when a feature is missing.
- **Fork-prefix sidecars** don't need a server API. The adapter captures main's exact outgoing request in `before_provider_request` (D-029). A sidecar resends it byte for byte plus an appended message, and the engine's automatic prefix cache does the rest.
  - The suffix goes in as a `user` or `system` message, whichever the template renders as a pure suffix. Eval checks this via `cached_tokens`.
  - Fork-prefix is enabled per module only when the profile claims F1 *and* eval confirms the hits.
- **Without F1** (ninfer today): D-024's rules apply: isolated prompts by default, at most one serialized fork while main is idle, and a cap on prompt size.
- **Without F5:** Exocortex's own queue (caps on in-flight sidecars and sidecar prompt size, `reservedForMain`) protects main.
- **ninfer parity asks** are in `docs/INFERENCE_ENGINES.md`, ranked: F1 concurrent prefix sharing, then F3 `json_schema`, F4 template conformance, F6 logprobs, F5 priority, F7 `n>1`. No non-standard features are requested; two "beyond parity" ideas are parked until eval evidence justifies them.

---

## Phase 1 (2026-10-04)

### D-033 — Trace store, config and eval harness as built · accepted (Phase 1; resolves open question 15)
- **Config:**
  - Sources: defaults ← `~/.exocortex/config.jsonc` (or `EXO_CONFIG`) ← `<cwd>/.exocortex/config.jsonc`, deep-merged and TypeBox-validated.
  - Unknown keys or invalid values **disable Exocortex** (fail closed), and pi shows a warning in UI modes. A missing `EXO_CONFIG` file counts as a problem.
  - Example: `exocortex.config.example.jsonc`.
- **Trace store (`@exocortex/core`):**
  - One SQLite DB per user by default; eval uses one per run. WAL mode, `node:sqlite`.
  - Only Node's SQLite `ExperimentalWarning` is suppressed, and only while the module loads.
  - Schema v1 has just `sessions` and `events`. The brief's `injections`, `verdicts` and `sidecar_calls` tables arrive as migrations in the phases that write them.
  - Appends are buffered in memory and written in one transaction per flush (after 50 ms, or at 256 ops, at `agent_settled`, or at shutdown). Write errors go to a callback and never throw into pi.
- **Event mapping (pi → trace):**
  - Kinds: `session.start/end`, `user.input`, `llm.request`, `message`, `tool.call`, `tool.result`, `turn.end`, `agent.settled`, `compaction`, `model.change`.
  - `llm.request` stores a **fingerprint**, not the payload: a hash per message, the tools hash, total characters and params. That keeps the DB small and still lets eval measure prefix stability.
  - `message` stores the full message, minus inline binary data.
  - `tool.result` stores the **original** tool output plus the bash `exit_code`.
  - `exo.*` custom messages are tagged `synthetic` with their module.
- **Eval harness (`@exocortex/eval`):**
  - **Own RPC driver** instead of pi's `RpcClient`, because it must auto-dismiss extension dialogs, enforce turn and wall-clock limits, kill whole process groups, and keep pi's stderr out of the console.
  - **Runs** go sequentially, one main agent at a time, so they don't compete for the inference server.
  - **Workspace** per run: copy the fixture's `repo/` into the run dir and `git init` + commit it, so diffs are visible.
  - **pi flags:** `-ne -ns -np -nc --no-themes`, `--session-dir` per run, Exocortex loaded with `-e`. The user's `~/.pi/agent` supplies models and auth unless `--pi-agent-dir` is given.
  - **Metrics** come only from the trace: turns, tokens (input/cached/output), cache-hit rate, prefix-kept rate, tool errors, repeated-error rate (deterministic normalized signatures), injections, continuations, compactions. The check command decides success.
  - **Fixtures:** `tasks/<id>/{task.json, repo/, solution.patch}`. `npm run eval -- --validate` (also run in CI) requires the pristine repo to fail the check and the solution to pass. Six seed tasks: 3 Python, 1 Go, 1 Rust, 1 C++.
- **Phase 1 acceptance status:**
  - Mechanics are verified end to end against a scripted fake model: success, failure and max-turns paths, plus the report for all 6 tasks.
  - The required baseline table on a real model has to be run on the owner's machine: `npm run eval -- --model <provider>/<model> --repeat 3`. Tag `phase-1` after that table exists (it now does: D-034).

---

### D-034 — Phase 1 baseline: fixtures are at ceiling · accepted (2026-10-04)
- **Run:** owner's machine, model `ninfer/coding` (Qwen3.8-27B on ninfer), config `all-off`, 6 tasks × 3 repeats.
- **Result:**
  - **Success:** 18/18 (100%), every task 3/3.
  - **Per run (mean):** 5.3 turns, 3.1k uncached input tokens, 17.6k cached input tokens, 2.7k output tokens, 7 s median wall clock.
  - **Cache hit 85%, prefix kept 100%:** pi's main loop is prefix-stable and ninfer's prefix reuse works for append-only conversations.
  - **0 repeated errors, 0 abnormal runs.**
- **Phase 1 acceptance:** met. The baseline table exists for ≥5 tasks.
- **Consequence:** the seed tasks are **too easy to measure any module**. At 100% success, the supervisor, trimmer, triage and memory can only show cost, never benefit.
  - Before any module's on/off comparison counts as evidence, the task set needs headroom: a baseline success rate of roughly 30–70% on this model.
  - The seed tasks stay as a fast smoke and regression set (`tags: ["small"]`).

---

### D-035 — Hard task tier · accepted (2026-10-04; calibration pending)
- **Context:** D-034 showed the seed tasks are at ceiling.
- **Decision:** add a `hard` tier of 12 tasks, three per failure mode a module targets. Tag them so results can be sliced:

  | Failure mode | Tasks |
  |---|---|
  | `spec-compliance` (supervisor) | `h-py-todo-cli`, `h-go-ratelimiter`, `h-rust-ini-parser` |
  | `error-recovery` (triage) | `h-rust-borrow-refactor`, `h-cpp-template-errors`, `h-go-aliasing-bug` |
  | `noisy-output` (trimmer) | `h-py-log-analyzer`, `h-py-noisy-test-suite`, `h-cpp-build-log` |
  | `navigation` / `algorithmic` | `h-py-mini-framework`, `h-go-multi-package-config`, `h-rust-forth` |

- **Harness support:**
  - **`hidden/` acceptance overlays:** applied after the agent settles, and during validation. Every hidden requirement must be stated in the prompt.
  - **`--tags`** selects a tier.
  - **Workspaces under the OS temp dir,** so the agent can't read `tasks/` (solutions, hidden tests).
  - **Task id must equal its directory name;** `--tasks` filters by directory before loading anything.
- **Resource safety:** checks that could blow up on a wrong solution cap their memory. `h-rust-forth` runs its test binary under `ulimit -v 4 GiB`, because a naive exponential expansion would otherwise exhaust host RAM next to the inference server.
- **Calibration:** see D-037.
  - **Originally pending.** The owner runs `npm run eval -- --tags hard --repeat 3`. Tasks outside a 1/3–2/3 success rate get reworked or dropped, and the decision is recorded here.
  - **Authors' guesses:** `h-go-multi-package-config`, `h-py-noisy-test-suite` and `h-rust-forth` may land too easy; `h-py-log-analyzer` (six bugs) and `h-py-mini-framework` may land too hard.
- **Authoring rules:** `docs/EVAL_TASKS.md`.

---

### D-037 — Hard tier calibration, round 1 · accepted (2026-10-04)
- **Run:** owner's machine, `ninfer/coding`, `all-off`, 12 hard tasks × 3 repeats.
- **Aggregate:** **23/36 (64%)**, inside the 30–70% band. 14.1 turns, 254k cached and 13.5k uncached input tokens, and 18k output tokens per run (mean); median wall clock 68 s. Cache hit 95%, prefix kept 100%, no abnormal runs.
- **Per task:**

  | Band | Tasks |
  |---|---|
  | In band (1/3–2/3) | `h-cpp-build-log` 1/3, `h-go-multi-package-config` 1/3, `h-go-ratelimiter` 1/3, `h-rust-ini-parser` 2/3 |
  | 3/3 | `h-cpp-template-errors`, `h-go-aliasing-bug`, `h-py-mini-framework`, `h-py-noisy-test-suite`, `h-py-todo-cli`, `h-rust-borrow-refactor` |
  | 0/3 | `h-py-log-analyzer`, `h-rust-forth` |

- **Interpretation:**
  - With 3 repeats, per-task rates are coarse. A task whose true rate is 0.7 scores 3/3 about a third of the time. The tier is judged on its **aggregate**, and that has headroom in both directions.
  - Statistical power is the real constraint. At 36 runs, the standard error of the aggregate rate is about 8 points, so module comparisons should use `--repeat 5` (60 runs per config) or more. Report a difference as real only when it holds across repeats.
- **Actions:**
  1. Keep every task for now; none gets dropped on one round of data.
  2. **0/3 tasks:** diagnose from their check logs before changing anything, to separate unfair hidden tests from merely hard ones. Then lower the difficulty, e.g. fewer bugs in `h-py-log-analyzer`.
  3. **3/3 tasks:** re-measure with more repeats once modules exist. Harden only the ones that stay at 100% and belong to the failure mode a phase targets.
  4. Spec-compliance (the supervisor's tasks) is at 6/9, which is enough headroom for Phase 3.
- **Follow-up (same day):**
  - **`h-py-log-analyzer`:** a run-3 check log showed a crash on hidden seed 7, plus 10 failures and 2 errors.
    - The generator emits every rare format with fixed per-entry probabilities over about 34k entries, so the visible seed-1 log contains every format the hidden seeds use. The task is fair; there are just too many bugs at once.
    - Two of the six (the nested JSON `error.code`, and timestamp comparison across UTC offsets) are now fixed in the starting code. That leaves four: the invalid-UTF-8 crash, the apostrophe/`shlex` crash, level aliases with continuation lines, and the root-cause exception.
  - **Python 3.13:** the owner's machine runs it, and all Python tasks re-validate under 3.13 as well as 3.11.

---

## Phase 2 (2026-10-04)

### D-036 — Sidecar pool and inference client as built · accepted (Phase 2; refines D-025, D-032)
- **Engine config:** `engine.{baseUrl, model, apiKey, profile, features}`.
  - Unset `baseUrl`/`model`/`apiKey` fall back to pi's main model when it is an `openai-completions` provider. Its API key comes from pi's model registry, with a 2 s cap.
  - `apiKey` accepts `$NAME`.
  - Profiles (`generic`, `vllm`, `sglang`, `llamacpp`, `ninfer`) map to the F1–F7 flags in `docs/INFERENCE_ENGINES.md`. They're conservative where support depends on server flags, and per-feature overrides win.
- **Inference client:**
  - Plain non-streaming `/chat/completions` over `fetch`.
  - `priority`, `response_format: json_schema` and `chat_template_kwargs.enable_thinking` are sent only when requested; the first two also need the profile to support them.
  - Usage includes `cached_tokens` when reported.
  - Errors are typed: `http`, `network`, `aborted`, `bad_response`.
- **Structured output:**
  - `json_schema` when the engine supports it; otherwise an appended *user* message with the JSON Schema.
  - JSON is extracted tolerantly (fences, `<think>` blocks, outermost braces) and TypeBox-validated.
  - One repair turn quotes the validation error, then it gives up (`invalid_output`).
- **Pool:**
  - Slots = `maxConcurrent − reservedForMain`, reserved at all times, because main can start at any moment.
  - Priority classes `critical > interactive > background`, FIFO within a class.
  - `background` is held while main is active (`agent_start` … `agent_settled`).
  - Each call has an end-to-end deadline, queueing included. On expiry the HTTP request is aborted, so the engine stops generating.
  - Per-module per-turn call caps and `max_tokens` clamps; an optional session token budget; cancellation by signal or filter.
  - **`run()` never rejects:** every failure resolves `ok:false` with an outcome, so modules degrade to a no-op.
  - Engine `priority` mapping when supported: critical 0, interactive 1, background 2. Main sends none, which is 0.
- **Turns:** user input (not extension input) starts a new turn and cancels non-background calls from the previous one.
- **Trace:** schema v2 adds `sidecar_calls`, one row per call (outcome, prompt hash, queue/latency, attempts, tokens including cached). Eval reports sidecar tokens and failures per config.
- **`/exo` command:** `status` and `ping` (a one-call engine check). It arrives ahead of Phase 3's toggles because it's the only way to check sidecar connectivity by hand.
- **Phase 2 acceptance:**
  - (a) A test submits 20 queued jobs over HTTP and they never exceed the configured concurrency (`maxInFlight` = slots). A fast-check property covers the slot cap and priority order over random job mixes.
  - (b) **Pending owner run:** the main-agent latency regression is measured by `npm run loadtest`, comparing main alone with main beside 20 sidecars kept in flight. Tag `phase-2` once that report exists (it does: D-038).

---

### D-038 — Load tests on ninfer: pool config must match the engine's real slots; Phase 2 acceptance met · accepted (2026-10-04)
- **Sidecar check:** `/exo ping` on the owner's machine took 75 ms, with 15 of 19 prompt tokens cached. Sidecars work against ninfer, using pi's main model as the engine.
- **Load test as run:**
  - ninfer had **2** slots, but the pool used the defaults (6 slots, 2 reserved, so 4 sidecar slots). Main context was about 16k estimated tokens.
  - Main alone: TTFT p50 175 ms, total p50 709 ms, about 436 tok/s decode.
  - With 20 sidecars kept in flight: TTFT p50 1303 ms (+644%), total p50 2083 ms (+194%), decode 305 tok/s.
  - Sidecars: 47 completed, 0 failed, p50 latency 1976 ms.
- **Reading:**
  - The pool believed it had 4 sidecar slots on a 2-slot engine, so sidecars took **both** real slots. ninfer has no request priority and serves requests FIFO, so main queued behind them.
  - This is the case `reservedForMain` exists to prevent, and it only works when `pool.maxConcurrent` matches the engine's real slot count. It doesn't measure what the pool does when configured correctly. **Phase 2 acceptance stays pending** until a re-run with matching config: `--max-concurrent 2 --reserved 1` now, then `6 / 2` once ninfer runs 6 slots.
  - Even when configured correctly, a sidecar's prefill still shares the GPU with main's decode. The remaining regression measures what F5 (request priority) and interleaved prefill would buy, which is direct evidence for that ninfer parity ask (`docs/INFERENCE_ENGINES.md`).
  - Cached tokens were 24,576 on every main request. That's ninfer's first context-checkpoint rung: each load-test request diverges after the shared system prompt, so reuse falls back to the nearest checkpoint. A real agent loop appends instead, and in eval reached 95% cache hit (D-037).
- **Re-run with matching config** (`--max-concurrent 2 --reserved 1`, so 1 sidecar slot):

  | Main agent | TTFT p50 | TTFT p95 | Total p50 | Total p95 | Decode tok/s |
  |---|---|---|---|---|---|
  | Alone | 182 ms | 196 ms | 741 ms | 782 ms | 438 |
  | With 20 sidecars queued | 177 ms | 505 ms | 791 ms | 887 ms | 381 |
  | Regression | −3% | **+157%** | +7% | +13% | −13% |

  - Sidecars: 29 completed, 0 failed, p50 latency 484 ms, 1/1 slot used.
  - **Phase 2 acceptance met:** the regression is measured and reported, and it's small at the median.
  - The p95 TTFT tail is the expected cost of ninfer's one-prefill-at-a-time, prefill-first scheduling: a main request that arrives while a sidecar prefill is running waits for it. Decode drops about 13% from sharing the batch.
  - Both costs are what request priority (F5) and interleaved prefill would remove. Re-measure at 6 slots (`--max-concurrent 6 --reserved 2`) when ninfer moves there.
- **Follow-ups:**
  - Document that `pool.maxConcurrent` must equal the engine's slot count. The example config and README say so.
  - `h-rust-forth` validates on the owner's 32-core machine, so its 0/3 is the model's failure, not the environment's. The next calibration run should use `--keep-workdirs` to see why.

---

## Phase 3 (2026-10-04)

### D-039 — Module interface and the supervisor as built · accepted (Phase 3; implements brief §5.4, §6.1, D-010, D-011)
- **Module interface (`@exocortex/core`):**
  - Hooks: `onUserTurn`, `onToolResult`, and `onSettle → SettleAction`, which is one of `suggest`, `continue` or `notify`.
  - Modules get a `ModuleContext` (pool, trace recorder, shell runner, log) and never import pi.
  - One instance per pi session, built from `config.modules.<id>` plus live `/exo` overrides.
  - Prompts are versioned files (`packages/mod-<id>/prompts/<name>.vN.md`, with `{{var}}`).
  - New trace kinds: `exo.ledger`, `exo.verdict`, `exo.action`, all tagged synthetic with their module.
- **Supervisor (`@exocortex/mod-supervisor`):**
  1. **Ledger:** on every user turn, an *interactive*, isolated sidecar extracts 1–7 criteria and check commands. It sees the previous checklist so follow-ups can amend it, and non-task messages produce no checklist. The ledger is stored, never injected.
  2. **Evidence at settle:** all deterministic. Git diff and stat since the task's starting commit (so commits made during the task count), untracked files, files the agent wrote, its last 10 commands with exit codes plus the tail of the last failure, and check-command results. Ordered by importance and capped at 8k characters; the raw diff is truncated first.
  3. **Checks (D-011 safety):** configured `checks`, plus ledger commands **only if they appear verbatim in the user's request**. A model can never invent a command to run.
  4. **Verdict:** a *critical*, isolated sidecar sees only the checklist, the evidence and the agent's final message (last 1.5k characters). Its output is schema-validated: `complete | incomplete | failed | uncertain`, `missing[]`, `asked_user`.
  5. **Action:**
     - `incomplete` with missing items → a short user-role message listing them.
     - **Suggest mode (default):** the message pre-fills the editor; in RPC it surfaces as `set_editor_text`. An accepted suggestion is recognised and counted as a continuation of the same task.
     - **Auto mode (opt-in):** a persisted `exo.supervisor` custom message plus `continue: true`.
     - `failed` → warning notification; anything else → status line.
  6. **Guards:**
     - `maxContinuations` (default 3).
     - Stop after two consecutive continuations with an unchanged diff fingerprint.
     - Never act when the agent ends by asking the user something: a heuristic runs before the verdict call, and the verdict's `asked_user` flag is checked after.
     - Only `completed` outcomes are judged; aborted or errored runs are skipped.
     - A settle budget of 5 minutes covers all modules.
- **Pi wiring:**
  - Settle hooks run in `agent_before_settle`, which pi awaits, so auto continuations use pi's boundary API and print/RPC modes wait for them.
  - Boundary-committed messages skip `message_end`, so the module host records each injection in the trace itself.
  - **`/exo` commands:** `on|off` (kill switch), `supervisor on|off|suggest|auto`, `status`, `ping`.
- **Eval:**
  - The RPC driver accepts `set_editor_text` as the next prompt, standing in for the user pressing Enter, within the task's turn and time limits.
  - Metrics count continuations (accepted plus auto) and verdicts by kind.
  - Run configs inherit `engine`/`pool` from the user's global config (D-038).
  - Configs: `supervisor` (suggest) and `supervisor-auto`.
- **Phase 3 acceptance (pending owner run):**
  - Command: `npm run eval -- --model ninfer/coding --tags hard --config all-off,supervisor --repeat 5`, sliced by the `spec-compliance` tag.
  - "No runaway loops": every run must stay within `maxContinuations`, and there must be no `max_turns` or timeout outcomes beyond the baseline's.

---

### D-040 — Test the adapter in-process; coverage ratchet in `npm run check`; trace inspector · accepted (Phase 4)
- **Context:** The pi adapter only ran inside spawned pi processes, so its hooks were barely covered: 72% statements and 65% branches overall.
- **Decision:**
  - `packages/pi-adapter/test/fake-pi.ts`: a fake `ExtensionAPI` that records handlers and commands and emits events in registration order, the way pi composes them. The module host, sidecars, `/exo`, runtime, trace recorder and entrypoint are tested in-process. The real-pi integration tests stay.
  - `npm test` runs vitest with v8 coverage. Thresholds sit just below the current numbers and only ever go up. CLI entrypoints (`cli.ts`, `*-cli.ts`) are excluded.
  - `npm run trace -- sessions | show <id> | calls <id>` inspects the trace store: metrics header, event timeline, per-module sidecar totals, `--json`.
- **Found by the new tests:** the module host's `textOf` emitted blank lines for non-text parts, so the supervisor's `lastAssistantText` started with a newline whenever the model thought first. Fixed on this branch. Phase 3 behavior is otherwise unchanged.

### D-041 — Tool-result rewrites and shared output analysis · accepted (Phase 4; implements brief §5.4 `onToolResult` rewrites, D-029)
- **Hook:** `rewriteToolResult(draft, signal) → {text, note} | undefined`.
  - Modules run in `MODULES` order (trimmer, then triage), and each sees earlier rewrites in `draft.current`.
  - Only text-only results are offered.
  - One 20 s budget per tool result covers all modules, because a rewrite holds the agent loop. A module that ignores its signal is cut off.
- **Pi mapping:**
  - Return `content` and keep `structuredContent`; replacing content alone would drop it (PI_API_NOTES §4).
  - Merge `details.exo.rewrites`, never replace `details`.
  - The original output is already in the trace: the recorder's `tool.result` handler runs before the host's. Each rewrite adds an `exo.rewrite` event.
- **Cache:** rewriting a new tool result changes only content the model has not seen yet, so the prefix is untouched (D-029).
- **`core/modules/output.ts`:**
  - terminal cleanup (ANSI, carriage-return redraws);
  - per-ecosystem error grammars (Rust, Go, C/C++ and linkers, Python/pytest, TypeScript), split into toolchain-specific and generic matches with false-positive guards;
  - normalized error signatures.
  - One definition serves triage, compaction and the eval's repeated-error metric (D-016).

### D-042 — Trimmer: deterministic first, extractive sidecar second · accepted (Phase 4; amends brief §6.2)
- **Deterministic tier (always):** bash results over 8k characters (~2k tokens).
  1. Clean terminal noise.
  2. Collapse runs of lines that differ only in numbers.
  3. Keep the head (40), the tail (80) and every error line ±3, verbatim. Specific errors win over generic ones, and the earliest windows are favored.
  4. Cut lines over 400 characters.
  5. Add a footer pointing at the full output: pi's `fullOutputPath`, else a copy the trimmer saves.
- **Sidecar tier (opt-in, `sidecar: true`):** runs only when the deterministic result is still over 8k characters.
  - The sidecar returns **line ranges, never prose**. Lines are copied verbatim, and the tail and the first specific error are always added.
  - Any failure, invalid range or over-budget selection falls back to the deterministic result.
  - Deadline 6 s, interactive priority.
  - Brief §6.2 had the sidecar first. The research (R2.1/R2.2) found extractive, deterministic-first pruning safer for small models: identifiers can't be corrupted and timeouts cost nothing.
- **Policy:**
  - `read`, `edit` and `write` are never trimmed, whatever the config. Default `tools: ["bash"]`.
  - No recall tool: the agent reads the saved file if it needs more.
- **Not done:** batched retro-masking of old observations through `context_edit` (R2.3). It edits earlier context, so it needs an explicit exception to D-029, measured as a compaction-like cache reset. Deferred until Phase 4 numbers exist.

### D-043 — Triage: gated on repetition · accepted (Phase 4; amends brief §6.3)
- **Change from the brief:** the brief called the sidecar on every failing result. The main model already sees the raw error, and same-model explanations add little on a first failure (research R3.1). So:
  - **First failure of a signature:** deterministic only. If the first error is buried more than 20 lines down, a `[exo triage: first error (line N): …]` line goes at the top.
  - **Repeat (same normalized signature within the task):** a notice that *describes* the repeat instead of echoing the failed command (R3.3). From the second occurrence, an optional sidecar diagnosis of at most 2 sentences that must name a different action. At most 2 hints per signature; deadline 8 s.
  - **Loop threshold (default 3):** a stronger, still advisory, warning. Tool calls are never blocked (D-010).
- **Guidance gate (R3.5, brief constraint 5):** a hint naming a path or backticked identifier that appears neither in the evidence nor in the workspace is dropped.
- **Exit codes:** `grep`/`rg`/`diff`/`test`/`which` exit 1 is an answer, not a failure (configurable `benignCommands`).
- **Counting:** counts reset on a new user request, not on extension continuations, so supervisor continuations count as the same task.

### D-044 — Compaction: summaries anchored in tracked facts · accepted (Phase 4; refines D-017)
- **From tracked facts, verbatim** (research R4.1):
  - every user request, oldest first;
  - files modified, with git numstat;
  - files only read;
  - commands whose last run failed, with exit code and first error;
  - commands that last succeeded, marked "no need to re-run".
- **From the sidecar (JSON):** only the narrative: current work, next step, dead ends and key facts.
  - On later compactions it updates the previous narrative rather than rewriting it (R4.2, anchored summaries).
  - Critical priority; deadline 90 s; the newest 60k characters of the serialized span.
- **Context:** the sidecar gets pi's own `serializeConversation(convertToLlm(span))` of the span being compacted, not D-017's `fork-prefix`.
  - Summarization reads the whole span anyway.
  - The compact form keeps the module harness-agnostic.
  - Fork-prefix stays a later optimization if compaction latency matters.
- **Fallback:**
  - `harness` (default): pi's own compaction.
  - `deterministic`: a facts-only summary.
  - A 120 s host budget and pi's abort signal bound it.
- **Hook:** `compact(request) → summary` returns `{compaction: {summary, firstKeptEntryId, tokensBefore, details.exo}}` from `session_before_compact`. Each summary is traced as `exo.compaction`.

### D-045 — Phase 4 plan, acceptance and research survey · accepted (2026-10-04)
- **Research:** `docs/RESEARCH.md` surveys the literature for every module, with evidence tags ([A]/[S]/[X]/[U]) and a table of conflicts with these decisions. Its Phase 4 recommendations shaped D-042 to D-044.
- **Deferred research recommendations, still open:**
  - Supervisor (R1.1–R1.6):
    - a deterministic pre-verdict (a failing check means `incomplete` with no LLM call);
    - per-criterion verdicts that cite evidence;
    - claims extracted from the final message;
    - test-tampering evidence;
    - thinking on for the verdict.
  - These change Phase 3 behavior, so they wait for the owner's Phase 3 A/B result, then get their own A/B.
- **Acceptance (amends brief §8 Phase 4, per R2.4/R7.2):**
  - **Trimmer:** fewer uncached main input tokens on the `noisy-output` slice, with no drop in success **and no rise in turns or wall-clock** beyond noise. Compression that saves tokens but causes re-reads is a regression.
  - **Triage:** repeated-error rate on the `error-recovery` slice.
  - **Compaction:** success on runs with at least one compaction (forced with a smaller context window).
  - **Statistics:** slices of 3 tasks × 5 repeats can only show very large effects (R7.1). Report them as descriptive, pair runs by task, and grow slices toward 10 tasks.
  - **Report:** with two or more configs, the summary has a "paired by task" section: mean Δ success with a seeded task-bootstrap 95% CI, an exact sign test, Δ turns/tokens/wall-clock, and the minimum detectable effect for the run count. `npm run eval -- --report <dir> --tags <slice>` re-renders any finished run, including the Phase 3 A/B.
- **Eval configs:** `trimmer`, `trimmer-llm`, `triage`, `compaction`, `phase4`. A test checks every config is valid and names a known module.
- **Branching (deviation from D-020):** Phase 4 work began on `claude/phase-4-context`, stacked on the Phase 3 branch, while the owner runs the Phase 3 A/B. It merges only after Phase 3 acceptance.

---

### D-046 — Supervisor research options, off until A/B'd · accepted (amends D-039 as options only)
- **Context:** `docs/RESEARCH.md` §1 recommends moving the supervisor's decisions toward deterministic evidence: same-model self-verification is weak, and a false "complete" is the costly error. Changing the defaults before the Phase 3 baseline exists would leave nothing to compare against.
- **Decision:** each recommendation is a setting. Defaults keep D-039's behavior exactly.

| Setting | Research | Effect |
|---|---|---|
| `preVerdict` | R1.1 | A failing check command (run at settle, so after every edit) means `incomplete` with no LLM call. No diff, no untracked files and no writes means `uncertain`. |
| `warningSignals` | R1.2 #4–#7 | Adds a "Warnings" section to the evidence: test files deleted, skip markers added, assertions removed, stub markers outside tests, success claims with no successful matching command after the last edit, and a last test run limited to a subset. |
| `verdictStyle: "per-criterion"` | R1.4 | The judge rates each item met/unmet/unknown and must quote an evidence line. Code derives the verdict: any unmet → `incomplete`; all met with real quotes → `complete`; otherwise `uncertain`. A quote not found in the evidence counts as unknown. |
| `finalMessage: "claims"` | R1.3 | The judge sees the final message's success claims, labelled unverified, plus its last 300 characters, instead of 1.5k characters of narrative. |
| `completeVotes: k` | R1.5 | A `complete` verdict is re-asked k−1 times at temperature 0.7; any dissent means `uncertain`. Only `complete` is re-checked, because it is the costly error. |

- **Not changed:** `thinking` keeps D-008's off default. `supervisor-think` A/Bs it (R1.6).
- **Trace:** every `exo.verdict` records `source: deterministic | llm` and `votes`. The eval reports **precision of `complete`** (of runs whose last verdict was `complete`, the share whose hidden check passed) and **failures caught**, plus the deterministic-verdict count.
- **Eval configs:** `supervisor-pre`, `supervisor-items`, `supervisor-votes`, `supervisor-think`, `supervisor-research` (all options on).
- **Deferred:** ledger `source: explicit|implied` (R1.7), and the in-loop check (R1.8).

### D-047 — Build ahead of GPU acceptance runs; gate merges and defaults, not work · accepted (amends D-020)
- **Context:** The owner's GPU is often busy. D-020 starts a phase only after the previous phase's acceptance passes, which idles development for days.
- **Decision:**
  - Development continues on stacked branches while acceptance runs are pending.
  - Everything new ships **off by default, or as an option** with an eval config, so one batch of A/B runs can settle several questions.
  - What stays gated on evidence:
    - **merging a phase to `main`**, and tagging it (D-022);
    - **changing a default** (turning a module or option on by default).
  - Each gated item names its eval command in DECISIONS.

---

### D-048 — Eval rigor: tamper guard, lucky passes, total cost · accepted
- **Tamper guard (research R7.4):**
  - After the agent stops and before the hidden overlay and the check, the fixture's original test files are restored (`isTestPath`, shared with the supervisor's warning signals). Editing, skipping or deleting tests can no longer make a run pass.
  - The run records `tamperedTests`, and the report counts tampered runs per config. New test files the agent adds are kept.
  - `protectTests: false` opts a task out when its prompt asks for test changes. `h-go-multi-package-config` is the only one: its hidden overlay supplies the updated tests.
  - `--validate` now fails a fixture whose `solution.patch` edits protected tests. That is how it found this task.
- **Lucky passes (R7.6):** a passing run counts as "lucky" when either:
  - no test or build command succeeded after the last file edit; or
  - one identical command failed 3+ times.

  They are reported per config, because success alone hides reliability gaps.
- **Cost (R7.3):** a *total tok* column (main input + cached + output + sidecar, per-run mean) shows what each config costs, to weigh against success.

---

### D-049 — Memory v1: verified pitfall cards, recalled into failing tool results · accepted (Phase 5; narrows brief §6.4 per research R5.1–R5.5)
- **Context:** the research is cautious. A plain Qwen 3.6-27B agent matched memory, workflow and skill modules once token budgets were equal, and Dynamic Cheatsheet helped small models little because they self-judge poorly. So v1 is the highest-precision memory available.
- **Admission (R5.1/R5.2):** a card is learned only from a *verified error→fix pair*:
  - a verifying command (build, test or run) fails;
  - the agent edits files;
  - the *same* command then passes.

  The pass is the external signal; the model's opinion of its work is never used. If the error changes before the command passes, the episode restarts.
- **Content:**
  - A background-priority sidecar phrases the lesson in 1–2 sentences from the error excerpt and the edits. It runs only while the main agent is idle (pool `backgroundWhenIdleOnly`), not in a separate sleep-time worker yet.
  - The lesson passes the same guidance gate as triage hints: any name it uses must appear in the evidence or the workspace.
  - Otherwise the card gets a deterministic summary of the edit.
- **Store:** `~/.exocortex/memory.db` (SQLite with FTS5), separate from the trace.
  - Cards are scoped by repo (D-018): origin remote URL, else the root commit's tree hash (stable across copies of a fixture), else the path.
  - Only delta ops (R5.5): ADD, MERGE (same repo and signature: `seen++`, evidence appended), SUPERSEDE and RETIRE (set `valid_to`). Nothing is deleted or rewritten wholesale.
- **Recall (hot path, no LLM):** a failing tool result's normalized error signature (D-016) is the key.
  - **Search order:**
    1. exact signature in this repo;
    2. the same signature seen in 2+ other repos (D-018 global promotion);
    3. an FTS5 keyword match on the error line, kept only when the card's trigger shares ≥60% of the error's keywords.
  - **Injection:** at most 2 cards and ~400 tokens, appended as a tool-result rewrite after trimmer and triage. That is cache-safe (D-029); the brief had user-turn injection, but pitfalls belong next to the error. Each card is recalled at most once per task.
- **Utility (R5.3):**
  - **Helped:** the card's error did not recur in the task (credited at settle or on the next request).
  - **Hurt:** the error recurred after the card was injected.
  - **Retire:** when `hurt − helped ≥ 2` after 3+ injections.
  - Recall ranks proven cards first.
- **Eval:**
  - Each memory config gets its own card store under the run dir.
  - Repeats run in order, and the report's "Success by repeat" table shows the learning curve.
  - Fixtures are separate repos, so this measures same-task replay: an upper bound (research §5c). Cross-task transfer needs sibling tasks in one repo, which is future fixture work.
  - Configs: `memory`, `memory-triage`.
- **Deferred:** `procedure`/`fact`/`preference` cards; user-turn retrieval; embeddings (D-026); a sleep-time curator.

---

### D-050 — Phase 6 starts small: verdict votes and diverse hypotheses for stuck loops · accepted (narrows D-015 per research R6.1–R6.3)
- **Context:** the research found that best-of-N gains come from executable verification. Without it, a same-model judge picking a winner plateaus early and adds false positives.
- **Decision:**
  - **Verdict voting** is the supervisor's `completeVotes` option (D-046), capped at 5 (R6.3).
  - **Diverse hypotheses** are triage's `hypotheses: k` option (off by default):
    - **Trigger:** the loop threshold, once per error signature per task.
    - **Calls:** k isolated sidecars run in parallel at temperature 0.8. Each gets a different diagnostic angle from `prompts/frames.v1.md`: the bug is elsewhere in the call path; a wrong API assumption; the environment or setup; a misread expectation; an earlier change.
    - **Filtering:** each answer must name a check. Answers that fail the guidance gate are dropped, as are near-duplicates (word-set Jaccard > 0.6).
    - **Output:** shown only when 2+ distinct hypotheses survive, as an unverified list. **No LLM picks a winner.**
- **Not done:**
  - D-015's fork-prefix context;
  - recording contrasting candidates for memory;
  - execution-based best-of-K. That would run only in the eval sandbox as a headroom study (R6.2).
- **Eval:** `triage-hypotheses` vs `triage` on `error-recovery`.

---

### D-051 — Hard tier grown to 28 tasks, 7 per failure mode; uncalibrated until a GPU run · accepted (research R7.1)
- **Context:** with 3 tasks per slice, a per-slice comparison could only detect differences of about 49 points (R7.1).
- **Decision:**
  - Each failure-mode slice now has 7 hard tasks: `spec-compliance`, `error-recovery`, `noisy-output` and `navigation`. One new task per language per slice.
  - The 16 new tasks are tagged `uncalibrated`. Step 0 of `docs/AB_PLAN.md` calibrates them: keep tasks between 1/3 and 2/3, rework or drop the rest, then remove the tag.
- **Quality bar:**
  - every task passes `--validate` under the tamper guard (D-048);
  - every hidden requirement is stated in the prompt or the repo's docs;
  - the authors confirmed the hidden tests catch the obvious shortcuts (special-casing, `reserve()`, `Box::leak`, removing logging, silencing warnings, a single-registry split).
- **Known gap:** `h-rust-template-lifetimes` would accept re-parsing on every render.
- **Next:** sibling tasks that share one repo, for memory's cross-task transfer (D-049); long tasks for compaction.

---

### D-052 — Merge default-off work without waiting for A/B; tags and defaults stay gated · accepted (amends D-047, D-020, D-022; owner's call, 2026-10-04)
- **Context:** the owner asked to merge and keep moving while GPU runs are pending.
- **Decision:**
  - Work that ships **off by default** merges to `main` once `npm run check` and CI are green.
  - Two things still wait for their acceptance run in `docs/AB_PLAN.md`:
    - **phase tags** (`phase-3`, `phase-4`, `phase-5`), D-022;
    - **turning any module or option on by default.**
- **Applied:** Phase 3 (#5) and the Phase 4/5/6 branch merge on this basis. Neither is tagged until its A/B passes.

### D-053 — Verified: masking evidence is weak for a 32B and ignores local caching; retro-masking stays deferred · accepted (2026-10-05; research verification, reaffirms D-042 "Not done")
- **Claim checked:** *The Complexity Trap* (RESEARCH.md §2a, exec #7, R2.3). The survey cited masking ≈ summary at half the cost, "with Qwen3-32B among the models", but had not seen the Qwen3-32B row or the cost model.
- **What the paper says (Table 1, §4.4, App. A):**
  - Qwen3-32B non-thinking: raw 17.0%, masking 15.0%, summary 16.0%; summary was the cheaper strategy. Thinking: 23.0 / 24.6 / 24.8%. Neither difference is significant.
  - For Qwen3-32B it was **masking** that lengthened trajectories (+13%), the opposite of the larger models.
  - Qwen costs use Alibaba list prices with no cache-hit discount; no configuration models a local prefix cache. The window M is scaffold-specific (§5.1).
- **New evidence:** EfficientAgent (2609.33762, Table 13) measured a local Qwen3-Coder-30B-A3B with prefix caching: observation masking dropped the prefix-hit rate from 96.5% to 50.8% and lengthened inference.
- **Implication:** the case for R2.3 on our model class is weaker than the survey said. R2.3 stays deferred (as in D-042). It is reconsidered only if Phase 4 runs show context-overflow or compaction-driven failures, and then as an A/B with prefix-hit rate, turns and wall-clock as co-primary metrics and K tuned for pi. No setting or eval config changes. Exec #7 and R2.3 in RESEARCH.md carry the caveat.

### D-054 — Verified: CodeJudgeBench's "retained reasoning" is about the judged response, not the judge · accepted (2026-10-05; research verification, touches D-046, R1.3, R1.6)
- **Claim checked:** RESEARCH.md §1a and R1.6 said keeping the judge's full reasoning improved accuracy, and that pairwise code judging was often below 60%.
- **What the paper says (abstract, RQ3, §5.1):**
  - Judges did better when given the *candidate's* full, unprocessed response (comments and reasoning) than code only. Nothing about the judge's own reasoning.
  - The <60% figure is for **non-thinking** judges, near the 50% random baseline; thinking judges, down to Qwen3-8B, did clearly better.
- **Implications:**
  - `supervisor-think` (R1.6): its evidence changes source but gets stronger. It is now the supervisor option with the highest prior. JEV-as-a-Judge (2609.26550) points the same way: judges without reasoning fall furthest behind on code.
  - `finalMessage: "claims"` (R1.3): the corrected finding is mild counter-evidence. Stripping the agent's narrative may remove signal the judge uses. Its A/B must be read as a real test, not a confirmation.
- **No default changes.** `thinking` stays off (D-008) and `finalMessage` stays as in D-039 until AB_PLAN step 2 runs. `supervisor-items` bundles `finalMessage: "claims"` with per-criterion verdicts, so AB_PLAN step 2 now notes that a flat or negative `supervisor-items` result needs a rerun with `finalMessage` at its default before per-criterion is judged. The eval configs are unchanged.

### D-055 — Verified: memory evidence holds; D-049's rationale reworded; expect small effects · accepted (2026-10-05; research verification, refines D-049's context only)
- **Claims checked:** 2606.15017 (Qwen 3.6-27B budget-matched), Dynamic Cheatsheet on small models, ACE's collapse example, SWE-Exp, Memento.
- **Confirmed:** with Qwen 3.6-27B a budget-matched vanilla actor scored 50.73% on WebArena against 46.15–49.08% for AWM, ASI and ReasoningBank, using fewer tokens (Table 1). ACE's 18,282 → 122-token collapse fell to 57.1%, below the 63.7% of no context (Fig. 2).
- **Corrected wording:** D-049's context says Dynamic Cheatsheet helped small models little "because they self-judge poorly". The paper (§5) attributes it to *generative competence*: small models produce correct solutions too rarely to seed memory and fail to apply what is stored. D-049 is not edited; this entry records the correction. The conclusion is the same: admit cards only from externally verified fixes.
- **New evidence:** VibeMemBench (2609.23570) found execution-verified experience helped held-out solvers by 1.1–4.5 points, but 11 of 12 pairings of existing memory systems with solvers failed to beat memory-off. That supports D-049's narrow design and predicts a small effect.
- **Implication:** AB_PLAN step 4 (`--repeat 3`) cannot detect a 1–4 point effect. Read it as a learning-curve and harm check: no drop in success, no budget-matched token loss. Do not read it as proof of benefit. No setting changes.

### D-056 — One supervisor option per eval config; `supervisor-claims` added · accepted (2026-10-04; follows D-054, amends D-046's config list)
- **Context:** `supervisor-items` set both `verdictStyle: "per-criterion"` (R1.4) and `finalMessage: "claims"` (R1.3). D-054 gave the two options opposite priors, so a result from that config could not be pinned on either.
- **Decision:**
  - `supervisor-items` sets `verdictStyle: "per-criterion"` only.
  - New `supervisor-claims` sets `finalMessage: "claims"` only.
  - `supervisor-research` still turns everything on. `supervisor-pre` keeps `preVerdict` and `warningSignals` together: they are one deterministic layer (R1.1/R1.2).
  - A test in `packages/eval/test/configs.test.ts` holds each single-option config to its one option, and `supervisor-research` to their union.
- **AB_PLAN step 2** lists `supervisor-think` first and adds `supervisor-claims`. The "rerun with a local copy" workaround from D-054 is gone.
- **No module or setting default changes** (D-052).

### D-057 — The eval report follows each repeated error to see which triage hint preceded its end · accepted (2026-10-04; AB_PLAN step 3, measures D-043's cap)
- **Context:** D-043 allows 2 hints per error signature. Self-Debug's gain came almost entirely from the first feedback turn, so the second hint has to show it earns its sidecar call. Checking that by hand in the trace does not scale to an A/B.
- **Decision:** `TraceMetrics.recurringErrors` holds one entry per error signature seen 2+ times in a run: `{occurrences, hints, after, fixed}`. It uses only data already in the trace:
  - **Failures** are `tool.result` events that triage would call a failure (error result or non-zero exit), grouped by the same normalized signature (D-016).
  - **Hints** are triage's `exo.rewrite` events whose note ends in `+ hint`, joined to the failing result by `toolCallId`. A hint the guidance gate dropped, a timed-out sidecar and a hypothesis list are not hints.
  - **`after`** describes what followed the last hint: `stopped` (the error did not come back and the agent kept working), `recurred`, or `ended` (no tool result followed, so the hint gets neither credit nor blame).
  - **`fixed`** is true when the command that last failed that way succeeded later. It is the same external signal memory admits cards on (D-049).
- **Report:** a "Repeated errors" section.
  - The first table needs no triage: for every config, how many repeated errors were gone after the 2nd occurrence and after the 3rd. Triage hints at exactly those points, so the baseline row is the counterfactual: how often the agent gets past the error unaided.
  - The second table credits each hinted error to its last hint: stopped after hint 1, stopped after hint 2, came back, or run ended, each with its "and fixed" count.
- **Reading it:** cap hints at 1 unless "stopped after hint 2" is a real share of "got hint 2" *and* beats the baseline's "gone after the 3rd time".
- **Limits:**
  - "Came before" is not "caused". The baseline row is the only control, and it is not paired by signature.
  - The report reads triage's note text. Triage's tests pin that text (`repeat 2 + hint`).
- **Not changed:** `maxHintsPerSignature` stays 2.

### D-058 — Memory's A/B is reported as a budget-matched harm check · accepted (2026-10-04; follows D-055, research R5.4)
- **Context:** D-055 says to read the memory run as a harm check: no drop in success and no budget-matched token loss. The report had a *total tok* column, but nothing next to the learning curve, no per-repeat cost and no statement of what the run could detect.
- **Already there:** `total tok` = main input + cached + output + all sidecar tokens. Memory's recalled cards are tool-result rewrites, so they are already counted in main input; its lesson-writing calls are sidecar calls.
- **Added,** as a "Token budget" table under "Success by repeat":
  - per config: main tokens, sidecar tokens per module (new `TraceMetrics.sidecarTokensByModule`), total, total per repeat, and tokens per passing run;
  - Δ total tokens against the first config, paired by task, with a task-level bootstrap CI and the smallest mean change those tasks could detect (2.8 × sd ⁄ √tasks);
  - the smallest detectable success difference for one repeat column and for all repeats together (D-045's formula).
- **Why tokens per pass:** in 2606.15017 the baseline caught up once it was given the memory methods' budget. Tokens per pass shows whether a success gain is larger than what the extra tokens would buy.
- **Limit:** cached tokens count at face value, although a local prefix hit is nearly free. The main table has the cached/uncached split.
- **`--report` recomputes metrics** from the run directory's `trace.db` when it is still there, so runs made before a metric existed get it too.

### D-059 — The report counts context overflows and compaction failures; failed compactions are traced · accepted (2026-10-04; supplies the evidence D-053 asks for)
- **Context:** D-053 reconsiders retro-masking only if Phase 4 runs show context-overflow or compaction-driven failures. The report did not show compactions at all, and the trace dropped pi's `session_compact_failed` event.
- **Decision:**
  - **Trace:** new event kind `compaction.failed`, recorded from `session_compact_failed` with `{reason, errorMessage, aborted, willRetry, fromExtension}`. No migration is needed: `kind` is free text.
  - **Metrics:**
    - `overflowCompactions`: compactions with `reason: "overflow"`, done or failed. Pi decides what an overflow is (PI_API_NOTES §9), so there are no error-text patterns here.
    - `failedCompactions`.
    - `errorStops` and `lengthStops`: turns ending with those stop reasons. An overflow error that pi's patterns miss (possible with a custom provider such as ninfer) shows up as an error stop with no compaction.
  - **Report:** a "Context pressure" section. Per config: runs that compacted, success with and without compaction (AB_PLAN step 3's primary for the compaction run), the four counts above, and **failed runs under context pressure** (failed the check after compacting or overflowing). When nothing compacted it says so in one line.
- **Trigger for D-053:** failed runs under context pressure in the `all-off` row of the `ninfer32k` run. A handful out of 84 runs is not a case for masking; a clear share of the failures is.
- **Limit:** a failure after compaction is not proof that compaction caused it. Runs that compact are the long, hard ones, so compare the column across configs on the same tasks.
- **Retro-masking stays unbuilt.**

### D-060 — Memory learns the user's working preferences and adds the ones a prompt leaves unsaid · accepted (2026-10-05; owner's request; builds the `preference` card deferred in D-049)
- **Goal:** if the user likes TDD and a later prompt does not mention it, the agent is told anyway.
- **Admission: the user's own words are the external signal.** D-049 admits pitfall cards only on a verified fix because a small model's opinion of its own work is unreliable (D-055). The equivalent for preferences is that the user said it. A background sidecar reads each message the user typed and *proposes* preferences; code decides (`admitPreference`):
  - the proposal's quote must appear in the message verbatim, or nothing is admitted;
  - a one-off ("this time", "for now") neither states nor withdraws a preference;
  - the rule may name no file or symbol the message does not (the guidance gate, R3.5);
  - "same as" and "replaces" count only when they point at a preference the sidecar was shown.
- **What is never read:** the agent's messages, extension-sent prompts, and accepted supervisor suggestions (the host now marks those `origin: "suggestion"`).
- **When a preference applies in a repo** (`activePreferences`), any one of:
  - the user said it as a standing rule here ("always", "never", "from now on", "I prefer" …). Code decides this from the quoted sentence; the model's opinion is not asked;
  - the user said it in `preferenceMinSessions` (default 2) separate sessions here. One task's instruction is not a preference; the same instruction in a second session is;
  - the user said it in 2+ repos. It is then about the user, not the repo (D-018's promotion rule).
- **Injection (hot path, no LLM):** on a typed prompt, the applying preferences that are not already in the conversation and that the prompt does not state itself (it carries ≥60% of the rule's keywords) are added as one `exo.memory` message right after the prompt.
  - At most `maxPreferences` (5) and `maxPreferenceChars` (900, about 225 tokens).
  - The wording says the request wins on conflict.
  - It is shown to the user (`display: true`): text added on their behalf should be visible.
  - Each preference is added once per conversation, and again after a compaction, since the summary may drop it.
  - Prompts under 4 words ("thanks", "go on") get nothing.
- **Store:** `preferences` and `preference_sightings` tables in the memory store (migration 2). A preference is global; its sightings (repo, session, standing, the user's quote) say where it applies. Delta ops only (R5.5): ADD, MERGE (a sighting), RETIRE. A withdrawal ("stop writing tests first") retires; nothing is deleted.
- **User control:** `/exo memory preferences` lists them; `/exo memory forget <id>` retires one.
- **Host changes** (harness-agnostic, in `ExoModule`):
  - `contextForUserTurn(turn)`: text for one persisted custom message after the user's prompt, returned from pi's `before_agent_start` (D-029's mechanism, first use). 2 s budget.
  - `onCompacted()`, `command(args)`, and `UserTurn.origin: "suggestion"`.
- **Off by default** (`memory.preferences: false`, D-052). It is not in the memory A/B: the fixtures repeat one prompt per task, so every task instruction would look like a repeated preference. Its evidence is daily use (D-014): `npm run trace -- stats` shows `preferences_added`, and `/exo memory preferences` shows what was learned.
- **Verified without a model:** a real-pi integration test shows the message lands after the prompt and that the next request's prefix is unchanged.
- **Open risks:**
  - The preference reaches the model as a second consecutive `user` message. Whether ninfer's chat template accepts that is still open question 14.
  - Paraphrases are merged by the sidecar's "same as" or by word overlap; with neither, one preference can be stored twice and each copy waits for its own second session. Embeddings (D-026) would fix that.
  - No helped/hurt accounting yet. A preference the user keeps having to repeat is evidence that injection is not working, not that the preference is wrong.
- **Not done:** the supervisor does not check preferences. R1.7's `implied` criteria are the place for it: a preference could lower `complete` to `uncertain`, never produce `incomplete` on its own.

### D-061 — Pre-A/B improvement pass over every module · accepted (2026-10-05; owner's request, before the runs in AB_PLAN)
- **Context:** no A/B has run yet, and every module is off by default, so fixing a module's behaviour now does not change a default (D-052) and does not invalidate a result. Each item below was found by reading the module against its own D-entry and the research.
- **Supervisor:**
  - **New files were invisible to the judge.** `git diff` leaves out untracked files, so for "add a module" tasks the verdict saw file names only, the stub and test-tampering signals saw nothing, and a continuation that only edited new files counted as "no progress" (two of those stop the supervisor). Evidence now includes each untracked file as a "new file" diff: up to 12 files, 6,000 characters each, smallest first so one large file cannot crowd out the rest.
  - **Stale failures.** The evidence showed the output of the last failing command even when that command had since passed. It is now shown only if the command never passed again.
- **Triage:**
  - **The second hint must differ from the first** (prompt `diagnose.v2`). The sidecar is shown the advice already given and told it did not work; a hint that repeats an earlier one (word overlap > 0.6) is dropped. The cap of 2 (D-043) now counts sidecar calls. This is what makes D-057's "stopped after hint 2" a fair test.
  - **Hints know which files were edited.** The recent-actions list showed `edit → ok`; it now shows `edit src/lib.rs → ok`.
- **Trimmer:**
  - **Budget.** A trimmed result is capped at `maxChars` (24,000): above it the error windows are halved, down to 4, so many long error lines cannot leave a "trimmed" output several times `minChars`.
  - **Read-backs are measured** (R2.1, R2.4). The saved full-output path goes into the rewrite's trace event (`ToolRewrite.details`), and the report's "Trimmed outputs" section counts how many saved outputs the agent later opened.
- **Compaction:**
  - **Grounding gate on the narrative** (R3.5). Once the transcript is gone the agent cannot check a name. Dead ends and key facts naming a file or symbol found nowhere in the transcript or the workspace are dropped, and so is such a next step.
  - **Accepted suggestions stay in the requests list**: they carry what was still missing.
  - **Replay rate** (R4.4): the report counts compactions after which one of the agent's next two commands re-ran something that had already passed.
- **Memory:** a fix the lesson sidecar calls not reusable (a typo, a one-off) makes no card. Before, it got a deterministic card anyway.
- **All modules:** an accepted suggestion (`origin: "suggestion"`) continues the task. Triage keeps its repeat counts, the trimmer keeps the original goal, and memory does not close the task.
- **Considered and left alone:**
  - Supervisor: the in-loop check (R1.8) and thinking by default (waits for `supervisor-think`).
  - Triage: resetting repeat counts after a pass. A regression to an old error is still a repeat.
  - Trimmer: de-duplicating a re-run's identical output against the earlier copy. It would need the agent to trust a pointer to earlier context.
  - Retro-masking (D-053).

### D-062 — Embeddings for memory, and three judgements moved from patterns to the sidecar · accepted (2026-10-05; owner's call; implements D-026's "later", amends D-060 and D-039)
- **Context:** the owner prefers an LLM call wherever it gives a much better answer than pattern matching, and will run an embedding model on the CPU. D-026 had deferred embeddings until recall was shown to be the bottleneck; this is the owner overriding that wait.
- **Principle kept:** the model proposes or ranks; code still verifies anything that is admitted (verbatim quotes, the guidance gate, ids that must be in the offered list). Exact keys stay deterministic: error signatures, evidence gathering, verified fixes.
- **Embeddings server:** new top-level config `embeddings: { baseUrl, model, apiKey?, timeoutMs }` for any OpenAI-compatible `/embeddings` endpoint.
  - `createEmbedder` in core returns unit vectors and never throws: a missing, slow or broken server yields undefined, and every caller falls back to its keyword path.
  - It is its own small client, not `InferenceClient.embed()` as D-026 sketched: it has a different server, no pool slots and no chat features.
  - Modules get it as `ModuleContext.embedder()`. `/exo ping` checks it. The eval passes the user's `embeddings` config through, like `engine` and `pool`.
- **Storage:** a `vectors` table in the memory store (migration 3): `(kind, ref_id, model) → Float32 blob`. Search is brute-force cosine in process. No vector database: the store holds hundreds of rows. Vectors are keyed by model, so changing the embedding model re-embeds lazily without mixing spaces.
- **No knowledge graph.** The relations in use (preference → sightings → repo and session; card → signature → repo) are plain tables. Reconsider with `procedure`/`fact` cards linked to files and symbols.
- **Where embeddings are used (memory only, so far):**
  - **Pitfall recall.** Exact signature still wins. Otherwise the keyword matches are joined by cards whose trigger is at least `minSimilarity` (0.85) similar to the failing output's first error line. Cards are embedded when learned; older ones are backfilled in the background the first time they are needed. Hot-path deadline `embedTimeoutMs` (1.5 s).
  - **Preference identity.** A proposed rule at least `preferenceSimilarity` (0.8) similar to a known preference is that preference. Order: the sidecar's "same as", then embeddings, then word overlap.
- **Moved from patterns to the sidecar:**
  - **Which preferences fit a prompt** (amends D-060's injection). Before the agent starts, an interactive sidecar call picks the applying preferences that are relevant to the request and not already stated in it (`preference-select.v1`). Ones it does not pick stay available for a later prompt. On failure, or with `preferenceSelect: false`: all of them minus keyword matches, as before. The host's user-turn budget rises from 2 s to 6 s; the call's own deadline is 4 s and it runs only while a preference is still unshown in the conversation.
  - **Standing rules** (amends D-060's admission). The proposal now carries the sidecar's reading of whether the user stated a rule for future work (`preferences.v2`), since natural phrasing ("I'm a TDD person") has no fixed cue. A rule is standing if the sidecar says so or the sentence has a cue. The one-off check and the verbatim-quote check stay in code.
  - **"The agent is waiting on the user"** (amends D-039's guard). The pattern on the final message's last lines ran before the verdict and switched the supervisor off whenever the agent ended on a question mark, including offers ("Want me to add tests too?") after unfinished work. The verdict now decides (`verdict.v3`/`v4`: a blocking question, not an offer). The pattern remains only where there is no LLM verdict to ask: the deterministic pre-verdict.
- **Costs to know about:**
  - Embedding calls are not in the trace or the report's token totals. They run on the CPU and do not compete for GPU slots.
  - The preference pick adds up to 4 s before the agent starts on a prompt, in conversations that still have an unshown preference.
  - The supervisor now makes a verdict call in cases where the pattern used to skip it.
- **Untested with real models.** The two similarity thresholds were picked without a real embedding model and will need tuning to the one the owner runs: check the `recalled` and `preference_seen` trace events. A sidecar that over-reads `standing` makes a one-task instruction apply at once; `/exo memory preferences` shows it and `forget` removes it.
- **Not done:** embeddings in triage (signature identity), compaction or the supervisor; an embedding-based "already said" check (the sidecar pick covers it).

### D-063 — Modules say what the user is waiting on · accepted (2026-10-05; owner's request)
- **Context:** several hooks hold pi while a sidecar answers (up to 4–10 s, 90 s for compaction). Only the settle hook said so ("exo: checking the work…"); the rest looked like a stall.
- **Decision:** `ModuleContext.progress(message)`. A module calls it just before a wait the user would notice; the host shows it and clears it when the hook returns, so a module cannot leave a stale message behind.
  - In pi it goes to both the status line (`setStatus`) and the text beside the working spinner (`setWorkingMessage`). When the last concurrent hook returns, the status line goes back to what the last settle left there and the spinner text to pi's default.
  - Without a UI (print mode, the eval over RPC) it does nothing.
- **Messages:** "Recalling your preferences…" (memory's pick before the agent starts), "Diagnosing the repeated failure…" and "Considering other causes of the repeated failure…" (triage), "Trimming noisy output…" (trimmer's sidecar tier), "Writing the compaction summary…" (compaction).
- **Not shown:** memory's similarity recall (1.5 s at most) and any background work, which holds nothing.
- **Unverified:** how pi's TUI renders a custom working message between a tool finishing and the next request. The status line is the dependable one.
- **Also fixed:** applying preferences are now ordered deterministically (ties broken by id).

### D-064 — Preferences also hold what the user expects of a kind of task, and learn from corrections · accepted (2026-10-05; owner's request; research §9, R9.1 and R9.5; amends D-060)
- **Goal:** delegation goes well when expectations are shared, and most go unsaid: how good is good enough, what to leave alone, how much detail and what tone to answer in. Exocortex should learn them and say them for the user. This entry is the first of three steps; the other two are under "Not done".
- **Evidence** (research §9): real users push back on about half of a coding agent's turns while the agent asks about 3% of the time (SWE-chat). Getting the missing information recovers most of the loss (Ambig-SWE, Dialogue-SWEBench). A model near our size cannot be trusted to notice that something is missing (Qwen 3 Coder never asked). Supplying what was learned needs no such judgement.
- **What a preference card may now hold** (amends D-060, which took only *how* work is done): an expectation of the *result* that would hold for other tasks of the same kind. Still never the task's own content.
- **Task kind.** Each card has one of `any`, `fix`, `feature`, `refactor`, `test`, `review`, `explain`, `docs`. The sidecar proposes it (`preferences.v3`); `any` is the default and what it is told to use when unsure.
  - The agent and the user read it as a prefix: "For bug fixes: Do not refactor nearby code."
  - The selection sidecar is told that such a rule fits only that kind of request (`preference-select.v2`). When selection is off or fails, the rule is added with its prefix and the agent decides.
  - Code cannot check the kind. What it does: a card stated for a second, different kind becomes `any`.
- **Corrections.** The sidecar says whether the user's message corrects what the agent just did; it now sees the last 1,200 characters of the agent's message, up from 400. Code counts it only if the agent had said something in this session.
  - Admission is D-060's, unchanged: the user's words verbatim, no one-offs, nothing ungrounded. A correction that only fixes this task's content is not a preference (prompt rule).
  - **A correction does not apply sooner.** One correction is still one task's instruction; it applies after a second session, or at once if said as a standing rule (D-060). Precision over recall (brief constraint 5).
  - What a correction adds is a record: each sighting is marked, and `/exo memory preferences` shows how many were corrections.
- **Repeats (R9.5).** A correction on a preference that was already added to this conversation means adding it did not work. It is counted on the card (`repeated`), traced as `preference_repeated` and shown in the list. This is the accounting D-060 listed as missing. Nothing acts on it yet.
- **Store:** migration 4 adds `task_kind` and `repeated` to `preferences` and `correction` to `preference_sightings`. Existing cards are `any`.
- **No new module and no new setting.** It is on with `memory.preferences`, which stays off by default (D-052). A separate module was considered: it would have needed its own reader of every user message, its own store access and a second injected message, to hold cards that differ from preferences by one column.
- **Open risks:**
  - The sidecar now fills seven fields per proposal. A 27B that mislabels the kind narrows a general preference; `any` when unsure limits this, and `/exo memory preferences` shows it.
  - A correction is recognised by the sidecar. A missed one loses only the mark; a false one, on a card already in the conversation, counts a repeat that did not happen.
  - Untested with a real model, like the rest of D-060 and D-062.
- **Not done:**
  - Steps 2 and 3 are deferred; D-065 has the notes for resuming.
  - **Step 2, the brief (R9.3):** before the agent starts, one visible message with fixed slots (goal, done when, non-goals, quality bar, report), each marked stated, learned or assumed. It states assumptions; it is not a plan to approve. This is where a module of its own is warranted.
  - **Step 3, questions (R9.2, R9.4):** only after step 2 shows which assumed slots users correct. At most three, never about what the repo can answer.
  - The supervisor still does not check preferences (D-060).
  - An eval with underspecified task variants (research §9(c)).

### D-065 — The brief (D-064 step 2) is deferred; notes for resuming · accepted (2026-10-05; owner's call)
- **Decision:** step 2 and step 3 of D-064 wait. Step 1 goes into daily use first, with `memory.preferences` on.
- **What step 1 should show before resuming:**
  - whether the sidecar labels task kinds and corrections sensibly: read `/exo memory preferences` and the `preference_learned` / `preference_seen` trace events;
  - how often `preference_repeated` fires. If added expectations are often corrected again, a brief that restates them will not help either, and the wording or placement of the injected message is the thing to fix.
- **The design as discussed** (not built, not final):
  - One visible `exo.` message before the agent starts, with fixed slots: goal, done when, non-goals, quality bar, how to report back.
  - Each slot marked *stated* (in the prompt), *learned* (a D-064 card) or *assumed* (the sidecar's guess).
  - Non-blocking: the user interrupts if an assumption is wrong. It states the expected result, never the steps (research R9.3).
  - Its own module (`mod-brief`), reading learned expectations from the memory store.
- **What exists to build on:**
  - `ExoModule.contextForUserTurn` is the hook. The host runs the modules' hooks one after another inside one 6 s budget (`USER_TURN_BUDGET_MS`, `pi-adapter/src/modules.ts`) and joins their texts into a single message, so the brief and memory's preferences already land together.
  - Modules cannot see each other's text. The brief would have to query the store itself (`activePreferences`), or the two would repeat each other. Decide which of them renders learned expectations once the brief exists.
  - For step 3, pi has blocking dialogs: `ctx.ui.confirm`, `select`, `input` (`docs/PI_API_NOTES.md`, `ExtensionUIContext`). They are no-ops in print mode and in the eval over RPC unless the client answers. `ModuleContext` exposes none of them yet.
- **Open design questions:**
  - **Cost.** A sidecar call before every task prompt, on top of memory's preference pick (up to 4 s), inside the shared 6 s. Either the budget rises or the two calls become one.
  - **When to skip.** Questions, short follow-ups and accepted suggestions need no brief. A length or task-kind gate decided in code is safer than asking the model.
  - **A wrong *assumed* slot steers the agent.** Options: show assumed slots to the user only, or word them as "unless you find otherwise".
  - **Whether one correction should be enough** to make an expectation apply (D-064 says no; the owner has not ruled on it).
  - Open question 14 still applies: the message arrives as a second consecutive `user` message.
- **Evidence to keep in mind** (research §9): the slot schema helped Qwen3 Coder 30B (25.4% → 32.3%) but not Devstral 2 Small 24B (42.2% → 38.6%), with a simulated user. A plan the user approves does not calibrate trust (Plan-Then-Execute). Qwen 3 Coder 480B never asked a question under any prompt, so step 3 cannot rely on the main model choosing to ask.
- **Measuring it** (research §9(c)): underspecified variants of the hard tasks with a sidecar as the user holding the full task; report hidden, hidden with the brief, and full. Not built. The current fixtures repeat one prompt per task and cannot show it.
- **Method note for the next research pass:** arXiv's HTML pages can be downloaded and searched directly (`https://arxiv.org/html/<id>`). A fetched summary of Ambig-SWE gave per-model resolve rates that are not in the paper; §9's figures were all read from the text.

### D-066 — An interview seeds preferences on a new install · accepted (2026-10-05; owner's request; builds on D-060 and D-064)
- **Goal:** a new install has no preferences, and D-060 makes each one wait for a second session unless it was said as a standing rule. `/exo memory interview` asks the user nine short questions so the common ones apply from the first prompt.
- **Evidence** (research §9, GATE): one study, not about coding. Having a model elicit preferences beat user-written prompts in most settings, with no clear winner between judging generated cases, yes/no questions and open questions. A participant stated a rule and then contradicted it on a concrete case. Judging cases and answering yes/no were rated less effort than writing.
- **Form, following that:**
  - Eight multiple-choice questions, then one open question.
  - Expectations that are hard to state in the abstract are asked as a situation to decide: scope of a bug fix, tests for a fix, an open choice in a request, when work counts as done, a new dependency. Habits people state readily are asked directly: commits, how to report back, how to answer questions.
  - "No preference" is the last option of every question and stores nothing.
- **No model reads a multiple-choice answer.** Each option carries a rule and task kind written in `mod-memory/src/interview.ts`. Picking the option is the user's own statement of that rule, which is D-060's admission signal. The sighting's quote is the question and the chosen label. A free-form answer to a scenario was rejected: a sidecar would have to generalise it into a rule, the judgement D-060 keeps from the model.
- **The open question** ("Anything else the agent should always or never do?") goes through D-060's gate unchanged: the sidecar proposes, the quote must be verbatim. Two differences: each admitted rule is standing, because the question asked for standing rules, and the call is `interactive`, because the user is waiting. Without a sidecar engine the answer is not read and the reply says so.
- **Interview answers apply in every repo, at once** (amends `activePreferences`, D-060). The questions are about the user's work in general, so D-018's "said in 2+ repos" test would only delay them.
- **The latest answer to a question is the answer.** Running the interview again retires what another option of the same question stored, also when the user now picks "No preference". A rule close to a known preference merges into it (exact text, then D-060's word overlap).
- **Cancelling** a question ends the interview and keeps the answers given so far.
- **Only the user starts it.** Nothing launches it on install: a dialog waits for as long as the user takes, and no hook may do that. The one prompt is in the reply of `/exo memory preferences` when the list is empty.
- **Marked.** Migration 5 adds `source` (`message` or `interview`) to `preference_sightings`. The list says "from the interview"; `preference_learned` and `preference_seen` carry `source: "interview"`; one `interview` trace event counts answered, added, retired and cancelled. D-065 wants to see how well the sidecar labels what it learns, and seeded cards would hide that if they could not be told apart. `preference_repeated` works on them as on any card, so the question D-065 gates on (does adding an expectation work?) gets evidence from day one.
- **Host change** (harness-agnostic): `ExoModule.command(args, dialog?)` may now return a promise, and gets a `Dialog` (`select`, `input`, `notify`) when the harness has a UI. Only commands get one. The pi adapter builds it from `ctx.ui` in TUI and RPC modes; in print and json modes there is none and the command says the interview needs an interactive session.
- **Needs `memory.preferences` on** (still off by default, D-052); otherwise the command says so and stores nothing.
- **Open risks:**
  - An offered option can suggest a preference the user does not hold, and each card takes one of the 5 places in a prompt. "No preference" and `/exo memory forget` are the only guards.
  - One answer to one scenario may be read more widely than the user meant. The task kind limits it for the two bug-fix questions and the question about explanations; the rest are `any`.
  - The questions and rules are the author's judgement of what matters, not measured. `preference_repeated` per card is the evidence to revise them by.
  - Untested with a real model and a real pi TUI: the dialogs are exercised only through fakes.
- **Not done:**
  - Questions generated for the user or the repo (GATE's method). That needs a model to word the rule.
  - D-064's steps 2 and 3 stay deferred (D-065). The interview is asked once, not per task.

### D-067 — Compaction writes opencode's structured summary; tracked facts stay · accepted (2026-10-05; owner's request; amends D-044)
- **Goal:** the owner is happy with how opencode compacts and wants ours to use a similar prompt and approach. Read in opencode 1.18.34 (`sst/opencode` at `907b3bc5`): `packages/opencode/src/session/compaction.ts`, `packages/core/src/session/compaction.ts` and `packages/opencode/src/agent/prompt/compaction.txt`.
- **What opencode does, and where we already matched:**
  - It keeps recent turns verbatim and summarizes the rest. Pi does this itself (`keepRecentTokens`, 20,000 by default) and hands us only the span to summarize.
  - It serializes the span with role labels and cuts each tool result at 2,000 characters. Pi's `serializeConversation`, which we use, does the same.
  - It gives the previous summary back to the model to merge into the new one. D-044 did this for the narrative only.
- **Adopted:**
  - **System prompt:** opencode's, verbatim: a summarization agent that does not continue the conversation or answer questions in it.
  - **Structure:** opencode's Markdown template: Objective, Important Details, Work State (Completed, Active, Blocked), Next Move, Relevant Files. It replaces D-044's JSON narrative (current work, next step, dead ends, key facts).
  - **Merging:** opencode's update instructions. The previous summary is discarded afterwards, so directives and decisions are carried forward, and the conversation wins where they conflict.
  - **Free Markdown, not a JSON schema.** The reply is taken from `## Objective` on, without the template's tags or a code fence.
  - **Limits:** opencode's 4,096 output tokens (`maxSummaryTokens`), and the whole span goes to the sidecar (D-068). `maxConversationChars` (400,000) remains only as a guard for a sidecar with a smaller window than the main model's.
- **Changed from opencode:**
  - The "Blocked" bullet also asks for approaches that were tried and failed, with why. D-044 had a dead-ends list for this (research R4.1) and the template had no place for it.
  - `/compact <focus>` is appended as "The user asked this summary to focus on: …". Opencode has no such input.
- **Kept from D-044:**
  - **Tracked facts follow the sidecar's summary, verbatim:** user requests, files modified with numstat, files read, commands that last failed or passed. The headings are unchanged. They overlap with "Relevant Files" and "Blocked"; the overlap is the exact record against the model's account of it.
  - **Only the sidecar's part is merged.** The previous summary is cut at the first facts heading; the facts are rendered again from what was tracked (R4.2). A summary pi wrote is carried whole. From a summary written before this entry, the part from "## Current work" is carried.
  - **The guidance gate (D-061),** now per bullet: a bullet naming a file or symbol found nowhere in the transcript, the previous summary or the workspace is dropped, and a section left empty says "(none)". The Objective is exempt, as `current_work` was.
  - Critical priority, the 90 s deadline, and both fallbacks.
- **A reply that ignores the template is not used.** Objective, Work State and Next Move must be present as headings; otherwise the fallback applies. A reply cut off after those is used.
- **Fixed on the way: summaries were being cut at 1,024 tokens.** The pool caps every sidecar call at `maxTokensPerCall`, default 1,024, and D-044's 1,200-token setting was silently clamped to it. The default is now 4,096.
- **Prompts:** `summarize-system.v2.md`, `summarize.v2.md`, `summarize-update.v2.md` and `summary-template.v2.md`; `summarize.v1.md` is removed. Opencode is MIT-licensed; its notice is in `packages/mod-compaction/THIRD_PARTY_NOTICES.md`.
- **Trace:** `exo.compaction` keeps `narrative` (a sidecar summary was used) and adds `updated` (a previous summary was merged).
- **Open risks:**
  - Untested with a real model. Nothing enforces the template as a JSON schema did; a reply that misses it costs the user the wait plus pi's own compaction. The debug log says "did not follow the template".
  - The gate now reads every bullet but the Objective, so a false positive drops more. `ungroundedReferences` treats anything shaped like `name.ext` as a path.
  - The summary is longer than D-044's, so each request after a compaction carries more.
- **Not done:**
  - Opencode's pruning of old tool outputs (`compaction.prune`). It rewrites earlier messages, which the prompt-cache rule forbids; D-053 keeps retro-masking deferred.
  - Opencode's synthetic "Continue if you have next steps…" message after an automatic compaction, and its replay of the last user message after an overflow. Both are pi's side of compaction.

### D-068 — The target model is strong and fast: no output limits to save time · accepted (2026-10-05; owner's correction)
- **Facts from the owner:** Qwen 3.8 27B is a very good local model, and ninfer decodes it at about 200 tokens per second. Earlier entries reason from a weak, slow 27B; where they set a limit to save output time, this entry replaces that reasoning.
- **Rule:** no sidecar call gets a low output limit, or any other constraint, in order to be quicker.
- **Changed:**
  - Every module's sidecar call asks for `SIDECAR_MAX_TOKENS` (4,096, in core). It only stops a runaway reply. Before: memory 60, 300 and 400; triage 250 and 300; trimmer 400; supervisor 700 and 800. A low limit also cut replies off, and with `thinking` on it could do so before the answer began.
  - The pool's default `maxTokensPerCall` is the same 4,096 (was 1,024). Config can still set it per module.
  - Compaction: 4,096 summary tokens and the whole span (D-067).
- **Not changed, and why:**
  - **Hook time budgets** (D-039, D-041, brief): every hook that holds pi keeps its deadline. They exist so an Exocortex fault cannot stall a session, whatever the model's speed. At 200 tokens per second the replies these calls produce fit them many times over.
  - **Limits on what enters the main model's context:** injected cards and preferences, hint and lesson lengths in the schemas, trimmed output sizes. They are about the main model's context, not the sidecar's speed.
  - **Limits on sidecar input** that an earlier entry justified by prefill time (the trimmer's `sidecarAboveChars` to `sidecarMaxInputChars` window; D-024's "keep isolated prompts short"). The owner's figure is for output; prefill speed and its effect on the main model's decode were measured in D-038 and are a separate question.
  - **Gates that check a sidecar's claims against evidence** (the verbatim-quote admission of D-060, the grounding gate of D-061, verified fixes in D-049). A strong model still states things that are not in its input; these cost no time. Loosening any of them is the owner's call, per gate.
- **Follow-up:** the README still introduces Exocortex as help for "a weak local LLM".

### D-069 — Triage also notices loops without an error, and asks for a hand-over when a loop goes on · accepted (2026-10-05; owner's request: patch the weakest module before the A/B runs; amends D-043)
- **Why triage:** D-043 sees one kind of stuck agent, a failing result whose normalized error repeats. Every comparable project reads in source treats that as one case of several, and all of them also do something when their warning is ignored. Triage did neither.
- **What the other projects do** (read in source, 2026-10-05):
  - **OpenHands** (`software-agent-sdk` at `39d34ec`, `openhands/sdk/conversation/stuck_detector.py`): compares actions *and* observations. Stuck is the same action with the same observation 4 times, the same action erroring 3 times, an A-B-A-B-A-B alternation with matching observations, or 3 agent messages in a row. For the erroring action it nudges once per streak at the threshold and declares the agent stuck one repeat later.
  - **Gemini CLI** (`fb972b2`, `packages/core/src/services/loopDetectionService.ts`): hashes tool name and arguments; a cycle of 1 to 5 calls repeated 5 times is a loop. It also looks for repeated text while streaming, and after 30 turns asks a model every 5 to 15 turns whether the agent is making progress, acting only at confidence 0.9. On the first detection it tells the model to step back (`core/client.ts`, `_recoverFromLoop`); on the second it stops the turn.
  - **opencode** (`907b3bc5`, `packages/opencode/src/session/processor.ts`): the same tool with the same input 3 times running asks the user for permission (`doom_loop`).
  - **Goose** (`5bd5e54`, `crates/goose/src/tool_monitor.rs`): counts consecutive identical calls against a configured maximum; the call past it fails the check.
  - **Cline** (`afabc82`, `apps/cli/src/runtime/interactive/mistakes.ts`): at a limit of consecutive mistakes it asks the user to choose between "try a different approach" and "stop this run".
- **Adopted:**
  - **A loop is a call and its result repeating, error or not** (OpenHands' comparison; Gemini's cycles). Core's `callKey` hashes the tool, its exact input and its output; `trailingLoop` finds the last 1 to 5 calls repeated in a row. Comparing results is what makes it safe at 3 repeats: a batch of similar calls or a test run whose counts change is not a loop.
  - **Run-to-run noise is ignored in the result:** durations, clock times, dates and addresses. Other numbers are kept, so "3 failed" then "2 failed" is progress.
  - **One notice per loop, at `loopThreshold` (3) rounds** (OpenHands nudges once per streak). It goes on the next result that is not a failure; failures in the loop already get D-043's notices.
  - **A hand-over at twice the threshold** (Gemini's second detection, Cline's question, opencode's permission). The notice then says to stop repeating and, failing a different approach, to stop and tell the user what was tried and what blocks it. D-043's repeated-error notice does the same from the 6th failure.
- **Fitted to this project:**
  - **Advisory only.** No call is blocked and no run is stopped (D-010): the others can stop the agent because they own its loop; a module here can only add text to a result. Asking the agent to hand over is the strongest step available without a host change.
  - **Deterministic, no sidecar.** Nothing is added to a result until a loop exists, and then one line.
  - **The same definition in the eval.** `stuckLoops` and `stuckLoopCalls` are computed from the original tool results with core's functions, so they mean the same with triage on or off. The report's "Stuck loops" section shows runs with a loop, their success, and calls made inside a loop.
  - `loops: false` turns it off; counts reset on a new user request, as D-043's do.
- **Open risks:**
  - A loop that is legitimate waiting (polling a job with an unchanged status) gets the notice. It is one line and says to do something else or use the result.
  - Exact comparison misses a loop whose output carries a changing counter or id that is not a time or address.
  - The hand-over is a request. An agent that ignores it carries on.
- **Not done:**
  - **Stopping the run or asking the user from the host** (what Gemini, Goose and Cline do). It needs a new module action and a ruling on D-010. `stuckLoopCalls` per loop in the A/B is the evidence for whether the request is enough.
  - **A sidecar that judges progress** (Gemini's periodic check). It could catch loops that never repeat exactly. Deferred until the deterministic count shows how many loops there are to find.
  - **Repeated text in the model's own output** (Gemini's chanting check, OpenHands' monologue). Modules see results, not the stream.
  - **Counting consecutive failures of any kind** (Cline). A build that fails differently each time is usually progress.

---

### D-070 — Trimmer: hide routine lines first, keep failures whole, trim from the full output, leave requested content alone · accepted (2026-10-05; owner's request: patch the weakest module before the A/B runs; amends D-042 and D-061)
- **Why the trimmer.** It runs on every long bash result and is the only module that removes text the model would otherwise read. D-042's design was never compared with another project's code (triage got that in D-069, compaction in D-067).
- **What others do.** Read at the commits named.
  - **Position only.** Codex (`3f1ccb7`, `codex-rs/utils/string/src/truncate.rs`): half head, half tail of a 10,000-token budget. Gemini CLI (`fb972b2`, `packages/core/src/utils/fileUtils.ts`): 20% head, 80% tail of 40,000 characters, saved to a file. OpenHands (`39d34ec`, `openhands/sdk/utils/truncate.py`): half and half of 30,000 characters, and the marker says which line of the saved file the cut starts at. Goose (`5bd5e54`, `developer/shell.rs`): the last 50 lines, with a hint to read the file with `sed -n '100,200p'`. opencode (`907b3bc`, `tool/truncate.ts`): 2,000 lines or 50 KB, with "Use Grep to search the full content or Read with offset/limit". pi does the same as opencode but keeps the tail (PI_API_NOTES, `bash`). None of them looks at what the lines say.
  - **Content.** RTK (`rtk-ai/rtk` at `cf018af`) and tokf (`mpecan/tokf` at `87c93d9`) filter per command. Both remove the lines a passing run prints (`Compiling`, `test … ok`, `=== RUN`, `--- PASS`) and keep each failure as a whole block (RTK's `RegexBlockFilter`: a start pattern plus the indented lines under it; tokf's `[[section]]`). RTK's contributing guide states the rules we borrow: output the agent asked for in detail is not compressed, the result is a subset of the real output in its own format, and anything capped comes with a way to get the rest.
- **Measured before the change.** The check command of each `noisy-output` task was run on its unsolved fixture, cut the way pi cuts it, then trimmed.
  - Six of the seven outputs are over pi's 50 KB (135 KB to 455 KB), so the trimmer only ever saw their last 50 KB.
  - `h-cpp-netcalc`: 63 failing checks. The trimmer showed 8 of them and 87 passing ones. TAP's `not ok` was not in the error grammar.
  - `h-go-settlement-calendar`: 32 lines say what each failing test got and wanted. The trimmer showed 1, with 152 `--- PASS` lines.
  - Python `unittest`'s `FAIL:` and `ERROR:` headers were not in the grammar either; they survived only when they fell in the last 80 lines.
- **Decision.**
  1. **Routine lines are hidden first** (`hideRoutine`, default on). Core's `isRoutineLine` lists what passing tests and build steps print for the D-016 toolchains and TAP. If what is left fits `minChars`, all of it is shown; only otherwise does D-042's head, tail and error selection run, on what is left. The last 5 lines are never hidden, and neither is a line the error grammar calls specific. Log levels (`DEBUG`, `INFO`) are not routine: they are the program's own output.
  2. **An error keeps its block.** D-042 kept 3 lines either side. Now the lines after an error are kept while they are indented or continue the diagnostic (a traceback, gcc's `note:` lines), up to `maxBlockLines` (30). 3 lines before stay.
  3. **The trimmer reads the harness's saved file** when the harness cut the output (`maxFullOutputBytes`, 16 MiB; larger or unreadable files fall back to the text as before). pi's "Showing lines…" notice is dropped, since it is no longer true, and the exit status is added back: the draft gains `status`, which the pi adapter fills from the text.
  4. **Markers give line numbers** in the saved file (`[… lines 41–1210 omitted …]`), and the footer says to grep the file or read a range. When the trimmer could not read the harness's file the numbers would be wrong, so markers only count, as before.
  5. **Requested content is left alone.** `cat`, `grep`, `git diff` and the like (`verbatimCommands`) are not logs. D-042 trimmed them as if they were, which cut a file to its first 40 and last 80 lines plus every line containing "error". A command counts when every part of it that prints ends in such a command, so `cargo test 2>&1 | tail -100` counts too: the agent chose those lines. pi's own 50 KB limit still applies. A command line with a heredoc, a substitution or a subshell is not classified and is trimmed as before.
  6. **Error grammar** (core, so triage, memory and the eval see it too): `unittest`'s `FAIL:`/`ERROR:`, a bare `AssertionError`, TAP `not ok`, GoogleTest `[  FAILED  ]`, and Go's indented `x_test.go:N:` messages.
- **Result on the same outputs.** `h-cpp-netcalc`: all 63 failures with their got/expected lines, in 8.9k characters (pi gives 51k, the old trimmer 5.4k). `h-go-settlement-calendar`: all 30 failing tests and all 32 messages in 5.9k (old: 12.2k). `h-rust-css-colors`: the same failures as before with no `test … ok` lines (old: 81). The other three change little: their noise is log lines and compiler warnings.
- **Side effect to know about.** An error signature is the first specific error line. For `unittest`, TAP and GoogleTest runs that is now the first failing test, where it used to be a later line such as `make: *** … Error 1`. Triage's repeat counts and memory's cards for those runners therefore follow which test fails first. Nothing has been A/B'd, so no stored result changes meaning.
- **Not done.**
  - **Per-command filters** like RTK's and tokf's (a parser per tool, one-line summaries on success). They rewrite the output into their own format and need a filter for each tool; the routine-line grammar gets the measured gain while every shown line stays verbatim.
  - **Grouping repeated compiler warnings** (RTK groups clippy warnings by lint). `h-cpp-build-log` and `h-rust-css-colors` are mostly warnings the prompt says to leave. It needs block-level matching across the output; revisit if the A/B shows those two tasks gaining nothing.
  - **Hiding `DEBUG` lines**, and a setting per toolchain.
  - **tokf's re-run signal** (the same command run again straight after a filtered result means the agent did not trust it). The report's read-back count (D-061) covers the same question.
- **A/B.** `trimmer` in AB_PLAN step 3 now measures this design. Apart from the grammar, the old behaviour is `hideRoutine: false`, `maxBlockLines: 0`, `verbatimCommands: []`, `maxFullOutputBytes: 0`; no eval config is added for it.

### D-071 — Supervisor: the judge reads the request, sees every changed file, and is told when the tests prove nothing · accepted (2026-10-05; owner's request: patch the weakest module before the A/B runs; amends D-039, D-046 and brief §6.1)
- **Why the supervisor.** It is first in AB_PLAN and the only module whose design had not been compared with other projects' code (compaction got that in D-067, triage in D-069, the trimmer in D-070). Read against them, its verdict rested on less than any of theirs.
- **What others do.** Read at the commits named. None of them has an isolated judge working from a summary.
  - **Run a command.** Aider (`5dc9490`, `aider/coders/base_coder.py`): with `--auto-test`, the test command runs after every edit and its failures become the next message. Goose (`5bd5e54`, `crates/goose/src/agents/retry.rs`): a recipe's `retry.checks` are shell commands run when the agent stops; a failing one restarts the attempt, up to `max_retries`.
  - **Hand the review back to the agent, which has the whole conversation and the tools.** SWE-agent (`3ea751c`, `tools/review_on_submit_m/bin/submit` and `config/default.yaml`): the first `submit` is not accepted. It returns the agent's full diff with a list: run the reproduction again if code changed after it, remove the reproduction script, revert edited test files, submit again. No model call. OpenHands (`software-agent-sdk` at `39d34ec`, `openhands/sdk/critic/base.py`): a critic scores the work on finish; below a threshold the agent is sent "Please review what you've done and verify each requirement is met. List what's working and what needs fixing, then complete the task", at most 3 times.
  - **Give the critic everything.** OpenHands' API critic (`critic/impl/api/critic.py`) is sent the whole conversation and the tool definitions.
  - **Cheap deterministic stops.** OpenHands' `EmptyPatchCritic` and Trae Agent (`e839e55`, `trae_agent/agent/trae_agent.py`, `must_patch`): an empty patch is not done; Trae does not count changes to tests. Roo Code (`b867ec9`, `src/core/tools/AttemptCompletionTool.ts`): completion is refused while todos are open. Gemini CLI (`fb972b2`, `packages/core/src/utils/nextSpeakerChecker.ts`): a model call decides whether the last message announced a next step and stopped; if so it sends "Please continue."
  - Codex (`3f1ccb7`, `codex-rs/hooks/src/events/stop.rs`) leaves the check to a user's Stop hook, and passes it `stop_hook_active` so the hook can tell it has already blocked once.
- **What was weak here, measured on the fixtures.**
  - **The judge never saw the request.** It saw a checklist of at most 7 items written by a sidecar. Five of the seven `spec-compliance` tasks state more than 7 numbered requirements (three state 12), in prompts of up to 4,500 characters full of exact values (`1.005` -> 100). A requirement past the seventh was not judged, and the detail of the others was gone.
  - **The judge saw the start of the diff.** Evidence was capped at 8,000 characters and the diff was cut at whatever room was left. The *reference* patch alone is over 6,000 characters for 8 of the 28 hard tasks, 4 of them `spec-compliance`; an agent's diff is rarely smaller. Later files were not shown at all.
  - **No check ran.** D-039 runs a command only from config or quoted in the request. The task prompts quote none, as real prompts rarely do (EVAL_TASKS rule 6), so in the `supervisor` config the only test evidence was the agent's own exit codes. Those are wrong when files changed after the run, and wrong when the output went through `| tail`, which reports `tail`'s exit code.
  - **`uncertain` did nothing**, and with the evidence above it was the honest verdict for much of a long task.
- **Decision.**
  1. **The verdict reads the user's request verbatim** (OpenHands' "give the critic everything", cut down to what an isolated call needs). Messages that continue a task are added under "(The developer then added:)"; an accepted suggestion is not a request. Up to 16,000 characters, start and end kept. The checklist stays as the index the verdict answers against, and the prompt says the request's detail is part of each item (`verdict.v5`, `verdict-items.v5`).
  2. **Up to 12 criteria** (brief §6.1 and D-039 had 7), one per listed requirement, in order, without merging (`ledger.v2`).
  3. **Evidence budget 40,000 characters** (`maxEvidenceChars`, was 8,000), and the diff is cut **per file**: each file gets an equal share, what a short file leaves goes to the longer ones, code comes before tests, and a cut file says how many lines are not shown. Check output is shown up to 4,000 characters (was 1,200) and an unfixed failure up to 2,000 (was 600).
  4. **The judge is told when the agent's own test run proves nothing; nothing is run** (`testRunNotes`, always on). Two cases: the workspace changed after the agent's last full test run (or build, when it ran no tests), or that run was piped into another command without `pipefail`. Each adds a "Note:" line under the agent's commands, and the prompts say such a run does not show the finished work passes. The items resting on it come back as not shown, so with `verifyUncertain` (item 5) the agent is asked to run its tests again. That is SWE-agent's review step: the agent re-runs, not the harness.
     - **"Changed" is measured, not inferred from which tool was used.** When a test or build run ends, the supervisor fingerprints the workspace: one `git` command hashing the tracked diff and the content of untracked, unignored files. At settle it takes the fingerprint again; a difference means the run is stale. So an edit from the shell (`sed -i`, a generator, `git checkout`) counts, and an edit that was undone does not. Outside a git repository, or if the fingerprint fails, it falls back to "a file tool was used after the run".
     - **Considered and dropped: running the command again ourselves** (Aider's and Goose's check, with the command taken from the agent's history). It was built and removed on the owner's objection. It gives the true exit code without an agent turn, but it needs a rule for a run that times out, a shell parser to decide what is safe to repeat, a guess at the directory the agent ran it in, and an answer for flaky suites, and in a session the user waits for the run. The agent has the right directory and environment and reads the output itself.
     - Commands the user names (`checks`, or quoted in the request) still run at settle, as in D-011. `exo.verdict` now records them: `checks: [{command, source: config | request, exitCode, timedOut}]`.
  5. **Option `verifyUncertain`, off (D-046's rule): on `uncertain`, ask the agent once** (SWE-agent's review, OpenHands' follow-up). The verdict lists the items the evidence does not show (`unverified`; in per-criterion mode, the items rated unknown), and the follow-up reads: "Before you stop: I could not confirm these parts of my request from your changes and test runs: … Check each one against my request and show what proves it (a command you run, or the code). Fix whatever turns out not to be done." It is a suggestion or, in auto mode, a continuation like any other: it counts toward `maxContinuations`, is asked once per task, and never when the agent changed nothing or is waiting on the user. Eval config `supervisor-verify`; `supervisor-research` includes it.
  6. **Two readings added to the verdict prompts:** a check run just now that exits non-zero means not done whatever the agent says, and a final message that says what it will do next and stops leaves those items undone (Gemini's case, without a call of its own).
- **How this sits with earlier entries.**
  - **D-039 item 3, "a model can never invent a command to run".** Unchanged: only the user's commands run.
  - **D-068 left sidecar input limits alone** because a sidecar's prefill shares the GPU with the main model's decode (D-038). The verdict runs after the agent has stopped, so its prefill delays only the verdict. The other modules' input limits are unchanged.
  - **D-046: options stay off until A/B'd.** Items 1 to 4 and 6 change what the plain `supervisor` config does. Nothing has been A/B'd, so no result changes meaning (as in D-061), and every option is still compared against the same `supervisor`. `maxEvidenceChars: 8000` gives back the old budget; the request in the prompt, the 12 criteria and the notes have no switch.
  - **D-010: suggest, don't act.** Unchanged. The verification request goes through the same suggest/auto path.
- **Costs to know about.**
  - A verdict prompt of up to about 15k tokens instead of about 3k. Prefill time on ninfer is not measured for this; the trace has each call's tokens and latency. `completeVotes` re-asks share the prefix.
  - Without `verifyUncertain`, a stale or piped test run changes only what the judge believes: an `uncertain` verdict still does nothing.
- **Open risks.**
  - Untested with a real model, like the rest of the supervisor.
  - A full request beside the checklist gives the judge more to find fault with: precision of `incomplete` may fall where precision of `complete` rises. The A/B reports both sides ("Supervisor verdicts vs hidden checks").
  - The fingerprint is taken when the test run's result arrives, not atomically with it. The agent's next tool call follows a model request, so the gap is far longer than the `git` call; a harness running tool calls in parallel could beat it.
  - A file the test run or a later command writes that git neither tracks nor ignores (a cache directory with no `.gitignore` entry) reads as a change. The cost is a note that makes the judge less sure.
  - Changes to ignored files are not seen.
  - `ledger.v2` asks for short index-like criteria. If the judge leans on them instead of the request, detail is lost again; the prompt says which wins.
- **Not done.**
  - **Acting on a stale test run without the judge** (a fixed "run your tests again" follow-up whenever the agent edits after testing). It would fire on a README edit too. The eval's "lucky passes" (D-048) count the same condition; if they are common in the `supervisor` row, this is the next step.
  - **An unconditional review on every stop** (SWE-agent's). In daily use it would put a message in the editor after every task. `verifyUncertain` asks only when the judge could not tell.
  - **Giving the judge the conversation** (OpenHands' critic). The request, the diff and a fresh test run are the parts that cannot be argued with; the agent's narrative is what D-039 keeps from the judge. `finalMessage` already A/Bs how much of it helps (D-054).
  - **A judge with tools** that reads files and runs commands itself. It would be a second agent loop in the pool. Reconsider if `uncertain` stays common after this entry.
  - **Not counting test-only changes as work** (Trae). `warningSignals` reports tampering; a task may be to write tests.
  - **The in-loop check** (R1.8) and thinking by default stay as D-061 left them.

---

### D-072 — Memory: a card is one problem and its fix, shown as a past fix to check · accepted (2026-10-05; owner's request: patch the weakest module before the A/B runs; amends D-049, D-018's promotion and research R5.3)
- **Why memory.** It is the last module in AB_PLAN whose design had not been compared with other projects' code (compaction got that in D-067, triage in D-069, the trimmer in D-070, the supervisor in D-071). D-060 to D-066 added preferences; the pitfall cards that step 4 measures were as D-049 left them.
- **What others do.** Read at the commits named; the lines quoted were checked in the clones. None of them keys memory on an error or injects it into a tool result, so what is borrowed is how they decide identity, what they tell the model about a memory, and what they count as feedback.
  - **Codex** (`7c2ce90`, `codex-rs/memories/write/templates/memories/stage_one_system.md`, `consolidation.md`; `ext/memories/templates/memories/read_path_v2.md`; `state/src/runtime/memories.rs`). A background model reads finished sessions. The prompt opens with a gate: "No-op is allowed and preferred when there is no meaningful, reusable learning worth saving", tested by "Will a future agent plausibly act better because of what I write here?". Failures have their own section, shaped "symptom -> cause -> fix + verification + stop rules", with "exact error snippets + pointers" as the handle. The reading side says "Memory is not proof of current behavior." Feedback is whether a memory was cited (`usage_count`); nothing scores whether it helped.
  - **Gemini CLI** (`fb972b2`, `packages/core/src/agents/skill-extraction-agent.ts`). A background agent proposes patches the user must approve. It looks for "Failed attempts followed by successful ones -> failure shield", and refuses what we store: "If the candidate is tied to one incident or cannot survive renaming the specific bug/ticket, do NOT create it." Its memory is loaded into every session, so one incident is noise there; ours is shown only when that incident's error is back.
  - **OpenHands** (`software-agent-sdk` at `50bb5b4`, `openhands/sdk/context/prompts/templates/skill_knowledge_info.j2`, `sections/dynamic.py`, `conversation/impl/local_conversation.py`). The nearest mechanism to ours: a rule whose path pattern matches a tool call is appended to that tool result, once per conversation. Keyword-triggered knowledge is introduced with "It may or may not be relevant to the user's request", and memory files as "unverified, possibly stale hints, never as authoritative instructions".
  - **claude-mem** (`57744a0`, `src/cli/handlers/file-context.ts`, `src/services/dedup/nearDuplicate.ts`). Notes about a file are added when the agent reads it, as one-line pointers with ids, and skipped when the file changed after the newest note. Two notes are near-duplicates only if no rare word is on one side alone.
  - **ReasoningBank** (`google-research/reasoning-bank` at `ed80611`, `WebArena/agents/legacy/agent.py`, `WebArena/prompts/memory_instruction.py`) and **SWE-Exp** (`6b5c92e`, `moatless/experience/exp_agent/exp_agent.py`). Both write from the whole trajectory, failed ones included; SWE-Exp picks the shortest resolved one. ReasoningBank's wrapper: "may be helpful to solve the task. You can use it when you feel it's relevant."
  - **ACE** (`82709de`, `playbook_utils.py`) and **ExpeL** (`e41ec9a`, `agent/expel.py`). Counters per item. ACE's are set by a model tagging the bullets the generator cited, and no code ranks or prunes by them. ExpeL's (+2 on add, +1 on agree, −1 on remove, dropped at 0) are set while writing rules, never by whether a rule helped when used. **mem0** (v1.0.11, `mem0/memory/main.py`) compared each new fact with its 5 nearest memories and had a model choose ADD, UPDATE, DELETE or NONE; at `c93420c` it only adds.
- **What was weak here, measured on the fixtures.** Each hard task's check was run while its reference patch was applied one file at a time, a stand-in for an agent that tests between edits (27 of the 28 fail at some point; 26 replays reach a pass).
  - **A card's key named the kind of error, not the problem.** The signature strips quoted names and numbers so that triage can count repeats. `h-rust-forth`, `h-rust-ini-parser` and `h-rust-text-table` all fail first with `error: test failed, to rerun pass <str>`. D-049 kept one card per repo and signature, so in one repo every later `cargo test` failure would have been merged into the first card and shown its lesson. D-018 promotes a signature seen in two other repos, and the eval gives each task its own repo in one store: each of those three tasks would have been shown the other two's lessons, under "this error was fixed before in this repo".
  - **Only the last error got a card.** When the error changed before the command passed, the episode restarted. A second attempt meets the first error. In the replay 21 of 26 tasks ended with a card their own first failure would recall; the other 5 change their first error line on the way.
  - **The wording claimed more than was known**: "this error was fixed before in this repo", also for keyword, embedding and other-repo matches.
  - **Credit followed the signature.** `hurt` was any later failure with the signature, so a different test failing counted against the card; `helped` was the error not coming back, so a card was credited when the agent never ran the command again.
  - **Rust panics were not in the error grammar** (core, so triage and the trimmer too). Rust 1.91+ prints `thread 'name' (12345) panicked at`; the pattern expected no thread id, so the first specific line was cargo's last.
- **Decision.**
  1. **A card is a signature plus the names in the failure** (Codex's exact snippets as the handle; claude-mem's rare-word rule; mem0's compare-before-add, in code). `failureDetail` reads the first 8 error lines and keeps quoted text, dotted or `::` paths and identifier-like tokens: test names, symbols, error codes, file names. Plain words of the message are left out; the signature holds those. A failure is the card's problem when the signatures match and the failure, read over its first 80 error lines, mentions at least `minDetail` (0.6) of the card's names. Learning merges into a card only when that holds both ways; otherwise it adds a card, so one signature can have many. Store migration 6 adds `detail` and `files`; cards from before it have no names and match on the signature, as they did.
  2. **Promotion needs the same problem** (amends D-018): two other repos with the signature *and* the names. A missing module or library in three repos still promotes; three unrelated test failures do not.
  3. **A card with the failure's signature and other names is a different problem**, so the keyword and embedding paths skip it. They are for another kind of error worded alike.
  4. **The first error is kept when the error changes** (ReasoningBank and SWE-Exp write from the whole route; Gemini's "failed attempts followed by successful ones"). A pass gives a card for the first error, with every edit since, and one for the last, with the edits that finished it. The pass is still the only admission signal (R5.2): it shows that those edits together fixed what the first run reported. An error that went away with nothing edited is dropped. At most 4 errors per command are kept.
  5. **The lesson sidecar reads the route** (`lesson.v2`): each error, the edits made while it stood, how often the command failed the same way in between, then the pass. It writes symptom → cause → fix (Codex's shape), is told the fix is what was in place at the pass and to mention a failed attempt only as a trap, and is asked Codex's question before writing anything. Excerpts are 20 lines (was 8) and edits 1,200 characters (was 400); the call runs in the background while the agent is idle, so its size delays nothing (D-071's reasoning for the verdict). Lessons may be 400 characters (was 300).
  6. **The agent is told what a card is** (OpenHands' and Codex's wording): "[exo memory: notes from earlier fixes, each written after a failing command passed. The code may have changed since: check a note against the current code before relying on it.]" Each note says how it matched ("this error, this repo", "a similar error, this repo", "this error, other repos") and which files the fix edited (claude-mem's pointer), so there is something to check it against.
  7. **Credit follows the command** (amends R5.3). A card shown for a failing command is `helped` when that command later passes in the task, `hurt` when its problem (signature and names) comes back twice or more, or comes back and the command never passes, and gets no credit when the agent never runs the command again. One more failure before the pass is not held against a card: the agent has to apply it. Each credit is traced (`credited`). Retirement is unchanged.
  8. **`cargo test` and `cargo test 2>&1` are one command** for fail → pass.
  9. **Error grammar** (core): Rust's panic line with a thread id.
- **Result on the same replay.** 26 of 26 tasks end with a card their own first failure recalls (was 21), and no task's first failure recalls another task's card (was 3). The 27th replay never passes: the script rewrites a Python file faster than the bytecode cache notices, which is the script's fault.
- **How this sits with earlier entries.**
  - **D-049 "recall: hot path, no LLM"** and **R5.2 admission**: unchanged. The name check is string work on text already in hand.
  - **D-062's principle** (the model proposes, code verifies): identity could have gone to the lesson sidecar as "same as card N", as preferences do. It is in code because recall has to make the same decision on the hot path, and two different rules for "same problem" would disagree.
  - **D-070's side effect** (for `unittest`, TAP and GoogleTest the signature follows the first failing test) is now harmless for memory within one failure set, and item 4 covers the first error changing.
  - **D-052**: memory is off by default and nothing has been A/B'd, so no result changes meaning. `minDetail: 0` gives back matching on the signature alone; the rest has no switch.
- **Open risks.**
  - Untested with a real model. The replay applies a reference patch; an agent takes other routes.
  - **The signature must still match.** Where it follows the first failing test and the agent's first failure is a different subset of tests, the card is not found. Rust prints test results in completion order, so non-quiet `cargo test` can vary run to run. A `tried` count in the `recalled` trace would show this; today a miss is silent.
  - **A piped run** (`cargo test 2>&1 | tail -30`) reports the last command's exit code, so it neither opens an episode nor recalls a card. D-071 tells the judge about such runs; memory does not see them.
  - **Edits made from the shell** (`sed -i`, a generator) are not seen, so a fix made only that way leaves no card.
  - `failureDetail` is a heuristic. A failure that names nothing identifier-like leaves a card with no names, which matches on the signature alone.
  - The first error's card holds every edit up to the pass. On the same task that is close to the solution: same-task replay was already an upper bound (research §5c), and it is more of one now.
- **Not done.**
  - **Skipping a card whose files changed since it was learned** (claude-mem). The repo scope is a remote or a root tree, not a commit, and a card's fix is supposed to be in the code already when the error comes back. The wording tells the agent to check instead.
  - **Asking the agent which notes it used** (ACE's `bullet_ids`, Codex's citation block). It would put an instruction about memory into the main model's context for every task. Credit stays on what the command did.
  - **A consolidation pass** that rewrites or merges cards across sessions (Codex's phase 2, Gemini's inbox). R5.5 rules out wholesale rewrites, and there are no cards yet to consolidate.
  - **Recall by the task instead of the error** (ReasoningBank and SWE-Exp key on the request). That is the user-turn retrieval D-049 deferred; it needs `procedure` cards.
  - **Requiring a fix to recur before it is kept** (Gemini). It would leave same-task replay with nothing to recall until the third repeat.

---

### D-073 — Triage: a repeat is the same errors again, not the same kind of error; the hint reads the code and the edits · accepted (2026-10-05; owner's request: patch the weakest module before the A/B runs; amends D-043, D-057 and D-061)
- **Why triage again.** Every module has had one pass against other projects' code. D-069 gave triage its loops; the repeated-error path, which is what AB_PLAN step 3 measures, was still D-043's. D-072 found that an error signature names the kind of error, not the problem, and fixed that for memory. Triage counted on the same signature, and so did the eval's primary metric for it.
- **What others do.** Read at the commits named. None counts a failure as a repeat because its first line is alike.
  - **Same call, same result.** OpenHands (D-069). Gemini CLI (`fb972b2`, `packages/core/src/services/loopDetectionService.ts`) tells its progress judge: "If the assistant is modifying different code or getting different errors, that is debugging progress, not a loop", and that re-running a build or test after changing code "is normal workflow".
  - **Counts that a success clears.** Roo Code (`b867ec9`, `src/core/tools/ApplyDiffTool.ts`, `EditFileTool.ts`): failed edits are counted per file and the count is deleted when an edit to that file succeeds.
  - **Feedback that carries the code.** Aider (`5dc9490`, `aider/linter.py`): `find_filenames_and_linenums` finds `file:line` in the output and `tree_context` appends that code under "See relevant line below marked with █". Its test loop sends the output back at most 3 times per request (`max_reflections`, `aider/coders/base_coder.py`), whatever the output says.
  - **Generic advice.** Trae Agent (`e839e55`, `trae_agent/agent/base_agent.py`, `reflect_on_result`): "Consider trying a different approach or fixing the parameters" after any failed tool. `TraeAgent` overrides it to return nothing.
- **What was weak here, measured on the fixtures.** Each hard task's check was run while its reference patch was applied one hunk at a time: a stand-in for an agent that tests between edits. 108 runs fail.
  - **Progress was counted as repetition.** Triage would have called 64 of them repeats. In 26 of those the output reported different errors from every earlier run: fewer failing tests, fewer compile errors, another message. `h-rust-borrow-refactor` goes 23, 21, 15, 13, 11, 8, 4 error lines and then passes; triage would have said "the current approach is not working: stop retrying it" at 13 and "stop and tell the user what is blocking you" at 4, one edit before the pass. Across the tasks: 38 loop warnings in 16 tasks, and 5 hand-over requests.
  - **The eval counted the same way,** so the `all-off` row's repeated-error rate would have been mostly agents making progress, and triage's row could only "improve" it by making them stop.
  - **A failed edit to one file repeated a failed edit to another**: the signature turns every path into `<path>`.
  - **The diagnosis read less than the agent had.** 1,000 characters of the request, six command labels and an excerpt of the output. It saw neither the code the error points at nor what the agent had changed, and it is the same model as the agent (R3.1).
  - **A piped run was invisible.** `cargo test 2>&1 | tail -30` exits 0, so triage did nothing (D-072 noted the same for memory).
- **Decision.**
  1. **A failure is what it reports** (OpenHands' and Gemini's rule, applied to the errors instead of the whole output). Core's `failureLines` takes the output's error lines (toolchain-specific ones when there are any, at most 400), removes what moves when nothing was fixed (line and column numbers, durations, dates, addresses, Rust's thread ids) and sorts them. Names, values and duplicates stay. `failureKey` hashes them with the tool name. An output with no error line is known by its last 40 lines, and one that printed nothing by its call.
  2. **A repeat is a failure whose key was seen earlier in the task.** Fewer or other errors is a new failure: no notice, no sidecar call. Going back to a failure seen before (an edit undone) is a repeat. Counts, hint caps and hypotheses are per key. Nothing else in D-043's ladder changes: notice at 2, warning at `loopThreshold`, hand-over at twice that.
  3. **The notice says what is known**: "this failed again with the same errors as before (first: …)", and, when files were edited since the failure was first seen, "The edits made since (a.rs, b.rs) did not change it."
  4. **The diagnosis is shown the code and the edits** (aider's report; D-071's reasoning for the judge). `diagnose.v3` and `hypothesis.v2` add:
     - the code at up to 4 places the excerpt points at, 5 lines either side, the named line marked. `file:line` and Python's `File "…", line N` are read; a place outside the workspace is skipped. 23 of the 27 fixtures' first failures give at least one;
     - the last 6 edits made since the failure was first seen, as before and after text (500 characters each), with the rule that a cause they would have fixed is ruled out. `fileEdits` moves from memory to core for this;
     - 6,000 characters of the request, start and end kept (was the first 1,000).
     The guidance gate checks a hint against all of it. The prompt is at most about 25,000 characters. The call holds the agent's tool result, so the main model is not decoding while it prefills (D-068's reason for leaving sidecar input limits alone does not apply; the 8 s deadline is unchanged).
  5. **A test or build run that failed behind a pipe is a failure** (`maskedFailures`, default on). Core's `maskedFailure`: the command ends in a run of the tests or the build (the supervisor's classifier, moved to core as `verifyingRun`), is piped without `pipefail`, exits 0, and what was let through has a toolchain-specific error line. A line that only mentions an error is not enough. The notice adds "The exit code shown is the pipe's last command's, not this run's."
  6. **The eval uses the same definitions** (D-069's rule). `repeatedToolErrors` and the "Repeated errors" section follow `failureKey`, and the section counts masked failures.
- **Result on the same replay.** 38 repeats (was 64), 17 loop warnings in 10 tasks (was 38 in 16), no hand-over request (was 5). The 38 are steps where the hunk applied did not touch what fails: an agent that edits, runs the tests and reads the same errors.
- **How this sits with earlier entries.**
  - **D-043 "counting":** counts still reset on a new user request and not on a continuation. A pass in between still does not reset them (D-061).
  - **D-057:** the report's hint tables are unchanged in shape. Hint 1 still comes at the 2nd sighting and hint 2 at the 3rd, but of the same errors.
  - **D-069:** a loop that ends in a failing call repeats its errors, so it still gets these notices.
  - **D-072:** memory keeps its own rule (signature plus the names in the first error lines). It asks "is this card's problem in the failure", which stays true while other tests are fixed; triage asks "did anything move".
  - **D-052:** triage is off by default and nothing has been A/B'd, so no result changes meaning. `maskedFailures: false` turns item 5 off; the rest has no switch.
- **Open risks.**
  - Untested with a real model. The replay follows a reference patch; an agent takes other routes.
  - **An agent that changes the failure on every attempt without getting nearer is never told.** That is D-069's "a build that fails differently each time is usually progress", now applied here too. `maxRepeatedFailures` (failures per command) in the report still shows such runs.
  - **A value that differs run to run and is not a time or an address** (a random seed, a temp path, hash-map order in a message) makes every failure new. D-069 has the same hole.
  - **Only error lines are compared.** Rust prints `left:`/`right:` on lines the grammar does not call errors, so an assertion that fails with another value in the same test reads as the same failure.
  - **A masked failure rests on one error line.** A passing piped run that prints `ERROR: …` from a log is taken for a failure; a second identical one gets a notice that says it failed. The notice says whose exit code was shown.
  - **Edits made from the shell** are not seen (as in D-072), so the notice and the prompt can say less than what was changed. The notice then says nothing about edits; the prompt says none were made with the edit tools.
  - The code shown is the file as it is when the hint is written. A harness that runs tool calls in parallel could land an edit between the run and its result.
- **Not done.**
  - **Masked failures in memory.** Memory opens no episode for a piped run (D-072's open risk). It can use `maskedFailure`, but its admission rule needs a decision about a piped pass first. Compaction is done in D-074.
  - **Saying that a failure got smaller** ("2 of 5 failing tests fixed"). The agent reads that in the output.
  - **A model judging progress** (Gemini's periodic check): as D-069 left it.
  - **Parsing each test runner's summary** to compare failing tests by name. The error lines carry the names for the D-016 toolchains.

---

### D-074 — Compaction: a test run that failed behind a pipe is not listed as succeeded · accepted (2026-10-05; owner's request; follows D-073, amends D-044's tracked facts)
- **Problem:** the tracked facts put `cargo test 2>&1 | tail -30` under "Commands that last succeeded (no need to re-run unless something changed)" whenever it exited 0, which a piped run does even when its tests fail. After a compaction that line is all the agent has left of the run.
- **Decision:** a command's last run counts as failed when core's `maskedFailure` (D-073, item 5) says so. It is listed under "Commands whose last run failed" as "errors in the output (exit code hidden by the pipe)", with its first error line.
- **Not changed:** a piped run with no toolchain error line in what it let through is still listed as succeeded. `tail -5` of a failing run can show only a summary the grammar does not know; the exit code is all there is then.
- **No switch.** Compaction is off by default and nothing has been A/B'd (D-052).

---

## Open questions (carried from brief §10, updated)

1. ~~Resolved by D-029.~~ Exact pi mechanism for injecting into the current user turn without altering prior messages. *(Phase 0)*
2. ~~Resolved by D-029 (no; Exocortex keeps the original).~~ Can `tool_result` rewrites preserve the original output for the trace? *(Phase 0)*
3. ~~Programmatic session branching~~ — no longer needed (D-015).
4. ~~Embedding model choice/runtime~~ — resolved by D-019; exact model is chosen at Phase 5.
5. ~~Resolved by D-039 (heuristic + verdict flag; measure false positives in eval).~~ Reliably detecting "agent asked the user a question" vs. "agent claims done". *(Phase 3)*
6. ~~Resolved by D-029 (yes, `before_provider_request`).~~ Can the pi adapter observe the exact outgoing LLM request (needed for byte-exact `fork-prefix`, D-007)? *(Phase 0)*
7. ~~Resolved by D-029 (yes, `ctx.ui.setEditorText`).~~ Can pi's UI API pre-fill the editor or offer one-key accept for supervisor suggestions (D-010)? *(Phase 0)*
8. ~~ninfer fork details~~ — mostly answered by D-023. Remaining: confirm the 6-slot build vs. the public 1-4 cap.
9. **New:** Thinking-mode defaults per module (D-008). *(Phase 3+, eval)*
10. ~~Superseded by D-032 (F3 / prompted-JSON fallback).~~ Does a named `tool_choice` enforce the XGrammar schema well enough to use as structured output (D-023)? *(Phase 2)*
11. ~~Superseded by R1.~~ After a fork-prefix sidecar claims main's retained state, does main's next request still hit cache (D-024)? *(Phase 2)*
12. **New:** Main's `reasoning_effort` / thinking setting decides which sidecar settings can share its prefix. Pick the main default with this in mind (D-008, D-023). *(Phase 2)*
13. ~~Resolved by D-029 (yes, both).~~ Can pi attach per-session headers or extra body fields to main's requests (needed to tag main with `session_id`/`retain`, D-028)? *(Phase 0)*
14. **New:** Does ninfer's Qwen template accept two consecutive `user` messages (injected `custom_message`, D-031)? *(Phase 2)*
15. ~~Resolved by D-033.~~ Keep `node:sqlite`'s ExperimentalWarning out of the pi TUI (D-030).
