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

### D-005 — Inference server: owner's ninfer fork with a shared prefix cache · accepted
- **Context:** The owner runs a custom server forked from ninfer. Its prefix cache is *shared across requests* (block/radix style, LRU eviction), not per slot. The owner can add server features.
- **Decision:**
  - Talk to it over the OpenAI-compatible API. Isolate server-specific extensions (cache hints, priority classes) behind a small `InferenceClient` interface in core.
  - Prompt-cache stability (brief §1 constraint 3) is critical: never mutate prior messages or the system prompt.
  - We may propose server-side features (e.g. request priority, cache-pinning for the main session) where they beat client-side workarounds. Record each one here.
- **Open:** exact concurrency limit, context length, and whether the server exposes cache-hit stats (useful for eval metrics). → Phase 0 notes.

### D-006 — Sidecars use the same model as main · accepted
- **Decision:** One loaded model (the same 27B) serves main and sidecars. The pool is the only concurrency control. Because sidecars share main's blind spots, prefer deterministic signals wherever possible (brief §9).
- **Consequences:** No separate small model to manage. Sidecar latency is 27B latency, so the trimmer/triage timeouts and fallbacks matter.

### D-007 — Sidecar context: hybrid, per module · accepted
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

### D-019 — Embeddings served by the inference server · accepted (resolves brief §10.4)
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

## Open questions (carried from brief §10, updated)

1. Exact pi mechanism for injecting into the current user turn without altering prior messages. *(Phase 0)*
2. Can `tool_result` rewrites preserve the original output for the trace? *(Phase 0)*
3. ~~Programmatic session branching~~ — no longer needed (D-015).
4. ~~Embedding model choice/runtime~~ — resolved by D-019; exact model is chosen at Phase 5.
5. Reliably detecting "agent asked the user a question" vs. "agent claims done". *(Phase 3)*
6. **New:** Can the pi adapter observe the exact outgoing LLM request (needed for byte-exact `fork-prefix`, D-007)? *(Phase 0)*
7. **New:** Can pi's UI API pre-fill the editor or offer one-key accept for supervisor suggestions (D-010)? *(Phase 0)*
8. **New:** ninfer fork details: concurrency limit, context length, cache-hit stats, priority support. *(Phase 0, owner input)*
9. **New:** Thinking-mode defaults per module (D-008). *(Phase 3+, eval)*
