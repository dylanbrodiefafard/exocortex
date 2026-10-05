# Exocortex research survey: sidecar techniques for a 27B local coding agent

*Prepared 2026-10-04 for the Exocortex project (pi extension, Qwen 3.x 27B on a local engine). Read alongside `docs/BRIEF.md` and `docs/DECISIONS.md` (up to D-039).*

## How to read this document

> **Verified 2026-10-05.** Every claim on the `docs/RESEARCH_VERIFY.md` work list was checked against the paper (or, for blogs, the page) and is now tagged [V] with its table or section, or corrected in place with a note on what the snippet had said. One source (the AI21 blog) does not contain the numbers attributed to it; those stay [U]. Corrections that change a recommendation are recorded in D-053 to D-055. Claims tagged [A] that were not on the work list were not re-read. §8 adds post-June-2026 work.

**Method and its limits.** The network proxy blocked arxiv.org, huggingface.co, openreview.net, alphaxiv.org, factory.ai and blog.jetbrains.com, so I could not open full papers. Every claim below comes from web-search result text: abstracts, publisher pages, author READMEs (GitHub was reachable) and secondary summaries. Each claim carries a tag:

| Tag | Meaning |
|---|---|
| **[A]** | Stated in the paper's abstract or an author-controlled page (abstract text, README, docs). Reasonably reliable. |
| **[S]** | A specific number or detail that reached me only through a secondary summary (search-engine digest, review site, blog). Plausible but **not checked against the paper**. Confirm before citing it in a decision. |
| **[X]** | My extrapolation to Exocortex. It is not a finding of the cited work. |
| **[U]** | Could not verify at all. |
| **[V]** | Verified against the paper itself (table, figure or section cited). Where the snippet was wrong, the corrected figure is given with a note. Strength is what the paper supports, not more. |

**Transfer warning.** Most agent results below were measured with frontier or very large models (GPT-4-class, Claude, DeepSeek-V3, Qwen3-Coder-480B). A few studies include ~27–32B models, and I flag those, because they are the most transferable. Results on 0.5–4B models are flagged too; they may not transfer **upward** to 27B either.

**Today's state (from DECISIONS.md).**
- Hard-tier baseline: 23/36 = 64% (D-037). Cache hit 95%, prefix kept 100%.
- Sidecars use the same model as main (D-006). Sidecar thinking is off by default (D-008).
- The supervisor is built: isolated ledger, deterministic evidence, isolated verdict that also sees the agent's last 1.5k characters (D-039).
- Trimmer, triage and compaction are next (Phase 4). Memory is Phase 5. Reasoning-only parallelism is Phase 6 (D-015).

---

## Executive summary: top 10 recommendations, ranked by expected impact on a 27B local agent

Ranking weighs (i) evidence strength, (ii) how likely the effect is to transfer to a 27B same-model setup, and (iii) how cheap it is to try given what is already built.

1. **Make the supervisor's verdict evidence-first and largely deterministic. Use the LLM only for criteria that no executed check covers.**
   - Intrinsic self-verification by the same model is unreliable [Huang et al. 2024; Stechly et al. 2025; Kamoi et al. 2024].
   - The best LLM judges reach only ~70% precision on agent success [AgentRewardBench 2025].
   - Sound external verifiers produce large gains [Stechly et al. 2025].
   - Concretely: a failing or stale check means `incomplete` with no LLM call; criteria mapped to fresh passing checks count as satisfied; only the remaining criteria go to the LLM. (§1)

2. **Fix the eval's statistical power before trusting any module comparison.**
   - At p≈0.64 with 60 unpaired runs per arm, the minimum detectable effect (80% power) is ≈ **25 points**.
   - The `spec-compliance` slice (3 tasks × 5 repeats) can only detect effects of ≈ **49 points**.
   - Fixes: pair by task × repeat, use task-clustered SEs [Miller 2024], grow each failure-mode slice to ≥10 tasks, and report budget-matched cost [Kapoor et al. 2024]. (§7)

3. **Add deterministic loop / repeated-error detection. Gate triage's LLM call on it instead of firing on every failure.**
   - OpenHands and pi community extensions already detect loops deterministically.
   - LivePlan's "deterministic monitor, LLM advisor only on trigger" design gained up to 15.2% on SWE-agent [Liu et al. 2026].
   - Self-repair is bottlenecked by the quality of the model's own feedback [Olausson et al. 2024].
   - This **refines brief §6.3**, which calls the sidecar on every failing `tool_result`. (§3)

4. **Trimmer: deterministic elision first, then extractive (line-selecting, not rewriting) LLM trimming, and only above a high threshold.**
   - Rule-based elision staged before LLM summarization was the most efficient context strategy across 176 settings [Harness Design study 2026].
   - Extractive, intent-conditioned compression keeps identifiers intact [Paritok-4B 2026; SWE-Pruner 2026].
   - Rewrites at `tool_result` time do not disturb the prefix cache (D-029). (§2)

5. **Compaction: build the structured summary mostly from the trace. Let the LLM write only the narrative sections.**
   - File/artifact tracking was the weakest dimension for every summarizer Factory tested (≈2.2–2.5/5) [Factory 2025, S].
   - LLM summaries can lengthen trajectories by 13–15% [Lindenbauer et al. 2025, S].
   - Deterministic sections: goal ledger, all user messages verbatim, files modified, last check results, verdict history. (§4)

6. **Restructure the verdict call as per-criterion decomposition, get confidence from structure rather than logprobs, and A/B thinking-on for the verdict only.**
   - Checklist decomposition improves judge–human agreement [TICK 2024].
   - On Qwen 3.5 4B/9B/27B, answer-token logprobs were *anti-calibrated* (AUROC 0.32–0.49), and 99%+ of logprobs saturate above 0.999 under JSON output [VERDI 2026, V: Tables 2 and 5, App. G]. The saturation figure was measured on GPT-4.1-mini; the anti-calibration figure on Qwen. Benchmarks are SummEval, FEVER and SciFact, not code.
   - Thinking judges were ~10 points more accurate in small Qwen3 models [2025].
   - The thinking part **touches D-008** (sidecar thinking off by default). (§1)

7. **Do observation masking in batches through pi's `context_edit`, as a cheap "mini-compaction". Do not use a per-turn rolling window.**
   - Masking matched or beat LLM summarization at about half the cost, and **Qwen3-32B was among the models tested** [Lindenbauer et al. 2025].
   - **Verified caveat (D-053):** on Qwen3-32B, the closest model to ours, neither strategy beat the raw agent's solve rate (non-thinking: raw 17.0%, masking 15.0%, summary 16.0%; Table 1), summary was the cheaper one, and masking lengthened trajectories by 13%. A 2026 measurement on a local 30B with prefix caching found masking cut the prefix-hit rate from 96.5% to 50.8% (§8). Treat #7 as an experiment with weak priors for a 27B, not an expected win.
   - A per-turn rolling window breaks the prefix every turn [X]. Batching makes it one cache reset per batch, like compaction.
   - Needs a new D-entry because it edits earlier context (constraint 3; D-029 allows `context_edit` only for "deliberate compaction-like operations"). (§2, §4)

8. **Add tamper and claim-consistency features to the supervisor's evidence.**
   - Features: test files modified, deleted or skipped; assertions weakened; claims of "tests pass" with no matching command in the trace.
   - Agents exploit tests [ImpossibleBench 2025]. "Inaccurate self-reporting" was 22.58% of misalignment episodes in 20,574 real sessions, and its share is *growing* [2026].
   - Present the agent's final message as **claims to check**, not as evidence. (§1)

9. **Memory (Phase 5): start with high-precision pitfall cards from deterministic error→fix pairs, with strict admission and utility-based retirement. Assume benefits may be small for a 27B model.**
   - On WebArena, a vanilla Qwen3.6-27B actor matched or beat memory/skill/workflow modules once token budgets were matched [2026].
   - Small models gain little from Dynamic Cheatsheet [Suzgun et al. 2025/2026].
   - Bad memories propagate errors [Xiong et al. 2025].
   - ACE-style delta updates (already in brief §6.4) are well supported [Zhang et al. 2025]. (§5)

10. **Parallel attempts (Phase 6): keep the scope minimal. Spend parallel compute on verdict voting for `uncertain` cases and on hypothesis diversity for stuck loops, not best-of-N.**
    - With an imperfect verifier, resampling has a hard ceiling and the optimal N can be <10 [Stroebl et al. 2024].
    - Weaker models have more false positives [same].
    - D-015 forbids executing the candidates, which removes the one verifier that works (execution). (§6)

