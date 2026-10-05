# A/B plan for GPU time

Everything built since Phase 3 ships off by default (D-047). This is the order to test it in once the machine is free. Each step names its command, the primary metric decided in advance (research R7.2), and what result changes a default.

Before starting, set `pool.maxConcurrent` / `pool.reservedForMain` in `~/.exocortex/config.jsonc` to match ninfer's real slots (D-038). With 2 slots that is `2` / `1`.

If you run an embeddings server (D-062), set `embeddings.baseUrl` and `embeddings.model` there too and confirm with `/exo ping`. The eval picks it up from the same file. It only affects configs with memory on.

**Cost.** The hard tier's median run was 68 s (D-037). Budget about 2 minutes per run to allow for the tail, so 100 runs take about 3–4 hours. Several configs can share one batch (`--config a,b,c`). They then share the baseline runs, and the report pairs every config against the first.

**Reading results.** Use the report's "Paired by task" section, not the raw success column. It prints the smallest difference the run count can detect. Below that, treat results as descriptive. Re-render any slice with `npm run eval -- --report eval-runs/<stamp> --tags <slice>`.

## 0. Calibrate the new fixtures (do first)

```sh
npm run eval -- --model ninfer/coding --tags uncalibrated --config all-off --repeat 3
```

- **Keep** tasks between 1/3 and 2/3. Rework or drop tasks at 0/3 or 3/3: they carry no signal (EVAL_TASKS.md). Then remove the `uncalibrated` tag.
- In the first calibration, 6 of 12 hard tasks scored 3/3 (D-037). Consider making those harder, or retagging them `regression` and running them less often.

## 1. Phase 3 acceptance: supervisor vs baseline

```sh
npm run eval -- --model ninfer/coding --tags hard --config all-off,supervisor --repeat 5
```

- **Primary:** Δ success on `hard`, paired by task.
- **Gate:** no runaway loops. Every run stays within `maxContinuations`, with no extra `max_turns` or timeout outcomes.
- **Also read:** precision of `complete` and failures caught (the "Supervisor verdicts vs hidden checks" section).
- **What `supervisor` now does (D-071):** the judge reads the request itself, sees every changed file, and is told when the agent's last test run came before its last edit or was piped. Verdict calls are larger (up to about 15k prompt tokens); nothing extra is run.
- **On a pass:** merge Phase 3 and tag `phase-3`.

## 2. Supervisor research options (D-046)

```sh
npm run eval -- --model ninfer/coding --tags hard --repeat 5 \
  --config supervisor,supervisor-think,supervisor-pre,supervisor-items,supervisor-claims,supervisor-votes,supervisor-verify
```

Each config turns on one option (D-056), so every row of the report is one option against `supervisor`.

- **Primary:** precision of `complete`, because a false "done" is the costly error. **Secondary:** Δ success, and verdict latency (sidecar tokens, wall-clock).
- **What changes a default:** an option that raises precision of `complete` without lowering success, at acceptable cost, becomes the default in a new D-entry. After the single-option runs, confirm with `supervisor-research` (all options on).
- **After research verification (D-054):**
  - `supervisor-think` has the strongest prior: non-thinking judges were near chance on pairwise code judging. If GPU time is short, run `supervisor,supervisor-think` first.
  - `supervisor-claims` (`finalMessage: "claims"`) is a real test, not a confirmation. CodeJudgeBench found judges do better *with* the judged response's full text, so stripping the narrative could lower precision. `supervisor-items` no longer sets it (D-056), so per-criterion verdicts are judged on their own.
  - `supervisor-verify` (D-071) turns an `uncertain` verdict into one request to the agent to check the unshown items. **Primary for this row:** Δ success. It costs a continuation, so it changes a default only if success rises without turns and wall-clock rising beyond what that one continuation explains. If `uncertain` is rare in the `supervisor` row, it has nothing to act on. It is also the only config that acts on a stale or piped test run (the agent is asked to run its tests again), so compare its "lucky passes" with `supervisor`'s.
  - `completeVotes` stays the logprob-free confidence route: logprobs are anti-calibrated on Qwen 3.5 27B (VERDI, verified).

## 3. Phase 4 modules (D-042 to D-045)

```sh
# Trimmer: noisy outputs
npm run eval -- --model ninfer/coding --tags noisy-output --config all-off,trimmer,trimmer-llm --repeat 5
# Triage: misleading or repeated errors
npm run eval -- --model ninfer/coding --tags error-recovery --config all-off,triage,triage-hypotheses --repeat 5
```

- **Trimmer:**
  - **Primary:** uncached main input tokens.
  - **Non-inferiority:** success, turns and wall-clock must not rise beyond noise (D-045).
  - **Read the baseline with pi's cut in mind (D-070):** six of the seven `noisy-output` checks print more than pi's 50 KB, so `all-off` sees only the end of them. The trimmer reads the saved file and can show failures `all-off` never sees, so a rise in success here is plausible, not only a fall in tokens.
  - **Watch for re-reads:** the report's "Trimmed outputs" section counts saved outputs the agent read back (D-061). A high share means something needed was trimmed.
