# Exocortex

An exocortex for small models. Exocortex makes a weak local LLM behave like a stronger coding agent by making cheap, parallel sidecar calls around it: supervision, context hygiene, error triage, reasoning-only parallel attempts, and learned memory. None of this adds cognitive load to the main model.

It runs as a [pi](https://github.com/badlogic/pi-mono) extension and targets a local Qwen 27B behind any OpenAI-compatible engine (primarily [ninfer](https://github.com/dylanbrodiefafard/ninfer); vLLM, SGLang and llama.cpp also work).

**Status:** Phase 0 (scaffold and verify). Today the extension only traces pi events.

## Docs

| | |
|---|---|
| [`docs/BRIEF.md`](docs/BRIEF.md) | Original project brief |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Every design decision; it overrides the brief where they differ |
| [`docs/PI_API_NOTES.md`](docs/PI_API_NOTES.md) | Pi's extension API as verified from source |
| [`docs/INFERENCE_ENGINES.md`](docs/INFERENCE_ENGINES.md) | Inference-engine features Exocortex uses, with fallbacks and engine support |

## Develop

Requires Node ≥ 22.19.

```sh
npm install
npm run check      # lint + typecheck + knip + tests: exactly what CI runs
npm run format     # auto-fix formatting and safe lint fixes
npm run test:watch
```

## Try it in pi

Trace every pi event to stderr:

```sh
EXO_DEBUG=1 pi -e /path/to/exocortex/packages/pi-adapter
```

- In the TUI, send the trace to a file instead: `EXO_DEBUG=1 EXO_DEBUG_FILE=/tmp/exo.log pi -e …`.
- To also log per-token events, set `EXO_DEBUG=verbose`.
- The `--exo-debug=1` flag works too. Write it with `=`, otherwise pi swallows the next argument as the flag's value.

To load it permanently, add the adapter path to `extensions` in `~/.pi/agent/settings.json`.

## Layout

```
packages/
  core/         harness-agnostic core (never imports pi)
  pi-adapter/   the pi extension entrypoint
  testkit/      test-only fakes (scripted OpenAI-compatible server)
docs/
```

Packages for the worker, the eval harness and the modules are added in the phase that needs them (see `docs/DECISIONS.md` D-020 and D-030).

## License

GPL-3.0-or-later
