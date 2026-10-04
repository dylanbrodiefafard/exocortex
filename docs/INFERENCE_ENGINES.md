# Inference engine expectations

Exocortex talks to its model through **the standard OpenAI-compatible Chat Completions API**, using only features that mainstream engines (vLLM, SGLang, llama.cpp) already provide. ninfer is the owner's primary engine, but Exocortex doesn't depend on anything ninfer-specific (D-032).

The engine-support columns are from general knowledge of each project as of 2026. Verify them against the version you deploy. "Flag" means the feature exists but is off by default.

## Features Exocortex uses

| # | Feature | What Exocortex does with it | Without it | vLLM | SGLang | llama.cpp | ninfer `e04fad3` |
|---|---|---|---|---|---|---|---|
| F1 | **Automatic prefix caching, shared across concurrent requests** | Fork-prefix sidecars: resend main's exact request (captured from pi) plus a short suffix, and pay only for the suffix | Sidecars use short, isolated prompts only | yes (APC) | yes (RadixAttention) | partial (per-slot; host-RAM prompt cache) | **partial**: single-owner checkpoints, no concurrent sharing |
| F2 | `usage.prompt_tokens_details.cached_tokens` | Measure cache hits per call; eval metric | Eval can't attribute latency | flag | yes | its own `timings` fields | yes |
| F3 | `response_format: json_schema` (grammar-constrained) | Sidecar verdicts, ledgers and extractions return valid JSON | Prompted JSON + validate + one repair retry | yes | yes | yes | **no** (tool-call args only) |
| F4 | `chat_template_kwargs.enable_thinking` affects only the generation suffix | Sidecars turn thinking off while still sharing main's prefix | Sidecars copy main's thinking settings | yes (stock Qwen template) | yes | yes | **no**: effort/thinking changes the system block |
| F5 | Request `priority` | Main beats sidecars in admission and prefill | Exocortex caps in-flight sidecars and prompt sizes itself | flag (`--scheduling-policy priority`) | flag | no | no |
| F6 | `logprobs` / `top_logprobs` | Calibrated confidence on supervisor verdicts (low margin → `uncertain`) | N-way voting, or no confidence | yes | yes | yes | no |
| F7 | `n > 1` sharing one prefill | Cheap verdict voting and parallel diagnoses | N separate requests (cheap anyway if F1 holds) | yes | yes | no | no (`n` must be 1) |
| F8 | Client disconnect cancels the request | Timed-out interactive sidecars stop using GPU | Wasted compute | yes | yes | yes | yes |
| F9 | `/v1/embeddings` (any server) | Memory retrieval, if BM25 recall proves insufficient (D-026) | BM25 + triggers only | yes | yes | yes | no; any separate server works |

At startup the `InferenceClient` reads an **engine profile** from Exocortex config (`generic`, `vllm`, `sglang`, `llamacpp`, `ninfer`): a set of the flags above. Each module checks the flags it needs and takes its fallback when one is false. There are no engine-specific code paths beyond request-field mapping. Eval measures the real effect (e.g. `cached_tokens` for F1) instead of trusting the profile.

## What ninfer would need for parity

Ranked by how much they matter to Exocortex. All of these are features the other engines already have.

1. **F1: concurrent prefix sharing.** This is the biggest gap.
   - **Need:** several in-flight requests reuse one cached prefix without claiming it, transparently, with no API. vLLM and SGLang do this by default.
   - **Why it's hard on ninfer:** Qwen3.x is a hybrid model, so a hit also needs the recurrent/GDN state at the boundary. Copy that state on fork, share full KV pages by refcount and copy the partial tail page.
   - **Test:** 4 concurrent requests = main's 100k-token history + distinct 500-token suffixes. Each reports `cached_tokens ≥ 100k`, and main's next request still hits.
2. **F3: `response_format` `json_schema` / `json_object`**, using the existing XGrammar path, without changing the rendered prompt.
3. **F4: template conformance.** `enable_thinking` and `reasoning_effort` should change only the generation suffix, as in the stock Qwen template, not the system block. Likewise, `tool_choice: none` and named `tool_choice` should constrain decoding, not drop tools from the prompt (vLLM keeps them rendered by default).
4. **F6: `logprobs` / `top_logprobs`.**
5. **F5: request `priority`** (vLLM semantics: integer, lower runs first; default 0). This matters more on ninfer than elsewhere, because one prefill at a time stalls decode.
6. **F7: `n > 1`.** It follows almost for free from F1.

Nothing beyond parity is requested. Earlier drafts asked for retention control, a session `continue_from` API, a capabilities endpoint, request deadlines and decode-time thinking budgets. All of these are dropped:
- pi exposes the exact outgoing request, so Exocortex can rebuild prefixes itself;
- client-side timeouts plus disconnect cover deadlines;
- the engine profile replaces capability discovery.

## Beyond parity: worth considering only with evidence
These aren't requested. They're listed in case eval data later shows a large, specific win:
- **Cache residency hints**, e.g. keep main's prefix hot under memory pressure. Eval would need to show main losing cache to sidecar churn.
- **Speculative forking:** decode N short sidecar continuations from one prefix within a single batch slot. This is only interesting if F1 + F7 prove to be the bottleneck.