- **Triage:**
  - **Primary:** repeated-error rate.
  - Self-Debug's gain came almost entirely from the first feedback turn (verified). Read the report's "Repeated errors" section (D-057): cap hints at 1 unless *stopped after hint 2* is a real share of *got hint 2* and beats `all-off`'s *gone after the 3rd time*.
  - **Secondary:** success, and turns from first failure to success.
  - **Loops without an error (D-069):** read the report's "Stuck loops" section. *Calls made inside a loop*, per loop, should fall against `all-off`. If loops are common in `all-off` and triage does not shorten them, the notice is not enough and stopping the run from the host is the next step. If no run loops, the tasks do not exercise this.
  - `triage-hypotheses` also measures Phase 6 (D-050).
- **Retro-masking (R2.3) is not in this plan** (D-053): for Qwen3-32B the source study showed no masking gain, and a local 30B lost half its prefix hits under masking. Revisit only if the compaction run below shows context-driven failures.
- **Compaction:** the hard tasks rarely reach pi's compaction threshold. Force it with a small-context copy of the model:
  1. In `~/.pi/agent/models.json`, copy your ninfer provider block under a new provider name, for example `"ninfer32k"`. Keep the same `baseUrl` and model `id` (so ninfer sees the same model name) and set the model's `"contextWindow": 32768`.
  2. Run:

     ```sh
     npm run eval -- --model ninfer32k/coding --tags hard --config all-off,compaction --repeat 3
     ```
  3. **Primary:** success on runs with at least one compaction: *success with compaction* in the report's "Context pressure" section (D-059).
  4. **Also read:** *replays after compaction* (D-061, research R4.4): the fact-anchored summary should lower it. And *failed runs under context pressure* in the `all-off` row. That count is the evidence D-053 asks for before retro-masking is reconsidered. If *error stops* is above zero with no overflow compactions, check `logs/*.stderr.log`: ninfer's overflow error may not match pi's patterns.
- **Phase 4 acceptance (brief §8, amended by D-045):**

  ```sh
  npm run eval -- --model ninfer/coding --tags hard --config all-off,phase4 --repeat 5
  ```

  It passes when main tokens drop with no drop in success and no rise in turns or wall-clock. On a pass, merge Phase 4 and tag `phase-4`.

## 4. Memory (D-049)

```sh
npm run eval -- --model ninfer/coding --tags hard --config all-off,memory,memory-triage --repeat 3
```

- **Primary:** the "Success by repeat" table. Memory can only help from r2 on, so look for a rise over r1 that `all-off` doesn't show.
- **Also read:** the "Token budget" table under it (D-058): total tokens per config and per repeat (main + every sidecar, memory's own column included), tokens per pass, and Δ total against `all-off` with its CI. This is the budget-matched comparison (research R5.4). The paragraph below the table states the smallest success difference the run could detect.
- **Expect a small effect (D-055).** Verified experience moved held-out solvers by 1–4.5 points in VibeMemBench, and `--repeat 3` cannot detect that. Read this run as a harm check plus the learning curve. It passes when success does not drop and Δ total tokens is not above zero by more than its *detectable Δ*. A benefit claim needs more repeats or cross-task fixtures. Then inspect the cards with `sqlite3 eval-runs/<stamp>/memory-memory.db 'select lesson, seen, injected, helped, hurt from cards'`.
- **With embeddings on (D-062):** `minSimilarity` (0.85) was chosen without a real embedding model. After the run, look at the `recalled` events for cards pulled in by similarity that have nothing to do with the error; raise the threshold if there are any.
- **Caveat:** this is same-task replay, an upper bound (research §5c). Cross-task transfer needs sibling fixtures in one repo.

**Preferences (D-060) are not part of this run.** Leave `memory.preferences` off here: the fixtures repeat one prompt per task, so task instructions would be learned as preferences. Try it in daily use instead, and check `/exo memory preferences` after a few days.

## 5. Everything together

```sh
npm run eval -- --model ninfer/coding --tags hard --repeat 5 \
  --config all-off,phase4,supervisor-research
```

Use this to check that the modules don't interfere with each other, for example triage and memory both annotating the same failure, or the supervisor reacting to trimmed output. Compare against each module's own run.

## Real sessions

Daily use is the other half of the evidence (D-014). After a week of normal work with modules on:

```sh
npm run trace -- stats --since 7d
```

The numbers to watch:
- the share of supervisor suggestions you accepted;
- how often trimmer and triage fired;
- what memory learned and recalled;
- what each module cost in sidecar tokens.

A module you keep rejecting is a module to fix or turn off.
