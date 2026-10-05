# Research verification handoff

`docs/RESEARCH.md` was written without access to the papers. The session's network policy blocked arxiv.org, openreview.net, huggingface.co, semanticscholar.org, aclanthology.org and dl.acm.org, so every claim tagged **[S]** (seen only in a secondary summary) or **[U]** (unverified) still needs checking against the source. This file is the work list for an agent that *can* reach those hosts.

**Before starting**, confirm access: `curl -sI https://arxiv.org/abs/2411.00640` should return 200. If it doesn't, the cloud environment's network access must allow these domains: `arxiv.org`, `export.arxiv.org`, `openreview.net`, `huggingface.co`, `api.semanticscholar.org`, `aclanthology.org`, `dl.acm.org`, `proceedings.mlr.press`. See https://code.claude.com/docs/en/cloud-environments#network-access.

## How to work each item

1. Read the paper (abstract, the relevant tables, the method section).
2. In `docs/RESEARCH.md`, change the tag to **[V]**, a new tag meaning "verified against the paper", and add the table or section number. Or correct the number and note what it was.
3. If a correction changes a recommendation, update the D-entry named below and the relevant eval config or setting default, and say so in the PR.
4. Add a **[V]** row to the tag table at the top of RESEARCH.md.

## Priority 1: decisions rest on these

| Claim (RESEARCH.md) | Paper | Decision that depends on it |
|---|---|---|
| Answer logprobs saturate (>0.999) under JSON output and are *anti-calibrated* on Qwen 3.5 4B/9B/27B (AUROC 0.32–0.49). VERDI's structural agreement scores AUROC 0.56–0.70 | VERDI, arXiv 2605.11334 | D-046 `completeVotes`: no logprob calibration, vote instead (R1.5) |
| Masking vs summarization: 54.8% vs 53.8% solve, costs, 13–15% elongation; **the Qwen3-32B row**; whether costs model prompt caching; masking window M=10 | The Complexity Trap (RESEARCH.md §2a) | R2.3 retro-masking (deferred in D-042); D-044's small narrative part |
| Artifact (file) tracking was the weakest dimension for every summarizer (~2.2–2.5/5); anchored iterative summaries scored 3.70 vs 3.44/3.35 | Factory compaction evaluation (§4a) | D-044: file lists come from facts, not the LLM; anchored narrative updates |
| ACE collapse example: 18,282 tokens at 66.7% rewritten to 122 tokens at 57.1%; model was DeepSeek-V3.1 | ACE, arXiv 2510.04618 | D-049 delta-ops-only rule (R5.5) |
| Dynamic Cheatsheet: small models (GPT-4o-mini) gained little or declined | Dynamic Cheatsheet, EACL 2026 | D-049: admission only from verified fixes, never self-judgment |
| Plain Qwen 3.6-27B agent matched memory/workflow/skill modules once budgets were equal | arXiv 2606.15017 (tagged [A]; re-check, it is the single most consequential result for Phase 5) | D-049 narrow scope; AB_PLAN step 4 budget-matched reading |
| Inaccurate self-reporting was 22.58% of misalignment episodes; 91.49% needed user correction | How Coding Agents Fail Their Users, arXiv 2605.29442 | D-046 `warningSignals` (unsupported-claim signal) |
| Retained judge reasoning improves accuracy; pairwise code judging often <60%; order swaps change up to 14% | CodeJudgeBench, arXiv 2507.10535 | `supervisor-think` A/B (R1.6 vs D-008) |

## Priority 2: context and calibration

- **SWE-agent-style observation windows:** last 5 observations kept gave 18.0% vs 15.0% with full history; the guardrail ablations (§2a).
- **Retrieval calls:** 21 → 64 for GPT-5.5 with no completion change (§2a, *Beyond Token Savings* / Liu 2026).
- **Human feedback repair:** 1.58× success (33.3% → 52.6%), and the plateau after about 2 iterations (§3a).
- **Pipeline elongation:** 12–82% more steps, and 72–81% of failures still found the right files (§3a).
- **Exploration result:** 2× success with −35% context (§4a).
- **SWE-Exp:** 42.0% → 73.0% across models, and cross-repo transfer (§5a).
- **Memento:** +4.7–9.6 points out of distribution (§5a).
- **Test-time compute vs parameters:** easy and medium problems vs hardest (§6a). Also the ~43% plateau for a single verifier (§6a).
- **AI21 eval variance:** pass@1 varies 2.2–6.0 points, the SD stays above 1.5 points at T=0, and "36 runs for a 1-point gain". Attribution is uncertain (§7a).
- **Reflexion on MBPP:** a 16.3% false-positive rate for self-generated tests (§1a).

## Priority 3: listed as unverifiable in RESEARCH.md

- **Model identities** in ECLoop, LivePlan and *Beyond Token Savings*.
- **Verbalized confidence:** whether the 2609.10996 "post-2025 flagship" behaviour applies to a 27B local model. This probably can't be settled from the paper. Note it as an A/B question instead.

## Also worth a fresh search (post-June-2026 work)

The survey's cutoff was what search snippets showed on 2026-10-04. Search for newer work on:
- same-model verification;
- observation masking under prompt caching;
- memory for ≤32B coding agents;
- LLM-judge calibration for Qwen-family models.

Add anything material as new entries with **[V]** tags.

## Done (2026-10-05)

All items above were checked against the papers (arxiv, openreview and huggingface reachable). Results are in `docs/RESEARCH.md` as **[V]** tags with table or section numbers.

| Outcome | Count | Items |
|---|---|---|
| Confirmed as written | 14 | VERDI; Factory (artifact trail is 2.19–2.45); ACE collapse and model; Dynamic Cheatsheet small models; 2606.15017 Qwen 3.6-27B; SWE-agent windows and ablations; Liu 2026 retrieval 21.0 → 63.9; Olausson 1.58×; failed-trajectory elongation; HiAgent; Memento; Snell and R2E-Gym ~43%; Reflexion MBPP 16.3%; model identities (ECLoop, LivePlan, Beyond Token Savings) |
| Corrected | 5 | Complexity Trap (Qwen3-32B row: no masking gain, summary cheaper; cost model ignores local caching) → **D-053**; CodeJudgeBench ("retained reasoning" is the judged response's, and <60% is non-thinking judges) → **D-054**; misalignment 91.49% (of visible resolutions, all symptoms); Self-Debug (gain is in the first turn, not ~2); SWE-Exp (42.0% and 73.0% are two backbones, not a gain) |
| Not accessible / unsupported | 1 | AI21 variance figures: the cited blog doesn't contain them; source unknown |
| Can't be settled from the paper | 1 | Verbalized confidence on a 27B (2609.10996 tested proprietary models only) → A/B question |

Also: D-049's paraphrase of Dynamic Cheatsheet ("self-judge poorly") is corrected to "generative competence" in **D-055**, with no change to the rule.

Fresh search (RESEARCH.md §8): EfficientAgent (masking halves a local 30B's prefix-hit rate; supports D-053), VibeMemBench (verified experience helps a little, self-built memory doesn't; supports D-049), JEV-as-a-Judge (no-reasoning judges fall behind on code; supports `supervisor-think`). None challenges a current decision. EfficientAgent challenges the survey's original exec #7 recommendation, which was already deferred.

No setting default or eval config changed. AB_PLAN steps 2–4 carry the reading notes.
