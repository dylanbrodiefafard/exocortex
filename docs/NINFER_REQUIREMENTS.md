# What ninfer needs to provide for Exocortex

Audience: the ninfer fork's owner. This is a requirements spec, not an implementation plan. You know the engine; the hints are only hints.

Baseline: `dylanbrodiefafard/ninfer` @ `e04fad3`, as surveyed in `docs/DECISIONS.md` D-023.
Target deployment: `qwen3.8-27b/nvfp4` (later Qwen 4 27B), 6 decode slots, ~700k-token KV pool, 260k max context, MTP on.

## The workload

Exocortex wraps a coding agent (pi). Each user session produces two kinds of traffic against one ninfer process:

- **Main:** one long-lived conversation that grows by appending: user turn → assistant tool call → tool result → assistant → … It gets to 50k–200k tokens. Its decode latency is what the user feels.
- **Sidecars:** many short requests (judge, summarize, extract, diagnose).
  - Most want to see main's **entire current context** and add a short instruction: suffix ~200–1,500 tokens, output ~50–800 tokens.
  - Several may run **at the same time from the same main frontier**, e.g. 3–5 parallel diagnoses or verdict votes.
  - They are throwaway: nobody continues from a sidecar's end state.

Today each sidecar either re-prefills main's whole context cold (100k+ tokens, which stalls main's decode under prefill-first) or claims main's single retained bundle. The requirements below remove both problems.

All new request fields go in the existing `ninfer` body object. Each field should also be accepted as an `X-Ninfer-*` HTTP header, because pi may only let us set headers on main's requests. Phase 0 will confirm which.

---

## P0 — the core design depends on these