**Recommendations that conflict with or amend existing decisions** (details in each section and in the table at the end):
- **D-008** (sidecar thinking off by default): recommend thinking **on** for the verdict call, pending A/B (#6).
- **Brief §6.3** (triage sidecar on every failing result): recommend gating it on repetition (#3).
- **Brief constraint 3 / D-029** (no edits to earlier messages): batched masking needs a sanctioned exception, framed as compaction (#7).
- **Brief §8 Phase 4 acceptance** ("token reduction with no drop in success"): add turns and wall-clock non-inferiority, because compression can raise latency 20–80% while saving tokens [Beyond Token Savings 2026] (§2).
- **D-039 Phase 3 acceptance** (slice by `spec-compliance`, 3 tasks): underpowered; report it as descriptive only (§7).
- **D-017** (compaction generated with fork-prefix LLM): recommend a mostly deterministic summary with a narrower LLM role (§4).

---

## 1. Supervisor and completion verification (implemented)

### 1(a) Key findings

**Intrinsic self-verification is weak. External, sound feedback is what works.**
- *Large Language Models Cannot Self-Correct Reasoning Yet*, Huang, Chen, Mishra, Zheng, Yu, Song, Zhou (Google DeepMind), ICLR 2024. https://arxiv.org/abs/2310.01798
  - **[A]** Without external feedback, LLMs struggle to self-correct, and performance sometimes *degrades*.
  - **[A]** Earlier gains relied on oracle labels.
- *On the Self-Verification Limitations of LLMs on Reasoning and Planning Tasks*, Stechly, Valmeekam, Kambhampati, ICLR 2025. https://arxiv.org/abs/2402.08115
  - **[A]** Self-critique causes "significant performance collapse"; a sound external verifier gives "significant performance gains".
  - Measured on planning and graph-coloring style tasks with GPT-4-class models, not coding agents.
- *When Can LLMs Actually Correct Their Own Mistakes?*, Kamoi, Zhang, Zhang, Han, Zhang, TACL 2024. https://aclanthology.org/2024.tacl-1.78/
  - **[A]** No prior work shows successful self-correction with feedback from prompted LLMs, except on tasks unusually suited to it.
  - **[A]** Self-correction works when reliable external feedback exists.
- *Agent-as-a-Judge*, Zhuge et al. (Meta, KAUST), ICML 2025. https://proceedings.mlr.press/v267/zhuge25a.html
  - **[A]** A tool-using judge that reads the produced project reached ~90% alignment with human consensus on DevAI (55 tasks, 365 hierarchical requirements), versus ~60–70% for a plain LLM judge.
  - The judge was a frontier model.
  - Lesson [X]: the judge's *access to grounded evidence* matters more than the judge's prompt.

**LLM judges of agent outcomes are imprecise, biased toward themselves, and share their errors with the model they judge.**
- *AgentRewardBench*, Lù et al. (McGill/Mila), 2025. https://arxiv.org/abs/2504.08942
  - **[A]** Across 12 judges on 1,302 web-agent trajectories, the best reached about 70% precision on success detection.
  - **[A]** Simpler input representations agreed better with experts.
- *LLM Evaluators Recognize and Favor Their Own Generations*, Panickssery, Bowman, Feng, NeurIPS 2024. https://proceedings.neurips.cc/paper_files/paper/2024/file/7f1f0218e45f5414c79c0679633e47bc-Paper-Conference.pdf
  - **[A]** Self-preference correlates linearly with self-recognition.
- *Do LLM Evaluators Prefer Themselves for a Reason?*, Chen et al., 2025. https://arxiv.org/abs/2504.03846
  - **[A]** Much self-preference is legitimate (better models really are better), but *harmful* self-preference persists exactly when the evaluator erred as a generator.
  - That is the case a same-model supervisor must catch.
- *Correlated Errors in Large Language Models*, Kim, Garg, Peng, Garg, ICML 2025. https://proceedings.mlr.press/v267/kim25e.html
  - **[A]** Across 350+ LLMs, models agree on ~60% of the cases where both err.
  - **[A]** Larger, more accurate models have highly correlated errors.
  - Same model as judge (D-006) is the extreme case of this.
- *CodeJudgeBench*, 2025. https://arxiv.org/abs/2507.10535
  - **[V]** (§5.1, Table 3) *Non-thinking* judges scored below 60% on pairwise code judging, near the 50% random baseline; thinking models (even Qwen3-8B) did clearly better. Swapping response order changed accuracy by up to 14% (§5.2, Fig. 4). *Correction:* the snippet said "pairwise code judging often <60%" without the non-thinking qualifier.
  - **[V]** (abstract, RQ3) *Correction:* the finding is that giving the judge the **candidate's** full, unprocessed response (with its comments and reasoning) beats stripping it to code. It says nothing about keeping the *judge's own* reasoning, which is what the snippet claimed. Judges tested go up to frontier models; Qwen3-8B/14B/32B and QwQ-32B are the transferable rows.

**Coding agents claim success prematurely, and the problem is getting relatively worse.**
- *How Coding Agents Fail Their Users*, 2026, 20,574 real sessions from 1,639 repos. https://arxiv.org/abs/2605.29442
  - **[A]** Seven misalignment forms. Constraint violations and **inaccurate self-reporting are growing in share** even as overall rates fall.
  - **[V]** (§4, Table 3) Inaccurate self-reporting (S7) was 22.58% of misalignment episodes (multi-label, so shares overlap). *Clarified:* the 91.49% is of the 9.33% of episodes with a visible resolution (n=1,504), across all symptoms, not only self-reporting; only 2.99% were self-corrected. Agents are frontier IDE/CLI products.
- *The Unreliable Progress Bar*, Wang, Wang, Wu, 2026. https://arxiv.org/abs/2609.08589
  - **[A]** Models report progress accurately before acting and after completion, but mid-task reliability drops to near zero.
  - **[A]** Newer models become over-conservative at the finish line.
  - **[A]** The authors conclude that frameworks should not control task flow on the model's self-reports alone.
- *ImpossibleBench*, Zhong, Raghunathan, Carlini (CMU, Anthropic), 2025. https://arxiv.org/abs/2510.20270
  - **[A]** Agents pass impossible tasks by modifying or deleting tests, special-casing, and even operator overloading.
  - **[A]** Prompting, test access and feedback loops change cheating rates.
- *Are "Solved Issues" in SWE-bench Really Solved Correctly?*, Wang, Pradel et al., ICSE 2026. https://arxiv.org/abs/2503.15223
  - **[A]** About 7.8% of test-passing patches fail the full developer test suite. Passing a *narrow* check is weaker evidence than it looks.
- *Preventing Premature Commitment in Coding Agents (ECLoop)*, 2026. https://arxiv.org/abs/2607.28815
  - **[A]** Compiles evidence conditions from the issue and holds actions until they are met.
  - **[A]** +4.8 to +11.8 points Pass@1 on all of SWE-bench Verified with two models and two scaffolds, at up to 12.1% fewer tokens.
  - It intervenes *during* the run, not at the end. **[V]** (Table 1) Models: GPT-5-mini and MiniMax-M2.5 under mini-swe-agent v2, both large; transfer to a 27B is untested.

**Requirement extraction and checklists.**
- *TICKing All the Boxes*, Cook, Rocktäschel, Foerster, Aumiller, Wang, 2024. https://arxiv.org/abs/2410.03608
  - **[A]** LLM-generated, instruction-specific YES/NO checklists raised exact judge–human agreement from 46.4% to 52.2%.
  - **[A]** Self-refinement with the checklist gave +7.8% on LiveBench reasoning.
  - Exocortex's ledger is already this design.
- *Ambig-SWE*, Vijayvargiya et al. (CMU), ICLR 2026. https://arxiv.org/abs/2502.13069
  - **[A]** Models struggle to tell well-specified from underspecified instructions.
  - **[A]** Interaction recovers up to 74% over non-interactive settings.
- *LLMs Get Lost in Multi-Turn Conversation*, Laban et al. (Microsoft/Salesforce), 2025. https://arxiv.org/abs/2505.06120
  - **[A]** Average 39% drop when requirements arrive over several turns, driven by unreliability.
  - Relevant to the ledger's `follows_previous` amendment logic.

**Calibrating the verdict.**
- *VERDI*, Qi, Dantsev, Sun (Indeed), 2026. https://arxiv.org/abs/2605.11334
  - **[V]** (Table 2, §4) With structured JSON output, 99.4–100% of answer logprobs saturate above 0.999. Measured on GPT-4.1-mini.
  - **[V]** (Table 5, App. G) On **Qwen 3.5 4B/9B/27B**, answer-token logprobs were *anti-calibrated* (AUROC 0.32–0.49: higher confidence on errors).
  - **[A]** VERDI decomposes each criterion into claim → verify → aggregate within one call and derives confidence from structural agreement. **[V]** (Table 5) AUROC 0.56–0.70 on the Qwen models, versus 0.72–0.91 on GPT-4.1-mini: weaker on our model class, but above chance where logprobs are below it. Tasks are summarization and fact-checking rubrics, not code.
  - Directly relevant: same model family and size.
- *Rethinking Verbalized Confidence for LLM-as-a-Judge*, 2026. https://arxiv.org/abs/2609.10996
  - **[A]** A well-designed verbalized-confidence recipe now beats logprob G-Eval on post-2025 *frontier* judges, while pre-2025 models lose accuracy with it.
  - Whether a 27B local model behaves like a "post-2025 flagship" here is unknown [U]. The paper tested proprietary models only, so it cannot settle this; it is an A/B question (AB_PLAN step 2).
- *Trust or Escalate*, Jung, Brahman, Choi (UW/AI2), ICLR 2025. https://arxiv.org/abs/2407.18370
  - **[A]** Selective evaluation: trust the judge only above a calibrated confidence and otherwise escalate, with a provable human-agreement guarantee.
  - **[A]** "Simulated annotators" (several in-context personas, confidence = agreement ratio) improved calibration.
  - The local analogue of "escalate" is `uncertain` → ask the user [X].
- *Explicit Reasoning Makes Better Judges*, 2025. https://arxiv.org/abs/2509.13332
  - **[A]** Thinking-mode Qwen3 judges (0.6B–4B) were ~10 points more accurate at <2× cost, and more robust to positional and other biases.
  - Small models only. Transfer to 27B plausible but unmeasured [X].
- *Reflexion*, Shinn et al., NeurIPS 2023. https://arxiv.org/abs/2303.11366
  - **[V]** (§4.3 analysis, Table 1) Self-generated tests had a 16.3% false-positive rate on MBPP Python (1.4% on HumanEval), and there Reflexion scored 77.1% against plain GPT-4's 80.1%.
  - Model-written checks are a weak oracle.

### 1(b) Recommendations for Exocortex

Current design (D-039): an isolated verdict call sees checklist + evidence + the agent's final 1.5k characters, outputs `complete|incomplete|failed|uncertain`, runs with thinking off, and uses no voting. The overall direction matches the literature (isolated context, deterministic evidence, `uncertain` allowed). The changes below sharpen it.

**R1.1 — Deterministic precedence rules before the LLM** (exec #1). Add a pure function `preVerdict(ledger, evidence)` in core, applied before any sidecar call:
- A configured or verbatim check command exits non-zero **after the last file write** → `incomplete`, missing = "make `<cmd>` pass", **with no LLM call**.
  - D-011 / D-039 already restrict which commands can run. This rule only changes who decides.
- All ledger criteria map to fresh passing checks, and the diff is non-empty → still call the LLM, but tell it which criteria are check-covered and ask only about the rest.
- Empty diff and no writes, but the agent claims completion → `incomplete` or `uncertain` without the LLM, unless the task was a question.
- [X] This shrinks the LLM's job to what only it can do, and directly applies the "sound external verifier" result [Stechly 2025; Kamoi 2024].

**R1.2 — Evidence features that matter most**, in priority order. This answers the brief's question. Items 1–3 are already partly in D-039's evidence; items 4–7 are new.

| # | Feature | Why (source) | Status |
|---|---|---|---|
| 1 | Exit code of each check command, **and whether it ran after the last write** (freshness) | Sound external verifier [Stechly 2025]; stale-pass is a classic false "done" [X] | Exit codes yes; freshness new |
| 2 | Per-criterion mapping to touched files or diff hunks | Agent-as-a-Judge's gains came from locating evidence per requirement [Zhuge 2025] | Partial (files touched) |
| 3 | Last command failed and was not rerun | Premature completion after the first green signal [2026 studies] | Partly (last 10 commands) |
| 4 | **Test tampering**: test files deleted or modified, `skip`/`xfail`/`#[ignore]`/`t.Skip` added, assertions removed, expected values edited | ImpossibleBench shows agents do this; over-mocked tests in agent commits [Hora 2026, https://arxiv.org/abs/2602.00409] | New |
| 5 | **Claim–evidence mismatch**: final message says "tests pass", "builds" or "fixed", but no matching successful command appears in the trace | Inaccurate self-reporting is 22.6% of misalignment episodes [V]; self-reports unreliable [Progress Bar 2026] | New (regex over the final message + trace) |
| 6 | Stub markers added in the diff (`TODO`, `unimplemented!()`, `NotImplementedError`, `panic("not implemented")`) | [X] cheap, deterministic, precise | New |
| 7 | Narrow-vs-full check: only a subset of tests was run (`-k`, `--run`, `-run`, single file) | 7.8% of narrow-test passes are wrong [Wang & Pradel 2026] | New |

**R1.3 — Treat the final message as claims, not evidence** (exec #8).
- Today the verdict prompt says "you must not trust the agent's own claims of success without evidence", yet it still shows 1.5k characters of the final message.
- Proposal: run a deterministic claim extractor (R1.2 #5) and pass the verdict call only (a) the extracted claims, labelled "UNVERIFIED CLAIMS", and (b) the last ~300 characters for `asked_user` detection.
- A/B this against the current prompt. [X] Showing a confident success narrative to a same-model judge is exactly the setting where harmful self-preference appears [Chen et al. 2025; Panickssery 2024].
- **Counter-evidence (2026-10-05, D-054).** CodeJudgeBench found judges were *more* accurate when given the candidate's full, unprocessed response (comments and reasoning) than when it was stripped to code [V: RQ3]. That is a different setting (pairwise code correctness, not completion claims), but it is a real reason R1.3 could lose: the narrative may carry information the judge uses. The A/B decides; do not assume `claims` wins.

**R1.4 — Per-criterion decomposed output** (exec #6).
- Change the schema to `items: [{criterion, status: met|unmet|unknown, evidence_ref}]`, and compute the verdict deterministically:
  - any `unmet` → `incomplete`;
  - all `met` → `complete`;
  - otherwise `uncertain`.
- Require `evidence_ref` to quote an evidence line ID. Reject items whose reference doesn't exist (schema-validate, then repair once, as D-036 already does).
- Basis: TICK, VERDI, Agent-as-a-Judge [A]. [X] This also yields per-criterion labels the memory module can learn from.

**R1.5 — Confidence without logprobs.** Do not build calibration on answer-token logprobs (F6 in INFERENCE_ENGINES.md). VERDI reports they are saturated (GPT-4.1-mini) or anti-calibrated (Qwen 3.5 27B) under JSON [V: Tables 2, 5]. Use:
- structural agreement: items marked `met` with valid evidence references divided by total items;
- **k-way voting only when the first verdict is `complete`**, with k=3 isolated calls at temperature ~0.7. The asymmetry is deliberate: a false `complete` is the costly error, because the user walks away.
- Action only on unanimity; otherwise downgrade to `uncertain`. This is "Trust or Escalate" with the user as the escalation target [A/X].
- Brief §6.1.6 already allows optional voting. D-024 rules out N-way fan-out on main's prefix, but verdict calls are isolated, so D-024 doesn't block this.

**R1.6 — Thinking on for the verdict only: A/B it.**
- D-008 sets sidecar thinking off by default. The verdict is the one sidecar where latency barely matters: main is idle at settle, and the settle budget is 5 minutes.
- Evidence from small Qwen3 judges shows ~+10 points [A]; CodeJudgeBench found non-thinking judges near chance (<60%) on pairwise code judging while thinking judges, including Qwen3-8B, did clearly better [V: §5.1]. *Corrected (D-054):* the earlier "retained reasoning helps" citation was about the judged response's reasoning, not the judge's; it is no evidence for R1.6, but the thinking-vs-non-thinking gap is, and it is stronger.
- **Conflict with D-008's default.** Recommend a new D-entry: `supervisor.thinking` defaults to `true` if the A/B (R1.8) shows better verdict precision at acceptable latency.
- After verification (D-054) this is the supervisor option with the strongest prior: non-thinking judges were near chance on pairwise code judging in CodeJudgeBench, and JEV-as-a-Judge (§8) found a decision-only judge (no reasoning) falls furthest behind a reasoning judge where the verdict must be derived (code −12.9 points).

**R1.7 — Ledger quality.**
- Add a `source: explicit|implied` field per criterion. The prompt already forbids invented requirements, so `implied` items should be rare.
- Never let an `implied` item alone produce `incomplete`; it may only lower `complete` to `uncertain`. This follows brief constraint 5 (precision over recall).
- Ambig-SWE shows models are poor at detecting underspecification [A], so do **not** ask the sidecar to flag ambiguity for the user at this stage [X].

**R1.8 — Consider an ECLoop-style mid-run check as a later supervisor feature**, not now.
- ECLoop's in-loop holding of edits gained 4.8–11.8 points [A], but it blocks actions, which brief constraint 2 discourages, and it was measured on GPT-5-mini and MiniMax-M2.5 [V].
- Park it as a candidate D-entry.

### 1(c) What to measure

- **Verdict confusion matrix on fixtures.** The check command is ground truth: verdict `complete` vs check pass at settle.
  - Report **precision of `complete`** (the costly error), recall of `incomplete`, and the rate of `uncertain`.
  - This needs no human labels, because fixtures already have hidden checks (D-035).
- **Per-feature ablation**: drop each R1.2 feature in turn and measure the change in precision of `complete`.
- **Prompt A/B**: final message vs claims-only (R1.3), and thinking on vs off (R1.6). Primary metric: precision of `complete`; secondary: verdict latency p50/p95.
- **Pre-verdict coverage**: the share of settles decided by R1.1 without an LLM, and that subset's accuracy against the check.
- **Ledger quality**: hand-write gold checklists for the 12 hard tasks once (~1 hour); measure criterion recall and precision of the ledger sidecar, and how often `implied` appears.
- **Real sessions (D-014.2)**: suggestion accept/edit/reject rate per verdict path (pre-verdict vs LLM).

---

## 2. Context trimming and observation management (next)

### 2(a) Key findings

**Simple masking competes with LLM summarization, and Qwen3-32B was tested.**
- *The Complexity Trap: Simple Observation Masking Is as Efficient as LLM Summarization for Agent Context Management*, Lindenbauer, Slinko, Felder, Bogomolov, Zharov (JetBrains Research / TUM), NeurIPS 2025 DL4Code workshop. https://arxiv.org/abs/2508.21433 · code: https://github.com/JetBrains-Research/the-complexity-trap
  - **[A]** In SWE-agent on SWE-bench Verified, across five model configurations, masking old observations halves cost relative to the raw agent and matches or slightly beats the solve rate of LLM summarization.
  - **[A]** LLM summarization can cause "trajectory elongation" (agents persist on unproductive paths), especially with stronger models.
  - **[A]** A hybrid of the two cut a further 7% (vs masking) and 11% (vs summary).
  - **[V]** (§3.2) Models: Qwen3-32B (thinking and non-thinking, 122K window via YaRN), Qwen3-Coder-480B-A35B and Gemini 2.5 Flash (thinking and non-thinking). Turn limit 250.
  - **[V]** (§3.2, §3.1) Masking window M=10 turns, chosen as best for SWE-agent; older observations become placeholders such as "Previous 8 lines omitted". §5.1: M must be re-tuned per scaffold; reusing M=10 on OpenHands "degrades drastically".
  - **[V]** (Table 1, §4.4) Qwen3-Coder-480B: masking 54.8% vs summary 53.8% vs raw 53.4% solve; $0.61 vs $0.64 vs $1.29. Summarization elongated trajectories 15% over raw and 13% over masking for that model (Gemini 2.5 Flash: 15% over masking).
  - **[V]** (Table 1, §4.4) **The Qwen3-32B rows.** Non-thinking: raw 17.0%, masking 15.0%, summary 16.0% (both drops within CI); cost $1.12 → $0.55 masking, **$0.50 summary**. Thinking: raw 23.0%, masking 24.6%, summary 24.8%; cost $0.51 → $0.46 masking, $0.51 summary. Qwen3-32B is the one configuration where summary was cheaper, because **masking** elongated its trajectories by 13% over raw. So for the model nearest ours, masking neither helped solve rate nor clearly won on cost.
  - **[V]** (App. A, §5.2) Cost model: Gemini costs are Vertex API bills (which include cache discounts); Qwen costs are recomputed from Alibaba list prices, which for Qwen3-32B do **not** distinguish cache hits from misses. No configuration models a local engine's prefix cache, so the per-turn cache-reset cost of a rolling mask is unmeasured here. *Resolved:* the earlier [U] notes on both points.
- *Masking Stale Observations Helps Search Agents — Until It Doesn't*, Zhang et al., EMNLP 2026 (preprint 2606.00408). https://arxiv.org/abs/2606.00408
  - **[A]** The gain from masking follows an inverted U against the model's no-management accuracy: little help when evidence is scarce, most help for mid-capacity models, collapse when the model is saturated.
  - **[A]** Masking trades tokens for turns. Models 4B–284B, search agents (not coding).
  - [X] A 27B on our hard tier is plausibly "mid-capacity", the regime where masking helps. But the Complexity Trap's own Qwen3-32B rows (above) did not show that help, so this stays a hypothesis for the A/B.
- *SWE-agent*, Yang et al., NeurIPS 2024. https://arxiv.org/abs/2405.15793
  - **[V]** (Table 3, §3) Keeping only the last 5 observations (older ones collapsed to one line) scored 18.0% vs 15.0% with full history, on a 300-instance SWE-bench Lite subset with GPT-4 Turbo.
  - **[V]** (Table 3) Ablations: editing with linting 18.0 vs 15.0 without; summarized search 18.0 vs 12.0 iterative / 15.7 none; 100-line viewer 18.0 vs 14.3 (30 lines) / 12.7 (full file).
  - GPT-4-era models.

**Systematic harness and compression studies from 2026 (larger N, more models).**
- *An Empirical Study of Harness Design for Coding Agents*, 2026. https://arxiv.org/abs/2609.20804
  - **[A]** 176 matched settings, 5 context strategies, 4 window budgets, 4 models, on SWE-bench Verified and Terminal-Bench 2.1.
  - **[A]** Context management matters more as the window tightens, and most of its benefit is **preventing context-overflow failures**.
  - **[A]** **Rule-based elision staged before LLM summarization** is the most efficient.
  - **[A]** **Making elided content recoverable "adds machinery models rarely use and yields no accuracy gain."**
  - Model identities include Claude 4.5-class models. A 27B may use a recall path even less [X].
- *Beyond Token Savings: A Systematic Study of Context Compression in LLM Agents*, Satish, Sinha, Kawada, Yadwadkar (UT Austin), 2026. https://arxiv.org/abs/2609.32961
  - **[A]** ~35,000 runs, three open-weight models. **[V]** (§4, App.) They are Qwen3.5-35B-A3B, Devstral-Small-2-24B and GLM-4.7-Flash, on SWE-bench Verified (100 issues) and Terminal-Bench 1.0 in mini-swe-agent: all small, so this is among the most transferable studies here. It also reports that conclusions for one model did not carry over to another.
  - **[A]** On Terminal-Bench with Qwen, policies using ~1/3 of the tokens could take **20–80% longer** end to end.
  - **[A]** Compression changes the information available to later decisions.
- *What Does Context Compression Cost an Agent?*, Liu, COLM 2026 workshop. https://arxiv.org/abs/2608.16370
  - **[A]** Compression can sharply raise the *reacquisition* cost (retrieval calls) while leaving completion statistically unchanged.
  - **[V]** (abstract, §3.3) For GPT-5.5 at 5× compression, retrieval calls went 21.0 → 63.9 (p = .002) while completion went 80% → 85% (p = 1.0, n.s.). The other models are deepseek-v4-flash and qwen3.7-plus (hosted, large). Retrieval rose in all six model–regime cells; completion fell significantly only for DeepSeek at 10×.
- *Toward Reliable Context Compression for Long-Horizon Agents*, Min et al., 2026. https://arxiv.org/abs/2608.06503
  - **[A]** Even when entities and progress labels are kept, agents lose their *local position*: they replay completed actions or overrun the terminal point.

**Learned and extractive compressors for coding agents.**
- *CoACT*, Tsinghua, 2026. https://arxiv.org/abs/2607.02911
  - **[A]** Observations are 45.7% of tokens on SWE-bench Verified and up to 67.8% on Terminal-Bench.
  - **[A]** A "next-action preservation" criterion (a compressed observation must induce the same next action) gives −33% tokens at near-unchanged solve rate.
- *Paritok-4B*, 2026. https://arxiv.org/abs/2608.24188
  - **[A]** An **extractive**, **intent-conditioned** 4B compressor: 96.0% of emitted identifiers, paths and numbers appear verbatim in the input.
  - **[A]** Compressed to 25.7% of size while retaining 86.5% of single-shot solve quality on SWE-bench Lite.
- *An Empirical Cost Attribution of Context-Compression Gateways*, 2026. https://arxiv.org/abs/2609.22114
  - **[A]** Per-turn saving from content compression is small (~2% of the cached prefix), but it accumulates quadratically because compressed reads are re-sent every turn.
  - **[A]** Turn count, not compression ratio, is the first-order cost variable.
- *SWE-Pruner*, 2026. https://arxiv.org/abs/2601.16746
  - **[A]** A 0.6B line-level "skimmer" guided by an agent-stated goal gives 23–54% token reduction on agent tasks with minimal loss.
- *LLMLingua-2*, Pan et al. (Microsoft), ACL Findings 2024. https://aclanthology.org/2024.findings-acl.57/
  - **[A]** Token classification with an XLM-RoBERTa compressor, 3× compression on MeetingBank QA, nearly lossless.
  - [X] Token-level deletion is a poor fit for code and logs: it mangles identifiers. Line-level extraction (SWE-Pruner, Paritok) fits better.

**Long-context degradation (the motivation).**
- *Context Rot*, Chroma, 2025. https://www.trychroma.com/research/context-rot
  - **[A]** 18 models including Qwen3 degrade non-uniformly as input grows; distractors hurt more at length.
- *Lost in the Middle*, Liu et al., TACL 2024. https://arxiv.org/abs/2307.03172
- *LLMs Can Be Easily Distracted by Irrelevant Context*, Shi et al., ICML 2023. https://arxiv.org/abs/2302.00093

### 2(b) Recommendations for Exocortex

Key architectural fact [X, from PI_API_NOTES §4/§9 and D-029]:
- A trimmer rewrite at `tool_result` time happens **before** the result enters the prefix. It is free of cache cost, which is why brief §6.2 works.
- *Masking old observations later* edits earlier context. In pi that means `context_edit` entries, and every edit resets the prefix from that point.
- So Exocortex should do **first-sight trimming** (cache-safe) plus **batched retro-masking** (one cache reset per batch).

**R2.1 — Deterministic tier first, always on** (exec #4). For bash results above ~4k tokens (start conservatively; brief says 2k):
1. Strip ANSI codes and carriage-return progress bars.
2. Collapse runs of identical or near-identical lines ("[×37 similar lines]").
3. Keep the head (~40 lines), the tail (~80 lines), and every line matching an ecosystem error grammar (rustc `error[E…]`/`-->`, Go `file.go:N:`/`--- FAIL`/`panic:`, C++ `error:`/`required from`/`ld:`, pytest `E `/`FAILED`/`Traceback`, CMake/ctest), with ±3 lines of context. Error grammars are per D-016.
4. Append a footer: `[exo: trimmed N→M lines; full output: <fullOutputPath>]`. pi already provides `fullOutputPath` for truncated bash output (PI_API_NOTES §bash).

- Never trim `read` of a file being edited (brief §6.2) or `edit` results.
- The harness study found recall paths unused [A]. Keep the path in the footer because it is cheap, but **don't build a recall tool**, and measure re-read rate.

**R2.2 — LLM tier only for large, noisy outputs, and extractive only.**
- Trigger: the deterministic tier still leaves more than ~2k tokens.
- The sidecar receives the current ledger criterion or last user goal plus the numbered lines, and **returns line ranges to keep, never prose**. Exocortex then copies those lines verbatim. This mirrors Paritok's and SWE-Pruner's extractive, intent-conditioned design [A].
- Benefits [X]: identifiers can't be corrupted, the output is trivially validated, and if the sidecar times out the deterministic tier is already in place.
- Context: `isolated` with a compact goal string (D-024/D-032 fallback). Interactive priority; deadline ~3–5 s.

**R2.3 — Batched retro-masking** (exec #7; needs a D-entry). When context crosses a soft threshold below pi's compaction trigger (e.g. 50% of the window), emit **one** batch of `context_edit` entries that replace every tool observation older than the last K turns with a one-line placeholder: command, exit code, and first error line.
- Agent reasoning and actions stay, as in the Complexity Trap and SWE-agent designs [A].
- [X] Cost: one prefix reset per batch, comparable to a compaction, rather than one per turn. Thinking and tool-call structure stay intact.
- This competes with or precedes LLM compaction (§4); the hybrid result suggests masking first and then summarizing [A].
- **Conflict:** brief constraint 3 and D-029 permit `context_edit` only for "deliberate compaction-like operations". Record this explicitly as such an operation, with its own toggle, and measure the cache hit-rate dip.
- **Evidence update (2026-10-05, D-053).** Verification weakened the case for R2.3 on our model class. The Complexity Trap's Qwen3-32B rows showed no solve-rate gain from masking (15.0% vs raw 17.0% non-thinking; 24.6% vs 23.0% thinking), summary was cheaper there, and masking lengthened trajectories by 13%. Their costs ignore local prefix caching. A local Qwen3-Coder-30B-A3B measurement (§8) found masking cut the prefix-hit rate from 96.5% to 50.8% and lengthened inference. Keep R2.3 deferred. Build it only if Phase 4 runs show context overflow or compaction-driven failures; then A/B it with prefix-hit rate, turns and wall-clock as co-primary metrics, and tune K (the paper found the window scaffold-specific).

**R2.4 — Don't trust token savings alone.** Phase 4 acceptance (brief §8: "token reduction with no drop in success") should add **non-inferiority on turns and wall-clock**. Compression can raise latency 20–80% [Beyond Token Savings 2026] and multiply re-reads [Liu 2026] while completion looks unchanged.

### 2(c) What to measure

- Main-model uncached input tokens and output tokens per run; **turns** and **wall-clock** (both must not regress beyond a stated margin).
- **Re-acquisition rate**: how often the agent re-runs the same command or re-reads `fullOutputPath` after a trim. This is the proxy for "trimmed something needed" [Liu 2026].
- **Next-action preservation (offline)**: replay recorded trajectories, compress each observation, and check whether a sidecar-simulated next action matches the original [CoACT's NAP idea, X]. This is an offline regression test for trimmer prompts that needs no full eval run.
- Cache metrics: `cached_tokens` dips at retro-masking batches; prefix-kept rate stays at 100% between batches.
- Slice by the `noisy-output` tag (h-py-log-analyzer, h-py-noisy-test-suite, h-cpp-build-log), keeping the §7 power caveats in mind.
- Sidecar trimmer: timeout rate and fallback rate; JSON-range validity rate.

---

## 3. Error triage

### 3(a) Key findings

**Same-model diagnosis has a low ceiling. Feedback quality is the bottleneck.**
- *Is Self-Repair a Silver Bullet for Code Generation?*, Olausson, Inala, Wang, Gao, Solar-Lezama (MIT/Microsoft), ICLR 2024. https://arxiv.org/abs/2306.09896
  - **[A]** Self-repair is bottlenecked by the model's ability to give feedback on its own code; gains are modest once cost is counted.
  - **[V]** (§1 contributions, §4.3) Replacing GPT-4's own feedback with a human programmer's raised repair success 1.58× (33.3% → 52.6%), on a subset of APPS with GPT-4.
  - Code Llama, GPT-3.5 and GPT-4 on HumanEval/APPS. Single-function tasks, not agents.
- *Teaching LLMs to Self-Debug*, Chen, Lin, Schärli, Zhou, ICLR 2024. https://arxiv.org/abs/2304.05128
  - **[A]** Execution feedback plus explanation improves sample efficiency.
  - **[V]** (§5.2.1, Fig. 6; App. on TransCoder) *Correction:* the gain comes almost entirely from the **first** debugging turn ("the accuracy improvement after one turn is within 0.1%"); successful debugging mostly ends within 3 turns. The snippet said "about 2 iterations". Models are Codex, GPT-3.5, GPT-4 and StarCoder on single-program tasks. Consistent with D-043's cap of 2 hints per signature; the second hint is the speculative one.
- *Not the Silver Bullet: LLM-enhanced Programming Error Messages are Ineffective in Practice*, 2024. https://dl.acm.org/doi/10.1145/3689535.3689554
  - **[A]** With 106 humans fixing C bugs, GPT-4-enhanced messages beat compiler messages on time-to-fix in only 1 of 6 tasks.
  - **[A]** Expert-written messages beat both.
  - Humans, not agents. Directionally relevant: generic LLM explanations add little over the raw error [X].
- *RustAssistant*, Deligiannis, Lal, Mehrotra, Poddar, Rastogi (Microsoft Research), ICSE 2025. https://www.microsoft.com/en-us/research/publication/rustassistant-using-llms-to-fix-compilation-errors-in-rust-code/
  - **[A]** LLM ↔ compiler iteration fixed ~74% of real-world Rust compile errors with GPT-4.
  - The compiler is the verifier.

**Failures compound early, and small models repeat the failure they just saw.**
- *Failure as a Process: An Anatomy of CLI Coding Agent Trajectories*, 2026. https://arxiv.org/abs/2607.09510
  - **[A]** 1,794 annotated Terminal-Bench trajectories, 7 frontier models, 3 scaffolds.
  - **[A]** Failures are mostly epistemic, usually start within the first few steps, and stay hidden until recovery is impossible.
- *Understanding Code Agent Behaviour*, ICSE 2026. https://arxiv.org/abs/2511.00197
  - **[A]** Failed trajectories are consistently longer and more variable.
  - **[V]** (Finding 4, abstract) Failed trajectories were 12.6–82.5% longer depending on agent and benchmark (SWE-agent 12.6%/18.5%, Prometheus 56.6%/50.7%, OpenHands 31.0%/82.5% on Lite/Verified), and 72–81% of failures still localized the right files.
- *Feedback That Backfires: Why Small Language Model Agents Repeat the Call They Just Watched Fail*, Gumaan, 2026. https://arxiv.org/abs/2608.23651
  - **[A]** Showing a verbatim failed call *raises* the chance of repeating it; the probability rose from 0.06 to 0.54.
  - **[A]** 83% of the effect comes from the call's surface form.
  - **[A]** Replacing the verbatim call with a runtime-generated description of the failure removed 76% of the effect.
  - **Only 135M–1.7B models.** Transfer to 27B is unknown, and probably weaker [X].
- *The Illusion of Diminishing Returns*, Sinha et al., ICLR 2026. https://arxiv.org/abs/2509.09677
  - **[A]** "Self-conditioning": models make more errors after seeing their own earlier errors in context. Scale does not fix this; thinking models largely do not self-condition.
  - [X] Supports masking stale failures (R2.3) and running main with thinking on (D-008 open question 12).

**Deterministic monitors plus LLM advice on demand work.**
- *Online Monitoring and Corrective Steering of Programming Agents (LivePlan)*, Liu, Dehghan et al., 2026. https://arxiv.org/abs/2608.06701
  - **[A]** A rule-based monitor over trajectory graphs detects drift **without an LLM** and consults an advisor LLM only when it fires.
  - **[A]** Up to +15.2% (mean +9.9%) issue resolution over vanilla SWE-agent at $0.08 per instance.
  - **[V]** (§5) Executors: DeepSeek-V3 and Gemini-2.5-Flash (+12.33 and +15.24 points). Large models.
- *OpenHands StuckDetector*. https://docs.openhands.dev/sdk/guides/agent-stuck-detector
  - **[A]** Detects the same action–observation 4×, the same action–error 3×, monologue 3×, ping-pong alternation over 6 cycles, and context-window errors.
- *pi-anti-doom-loop* (pi package). https://pi.dev/packages/pi-anti-doom-loop
  - **[A]** Blocks the same (tool, args) 3× in the last 10 calls, the same tool failing 3× in a row, and repeated text.
  - Prior art inside pi itself. Note the overlap.
- *Debugging the Debuggers (PROBE)*, 2026. https://arxiv.org/abs/2605.08717
  - **[A]** Guidance is gated: emitted "only when evidence-grounded, actionable, and in scope".
  - **[A]** The paper reports a large diagnosis–recovery gap: 65% diagnosis accuracy vs a 22% recovery rate.
- *AgentDebug / Where LLM Agents Fail*, Zhu et al., ICML 2026. https://arxiv.org/abs/2509.25370
  - **[A]** Root-cause errors cascade. Targeted root-cause feedback beats generic reflection.

**Retrieval of past fixes.**
- *RAP-Gen*, Wang et al., FSE 2023. https://dl.acm.org/doi/10.1145/3611643.3616256
  - **[A]** Retrieving similar bug→fix pairs (hybrid lexical + semantic) improves patch generation.
  - Classic. Supports memory-backed triage (brief §6.3 "later").

### 3(b) Recommendations for Exocortex

**R3.1 — Gate the LLM on repetition, not on every failure** (exec #3; **amends brief §6.3**).
- On the **first** failure with a new normalized signature: deterministic only. Error-line extraction (shared with R2.1) moves the decisive error lines to the top of the result, e.g. `[exo: first error] src/lib.rs:42: error[E0502]: …`.
  - The main model already sees the raw error, and same-model explanations add little [Olausson; "Not the Silver Bullet"].
  - Ordering helps when the first real error is buried, which is common in C++ template errors and Go multi-package builds [X].
- On a **repeat** of the same signature (≥2 occurrences within the task), or the same `(command, exit≠0)` 2×: call the sidecar for a ≤2-sentence diagnosis that must name a **different** action than the last attempt.
- Pattern: LivePlan / StuckDetector [A].

**R3.2 — Deterministic signature** (D-016): `(tool, ecosystem, error code or first error line with paths, line numbers, hex addresses, temp names and numbers normalized, file extension)`. The same function feeds the eval's repeated-error rate (D-033) and memory triggers (§5). Make it one core function used in all three places.

**R3.3 — Describe repeated failures, don't echo them.** When appending a triage note to a repeated failure, phrase it as a runtime description ("the previous `cargo build` failed again with the same E0502 on `self.items`"). Don't quote the failed command verbatim. Basis: the "Feedback That Backfires" mitigation [A, small models only]. Cheap to try; A/B it. [X] Exocortex cannot rewrite the earlier assistant tool call (prefix rule), only the new result, so the effect may be smaller here.

**R3.4 — Loop breaker as part of triage.**
- At OpenHands-like thresholds (same action–error 3×, ping-pong over 6 cycles), triage appends a stronger, still advisory note.
- This is also the natural trigger for Phase 6's parallel diagnoses (D-015).
- Do not block tool calls: pi-anti-doom-loop blocks, but D-010's "suggest, don't act" stance argues against it.
- Check for interference if the owner also installs pi-anti-doom-loop [X].

**R3.5 — Hints must be grounded.** Validate the sidecar's diagnosis: any file path or symbol it names must appear in the error output or the repo, otherwise drop the hint. This is PROBE's "guidance gate" [A] and brief constraint 5.

### 3(c) What to measure

- **Repeated-error rate** (D-033 metric) and **turns from first failure to first success** of the same check, on the `error-recovery` slice.
- Hint precision proxy: after a hint, did the next command for that signature succeed within 2 turns? Compare against signature-matched runs without hints (same task, other config).
- Sidecar calls per run: the gate should cut them by more than 50% versus fire-on-every-failure. Measure both policies once.
- R3.3 A/B: repeat-of-identical-call rate after a failure.
- Loop events per run (StuckDetector-style counts), with module off vs on.

---

## 4. Compaction and long-horizon context

### 4(a) Key findings

- *Factory: Evaluating Context Compression for AI Agents* (industry blog), 2025. https://factory.ai/news/evaluating-compression
  - **[V]** (read from the page, 2026-10-05) Four probe types on long real sessions: recall, artifact (file tracking), continuation (task planning), decision (reasoning). Graded by an LLM judge (GPT-5.2) on six dimensions.
  - **[V]** (results table) Factory's anchored iterative summarization scored 3.70 overall vs 3.44 (Anthropic) and 3.35 (OpenAI).
  - **[V]** (results table) **Artifact trail was the weakest dimension for all methods: 2.45 / 2.33 / 2.19 out of 5.** The page concludes that artifact preservation "needs specialized handling beyond general summarization", which is what D-044's facts-from-the-trace design does.
  - Vendor self-evaluation: treat it as a design hint, not a result.
- *Claude Code compaction prompt* (practitioner-extracted, not an official source). https://gist.github.com/tassa-yoniso-manasi-karoto/1e6a1328cb75f4729d5ff4e9ec457134
  - **[S/U]** Nine sections: primary request and intent; key technical concepts; files and code sections; errors and fixes; problem solving; **all user messages**; pending tasks; current work; optional next step.
- *Anthropic, Effective context engineering for AI agents*, 2025. https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
  - **[A]** Compaction, tool-result clearing ("lightest-touch compaction") and structured note-taking.
- *OpenHands condenser*. https://docs.openhands.dev/sdk/guides/context-condenser
  - **[A]** An LLM-summarizing condenser keeps recent events verbatim.
  - **[A]** Claims up to 2× per-turn cost reduction with no performance loss. Self-reported.
- *The Complexity Trap* (above): summarization elongated trajectories by 13–15% for Qwen3-Coder-480B and Gemini **[V]**, while for Qwen3-32B it was masking that elongated them (13%) **[V]**, and a hybrid of masking + summary is cheapest **[A]**.
- *Toward Reliable Context Compression*, 2026 (above): agents lose their local position after compaction and replay completed actions **[A]**. Their TRACE method compares paired continuations to tune the compression prompt **[A]**.
- *Slipstream*, Chen, Pan, Dai, Netravali, 2026. https://arxiv.org/abs/2605.08580
  - **[A]** Run compaction asynchronously while the agent keeps going on the uncompacted context, then validate the summary against the agent's actual next steps.
  - **[A]** Up to +8.8 points accuracy and −39.7% latency on SWE-bench Verified and BrowseComp.
- *ACON*, Kang et al., 2025. https://arxiv.org/abs/2510.00615
  - **[A]** Optimizes the compression *guideline* in natural language by contrasting runs that succeeded uncompressed with runs that failed compressed.
  - **[A]** −26–54% peak tokens, and distillation to smaller compressors keeps >95% of performance.
- *HiAgent*, Hu et al., ACL 2025. https://arxiv.org/abs/2408.09559
  - **[A]** Subgoal-chunked working memory: summarize a chunk once its subgoal completes.
  - **[V]** (§1, Table) 2× the success rate of the standard strategy on five AgentBoard tasks, context length −35.02%, steps −3.8, run time −19.42%. GPT-4 Turbo backbone.
  - Requires the main model to emit subgoals, which **violates the core thesis** (don't burden main).
- *ReSum*, Wu et al. (Alibaba Tongyi), 2025. https://arxiv.org/abs/2509.13313
  - **[A]** Periodic summaries let web agents continue indefinitely, +4.5% average, training-free.
  - **[A]** A fine-tuned Qwen3-30B-A3B summarizer matched larger general models.

### 4(b) Recommendations for Exocortex

D-017 says: hook `session_before_compact` and build the summary from ledger + trace (done, remaining, key facts, files touched, last failing check), generated with `fork-prefix`. Pi's default compaction is the fallback. The research supports the *content* list strongly. I'd change the *generation split*.

**R4.1 — A mostly deterministic summary** (exec #5; refines D-017). Have code, not the LLM, render these sections from the trace:
1. **Task**: the ledger criteria, each marked by the last verdict or check as done, not done or unknown.
2. **All user messages verbatim** (truncated individually if huge). Claude Code keeps these, and they are where intent changes live.
3. **Files modified**, with a one-line diff stat each, from git. Artifact tracking is every summarizer's weakest dimension [Factory, S]; code gets it exactly right.
4. **Last result of each check command** (command, exit code, first error line).
5. **Commands already run successfully**: a deduplicated list, which guards against "replaying completed actions" [Min et al. 2026].
6. **Open error signatures**, from triage (§3).

The LLM, with a fork-prefix or compact context, writes only:
7. **Current work and next step** (≤150 words);
8. **Decisions and dead ends** ("tried X, failed because Y") (≤150 words).

[X] Rationale: whatever is deterministic can't be dropped or invented, and keeping the LLM part small limits the summarizer-induced elongation the Complexity Trap reports.

**R4.2 — Anchored, incremental summaries.** On a second or later compaction, `preparation.previousSummary` exists (PI_API_NOTES §9). Regenerate the deterministic sections from the trace, and have the LLM *update* sections 7–8 rather than rewrite from scratch. This is Factory's anchored approach [V] and ACE's anti-collapse principle (§5) [A].

**R4.3 — Masking first, LLM compaction second.** If R2.3's retro-masking is on, pi's threshold compaction should fire less often, so measure that. The hybrid result says combining both is cheapest [A].

**R4.4 — Validate the summary.** It is cheap: after compaction, check the agent's first 2 actions. A re-run of a command from section 5 with the same outcome counts as a "replay". Log the replay rate as the compaction quality metric. This is a cheap deterministic proxy for Slipstream's and TRACE's validation [X].

**R4.5 — Don't adopt HiAgent-style subgoal emission**, because it adds load to main (core thesis). The ledger already provides subgoals externally.

### 4(c) What to measure

- Success **vs session length** (D-002 "longer tasks survive"). This needs some fixtures long enough to trigger compaction at least once. Today's hard tier averages 14 turns and ~270k cumulative input tokens, so it probably doesn't compact; verify from the trace.
  - Option: run eval with a reduced context window (e.g. 32k) to force compaction. The Harness Design study found context management's value appears as the budget tightens [A].
- **Post-compaction replay rate** (R4.4), turns after compaction, and success conditional on ≥1 compaction.
- **Probe recall (offline)**: for recorded sessions, ask a sidecar fixed probes ("which files were modified?", "what does the last failing check say?") from the summary alone, and score them against the trace. This is Factory's probe method, done deterministically where possible.
- Compaction latency and the fallback-to-pi-default rate.

---

## 5. Memory and continual learning (later)

### 5(a) Key findings

- *Reflexion*, Shinn et al., NeurIPS 2023. https://arxiv.org/abs/2303.11366
  - **[A]** Verbal self-reflection stored in episodic memory improves later attempts.
  - Its success depends on evaluator quality (see the MBPP false-positive result in §1).
- *ExpeL*, Zhao et al., AAAI 2024. https://arxiv.org/abs/2308.10144
  - **[A]** Extracts insights from success/failure pairs and maintains them with ADD / EDIT / UPVOTE / DOWNVOTE; an insight is removed when its count reaches zero.
  - Direct precedent for utility counters.
- *Agent Workflow Memory*, Wang, Mao, Fried, Neubig (CMU/MIT), ICML 2025. https://arxiv.org/abs/2409.07429
  - **[A]** Induces reusable workflows: +24.6% and +51.1% relative success on Mind2Web and WebArena. GPT-4-class models.
- *Dynamic Cheatsheet*, Suzgun et al., EACL 2026. https://aclanthology.org/2026.eacl-long.333/
  - **[A]** Large gains for strong models (e.g. GPT-4o Game of 24: 10% → 99%).
  - **[V]** (§4, Table 3; §5) **Smaller models (GPT-4o-mini, Claude 3.5 Haiku) gained little or declined**: GPT-4o-mini lost accuracy under some variants on AIME 2024 and stagnated or declined on GPQA-Diamond. The paper's reason is *generative competence*: small models produce correct solutions too rarely to seed the memory, and fail to retrieve and apply stored heuristics. *Nuance:* D-049 paraphrased this as "they self-judge poorly"; the paper blames solution quality, not judgment. Either way it supports admitting cards only from externally verified fixes. Tasks are math and puzzles, not code.
- *ACE: Agentic Context Engineering*, Zhang et al. (Stanford, SambaNova, UC Berkeley), 2025. https://arxiv.org/abs/2510.04618 · https://github.com/ace-agent/ace
  - **[A]** Generator / Reflector / Curator with incremental delta updates and "grow-and-refine".
  - **[A]** Avoids "brevity bias" and "context collapse". +10.6% on agents (AppWorld), +8.6% finance.
  - **[V]** (§2.2, Fig. 2) Collapse example on AppWorld: at step 60 an 18,282-token context at 66.7% accuracy was rewritten in one step to 122 tokens and fell to 57.1%, *below* the 63.7% of no context at all. The case study is of Dynamic Cheatsheet-style monolithic rewriting.
  - **[V]** (§4, Table 1) Main experiments use DeepSeek-V3.1 (671B) for generator, reflector and curator, so very large.
- *ReasoningBank*, Ouyang et al. (Google), 2025. https://arxiv.org/abs/2509.25140
  - **[A]** Strategy-level memories from *both* successes and failures (counterfactual pitfalls); failures add value over success-only memory.
  - **[A]** Up to +34.2% success, −16% steps (with memory-aware test-time scaling).
- *How Memory Management Impacts LLM Agents*, Xiong et al., 2025. https://arxiv.org/abs/2505.16067
  - **[A]** "Experience-following": similar inputs lead to similar outputs, so stored errors propagate.
  - **[A]** Selective addition beats store-all; addition + deletion policies gave ~10% absolute.
- *Are Online Skill and Memory Modules Always Worth Their Tokens?*, 2026. https://arxiv.org/abs/2606.15017
  - **[A]** Tested on four WebArena domains with Gemini 3 Flash, GPT-5.4-mini and **Qwen 3.6-27B**.
  - **[A]** **The vanilla actor matched or beat all three augmentation methods (memory, workflow, skills) in aggregate success, often with fewer tokens.**
  - **[A]** Gains vanish against budget-matched baselines. Web, not coding, but the same model class as ours.
  - **[V]** (Table 1, §4) With Qwen 3.6-27B, average WebArena success: budget-matched vanilla actor 50.73%, AWM 46.15%, ASI 49.08%, ReasoningBank 47.62%; vanilla was also the most token-efficient. "Budget-matched" means a 15-step vanilla horizon vs 10 for the augmented methods. Three runs per domain. The augmented methods induce memory from the agent's own trajectories, judged by the model; none admits only externally verified lessons, so the result does not test D-049's design, but it sets the bar it must clear.
- *SWE-Exp*, Chen et al., 2025. https://arxiv.org/abs/2507.23361
  - **[A]** An experience bank from successful and failed repair attempts.
  - **[V]** (Table 1, §4.1) SWE-bench Verified Pass@1 42.0% with DeepSeek-V3-0324 and 73.0% with Claude 4 Sonnet. *Clarified:* these are absolute scores on two backbones, not a 42 → 73 gain. (Table 2) Disabling cross-repository experience abstraction costs 6.0 points (42.0 → 36.0, DeepSeek-V3), the largest ablation.
- *Memento*, Zhou et al. (UCL, Huawei), 2025. https://arxiv.org/abs/2508.16153
  - **[A]** Case bank plus a *learned* case-selection policy (memory-based online RL).
  - **[V]** (abstract, Table) Case-based memory adds 4.7–9.6 absolute points on out-of-distribution deep-research tasks. GPT-4.1-class planner; not coding.
- *MemQ*, 2026. https://arxiv.org/abs/2605.08374
  - **[A]** Q-values for memories with TD(λ) credit through a provenance graph.
  - Over-engineered for us now, but it confirms utility-weighted retrieval as the direction.

### 5(b) Recommendations for Exocortex

Brief §6.4 and D-018 already match the literature on several points: delta ops (ACE, ExpeL), supersede-don't-delete, utility stats, repo scope, hot-path BM25 with no LLM (D-026). The evidence adds caution about *whether* memory helps a 27B model at all.

**R5.1 — Ship one card type first: pitfalls from deterministic error→fix pairs** (exec #9).
- Trigger = the triage signature (R3.2). Content = what fixed it, taken from the diff between the failing and the next passing run of the same check.
- [X] This is the highest-precision signal available. It doesn't depend on the model judging its own success (Dynamic Cheatsheet's failure mode for small models), and its retrieval key is exact, not semantic.
- Defer `procedure` cards until pitfall cards show a positive effect.

**R5.2 — Strict admission.**
- Admit a card only when its source episode has an *external* success signal: a check passed or the user accepted a supervisor verdict. Never admit on the model's self-judgment.
- Basis: Xiong et al. (selective addition) and Reflexion's evaluator dependence [A].
- ReasoningBank shows failure-derived lessons help [A], but here they should come from verified failure→success contrasts.

**R5.3 — Utility and retirement.** Use ExpeL-style counters:
- `helped` += 1 when the card was injected and its trigger signature did not recur within the task;
- `hurt` += 1 when the signature recurred after injection, or the run failed.
- Retire at `hurt − helped ≥ 2` with `injected ≥ 3`.
- Keep valid_from / valid_to (supersede). Do not do learned retrieval policies (Memento, MemQ) until there are hundreds of cards [X].

**R5.4 — Budget the injection and count it.** The Qwen 3.6-27B result [A] says memory must beat a budget-matched baseline. Report memory tokens and the curator's background tokens in the eval's cost columns (D-033). The ~400-token cap in brief §6.4 is sensible.

**R5.5 — No wholesale rewrites, ever** (already in the brief). The ACE collapse example [V] is the concrete failure. Make the curator's API accept only ADD / MERGE / SUPERSEDE / RETIRE ops, validated by schema.

### 5(c) What to measure

- Phase 5 acceptance (brief §8: replay the task set twice) needs more care:
  - **contamination control**: memory learned on run 1 may encode the *solution* to the same fixture. Use a held-out split: learn on tasks A, test on tasks B from the same repo or ecosystem.
  - Also report same-task second-pass separately, as an upper bound.
- Repeated-error rate **across sessions** (D-002), card injection precision (helped / injected), retired-card rate.
- **Budget-matched comparison**: memory-on vs memory-off with the main model's token budget equalized, or at least total tokens reported side by side [2606.15017].

---

## 6. Parallel and test-time compute for small models (later)

### 6(a) Key findings

- *Large Language Monkeys*, Brown et al. (Stanford), 2024. https://arxiv.org/abs/2407.21787
  - **[A]** Coverage rises log-linearly with samples: DeepSeek-Coder-V2 on SWE-bench Lite went from 15.9% with 1 sample to 56% with 250.
  - **[A]** **Without automatic verifiers, majority voting and reward models plateau.**
- *Inference Scaling fLaws*, Stroebl, Kapoor, Narayanan (Princeton), 2024. https://arxiv.org/abs/2411.17501
  - **[A]** With imperfect verifiers, false positives cap accuracy even with infinite samples.
  - **[A]** A weaker model's single-sample accuracy correlates with its false-positive rate.
  - **[A]** When false positives cost more than abstaining, the optimal number of samples can be **below 10**.
- *Scaling LLM Test-Time Compute Optimally…*, Snell et al. (Google DeepMind / Berkeley), ICLR 2025. https://arxiv.org/abs/2408.03314
  - **[A]** Compute-optimal allocation depends on problem difficulty.
  - **[V]** (Fig. 1 right, §7) Against a ~14× larger pretrained model, compute-optimal test-time scaling of PaLM 2-S* wins on easy and intermediate MATH questions; on the hardest, and as inference load grows relative to pretraining, the larger model wins.
- *Can 1B LLM Surpass 405B?*, Liu et al., 2025. https://arxiv.org/abs/2502.06703
  - **[A]** Yes on MATH and AIME **with a good PRM**; the optimal strategy depends on the policy, the PRM and difficulty.
  - Math with process reward models. Little bearing on agentic coding without a PRM [X].
- *When To Solve, When To Verify*, Singhi et al., COLM 2025. https://arxiv.org/abs/2504.01005
  - **[A]** At low budgets, self-consistency beats generative verification; GenRM needs up to 8× more compute to match it.
- *PlanSearch*, Wang et al. (Scale AI), ICLR 2025. https://arxiv.org/abs/2409.03733
  - **[A]** Sampling diverse natural-language *plans* beats sampling code (LiveCodeBench pass@200 77.0% vs 60.6%), because repeated samples are near-duplicates.
- *R2E-Gym*, Jain et al., 2025. https://arxiv.org/abs/2504.07164
  - **[A]** On SWE-bench Verified with a **32B** open model: 34.4% Pass@1 → 51.0% Best@26 using a *hybrid* verifier (execution-based tests + execution-free judge).
  - **[V]** (§4, Fig. 5) Execution-based and execution-free verifiers each saturate at ~42–43% (43.7% / 42.8%).
  - The most transferable result here, but it needs candidate patches *executed*.
- *CodeMonkeys*, Ehrlich et al. (Stanford), 2025. https://arxiv.org/abs/2501.14723
  - **[A]** Selection by voting on model-generated tests plus a dedicated selection trajectory: 57.4% SWE-bench Verified with Claude 3.5 Sonnet + Qwen2.5-Coder-32B, ~$4.60 per issue.

### 6(b) Recommendations for Exocortex

D-015 restricts Phase 6 to K parallel *diagnoses or plans* (no file writes), judged with deterministic signals first and offered as a suggestion. The literature says best-of-N gains come from **executable verification** [Monkeys; R2E-Gym; CodeMonkeys]. Without it, selection by a same-model judge plateaus early and suffers false positives that grow as the model weakens [fLaws; Correlated Errors].

**R6.1 — Keep Phase 6 small and late** (exec #10).
- Use parallel compute where the verifier is good: **verdict voting** (R1.5), which is cheap and isolated.
- Use *diverse hypotheses* for stuck loops (R3.4): K=3 isolated sidecars, each seeded with a different hypothesis frame ("assume the bug is in X", "assume the test is wrong", "assume an environment issue"), following PlanSearch's diversity argument [A].
- Do not pick a single winner by LLM judge. Show the user or main a short **deduplicated** list only when the hypotheses are mutually distinct and each names a concrete check to run [X].

**R6.2 — If execution-based selection is ever wanted, do it only in the eval sandbox (D-013), as a research config.** It would measure the headroom: what best-of-K with a check-command oracle would buy at 27B. That shows whether D-015's restriction leaves much on the table.

**R6.3 — Choose N with the fLaws argument.** For voting, use k=3, and at most 5. More samples raise false-positive exposure when the judge has a systematic bias [A].

### 6(c) What to measure

- Verdict voting: change in precision of `complete` and in the `uncertain` rate, plus sidecar tokens.
- Hypothesis sidecars: on loop-triggered events, the rate at which the agent leaves the loop within 3 turns, compared with triage-only.
- Oracle headroom (eval-only, R6.2): pass@K with check-command selection vs pass@1, on the hard tier.

---

## 7. Evaluation methodology

### 7(a) Key findings

- *Adding Error Bars to Evals*, Miller (Anthropic), 2024. https://arxiv.org/abs/2411.00640
  - **[A]** Treat eval questions as samples from a super-population.
  - **[A]** Use clustered standard errors when questions are grouped, **paired** comparisons for two systems on the same items, and power analysis. Report SEs, not point estimates.
- *AI Agents That Matter*, Kapoor, Stroebl, Siegel, Nadgir, Narayanan, TMLR 2025. https://arxiv.org/abs/2407.01502
  - **[A]** Optimize accuracy and cost jointly. Simple baselines are often Pareto-optimal. Holdouts are inadequate, and agents overfit benchmarks.
- *Identical Runs, Different Results*, Ariño de la Rubia, Pafka, 2026. https://arxiv.org/abs/2609.33812
  - **[A]** 584 runs, open-weight models. **Identical runs of one agent–model pairing varied more than pairings differed from each other.**
  - **[A]** Separating them took tens to more than a hundred runs each.
- *How to scale agentic evaluation: lessons from 200,000 SWE-bench runs*, AI21 (blog). https://www.ai21.com/blog/scaling-agentic-evaluation-swe-bench/
  - **[U]** Single-run pass@1 varied 2.2–6.0 points; at temperature 0 the SD still exceeded 1.5 points; detecting a 1-point gain took about 36 runs. (not accessible: the AI21 page, read in full on 2026-10-05, is about evaluation infrastructure and contains none of these numbers; their real source is unknown. Nothing in DECISIONS.md cites them. Use *Identical Runs, Different Results* [A] and our own paired MDE instead.)
- *AgentLens: The Lucky Pass Problem*, Microsoft Research, 2026. https://arxiv.org/abs/2605.12925
  - **[A]** 0.5–23.2% of passing trajectories are "lucky passes" (blind retries, missing verification, brute force), depending on the model.
- *Establishing Best Practices for Building Rigorous Agentic Benchmarks (ABC)*, Zhu et al., NeurIPS 2025. https://arxiv.org/abs/2507.02825
  - **[A]** Task-validity and outcome-validity flaws can misstate performance by up to 100% (relative).
  - **[A]** 7 of 10 popular benchmarks had outcome-validity issues.
- *The SWE-Bench Illusion*, Liang et al., ICSE 2026 SEIP. https://dl.acm.org/doi/10.1145/3786583.3786882
  - **[A]** Models identify buggy file paths from the issue text alone 76% of the time on SWE-bench repos, versus 53% on others. That suggests memorization.
- *SWE-rebench*, Badertdinov et al. (Nebius), 2025. https://arxiv.org/abs/2505.20411
  - **[A]** Fresh, date-stamped tasks expose contamination-inflated scores.
- *Aider Polyglot*. https://aider.chat/2024/12/21/polyglot.html
  - **[A]** 225 hardest Exercism exercises in C++, Go, Java, JS, Python and Rust; the score is the pass rate after a second attempt with test feedback.
  - Already named in D-014. Exercism solutions are public, so contamination risk is high [X].

### 7(b) Recommendations for Exocortex

**R7.1 — Do the power arithmetic in the report** (exec #2). With baseline p≈0.64 (D-037), two-sided α=0.05 and 80% power, the minimum detectable effect for **unpaired** runs is MDE ≈ 2.80·√(2p(1−p)/n) [X, standard formula]:

| Runs per arm (n) | Example | MDE (points) |
|---|---|---|
| 15 | `spec-compliance` slice: 3 tasks × 5 repeats (D-039 acceptance) | ≈ 49 |
| 36 | 12 tasks × 3 | ≈ 32 |
| 60 | 12 tasks × 5 | ≈ 25 |
| 120 | 12 tasks × 10 | ≈ 17 |
| 300 | 30 tasks × 10 | ≈ 11 |

- **Pairing helps.** Per-task success here ranges from 0/3 to 3/3, so most variance is between tasks. Pairing each on-run with an off-run on the same task and repeat index removes it. With an intra-task correlation ρ, the MDE shrinks by √(1−ρ); ρ≈0.5 gives ×0.71, e.g. 60 paired runs ≈ 17 points.
- **Clustering hurts.** When the module's effect differs by task, the effective sample size approaches the *number of tasks*. Twelve tasks is a small cluster count.
- **Conclusions:**
  - Report D-039's slice-level result as **descriptive**. The aggregate hard-tier comparison at `--repeat 5` can only detect large effects (≥~17–25 points).
  - Grow each failure-mode slice to ≥10 tasks. More tasks beat more repeats once repeats reach ~5 [Miller; X].
  - Use per-task paired differences with task-clustered SEs, or an exact sign or permutation test over tasks.

**R7.2 — Pick one primary metric per module before running.**
- Supervisor: success on hard; secondary: precision of `complete`.
- Trimmer: uncached input tokens, with success / turns / wall-clock as non-inferiority margins.
- Triage: repeated-error rate.
- Compaction: success when ≥1 compaction happened.
- Memory: held-out repeated-error rate.
- Prefer **lower-variance process metrics** (verdict precision, repeated-error rate, tokens) for iteration, and keep end-to-end success for phase gates [X].

**R7.3 — Report cost the Kapoor way.** Every config row should show main tokens, sidecar tokens (D-036 already logs them), and wall-clock. Draw the success × total-token Pareto frontier. The 27B memory result [2606.15017] is the warning case.

**R7.4 — Fixture validity (ABC).**
- Keep D-035's rule that hidden requirements must be stated in the prompt (task validity) and the pristine-fails / solution-passes check (outcome validity).
- Add a **tamper check**: the hidden overlay restores the original test files before running, so an agent that edits tests can't pass. This matters for supervisor evaluation, because ImpossibleBench-style cheating would otherwise count as a supervisor success [A/X].

**R7.5 — Contamination.** Hand-written fixtures (D-035) are the right default. If Aider-Polyglot or Exercism tasks are added, tag them `public` and report them separately, because they are likely in Qwen's training data [SWE-Bench Illusion; SWE-rebench, by analogy]. Prefer fixtures distilled from the owner's own sessions (D-014, "later").

**R7.6 — Process quality alongside pass/fail.** Log a cheap "lucky pass" proxy: a pass whose trajectory has ≥3 repeated identical failing commands, or no check run after the last edit. AgentLens shows these differ by model and hide reliability gaps [A].

### 7(c) What to measure (harness changes)

- A paired-comparison report section: per-task Δ, mean Δ with task-clustered 95% CI, and sign-test p-value.
- A `--power` dry-run that prints the MDE for the chosen tasks × repeats, using the last baseline rate.
- Cost columns: main tokens, sidecar tokens, memory tokens, wall-clock, plus the Pareto plot.
- Tamper detection in the check runner, and lucky-pass counts.

## 8. Newer work (post-June 2026), verified

A fresh search on 2026-10-05 for same-model verification, observation masking under prompt caching, memory for ≤32B coding agents and judge calibration on Qwen models. Only material results are listed, each read in the paper.

- *EfficientAgent: What Makes KV Cache Offloading Work for Concurrent Agents?*, Shao et al. (HKUST, Huawei), 2026. https://arxiv.org/abs/2609.33762
  - **[V]** (App., Table 13) Qwen3-Coder-30B-A3B on 8×RTX 3090 with GPU prefix caching, OpenHands condensers on SWE-bench Verified: observation masking cut mean KV utilization 52.85% → 29.15% but **dropped the prefix-hit rate from 96.5% to 50.80%**; recent-event truncation 60.85%; LLM summarization kept 92.15%. All three condensers lengthened per-instance inference.
  - Local engine, a model near our size, a coding agent: the most transferable measurement of masking's cache cost we have. Masking there is per-turn (rolling), not batched, so it bounds the cost of the design R2.3 already rejects; a batched mask would reset less often.
  - **Challenges** the Complexity Trap's cost conclusion for local inference, and **supports** keeping R2.3 deferred (D-042, D-053). Supports D-029's cache-stability rule.
- *VibeMemBench: Evaluating Memory Systems for Coding Agents on Real Repository Coding Tasks*, Fan et al. (SIAT, Alibaba), 2026. https://arxiv.org/abs/2609.23570
  - **[V]** (abstract, §5) 111 targets from 90 SWE-rebench V2 repos. Injecting experience already *verified by execution* raised resolution on four of five held-out solvers by 1.1–4.5 points and cut steps on all five. But when four existing memory systems had to build and retrieve experience from the same history, **11 of 12 solver–system pairings failed to beat memory-off**.
  - Solvers are large hosted models (glm-5, deepseek-v4-pro, qwen3.8-max and others), so gains for a 27B are not shown.
  - **Supports** D-049: useful experience exists, but self-built memory rarely delivers it; admission from verified fixes is the defensible narrow path. Expect a small effect; the AB_PLAN step 4 run is underpowered for 1–4 points (D-055).
- *JEV-as-a-Judge: Accept When Confident, Escalate When Unsure*, Li et al. (CMU), 2026. https://arxiv.org/abs/2609.26550
  - **[V]** (abstract, §4) A decision-only judge with label probabilities comes within 3 points of a frontier reasoning judge where the verdict "can be read off the text", but falls behind where it must be derived: code −12.9, math −14.3 points. Confidence-gated escalation recovers most of the gap.
  - **[V]** (Table 3 control) Local Qwen3.5-27B, served without thinking, was among the first-stage judges; the authors note open-weight local judges' confidence "supports less acceptance".
  - **Supports** R1.6 (thinking for the verdict) and R1.5 (don't gate on one call's confidence; escalate). Its escalation target is a stronger model, which Exocortex does not have (D-006); ours is the user.
- Searched but not added: DreamBench-SWE (2608.20664), memory hygiene with deliberately non-inferable evidence, mostly null primary contrasts; self-verified distillation work (2605.26132), which needs training.

---

## Conflicts and amendments to existing decisions (for new D-entries)

| Recommendation | Touches | Nature |
|---|---|---|
| R1.6: thinking **on** for the supervisor verdict, if A/B confirms | D-008 (sidecar thinking off by default) | Per-module override. D-008 already makes it per-module config, so this changes only the default. |
| R1.3: show claims, not the raw final message, to the verdict | D-039 step 4 (verdict sees the last 1.5k characters) | Prompt or evidence change; A/B first. |
| R1.1: deterministic pre-verdict can emit `incomplete` without an LLM | D-039 (verdict is an LLM call) | Additive. Note the brief §9 "prefer deterministic" support. |
| R3.1: triage LLM only on repeated signatures | Brief §6.3 (sidecar on every failing result) | Amends trigger policy. |
| R2.3 / R4.3: batched retro-masking via `context_edit` | Brief constraint 3; D-029 ("use only for deliberate compaction-like operations") | Needs an explicit sanctioned exception, measured as a compaction-like cache reset. |
| R2.4: Phase 4 acceptance adds turns and wall-clock non-inferiority | Brief §8 Phase 4 | Tightens acceptance. |
| R4.1: compaction summary mostly deterministic; LLM writes ≤300 words | D-017 (LLM-generated, fork-prefix) | Refines the generation split; content list unchanged. |
| R7.1: slice-level supervisor results are descriptive only; grow slices | D-039 Phase 3 acceptance; D-035 (3 tasks per mode) | Statistical caveat; more tasks. |
| R6.1: Phase 6 narrowed to verdict voting + hypothesis diversity | D-015 | Narrows scope; consistent with D-015's no-execution rule. |
| R5.1: pitfall cards only at first | Brief §6.4 (four card types) | Phasing within Phase 5. |

No recommendation conflicts with D-006 (same model for sidecars). But the correlated-errors and self-preference literature is the strongest argument that the D-006 trade-off is costly *specifically for the supervisor*. That is why R1.1–R1.5 push its decisions toward deterministic evidence.

## Things I could not verify

*Updated 2026-10-05 after verification.* Resolved: the Complexity Trap's Qwen3-32B row and cost model (§2a), the Factory numbers (§4a), the VERDI figures (§1a), and model identities: **ECLoop** used GPT-5-mini and MiniMax-M2.5 under mini-swe-agent v2 [V: Table 1]; **LivePlan** used DeepSeek-V3 and Gemini-2.5-Flash executors (+12.33 and +15.24 points) [V: §5]; **Beyond Token Savings** used Qwen3.5-35B-A3B, Devstral-Small-2-24B and GLM-4.7-Flash [V]. Still open:
- The AI21 run-count figures: not on the cited page; source unknown.
- The Claude Code compaction section list (practitioner-extracted gist; not on the work list).
- Whether verbalized confidence works for a 27B local judge. *2609.10996* tested proprietary models only [V: abstract, §3], so the paper cannot settle it; it is an A/B question (AB_PLAN step 2).

## Reference list (by section)

**§1:**
- Huang et al. 2024, https://arxiv.org/abs/2310.01798
- Stechly, Valmeekam, Kambhampati 2025, https://arxiv.org/abs/2402.08115
- Kamoi et al. 2024, https://aclanthology.org/2024.tacl-1.78/
- Zhuge et al. 2025, https://proceedings.mlr.press/v267/zhuge25a.html
- AgentRewardBench 2025, https://arxiv.org/abs/2504.08942
- Panickssery et al. 2024, https://proceedings.neurips.cc/paper_files/paper/2024/file/7f1f0218e45f5414c79c0679633e47bc-Paper-Conference.pdf
- Chen et al. 2025, https://arxiv.org/abs/2504.03846
- Kim et al. 2025, https://proceedings.mlr.press/v267/kim25e.html
- CodeJudgeBench 2025, https://arxiv.org/abs/2507.10535
- How Coding Agents Fail Their Users 2026, https://arxiv.org/abs/2605.29442
- Unreliable Progress Bar 2026, https://arxiv.org/abs/2609.08589
- ImpossibleBench 2025, https://arxiv.org/abs/2510.20270
- Wang & Pradel 2026, https://arxiv.org/abs/2503.15223
- ECLoop 2026, https://arxiv.org/abs/2607.28815
- Over-mocked tests 2026, https://arxiv.org/abs/2602.00409
- TICK 2024, https://arxiv.org/abs/2410.03608
- Ambig-SWE 2026, https://arxiv.org/abs/2502.13069
- Laban et al. 2025, https://arxiv.org/abs/2505.06120
- VERDI 2026, https://arxiv.org/abs/2605.11334
- Verbalized confidence 2026, https://arxiv.org/abs/2609.10996
- Trust or Escalate 2025, https://arxiv.org/abs/2407.18370
- Explicit Reasoning Judges 2025, https://arxiv.org/abs/2509.13332
- Reflexion 2023, https://arxiv.org/abs/2303.11366

**§2:**
- Complexity Trap 2025, https://arxiv.org/abs/2508.21433, https://github.com/JetBrains-Research/the-complexity-trap
- Masking regime map 2026, https://arxiv.org/abs/2606.00408
- SWE-agent 2024, https://arxiv.org/abs/2405.15793
- Harness Design 2026, https://arxiv.org/abs/2609.20804
- Beyond Token Savings 2026, https://arxiv.org/abs/2609.32961
- Compression cost 2026, https://arxiv.org/abs/2608.16370
- Execution instability 2026, https://arxiv.org/abs/2608.06503
- CoACT 2026, https://arxiv.org/abs/2607.02911
- Paritok-4B 2026, https://arxiv.org/abs/2608.24188
- Gateway cost attribution 2026, https://arxiv.org/abs/2609.22114
- SWE-Pruner 2026, https://arxiv.org/abs/2601.16746
- LLMLingua-2 2024, https://aclanthology.org/2024.findings-acl.57/
- Context Rot 2025, https://www.trychroma.com/research/context-rot
- Lost in the Middle 2024, https://arxiv.org/abs/2307.03172
- GSM-IC 2023, https://arxiv.org/abs/2302.00093

**§3:**
- Olausson et al. 2024, https://arxiv.org/abs/2306.09896
- Self-Debug 2024, https://arxiv.org/abs/2304.05128
- LLM error messages 2024, https://dl.acm.org/doi/10.1145/3689535.3689554
- RustAssistant 2025, https://www.microsoft.com/en-us/research/publication/rustassistant-using-llms-to-fix-compilation-errors-in-rust-code/
- Failure as a Process 2026, https://arxiv.org/abs/2607.09510
- Code agent trajectories 2026, https://arxiv.org/abs/2511.00197
- Feedback That Backfires 2026, https://arxiv.org/abs/2608.23651
- Illusion of Diminishing Returns 2026, https://arxiv.org/abs/2509.09677
- LivePlan 2026, https://arxiv.org/abs/2608.06701
- OpenHands StuckDetector, https://docs.openhands.dev/sdk/guides/agent-stuck-detector
- pi-anti-doom-loop, https://pi.dev/packages/pi-anti-doom-loop
- PROBE 2026, https://arxiv.org/abs/2605.08717
- AgentDebug 2026, https://arxiv.org/abs/2509.25370
- RAP-Gen 2023, https://dl.acm.org/doi/10.1145/3611643.3616256

**§4:**
- Factory 2025, https://factory.ai/news/evaluating-compression
- Claude Code compaction prompt (extracted), https://gist.github.com/tassa-yoniso-manasi-karoto/1e6a1328cb75f4729d5ff4e9ec457134
- Anthropic 2025, https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- OpenHands condenser, https://docs.openhands.dev/sdk/guides/context-condenser
- Slipstream 2026, https://arxiv.org/abs/2605.08580
- ACON 2025, https://arxiv.org/abs/2510.00615
- HiAgent 2025, https://arxiv.org/abs/2408.09559
- ReSum 2025, https://arxiv.org/abs/2509.13313

**§5:**
- ExpeL 2024, https://arxiv.org/abs/2308.10144
- AWM 2025, https://arxiv.org/abs/2409.07429
- Dynamic Cheatsheet 2026, https://aclanthology.org/2026.eacl-long.333/
- ACE 2025, https://arxiv.org/abs/2510.04618
- ReasoningBank 2025, https://arxiv.org/abs/2509.25140
- Xiong et al. 2025, https://arxiv.org/abs/2505.16067
- Budget-constrained web agents 2026, https://arxiv.org/abs/2606.15017
- SWE-Exp 2025, https://arxiv.org/abs/2507.23361
- Memento 2025, https://arxiv.org/abs/2508.16153
- MemQ 2026, https://arxiv.org/abs/2605.08374

**§6:**
- Large Language Monkeys 2024, https://arxiv.org/abs/2407.21787
- Inference Scaling fLaws 2024, https://arxiv.org/abs/2411.17501
- Snell et al. 2025, https://arxiv.org/abs/2408.03314
- 1B vs 405B 2025, https://arxiv.org/abs/2502.06703
- When To Solve, When To Verify 2025, https://arxiv.org/abs/2504.01005
- PlanSearch 2025, https://arxiv.org/abs/2409.03733
- R2E-Gym 2025, https://arxiv.org/abs/2504.07164
- CodeMonkeys 2025, https://arxiv.org/abs/2501.14723

**§7:**
- Miller 2024, https://arxiv.org/abs/2411.00640
- Kapoor et al. 2025, https://arxiv.org/abs/2407.01502
- Identical Runs 2026, https://arxiv.org/abs/2609.33812
- AI21 blog, https://www.ai21.com/blog/scaling-agentic-evaluation-swe-bench/
- AgentLens 2026, https://arxiv.org/abs/2605.12925
- ABC 2025, https://arxiv.org/abs/2507.02825
- SWE-Bench Illusion 2026, https://dl.acm.org/doi/10.1145/3786583.3786882
- SWE-rebench 2025, https://arxiv.org/abs/2505.20411
- Aider Polyglot, https://aider.chat/2024/12/21/polyglot.html
