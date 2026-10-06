# Hardening plan

A read-only audit of every package (2026-10-06) found the weak spots listed here. This file tracks fixing all of them (D-076). Each item names the file, what goes wrong, and the fix the audit proposed. Line numbers are as of `818186f`.

## How the work is organised

- **One stream per section**, each on its own branch, squash-merged to `main` when `npm run check` passes.
- **Two waves.** Wave 1 changes what the modules build on (core's reading of commands and output, the adapter's dispatcher, core infrastructure, the eval). Wave 2 changes the modules themselves and starts once wave 1 is on `main`.
- **Each stream owns its files.** A stream that needs a change in another stream's files makes the smallest one that works and says so in its report.
- **Each stream records one entry in `DECISIONS.md`** under the number given below, listing what it changed and anything it chose not to do.

## Rules for every item

1. **Confirm the finding first.** Read the code path, and write the failing test before the fix. An audit finding that does not reproduce is marked `[-]` with one line saying why.
2. **Every fix lands with a regression test** that fails without it.
3. **Tick the item** in this file when it is done: `[x]` done, `[-]` not done (with the reason), `[ ]` open.
4. A proposed fix is a starting point. A better one is welcome; record the difference in the stream's `DECISIONS.md` entry.

## Status

| Stream | Branch | Decision | Wave | Status |
|---|---|---|---|---|
| A. Core: reading commands and output | `fix/core-run-reading` | D-077 | 1 | merged (`588696a`) |
| B. Adapter: hook dispatcher and lifecycle | `fix/adapter-dispatcher` | D-078 | 1 | merged (`b7ef097`) |
| C. Eval: statistics and harness | `fix/eval-rigor` | D-079 | 1 | merged (`e7316f3`) |
| D. Core: trace, inference, config, processes | `fix/core-infra` | D-080 | 1 | merged (`e5a056c`) |
| M. Memory | `fix/memory-admission` | D-081 | 2 | in progress |
| T. Triage | `fix/triage-identity` | D-082 | 2 | merged |
| R. Trimmer | `fix/trimmer-selection` | D-083 | 2 | merged |
| S. Supervisor | `fix/supervisor-evidence` | D-084 | 2 | merged |
| K. Compaction | `fix/compaction-facts` | D-085 | 2 | merged |
| E. Eval follow-up | `fix/eval-followup` | D-086 | 2 | in progress |

---

## A. Core: reading commands and output

Files owned: `packages/core/src/modules/{runs,output,loops}.ts`, their tests, `packages/core/prompts/`. This is the layer memory, triage, compaction, the trimmer, the supervisor and the eval all read through.