### R1. Fork-on-reuse of retained prefixes (copy-on-write)
**Need:** any number of concurrent requests can reuse the same retained prefix (main's end frontier or a checkpoint) **without consuming it**. The original bundle stays retained and reusable by main's next request.

- **Semantics:** when a request matches a retained bundle, it forks from it. Full KV pages are shared by refcount, the partial tail page is copied, and the recurrent/GDN + conv state at the boundary is copied (it's fixed size per layer). The source bundle's ownership and LRU position are unaffected, apart from a "recently used" touch.
- Forked pages are freed when the last reference drops. A fork never makes the parent's pages writable.
- **Acceptance:**
  1. Main at 100k tokens finishes a turn.
  2. Fire 4 concurrent requests = main's exact history + a distinct 500-token suffix each. Every one reports `cached_tokens ≥ 100k` and prefills ≤ ~600 tokens.
  3. Main's next request (history + its own new suffix) also reports `cached_tokens ≥ 100k`.
  4. KV pool use during step 2 grows by about 4 × (suffix + output), not 4 × 100k.

### R2. Priority classes that protect main's decode
**Need:** `ninfer.priority: "main" | "interactive" | "background"` (default `main`, so unaware clients are unaffected).

- **Admission:** order by class, then FIFO. A higher class can't be blocked behind a lower class waiting for KV.
- **Prefill vs. decode:** while any `main`-class request is decoding, lower-class prefill is chunked and interleaved so that main's inter-token gap grows by at most a bounded amount. Target: **p95 main inter-token latency ≤ 1.25× its solo baseline** with 5 concurrent `interactive` sidecars doing 1.5k-token suffix prefills on forked prefixes (R1).
- **Preemption (P1):** under KV pressure, `background` requests may be paused (state retained or recomputed) to admit `main`/`interactive` requests.
- **Acceptance:** that p95 target holds, and an `interactive` request submitted behind 3 queued `background` requests is admitted first.

### R3. Retention control
**Need:** `ninfer.retain: "none" | "normal" | "session"`.

- `none`: don't keep this request's end state (sidecars). This stops throwaway sidecars from evicting useful bundles.
- `normal`: today's behaviour.
- `session` + `ninfer.session_id: "<string>"`: keep this request's end frontier as the session's latest frontier, with eviction priority above `normal`. Only the latest frontier (plus the existing checkpoint ladder) per session is protected; the previous frontier is released once the new one exists. Cap with a server flag, e.g. `--max-pinned-sessions 2`.
- **Acceptance:** main tagged `session` survives eviction while 50 `retain:none` sidecars run with 2k-token suffixes. Its next request hits cache.

### R4. Structured output that doesn't touch the prompt
**Need:** `response_format: {type:"json_schema", json_schema:{name, schema, strict:true}}`, enforced by XGrammar at sampling time.

- It **must not change the rendered prompt in any way**, or it breaks R1 reuse. In particular, tools or the system block must not be re-rendered.
- **With thinking on:** the grammar applies to content after the reasoning block closes. With thinking off: from the first token.
- Supported JSON-Schema subset: object/array/string/number/integer/boolean/enum/required/maxItems/maxLength. Document anything unsupported, and reject it with a 400 rather than silently ignoring it.
- **Acceptance:** 1,000 sidecar calls with a verdict schema produce 100% schema-valid JSON, and `cached_tokens` is identical with and without `response_format`.

---

## P1 — large quality or robustness wins

### R5. Append-only continuation from a session frontier
**Need:** `ninfer.continue_from: {session_id, seq?}` plus `messages` containing **only the new messages to append**.

- The server renders those messages as a pure suffix after the session's frozen frontier, closing the assistant turn as the template requires. It **never re-renders earlier content**: no thinking stripping and no system-block changes.
- The request forks per R1. `seq` (returned in main's responses as `ninfer.session_seq`) pins a specific frontier so a sidecar doesn't race main's next turn. Omitted means "latest".
- **Why:** the client no longer has to reproduce main's request byte for byte (system prompt, tools, template kwargs, thinking-strip rules). That's the most fragile part of fork-prefix sidecars, and pi may not expose the exact request.
- **Acceptance:** a sidecar sending only `[{role:"system", content:"…"}]` with `continue_from` gets `cached_tokens` = main's frontier length, and its output reflects main's full context.

### R6. Decode-time thinking control
**Need:** `ninfer.thinking_budget_tokens: N`. `0` means close the reasoning block immediately; `N` means force-close after N reasoning tokens.

- It's applied at **decode time only**, unlike `enable_thinking`/`reasoning_effort`, which change the system block today and so break prefix sharing with main.
- **Acceptance:** a sidecar with `thinking_budget_tokens: 0` on a forked main prefix gets full `cached_tokens` and emits no reasoning tokens.

### R7. Capability discovery
**Need:** `GET /v1/ninfer/capabilities` → `{version, features: {fork_reuse, priority, retain, json_schema, continue_from, thinking_budget, logprobs, n, deadline, embeddings}, limits: {max_concurrency, max_context, kv_capacity_tokens}}`.

Exocortex reads this at startup and turns each fallback path on or off accordingly.

### R8. Telemetry additions
Already good: `cached_tokens`, `reuse_source`, `prefix_reuse_path`, `ttft_ms`, prefill/decode blocks.

Add per response:
- `queue_wait_ms`
- `priority` (echoed)
- `fork: {source: "session"|"checkpoint"|"frontier", session_id?, seq?, shared_pages}`
- `retained: bool`

Add a status endpoint, `GET /v1/ninfer/status`: active and queued counts per class, KV pool used/free, and retained bundles (session id, length, last use). This is for `/exo` status and debugging.

---

## P2 — nice to have

- **R9. `logprobs` / `top_logprobs`** on content tokens. The supervisor reads P(`"complete"`) as a calibrated confidence and routes low-margin verdicts to `uncertain`. That's cheaper than N-way voting.
- **R10. `n > 1`** sharing one prefill, i.e. R1 within a single request. Used for verdict voting and parallel diagnoses (D-015).
- **R11. `ninfer.deadline_ms`:** drop the request (with HTTP 504) if it isn't finished by then, including while queued. Interactive sidecars become useless after ~2–5 s.
- **R12. Named `tool_choice` as a decode-time constraint** that doesn't remove other tools from the rendered prompt. This matters only if R4 is unavailable.

## P3

- **R13. `/v1/embeddings`** with a small embedding model, if VRAM allows. Exocortex starts with BM25 + triggers regardless (D-026), so this is lowest priority.

---

## Suggested order

1. **R1 → R3 → R2.** Fork-on-reuse is the foundation. Retention keeps sidecars from wrecking the pool. Priority keeps main fast.
2. **R4.** Small, and reuses the existing XGrammar path.
3. **R7 + R8.** Cheap, and they let Exocortex measure everything above.
4. **R5, R6.** Remove client-side fragility.
5. P2 as time allows.

Exocortex Phases 0–1 (scaffold, trace store, eval) need none of this. Phase 2 (sidecar pool) is where R1–R4 and R7 start to matter, and the pool's load test doubles as the acceptance test for R1–R3.
