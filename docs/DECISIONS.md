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