- [x] **A1. Command lines are split without parsing.** `runs.ts:28-34`. `verifyingRun` does `split("&&")` then `split("|")`, so quotes are ignored (`go test -run 'TestA|TestB'` reads as piped) and `;`, `||`, newlines and subshells are not seen. *Fix:* move the trimmer's tokenizer (`mod-trimmer/src/command.ts`, `splitCommand`/`tokenize`) into core and export it; split on unquoted `;`, `&&`, `||`, `|` and newline; classify every segment; take the last test or build segment, not the last `&&` step. Mark the exit code hidden whenever the runner is not the final, unpiped segment (`cargo test; echo done`, `cargo test | tail && git status`, `(cd x && cargo test) | tail`). The trimmer then imports the tokenizer from core.
- [x] **A2. Runner spellings are a short allow-list.** `runs.ts:13-17`. Not recognised: `uv run pytest`, `poetry run pytest`, `python3.11 -m pytest`, `.venv/bin/pytest`, `cargo nextest run`, `cargo +nightly test`, `env X=1 cargo test`, `time go test`, `timeout -k 5 60 pytest`, `make -j 8 test`, `make -C build test`, `npm run check`, `pnpm test`, `yarn test`, `bun test`, `just test`, `./run_tests.sh`, `bash -lc '…'`. *Fix:* strip wrappers (`env`, `VAR=…`, `time`, `timeout [opts]`, `uv run`, `poetry run`, `pythonX.Y -m`, a path before the runner, `cargo +toolchain`, a subshell, `bash -lc`) before matching; add the package-manager runners; let callers pass extra test commands (the supervisor's `checks` setting, S7).
- [x] **A3. An unrecognised piped command falls through to `passed`.** `runs.ts:83-86`. *Fix:* `outcomeOf` returns `unknown` for an exit-0 command that contains an unquoted pipe and was not recognised. Update every caller for the new answer.
- [x] **A4. A pass summary anywhere outvotes a later failure.** `runs.ts:40-47, 73-76`. `cargo test | grep 'test result'` printing `ok.` then `FAILED.` reads as passed. *Fix:* add `^test result: FAILED` and unittest's `^FAILED \(` as failure lines, and require the last summary line to be a pass.
- [x] **A5. `BUILD_RUNNER` ends in an optional `(\s|$)?`.** `runs.ts:15-16`. `cargo buildx` counts as a build. *Fix:* make the boundary required.
- [x] **A6. One grammar decides both "keep this line" and "this run failed".** `output.ts:11-42`. On a green run these read as failure: `go test -v` `t.Log` lines (`/^\s+\S+_test\.go:\d+: /`), `log.Lshortfile` lines (`/^\S+\.go:\d+(:\d+)?: /`), `/usr/bin/ld: warning: …`, `ERROR: pip's dependency resolver…`, `SystemExit: 0`. *Fix:* keep two lists: lines that decide a verdict (what a runner prints when it fails) and lines worth keeping when trimming. An indented `_test.go:N:` line counts toward a verdict only with a `--- FAIL` line; exclude `ld: warning:`.
- [x] **A7. Python exception names and Rust doctest names are missed.** `output.ts:41, 16`. `json.decoder.JSONDecodeError: …` and `subprocess.CalledProcessError: …` classify as nothing; `test src/lib.rs - add (line 5) ... FAILED` does not match `test \S+ … FAILED`. *Fix:* `^([A-Za-z_]\w*\.)*[A-Z]\w*(Error|Exception|Exit|Interrupt)(: |$)`, and `.+` for the test name.
- [x] **A8. The generic error pattern fires on names.** `output.ts:74-77`. `…/src/error.cpp.o`, `ok  example.com/app/internal/errors 0.01s`, `Compiling error-chain v0.12.4`, `test parse::error::tests::roundtrip ... ok`, ``warning: unused variable: `error` ``. Any of these vetoes a sidecar's `passed` (`runs.ts:161`). *Fix:* strip path, module-path and backticked tokens before the generic test.
- [x] **A9. Failure identity erases values and keeps positions.** `loops.ts:15-20, 41-45, 53-63`. `VOLATILE` turns `'10:30' == '10:45'` and `'10:44' == '10:45'` into the same key, as with dates and `5 ms`/`6 ms`; rustc errors at two files share a key because ` --> path` is not an error line; tsc's `(12,5)` and pytest temp paths make one error look new each run; in `callKey`, `a.c:12:34` is read as a clock time. *Fix:* apply `POSITIONS` before `VOLATILE`; apply the time, date and duration rules only outside quotes and on summary-like lines; add `\(\d+,\d+\)`; normalise `/tmp/…` segments, UUIDs and `host:port`; for rustc and clang, append the following ` --> file` path (no line) to the error line before keying.
- [x] **A10. The ANSI pattern can delete real output.** `output.ts:80`. `\u001b\][^\u0007]*(…)` is greedy across newlines, so two ST-terminated OSC 8 links swallow everything between them. *Fix:* `\u001b\][^\u0007\u001b\n]*(?:\u0007|\u001b\\)`.
- [x] **A11. `ungroundedReferences` flags ordinary prose.** `output.ts:163-173`. `e.g`, `Node.js`, `` `parse_config()` `` when the transcript has `parse_config`. *Fix:* require a `/` or a known source extension for bare-word path matches; strip trailing `()`, `:N` and generics before checking.
- [x] **A12. One benign-exit rule.** Triage knows `grep`/`diff`/`test` exiting 1 is not a failure (`mod-triage`, `isBenign` and its `benignCommands` setting); compaction does not (K3). *Fix:* move the test into core and export it; triage imports it.
- [x] **A13. Fixture tests from real output.** `runs.test.ts`, `output.test.ts` and `loops.test.ts` cover only canonical spellings. *Fix:* table-driven tests over real Rust, Go, C++ and Python output and the command lines in A1–A2, in both directions (failing run read as failed, passing run read as passed).

## B. Adapter: hook dispatcher and lifecycle

Files owned: `packages/pi-adapter/src/`, `packages/core/src/modules/types.ts`, `docs/PI_API_NOTES.md`.

- [x] **B1. `onError` and `log` can throw.** `index.ts:37-40, 50-52`. Both call `pi.getFlag()` every time; the audit found it throws once the runner is invalidated (`/new`, `/resume`, `/fork`, `/reload`), which turns a caught error in background work into an unhandled rejection. *Fix:* make `level()` total (try/catch, fall back to the last value read); wrap the bodies of `onError` and `log`; abort the embedder and background work at `session_shutdown`. *Done (D-078):* as proposed; the embedder has nothing to abort, so shutdown drops it with the pool and disposes the modules first.
- [x] **B2. The settle hook is not bounded and ignores the user's abort.** `modules.ts:438-464`. `onSettle` is awaited directly; the five-minute timer only signals; Esc and `/new` wait on a running check. After an abort `apply()` still runs. *Fix:* one `withBudget(ms, parentSignal, fn)` helper used by all four hooks (it replaces the four hand-copied `AbortController` + `setTimeout` blocks); link `ctx.signal` when defined; skip `apply()` when aborted; test with `budgetsMs.settle`. *Done (D-078):* `withBudget` in `budget.ts`. `ctx.signal` is undefined in the settle hook (PI_API_NOTES §15), so settle stops on `session_before_switch`/`_fork`, `session_shutdown` and Escape instead; the other hooks link `ctx.signal`.
- [x] **B3. No host-side cap on consecutive `continue` results.** `modules.ts:479-500`. Only the supervisor's own counter stops a loop. *Fix:* a small host counter, reset on `input`. *Done (D-078):* 20 in a row; refused continuations are traced as `exo.action`.
- [x] **B4. A hook that loses its budget still commits module state.** `modules.ts:316-323, 370, 577-584`. Memory marks preferences injected that were never shown (`mod-memory/src/memory.ts:193-210`). *Fix:* hooks return their result with a `commit()` the host calls only when it applies the result; at the least the host tells the module whether the result was applied. *Done (D-078):* every hook result may carry `commit()`; memory marks preferences in it.
- [x] **B5. A suggestion overwrites the user's draft.** `modules.ts:472-478`. *Fix:* when `getEditorText().trim() !== ""`, notify and keep `suggested` instead of setting the editor. *Done (D-078).*
- [x] **B6. The compaction request shows Exocortex's own injections as user text.** `modules.ts:397-402`. *Fix:* drop or relabel span messages where `exoModuleOf(m)` is defined before `convertToLlm`. *Done (D-078):* relabelled `[Exocortex <module>, not the user]`, not dropped.
- [x] **B7. Any user input cancels the running turn's sidecar calls.** `sidecars.ts:82-88`. A steer or follow-up typed mid-run cancels the trimmer's rewrite or the supervisor's verdict. *Fix:* only when `event.streamingBehavior === undefined`. *Done (D-078).*
- [x] **B8. `tool_result` hooks overlap in parallel tool mode.** `modules.ts:256-275, 365-387`. Modules were written as if results arrive in order; all rewriters share one 20 s budget first-come. *Fix:* serialise the host's `tool_result` handling through a per-session promise chain; give each rewriter a slice of the remaining budget. *Done (D-078):* user-turn context gets the same equal shares.
- [x] **B9. The pool rebuild leaves a window with no pool.** `sidecars.ts:33-55, 72-80`. *Fix:* resolve the target, build the new pool, copy `mainActive`, swap, then close the old one; a generation counter discards a stale rebuild. *Done (D-078).*
- [x] **B10. Any `/exo` toggle rebuilds every module, and nothing is restored on reload.** `modules.ts:133-146`, `runtime.ts:46-53`, `command.ts:36, 83`. The supervisor's ledger, triage's counts and memory's session identity are wiped; `/exo off` overrides are lost on `/reload`; one SQLite connection leaks per session replacement. *Fix:* keep instances whose merged settings are unchanged; add `dispose()` to `ExoModule`; close the store on every `session_shutdown`; persist overrides with `pi.appendEntry("exo.overrides", …)` and restore them at `session_start`. *Done (D-078):* memory does not close its own database yet (M9/M10 own it).
- [x] **B11. Modules have nowhere to keep state that outlives them.** Needed by M9, S10, K1. *Fix:* add to `ModuleContext` (a) the harness session id and (b) a small persisted-state API (`saveState(value)` / the last saved value at creation), stored as an `exo.<module>.state` custom entry; pass the previous compaction entry's `details` in `CompactionRequest`. *Done (D-078):* `sessionId`, `savedState`, `saveState`; `CompactionRequest.previousDetails` and `CompactionSummary.details`.
- [x] **B12. A merged user-turn message is tagged with only the first module.** `modules.ts:325-334`. *Fix:* `exo.context` when more than one module contributes; the recorder reads `details.exo.modules`. Also reconcile `display: true` with D-029. *Done (D-078):* the trace event's module is `context`, with the contributors in its `details.exo.modules`. D-060 already made these messages visible; D-029's `display: false` is superseded.
- [x] **B13. Synthetic trace events have no turn number.** `modules.ts:164, 194, 379, 483`. *Fix:* a `runtime.record(event)` that adds the current turn, used everywhere. *Done (D-078).*
- [x] **B14. `untilAborted` ignores an already-aborted signal.** `modules.ts:577-584, 414-430`. *Fix:* return at once when `signal.aborted` (subsumed by B2's helper); add the `break` to the compact loop. *Done (D-078).*
- [x] **B15. Settle shows nothing while checks run.** D-011 says inferred commands are shown when run. *Fix:* wrap settle in `whileHolding` so a module's `ctx.progress` reaches the status line (the supervisor calls it in S4). *Done (D-078).*
- [x] **B16. Pi behaviour relied on but not in `PI_API_NOTES.md`.** `getApiKeyForProvider`, `event.context.llmMessages`, `event.outcome` values, the `exitCode` fallback, concurrent `tool_result` dispatch, the factory re-running on session replacement, `getFlag` throwing when stale, `abort()` waiting on before-settle. *Fix:* verify each in pi's source and add it with a file:line citation. *Done (D-078):* PI_API_NOTES §15; three of the claims are also checked against real pi by an integration test.

## C. Eval: statistics and harness

Files owned: `packages/eval/`, `packages/testkit/`, `docs/AB_PLAN.md`, `docs/EVAL_TASKS.md`, `tasks/*/task.json`.

- [x] **C1. The smallest detectable difference counts repeats as independent.** `report.ts:433-434`, `stats.ts:123-126`. *Fix:* compute it from the paired per-task deltas (`Z_SUM * sd(deltas) / sqrt(tasks)`), print it per comparison, and update `AB_PLAN.md`'s "Reading results". *Done with t quantiles in place of z, and the exact rule at six tasks (D-079).*
- [x] **C2. The tamper guard restores only test files.** `workspace.ts:42-55`. A rewritten `Makefile` `test:` target, `autotests = false` in `Cargo.toml`, or a Go `TestMain` that exits 0 passes the check; an agent-added test that is wrong or collides with a hidden one fails a correct solution. *Fix:* a per-task `protect` list (default `Makefile`, `Cargo.toml`, `go.mod`, `CMakeLists.txt`, `conftest.py`, `pytest.ini`, `pyproject.toml`) restored like tests, unless the task's solution changes that file; move agent-added test files aside before the check and record them; `--validate` records the solution's executed-test count and a check that runs fewer fails. *Done; the count is a `minTests` floor in `task.json`, Rust modules under `src/` are not set aside, and three C++ fixtures keep a known false-fail risk (D-079).*
- [x] **C3. Infrastructure failures score as task failures.** `run.ts:101-112, 165-177`, `report.ts:56-61`. *Fix:* an `invalid` class (`setup_failed`, `crashed`, check timeout, a final provider-error stop with no tool calls); retry once; drop the (task, repeat) block from both arms in paired statistics; its own report column. *Done, except a check timeout: the check is run once more and a second timeout is a failure, not an invalid run (D-079).*
- [x] **C4. Many treatments, no multiplicity control; three primaries have no interval.** `report.ts:428-459`. *Fix:* a Holm-adjusted p column across treatments; a Wilson interval and paired delta for precision-of-complete; route input tokens and repeated-error rate through `pairedRelativeChange`.
- [x] **C5. The percentile bootstrap is degenerate at 3–12 tasks.** `stats.ts:157-168`. *Fix:* an exact sign-flip permutation test on the mean delta with the interval from inverting it (or a t-interval); print "n too small" below about 6 tasks.
- [x] **C6. Cost deltas are a mean of ratios.** `stats.ts:103-107, 170-173`. Biased upward under the null; zero-baseline tasks dropped silently. *Fix:* mean log-ratio or ratio of sums with the task bootstrap; report dropped tasks. *Done as the mean log ratio with the sign-flip interval, not a bootstrap (D-079).*
- [x] **C7. Pi's own compaction tokens may be uncounted in the baseline arm.** `metrics.ts:109-115`. *Fix:* confirm in pi's source whether the summariser's usage reaches `turn_end`; if not, trace it and add it to main tokens. *Confirmed: it does not. It is on the compaction entry the trace already records, so the eval adds it from there with no adapter change (D-079).*
- [x] **C8. One exception after the agent finishes aborts the suite; no resume.** `run.ts:72-85, 149-163`, `cli.ts:95-130`, `workspace.ts:49`. *Fix:* wrap the post-agent steps and record `outcome: "harness_error"`; clean up after the record is appended; `--resume <dir>` skips labels already in `results.jsonl`; skip unparsable JSONL lines with a warning.
- [x] **C9. The RPC driver's time limit does not cover its own awaits.** `pi-rpc.ts:134, 151, 192, 214-216`. *Fix:* race every `send` against the remaining budget and fall through to `killGroup`; on reaching `maxTurns`, wait briefly for `agent_settled` before declaring `max_turns`; add `stdin.on("error", …)`. *Done; `max_turns` is decided by the next `turn_start`, not by a timed wait (D-079).*
- [x] **C10. Config order is fixed and some state is shared between arms.** `run.ts:72-78, 224-234`. *Fix:* shuffle config order per (task, repeat) with a seeded generator recorded in the run directory; always set memory's `dbPath` and the trimmer's `saveDir` under the run directory; log when `machineSettings` returns `{}`. *Done; the trimmer's `saveDir` goes under the work root, outside the repo, since the agent is shown those paths (D-079).*
- [x] **C11. The fake OpenAI server is more forgiving than a real one.** `testkit/src/fake-openai-server.ts:76-94, 144-160, 179-203`, `module-context.ts:44-55`. *Fix:* scripted reply kinds `length`, `reasoning`, `overflow`, `drop_midstream`; usage that scales with the request; the usage chunk only when asked for; unique tool-call ids; an opt-in strict mode that rejects bad role sequences; the test context honours its abort signal.
- [x] **C12. The load test can hang.** `loadtest.ts:93-95, 172`. *Fix:* try/finally around the saturating loop; report a phase in which every sidecar failed as failed, not as 0% regression.

## D. Core: trace, inference, config, processes

Files owned: `packages/core/src/{trace,inference}/`, `packages/core/src/{config,json,fingerprint,debug-log}.ts`, `packages/core/src/modules/command.ts`.

- [x] **D1. One failed flush loses the session's trace.** `trace/store.ts:166-180`. The batch, including the session row, is discarded; later events then fail the foreign key. A locked database also blocks pi's event loop for 2 s. *Fix:* serialise `data` at `append` so a bad value drops only itself; on `SQLITE_BUSY` put the batch back with a cap and backoff; `BEGIN IMMEDIATE` and a short `busy_timeout`; guard the rollback and `onError`.
- [x] **D2. `extractJson` can return a draft from the model's reasoning.** `inference/structured.ts:74-86`. It strips a thinking block only when both tags are present. *Fix:* cut everything up to the last `</think>`; treat an unclosed `<think>` as no answer; scan balanced JSON values from the end; take the first candidate that passes the schema, not the first that parses.
- [x] **D3. A held background call times out without running.** `inference/pool.ts:176-178, 284`. *Fix:* start a held background job's deadline when it first becomes eligible, or a separate long `maxHoldMs`; a distinct outcome (`expired_held`) in the trace.
- [x] **D4. Background calls are cancelled at shutdown.** `inference/pool.ts` `close()`. *Fix:* add a bounded `drain(ms)` that lets queued and running background jobs finish. (Wired into shutdown by M13 and the eval by E2.)
- [x] **D5. A repository's own config has full authority.** `config.ts:146-148, 173`, `inference/engine.ts:101, 111-114`. A cloned repo's `.exocortex/config.jsonc` can point the engine at another host with an environment variable as the bearer token. *Fix:* the project file may set `modules.*` and `enabled` only; `engine`, `embeddings`, `trace` and `pool` there are reported as problems and ignored.
- [x] **D6. Relative paths resolve against the process cwd.** `config.ts:97`. *Fix:* resolve against the directory of the file that set them.
- [x] **D7. Config validation lets typos through and rejects a missing `enabled`.** `config.ts:8-17, 63, 105`. *Fix:* validation takes the known module ids and each module's strict schema; `enabled` optional; cap timeouts at 2^31−1; check `baseUrl` with `new URL`. (Wiring the ids in from the adapter's `runtime.ts` is part of this item.)
- [x] **D8. `runProcess` does not honour its timeout or its never-rejects contract.** `modules/command.ts:43-76`. It resolves on `close`, so a daemonised child holds it; `spawn` can throw synchronously; an already-aborted signal is ignored; chunks are decoded one by one. *Fix:* resolve on `exit` plus a short drain grace, then destroy the streams; try/catch around `spawn`; check `signal.aborted` first; `StringDecoder`.
- [x] **D9. Pool accounting under-reports.** `inference/pool.ts:211, 270, 288-291, 367-370`, `client.ts:123`. Usage is lost when a repair turn times out; the budget is checked at submission only; the trace records the unclamped `maxTokens`; a reply cut at `max_tokens` comes back `ok`. *Fix:* call `onResponse` per response inside `completeStructured`; record the clamped value; surface `finishReason` and skip the repair turn on `length`.
- [x] **D10. "Never throws" helpers that throw.** `inference/embeddings.ts:49` (`AbortSignal.timeout` outside the `try`), `json.ts:20-43` (a throwing getter; `Error` and `Map` become `{}`; typed arrays expand per element). *Fix:* move and clamp; try/catch per property; special-case `Error`, `Map`, `Set` and array-buffer views.
- [x] **D11. Migration race, pragma order, no retention.** `trace/schema.ts:57-73`, `trace/sqlite.ts:33-36`, `trace/store.ts:214-218`. *Fix:* `BEGIN IMMEDIATE` and re-read `user_version` inside it; set `busy_timeout` first; a retention setting that prunes old sessions at open; filter `kinds` in SQL.

---

## M. Memory (wave 2)

Files owned: `packages/mod-memory/`.

- [ ] **M1. A pass is admitted as a fix whatever the edits were.** `episodes.ts:98-124`, `memory.ts:511-550`. Skipping the test, an unrelated edit beside a shell fix, or a flaky test all store a card. *Fix:* refuse an episode whose edits are all on `isTestPath` paths or add skip/ignore/xfail markers; record mutating shell commands between failure and pass and drop or annotate such an episode; ignore edits outside the cwd; tell `lesson.v2` to return "" when the route only loosens a test.
- [ ] **M2. The lesson falls back to the deterministic text without the reusability gate.** `memory.ts:529-537, 671-694`. *Fix:* with D3 in place, retry at the next settle on timeout instead of writing a deterministic card; re-check `existing` after the await with an in-flight map; for a `write`, name only the file.
- [ ] **M3. The tracker matches errors by signature alone.** `episodes.ts:72`. Two different failing tests with one normalised signature become one card. *Fix:* one `sameProblem(signature, detailA, detailB, minDetail)` predicate used in `onFailure` and at `memory.ts:503, 515-522, 721`.
- [ ] **M4. A wrong lesson is never replaced.** `memory.ts:524-528, 164-171`, `store.ts:305`. *Fix:* when a known problem is fixed again by edits to different files, distill and `store.supersede`; withhold `helped` when the pass's edited files do not intersect the shown card's files.
- [ ] **M5. Keyword recall fires on one shared word.** `store.ts:272-290`, `memory.ts:728-731`. *Fix:* at least 3 shared keywords and a symmetric measure; no result for a query under 3 keywords; rescore before capping candidates.
- [ ] **M6. The sidecar can retire any preference with an unchecked `replaces`.** `preferences.ts:84-91`, `memory.ts:363`. *Fix:* require topical overlap between the replaced rule and the quote or new rule; notify the user; list recently retired preferences with a restore command.
- [ ] **M7. Preference identity ignores negation.** `store.ts:186-199`, `preferences.ts:143-154, 189-194`. *Fix:* a polarity flag per rule, required equal in `sameRule` and `alreadySaid`; check all live preferences, not the last 30.
- [ ] **M8. Recalled text is stored and replayed unsanitised, and crosses repos.** `memory.ts:695-701, 758-796`. *Fix:* collapse whitespace and strip `[`, `<<<`, `>>>` from lessons at admission; escape delimiters in `renderRoute`; for other-repo matches render only distilled lessons without file names; create the database with mode 600.
- [ ] **M9. Session identity and per-task state reset on rebuild.** `memory.ts:146-156`. *Fix:* use B11's session id for `session`; keep per-session state keyed by it; call `finishTask()` on dispose.
- [ ] **M10. Store: migration race, non-atomic writes, no recovery, no cap.** `store.ts:240-303, 463-477`. *Fix:* `BEGIN IMMEDIATE` and re-read `user_version`; transactions around `insert` and `merge`; quarantine a corrupt file and start fresh; try/finally in `finishTask`; filter vectors by scope in SQL; cap live cards per scope.
- [ ] **M11. The edit cap keeps the earliest edits.** `episodes.ts:119-122`. *Fix:* keep the latest edit per path; expire an open command after K intervening tool calls.
- [ ] **M12. Repo scope is an unnormalised string and falls back silently.** `memory.ts:799-809`. *Fix:* normalise to `host/owner/repo`; tell a timeout from "no remote" and disable learning for the session on timeout.
- [ ] **M13. Lesson-writing is cancelled at shutdown.** *Fix:* the adapter's `session_shutdown` awaits D4's bounded `drain` before closing the pool.
- [ ] **M14. `memory.ts` is one 570-line closure.** *Fix:* split into `learn.ts`, `recall.ts`, preference wiring beside `preferences.ts`, interview wiring in `interview.ts`, `scope.ts`; `memory.ts` composes them.

## T. Triage (wave 2)

Files owned: `packages/mod-triage/`.

- [x] **T1. Counts never reset when a failure is fixed.** `triage.ts:138-140`. A regression 40 calls later is told "the edits did not change it". *Fix:* on a passing run of a command, clear the counts, `editedAtFirst`, `hintCalls` and `hypothesized` of the signatures that command last produced.
- [x] **T2. Every failed `edit` on a file shares one key.** *Fix:* fold a hash of `oldText` into the key for `edit` failures.
- [x] **T3. Any user message wipes everything.** `triage.ts:108-112`. "try again" becomes the goal. *Fix:* do not reset on a user turn; keep the last few user messages within `GOAL_CHARS` as the goal.
- [x] **T4. No `onCompacted`.** Hints are gone from context but still deduplicated against. *Fix:* clear `hints`, `hintCalls` and `hypothesized`; keep counts.
- [x] **T5. The deterministic notice waits on the sidecar calls.** `triage.ts:157-170`. On overrun the whole rewrite is dropped though the count was incremented. *Fix:* race the sidecar work against `signal` and always return the notice; skip `diagnose` when `hypothesize` used its deadline; cap both timeouts in the schema; commit counts through B4.
- [x] **T6. State is lost on reload.** *Fix:* persist counts through B11.

## R. Trimmer (wave 2)

Files owned: `packages/mod-trimmer/`.

- [x] **R1. Collapsing similar lines removes error locations and test names.** `trim.ts:165-190`. *Fix:* never collapse a line `classifyErrorLine` recognises or that has a `path:line` location; when numbered, render the marker as `[… lines A–B: N more similar …]`.
- [x] **R2. The error cap counts lines and favours the earliest.** `trim.ts:150-162`. Sixty passing tests' log lines outbid the one failing test. *Fix:* build blocks first, cap blocks, rank failure headers (`--- FAIL`, `FAILED`, `error[`, `panic:`, `not ok`) above message lines; use A6's verdict list for what counts.
- [x] **R3. Crash blocks are cut.** `trim.ts:130-147`. A Python traceback loses its exception line; a Go panic loses its frames; a data-race block is dropped whole. *Fix:* a `Traceback` block includes the first unindented line after it; a `panic:` or `fatal error:` block runs through one blank line and the `goroutine N [` paragraphs; `WARNING: DATA RACE` and sanitizer errors open blocks that run to their closing line.
- [x] **R4. The requested-content exemption is too narrow and too wide.** `command.ts:50`, `settings.ts:7-12`. `grep -rn "fn main()" src` is trimmed; `cargo test | cat` is not. *Fix:* do the syntax check inside the tokenizer (A1), where quote state is known; add `xargs` as a wrapper; when the first stage is not itself a verbatim command, exempt only selecting sinks.
- [x] **R5. `maxChars` is not a ceiling.** `trimmer.ts:152-163`. *Fix:* after the window floor, shrink tail and head lines, then line length, until it fits; apply the same test to the sidecar's selection.
- [x] **R6. Saved outputs share one directory.** `trimmer.ts:235-237`. *Fix:* a per-session subdirectory, removed on dispose.

## S. Supervisor (wave 2)

Files owned: `packages/mod-supervisor/`.

- [x] **S1. New files reach the judge cut and unmarked.** `supervisor.ts:386-392, 409, 442-456`. `head -c 6000` with no marker; only the first 12 by `ls-files` order; names C-quoted without `-z`; the progress fingerprint hashes the same cut text. *Fix:* `git -c core.quotePath=false ls-files -z`; fetch each file with a generous cap and let `fitDiff` share and mark the cut; choose by size or by what the agent touched; "N more new files not shown"; fingerprint the full content. *Done; one part did not reproduce:* a large new file among the first twelve did change the fingerprint when edited past the cut (the `index` line of `git diff --no-index` carries the blob id). Files past the twelfth did not.
- [x] **S2. The "changed since tests" hash flips on `git commit`.** `supervisor.ts:632-638`. *Fix:* a commit-invariant hash (per-file content of everything changed since the task's `startRef`, plus untracked files).
- [x] **S3. Check commands: lost on follow-up, any substring accepted.** `supervisor.ts:349-355, 416-435`. *Fix:* carry `checkCommands` forward with `follows_previous`; require a whole backtick or code-fence span of the message; refuse request-sourced commands containing `;`, `&&`, `|`, `>` or `$(` unless also in `settings.checks`.
- [x] **S4. Checks run with nothing shown.** *Fix:* `ctx.progress("running: <cmd>")` (B15 carries it to the status line).
- [x] **S5. A check that did not finish is reported as failing.** `supervisor.ts:473-479`, `evidence.ts:51`. *Fix:* split failed (a number other than 0) from inconclusive (timed out or null); inconclusive never yields `incomplete`.
- [x] **S6. Two grammars for "is this a test run".** `signals.ts:15-19, 113-123, 151-161`. `git commit -m 'make pytest pass'` supports "all tests pass"; `pytest tests/test_one.py` counts as the full run. *Fix:* use core's `verifyingRun` and `outcomeOf` (A1–A3) everywhere; treat a positional test file, `-R` and a single package path as narrow.
- [x] **S7. The user's `checks` are not known as test commands.** *Fix:* pass `settings.checks` to A2's extra-commands hook.
- [x] **S8. Verdict acceptance is loose.** `supervisor.ts:606-622, 267-286, 510-524`. A quote of `}` makes an item met; `complete` with a non-empty `missing` is taken at face value; a dissenting vote's `missing` is discarded; a timed-out vote counts as dissent; `lastVerdict` is never cleared. *Fix:* a quote of at least about 12 non-space characters within one added line, check-output line or command line; coerce `complete` with `missing` to `incomplete`; pass dissenters' items through as `unverified`; ignore unavailable votes; reset `lastVerdict`.
- [x] **S9. Warning signals misfire both ways.** `signals.ts:13-14, 48-62`. `todos.append(todo)` is a stub marker; a changed expected value is not tampering. *Fix:* `TODO|FIXME|XXX` case-sensitive after a comment leader; report changed assertion lines in existing test files; skip commented-out added lines; a signal for modified runner config.
- [x] **S10. A follow-up resets `startRef` and the continuation count; state is lost on reload.** `supervisor.ts:154-165, 382-385`. *Fix:* inherit `startRef` and `continuations` with `follows_previous`; treat an edited suggestion as an acceptance; persist the ledger, `startRef` and count through B11; record a skip when settle finds no task.

## K. Compaction (wave 2)

Files owned: `packages/mod-compaction/`.

- [x] **K1. Facts do not survive a second compaction or a reload.** `compaction.ts:65-67, 86-92, 254-261`. *Fix:* return the facts in the compaction's `details.exo.facts` and seed from the previous entry's (B11); fall back to parsing the facts sections of `previousSummary`; track `read`/`edit`/`write` paths in `onToolResult`.
- [x] **K2. Command records are keyed by the raw string and go stale.** `compaction.ts:116-130`. `cargo test` failing then `cargo test -- --nocapture` passing leaves the failure listed. *Fix:* key verifying runs by kind and bare command (A1); stamp records with a sequence number, bump it on edits, and render a pass before later edits as such.
- [x] **K3. The failed list keeps the oldest 40 and counts benign exits.** `compaction.ts:284-295, 306-310`. *Fix:* slice from the end; use A12's benign rule; list verifying runs plus the last few other failures.
- [x] **K4. An ungrounded reference deletes the whole bullet.** `compaction.ts:235`. A Next Move step naming a file to create vanishes. *Fix:* under `## Next Move`, allow paths whose parent directory exists; on a miss, drop the backticks or mark the name unverified instead of deleting the bullet; log the reference.
- [x] **K5. No overall budget; the prior narrative is cut below its own size.** `compaction.ts:29, 257-275`. *Fix:* a character budget for the requests section (first and newest whole, the middle one line each); derive the prior cap from `maxSummaryTokens`.
- [x] **K6. "Files modified" misses shell edits and lists a file twice.** `compaction.ts:138-151, 276-281`. *Fix:* normalise tool paths relative to the repo root; `git status --porcelain=v1 -z` with `git diff --numstat --relative HEAD`, labelled new/deleted/renamed; subtract the tree's dirty set at session start.

## E. Eval follow-up (wave 2)

Files owned: `packages/eval/`.

- [ ] **E1. "Lucky pass" has its own idea of a verifying run.** `metrics.ts:352-378`. A piped failing run counts as verification; `grep -rn pytest .` counts; bash edits are not edits. *Fix:* use core's classifier (A1–A3) for both "is a verify command" and "passed"; detect edits from the final diff against the baseline commit.
- [ ] **E2. Closing pi at settle cuts memory's lesson-writing short.** `pi-rpc.ts:135-136, 167-176`. *Fix:* with M13 in place, raise the close grace to cover the drain and record how many background calls were cut off per run.
