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

**Embeddings (optional).** Point `embeddings` in the config at any OpenAI-compatible `/embeddings` server, for example a small model on the CPU. Memory then recognises the same error, or the same preference, said in different words. Without it, keyword matching is used. `/exo ping` checks both servers.

Inside pi:
- `/exo` shows status.
- `/exo ping` makes one sidecar call to check that the sidecar engine is reachable.
- `/exo off` and `/exo on` turn every module off or back on for the session.
- `/exo <module> on|off` toggles one module for the session (`supervisor`, `trimmer`, `triage`, `memory`, `compaction`).
- `/exo memory preferences` and `/exo memory forget <id>` list and remove learned preferences.

### Supervisor

Enable it in `~/.exocortex/config.jsonc` with `"modules": { "supervisor": { "enabled": true } }`, or for one session with `/exo supervisor on`.

When the agent stops, the supervisor:
1. compares what you asked for (a checklist it extracted from your message) with evidence from the workspace: the diff, the commands the agent ran and their exit codes, and any check commands you quoted;
2. if something is missing, puts a follow-up listing it in your editor. Press Enter to send it, or edit it first.

`/exo supervisor auto` lets it send the follow-up itself, at most 3 times per task. Settings are in [`exocortex.config.example.jsonc`](exocortex.config.example.jsonc).

### Trimmer, triage and compaction (Phase 4)

Each is off by default. Enable them under `modules` in `~/.exocortex/config.jsonc`, or for one session with `/exo trimmer on`, `/exo triage on` or `/exo compaction on`.

- **Trimmer:** shortens long bash outputs before the model sees them. It keeps the first and last lines and every error with its context, verbatim, and says where the full output is. With `"sidecar": true`, a sidecar picks which lines to keep; it can only select lines, never rewrite them. `read`, `edit` and `write` results are never trimmed.
- **Triage:** on a first failure it only moves a buried first error to the top. When the same failure happens again, it says so and adds a two-sentence hint from a sidecar; a hint that names files or symbols found nowhere in the output or the repo is dropped. At three repeats it warns that the approach isn't working.
- **Compaction:** when pi compacts the conversation, the summary lists your requests verbatim, the files changed, which commands last failed (with their first error) and which succeeded. A sidecar adds only what the agent was doing, what to do next, and the dead ends. If the sidecar fails, pi compacts as usual.

### Memory (Phase 5)

Enable with `"memory": { "enabled": true }` or `/exo memory on`. When a build or test command fails, the agent edits files and the same command then passes, memory saves a short lesson about that fix for this repo. The next time the same error appears, even in a later session, the lesson is added to the failing output. Lessons that keep failing to help are retired automatically. Cards live in `~/.exocortex/memory.db`.

With `"preferences": true` it also learns how you like work done. It reads only what you type. Say something as a standing rule ("always write the failing test first", "from now on keep commits small"), or give the same instruction in two sessions, and it becomes a preference. Later prompts that leave it unsaid get it added as a short visible note; your prompt wins on any conflict. `/exo memory preferences` lists what it has learned and `/exo memory forget <id>` removes one (D-060).

It also learns what you expect of one kind of task, including from your corrections. Tell the agent "don't refactor the code around it when you fix a bug" in two sessions and later bug-fix prompts get "For bug fixes: Do not refactor nearby code." The list shows which preferences came from corrections, and which ones you had to correct the agent on again after they were added (D-064).

Why each works this way, with the research behind it, is in [`docs/DECISIONS.md`](docs/DECISIONS.md) (D-041 to D-049) and [`docs/RESEARCH.md`](docs/RESEARCH.md).

### Inspect traces

```sh
npm run trace -- sessions                 # newest sessions (--label, --limit)
npm run trace -- show <id-prefix>         # metrics + event timeline (--kinds tool.result,exo.rewrite)
npm run trace -- calls <id-prefix>        # sidecar calls and per-module totals
npm run trace -- stats --since 7d         # what the modules did across your sessions
```

Add `--json` for machine-readable output, and `--db <path>` to read a store other than the configured one.

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
npm run eval -- --config all-off,trimmer --tags noisy-output --repeat 5   # configs: packages/eval/configs/
npm run eval -- --validate                                      # fixture QA: pristine fails, solution passes
npm run eval -- --report eval-runs/<stamp> --tags spec-compliance   # re-render a finished run, or one slice of it
```

- Each run copies a fixture from `tasks/` into `eval-runs/<timestamp>/work/` and drives pi over RPC with only Exocortex loaded. It then scores the run with the task's check command and computes metrics from the trace.
- Output goes to `eval-runs/<timestamp>/`: `summary.md`, `results.json`, per-run stderr and check logs, and pi sessions.
- With two or more configs, the summary compares each one with the first, task by task: the mean success difference with a bootstrap 95% CI, a sign test, changes in turns, tokens and wall-clock, and the smallest difference the run count can detect. A dozen tasks × 5 repeats only detects large effects; see `docs/RESEARCH.md` §7.
- The summary also shows how repeated errors went and which triage hint preceded the end of each (D-057), how often trimmed outputs were read back (D-061), compactions, replays after them and context overflows per config (D-059), and, with `--repeat 2` or more, success and total tokens by repeat (D-058).
- Models and auth come from your `~/.pi/agent`. Pass `--pi-agent-dir` to use another directory.
- The fixtures need `python3`, `go`, `cargo` and `g++`/`make`.

To add a task, create `tasks/<id>/` with:
- `task.json`: id, language, prompt, check command, limits;
- `repo/`: the starting code;
- `solution.patch`: a reference fix;
- optionally `hidden/`: acceptance tests the agent never sees.

Then run `--validate`. See [`docs/EVAL_TASKS.md`](docs/EVAL_TASKS.md) for the tiers and authoring rules, and [`docs/AB_PLAN.md`](docs/AB_PLAN.md) for the order to A/B the modules in.

## Load test

Measures how much the sidecar pool slows the main agent: main requests alone, then the same requests while 20 sidecar calls are kept in flight.

```sh
npm run loadtest -- --base-url http://127.0.0.1:8080/v1 --model qwen3.8-27b --profile ninfer
```

Pass `--max-concurrent` equal to the engine's real slot count (and `--reserved`, at least 1). If the pool thinks it has more slots than the engine, sidecars crowd out the main agent (D-038). Writes `eval-runs/loadtest-<timestamp>/summary.md`. Run `npm run loadtest -- --help` for sizes and concurrency.

## Layout

```
packages/
  core/         harness-agnostic core (never imports pi): config, trace, inference, sidecar pool, module API
  pi-adapter/   the pi extension entrypoint: event wiring, module host, /exo
  mod-*/        modules: supervisor, trimmer, triage, memory, compaction (prompts/ holds their versioned prompts)
  eval/         RPC-driven eval harness, metrics and reports (configs/ holds Exocortex configs to A/B)
  testkit/      test-only fakes (scripted OpenAI-compatible server, module context)
tasks/          eval fixtures
docs/
```

Packages for the memory worker and later modules are added in the phase that needs them (see `docs/DECISIONS.md` D-020 and D-030).

## License

GPL-3.0-or-later
