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
  - The required baseline table on a real model has to be run on the owner's machine: `npm run eval -- --model <provider>/<model> --repeat 3`. Tag `phase-1` after that table exists.

---

## Open questions (carried from brief §10, updated)

1. ~~Resolved by D-029.~~ Exact pi mechanism for injecting into the current user turn without altering prior messages. *(Phase 0)*
2. ~~Resolved by D-029 (no; Exocortex keeps the original).~~ Can `tool_result` rewrites preserve the original output for the trace? *(Phase 0)*
3. ~~Programmatic session branching~~ — no longer needed (D-015).
4. ~~Embedding model choice/runtime~~ — resolved by D-019; exact model is chosen at Phase 5.
5. Reliably detecting "agent asked the user a question" vs. "agent claims done". *(Phase 3)*
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
