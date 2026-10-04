# Exocortex

An exocortex for small models. Exocortex makes a weak local LLM behave like a stronger coding agent by making cheap, parallel sidecar calls around it: supervision, context hygiene, error triage, reasoning-only parallel attempts, and learned memory. None of this adds cognitive load to the main model.

It runs as a [pi](https://github.com/badlogic/pi-mono) extension and targets a local Qwen 27B behind any OpenAI-compatible engine (primarily [ninfer](https://github.com/dylanbrodiefafard/ninfer); vLLM, SGLang and llama.cpp also work).

**Status:** Phase 3 (supervisor). Every session is traced to SQLite. The first module, the supervisor, checks whether the agent really finished what you asked and suggests a follow-up when it didn't.

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

From the repo, run the pinned pi with Exocortex loaded:

```sh
npm run pi -- --model <provider>/<model-id>     # e.g. --model ninfer/coding
```

With your own pi install, use `pi -e /path/to/exocortex/packages/pi-adapter`.

To load it permanently, add the adapter path to `extensions` in `~/.pi/agent/settings.json`.

Every session is recorded to `~/.exocortex/exocortex.db`. To configure that, copy [`exocortex.config.example.jsonc`](exocortex.config.example.jsonc) to `~/.exocortex/config.jsonc`. A broken config disables Exocortex rather than breaking pi.

Inside pi:
- `/exo` shows status.
- `/exo ping` makes one sidecar call to check that the sidecar engine is reachable.
- `/exo off` and `/exo on` turn every module off or back on for the session.

### Supervisor

Enable it in `~/.exocortex/config.jsonc` with `"modules": { "supervisor": { "enabled": true } }`, or for one session with `/exo supervisor on`.

When the agent stops, the supervisor:
1. compares what you asked for (a checklist it extracted from your message) with evidence from the workspace: the diff, the commands the agent ran and their exit codes, and any check commands you quoted;
2. if something is missing, puts a follow-up listing it in your editor. Press Enter to send it, or edit it first.

`/exo supervisor auto` lets it send the follow-up itself, at most 3 times per task. Settings are in [`exocortex.config.example.jsonc`](exocortex.config.example.jsonc).

### Debug output

Trace every pi event to stderr:

```sh
EXO_DEBUG=1 pi -e /path/to/exocortex/packages/pi-adapter
```

- In the TUI, send the trace to a file instead: `EXO_DEBUG=1 EXO_DEBUG_FILE=/tmp/exo.log pi -e …`.
- To also log per-token events, set `EXO_DEBUG=verbose`.
- The `--exo-debug=1` flag works too. Write it with `=`, otherwise pi swallows the next argument as the flag's value.

## Eval

```sh
npm run eval -- --model <provider>/<model-id> --repeat 3        # baseline: every module off, all tasks
npm run eval -- --model <provider>/<model-id> --tags hard       # only the hard tier (or --tags smoke)
npm run eval -- --config all-off,supervisor --tags hard --repeat 5   # A/B a module
npm run eval -- --validate                                      # fixture QA: pristine fails, solution passes
```

- Each run copies a fixture from `tasks/` into `eval-runs/<timestamp>/work/` and drives pi over RPC with only Exocortex loaded. It then scores the run with the task's check command and computes metrics from the trace.
- Output goes to `eval-runs/<timestamp>/`: `summary.md`, `results.json`, per-run stderr and check logs, and pi sessions.
- Models and auth come from your `~/.pi/agent`. Pass `--pi-agent-dir` to use another directory.
- The fixtures need `python3`, `go`, `cargo` and `g++`/`make`.

To add a task, create `tasks/<id>/` with:
- `task.json`: id, language, prompt, check command, limits;
- `repo/`: the starting code;
- `solution.patch`: a reference fix;
- optionally `hidden/`: acceptance tests the agent never sees.

Then run `--validate`. See [`docs/EVAL_TASKS.md`](docs/EVAL_TASKS.md) for the tiers and authoring rules.

## Load test

Measures how much the sidecar pool slows the main agent: main requests alone, then the same requests while 20 sidecar calls are kept in flight.

```sh
npm run loadtest -- --base-url http://127.0.0.1:8080/v1 --model qwen3.8-27b --profile ninfer
```

Pass `--max-concurrent` equal to the engine's real slot count (and `--reserved`, at least 1). If the pool thinks it has more slots than the engine, sidecars crowd out the main agent (D-038). Writes `eval-runs/loadtest-<timestamp>/summary.md`. Run `npm run loadtest -- --help` for sizes and concurrency.

## Layout

```
packages/
  core/         harness-agnostic core (never imports pi)
  pi-adapter/   the pi extension entrypoint
  eval/         RPC-driven eval harness, metrics and reports (configs/ holds Exocortex configs to A/B)
  testkit/      test-only fakes (scripted OpenAI-compatible server)
tasks/          eval fixtures
docs/
```

Packages for the sidecar pool, the worker and the modules are added in the phase that needs them (see `docs/DECISIONS.md` D-020 and D-030).

## License

GPL-3.0-or-later
