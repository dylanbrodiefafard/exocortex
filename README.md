<h1 align="center">Exocortex</h1>

<p align="center">
  <b>An exocortex for small models.</b><br>
  Make a local LLM behave like a stronger coding agent by spending cheap, parallel sidecar calls around it.
</p>

<p align="center">
  <a href="https://github.com/dylanbrodiefafard/exocortex/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/dylanbrodiefafard/exocortex/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: GPL-3.0-or-later" src="https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg"></a>
  <img alt="Node ≥ 22.19" src="https://img.shields.io/badge/node-%E2%89%A5%2022.19-brightgreen.svg">
  <img alt="Status: experimental" src="https://img.shields.io/badge/status-experimental-orange.svg">
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#features">Features</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#roadmap">Roadmap</a> ·
  <a href="#documentation">Docs</a>
</p>

---

Exocortex is an extension for the [pi](https://github.com/badlogic/pi-mono) coding agent. It watches a session from the outside and helps in the places where a ~27B local model usually falls down: it checks whether the work is really finished, cuts noisy build output down to the errors, notices when the agent is going in circles, writes better handovers at compaction, and remembers fixes and your preferences across sessions.

The main model does none of this work. Exocortex gives it no new tools and no extra instructions. The help comes from short side calls ("sidecars") to the same local server, using GPU slots the main agent isn't using.

> [!NOTE]
> **Status: experimental.** All five modules are built and tested, but every one ships **off by default**: the runs that would show how much each one helps have not been done yet, so there are no measured results to quote. You choose which to turn on. See the [roadmap](#roadmap).

## Why

A small local model running a coding agent is already at its limit on the task itself. It fails in a handful of predictable ways, and prompting it harder makes most of them worse because the prompt is more for it to keep track of.

| The problem | What Exocortex does | Module |
|---|---|---|
| The agent says "done" when it isn't, or when the tests it ran prove nothing | Compares your request with evidence from the workspace and drafts a follow-up listing what is missing | [Supervisor](#supervisor) |
| Hundreds of lines of build and test output bury the one error that matters | Shortens the output to the errors and their context, verbatim | [Trimmer](#trimmer) |
| The agent retries the same failing fix, or loops with no error at all | Says the failure is a repeat, names the edits that didn't change it, and adds a short hint | [Triage](#triage) |
| After compaction the agent forgets what it was doing | Writes a structured handover and lists your requests verbatim under it | [Compaction](#compaction) |
| Every session starts from zero: the same bug gets rediscovered, the same preference gets repeated | Saves fixes that worked and how you like work done, and brings them back when they apply | [Memory](#memory) |

### Design goals

- **No extra load on the main model.** It is never asked to save memories, plan, or call an Exocortex tool.
- **Never break the session.** Every hook catches its own errors and has a time budget. A broken config turns Exocortex off, and pi carries on as normal.
- **Keep the prompt cache.** Earlier messages, the system prompt and the tool set are never changed. Help arrives as a new message or as a rewrite of the tool result that just came in.
- **Say nothing rather than something wrong.** Anything put into context has to pass a precision check; a sidecar that times out or answers badly means no help that turn.
- **Local first.** No cloud service is needed. Everything talks to an OpenAI-compatible endpoint you run.
- **You stay in control.** Each module can be turned on or off on its own, in the config or mid-session.

## Features

- **Five independent modules:** supervisor, trimmer, triage, compaction and memory, each off until you enable it.
- **Sidecar pool:** a scheduler with priorities, per-call timeouts, token budgets and slots reserved for the main agent.
- **Session traces:** every session is recorded to SQLite, with a CLI to inspect events, sidecar calls and what each module did.
- **Engine profiles:** works with any OpenAI-compatible server, with fallbacks for features an engine lacks.
- **Kill switches:** `/exo off` disables everything for the session; `/exo <module> off` disables one module.

### Supervisor

When the agent stops, the supervisor compares what you asked for (your message, and a checklist extracted from it) with evidence from the workspace: the diff, the commands the agent ran and their exit codes, and check commands: the ones in your config, and a test or build command your message names in backticks ("make sure `cargo test` passes"). It notes when the agent's last test run came before its last edit, or was piped so that its exit code proves nothing.

If something is missing, it puts a follow-up listing it in your editor. Press Enter to send it, or edit it first. `/exo supervisor auto` lets it send the follow-up itself, at most 3 times per task.

### Trimmer

Shortens long build and test output before the model sees it. It first hides what a passing run prints (passing tests, compile progress). If the rest is still long, it keeps the first and last lines and every error with the lines under it.

- Everything shown is verbatim. Markers give the omitted line numbers, and a footer says where the full output is.
- When pi has cut a very long output to its end, the trimmer works from pi's saved copy, so early errors are not lost.
- Output you asked to read (`cat`, `grep`, `git diff`, a pipe into `tail`) is left alone, and `read`, `edit` and `write` results are never trimmed.
- With `"sidecar": true`, a sidecar picks which lines to keep. It can only select lines, never rewrite them.

### Triage

On a first failure, triage only moves a buried first error to the top. It steps in when a failure reports the same errors again:

- It says so, names the edited files that did not change it, and adds a two-sentence hint from a sidecar that has read the code the errors point at and those edits. A hint that names files or symbols found nowhere in its evidence or the repo is dropped.
- Fewer failing tests or a different message counts as progress, not a repeat. A test run that failed behind `| tail` still counts as a failure.
- Once the command passes, the failure is forgotten: if it breaks again later, that is a first failure. A failure that went away and came back without a pass is described as that, with no claim about the edits.
- Counting carries on through your own messages ("try again") and through `/reload`.
- At three sightings of the same errors, it warns that the approach isn't working.
- It also notices loops with no error at all: the same call returning the same result, or a short cycle of calls ending the same way, three times running.
- If either kind of loop reaches six rounds, it tells the agent to stop and report to you what is blocking it.

### Compaction

When pi compacts the conversation, a sidecar writes a structured handover (objective, important details, work state, next move, relevant files) and merges the previous summary into it on later compactions. Below it, the summary lists your requests verbatim, the files changed, which commands last failed (with their first error) and which succeeded. If the sidecar fails or ignores the format, pi compacts as usual.

### Memory

Memory learns two kinds of things, and neither needs the agent to do anything.

**Fixes.** When a build or test command fails, the agent edits files and the same command then passes, memory saves a short lesson about that fix for this repo. It saves nothing when the edits cannot be the fix: only tests were changed, a test was skipped or lost an assertion, or a shell command changed files on the way (a checkout, an install, a formatter). With a sidecar model, the sidecar must also find that the edits explain the pass. The next time the same problem appears (the same kind of error naming the same tests or symbols), even in a later session, the lesson is added to the failing output as a past fix to check against the current code. Lessons that keep failing to help are retired automatically, and a lesson is replaced when its problem is later fixed through other files. `/exo memory cards` lists this repo's lessons and `/exo memory forget card <id>` removes one.

**Preferences** (`"preferences": true`). It reads only what you type. Say something as a standing rule ("always write the failing test first"), or give the same instruction in two sessions, and it becomes a preference. Later prompts that leave it unsaid get it added as a short visible note; your prompt wins on any conflict. It also learns what you expect of one kind of task from your corrections: tell the agent "don't refactor the code around it when you fix a bug" in two sessions, and later bug-fix prompts get "For bug fixes: Do not refactor nearby code."

`/exo memory interview` gets a new install started with eight multiple-choice questions and one open one, about a minute in total. `/exo memory preferences` lists what has been learned, and `/exo memory forget <id>` removes one. When the model reads one of your messages as withdrawing a preference, you are told, and `/exo memory restore <id>` brings it back.

## Quick start

### Requirements

- **Node ≥ 22.19.** There is no build step; packages run from TypeScript source.
- **[pi](https://github.com/badlogic/pi-mono)**, already set up with a model. The repo also pins its own copy for `npm run pi`.
- **An OpenAI-compatible inference server.** The target is a local Qwen 27B on [ninfer](https://github.com/dylanbrodiefafard/ninfer); vLLM, SGLang and llama.cpp also work. It should serve at least two requests at once, so sidecars have a slot that isn't the main agent's.

### Install

```sh
git clone https://github.com/dylanbrodiefafard/exocortex.git
cd exocortex
npm install
```

### Run

From the repo, start the pinned pi with Exocortex loaded:

```sh
npm run pi -- --model <provider>/<model-id>     # e.g. --model ninfer/coding
```

Or load it into your own pi install:

```sh
pi -e /path/to/exocortex/packages/pi-adapter
```

To load it in every session, add that path to `extensions` in `~/.pi/agent/settings.json`.

### Configure

Out of the box Exocortex only records traces. Copy the example config and turn on the modules you want:

```sh
mkdir -p ~/.exocortex
cp exocortex.config.example.jsonc ~/.exocortex/config.jsonc
```

```jsonc
{
	"pool": { "maxConcurrent": 6, "reservedForMain": 2 }, // maxConcurrent must equal your engine's parallel slots
	"modules": {
		"supervisor": { "enabled": true },
		"trimmer": { "enabled": true }
	}
}
```

### Check it works

Inside pi, run `/exo` to see which modules are on, and `/exo ping` to make one sidecar call and confirm the engine is reachable.

## Usage

Everything is controlled from pi with the `/exo` command. Toggles last for the current session; the config file sets the defaults.

| Command | What it does |
|---|---|
| `/exo` | Show status: config, active modules and sidecar pool statistics |
| `/exo ping` | Make one sidecar call (and one embedding, if configured) to check the servers |
| `/exo off` · `/exo on` | Turn every module off, or back on |
| `/exo <module> on\|off` | Toggle one module: `supervisor`, `trimmer`, `triage`, `memory`, `compaction` |
| `/exo supervisor suggest\|auto` | Draft the follow-up in your editor, or send it automatically |
| `/exo memory preferences` | List learned preferences |
| `/exo memory forget <id>` | Remove a preference |
| `/exo memory restore <id>` | Bring back a removed preference |
| `/exo memory cards` | List the lessons saved for this repo |
| `/exo memory forget card <id>` | Remove a lesson |
| `/exo memory interview` | Answer a few questions to seed your preferences |

## Configuration

Config is JSONC, read from three places:

| Location | Scope |
|---|---|
| `~/.exocortex/config.jsonc` | Your settings, for every project |
| `EXO_CONFIG=<path>` | Replaces that file |
| `<repo>/.exocortex/config.jsonc` | Per project: may set `enabled` and `modules` only |

A project's file comes with the repository, so it can switch modules on or off and tune them, and nothing more. `engine`, `embeddings`, `pool` and `trace` there are ignored and reported: where sidecar calls go, and with which API key, is yours to decide. Look at a cloned repository's `.exocortex/config.jsonc` before you work in it, as you would its scripts: a module's settings can name commands to run (the supervisor's `checks`).

[`exocortex.config.example.jsonc`](exocortex.config.example.jsonc) documents every option. The ones you are most likely to set:

- **`engine`**: where sidecar calls go (`baseUrl`, `model`, `apiKey`) and which `profile` the server matches: `generic`, `vllm`, `sglang`, `llamacpp` or `ninfer`. Unset fields fall back to pi's main model when it is an OpenAI-compatible provider.
- **`pool`**: `maxConcurrent` must equal the engine's real slot count, and `reservedForMain` is the number of slots sidecars never take. If the pool thinks it has more slots than the engine does, sidecars crowd out the main agent.
- **`modules`**: one block per module. All are off unless enabled here.
- **`embeddings`** (optional): any OpenAI-compatible `/embeddings` server, for example a small model on the CPU. Memory then recognises the same error, or the same preference, said in different words. Without it, keyword matching is used.

- **`trace`**: `dbPath` is where sessions are recorded (a relative path is relative to the config file's directory), and `retentionDays` deletes sessions older than that when pi starts. The default, `0`, keeps everything.

Unknown keys, unknown modules, unknown module settings and invalid values disable Exocortex and show a warning in pi, so a typo cannot change behaviour silently.

### Engine support

Exocortex uses only the standard Chat Completions API. An engine profile records which optional features the server has (shared prefix caching, `json_schema` output, request priority and so on), and each module falls back when one is missing. [`docs/INFERENCE_ENGINES.md`](docs/INFERENCE_ENGINES.md) has the feature-by-engine table.

## How it works

```
            ┌──────────────────────── pi process ────────────────────────┐
 user ───▶  │  main agent loop                                           │
            │     │ events (agent start/end, tool calls and results,     │
            │     │         compaction, session lifecycle)               │
            │     ▼                                                      │
            │  @exocortex/pi-adapter   translates pi events, hosts /exo  │
            │     │                                                      │
            │     ▼                                                      │
            │  @exocortex/core                                           │
            │   ├─ trace store (SQLite)                                  │
            │   ├─ sidecar pool (concurrency, priority, budgets)         │
            │   ├─ config, module registry, kill switches                │
            │   └─ modules: supervisor · trimmer · triage ·              │
            │               compaction · memory                          │
            └────────────────────────────────────────────────────────────┘
                         │ OpenAI-compatible HTTP
                         ▼
                  local LLM server (N slots)
```

- **Main agent**: the pi agent loop you are talking to.
- **Sidecar**: a separate, short-lived LLM call made by Exocortex to judge, summarise or extract. The main agent never sees it as a tool.
- **Pool**: the scheduler that owns the concurrency slots and decides which sidecar calls run, always leaving room for the main agent.
- **Trace**: an append-only record of the session: prompts, tool calls, results, injections and verdicts.

Modules react to pi's events. They can do two things to the conversation: add a new message tagged `exo.*`, or rewrite the tool result that has just arrived. Earlier turns are never touched, so the server's prefix cache stays valid.

## Observability

### Traces

Every session is recorded to `~/.exocortex/exocortex.db`.

```sh
npm run trace -- sessions                 # newest sessions (--label, --limit)
npm run trace -- show <id-prefix>         # metrics + event timeline (--kinds tool.result,exo.rewrite)
npm run trace -- calls <id-prefix>        # sidecar calls and per-module totals
npm run trace -- stats --since 7d         # what the modules did across your sessions
```

Add `--json` for machine-readable output, and `--db <path>` to read a store other than the configured one.

### Debug output

```sh
EXO_DEBUG=1 pi -e /path/to/exocortex/packages/pi-adapter                        # trace every pi event to stderr
EXO_DEBUG=1 EXO_DEBUG_FILE=/tmp/exo.log pi -e /path/to/exocortex/packages/pi-adapter   # to a file, for the TUI
```

Set `EXO_DEBUG=verbose` to also log per-token events. The `--exo-debug=1` flag works too; write it with `=`, otherwise pi takes the next argument as the flag's value.

## Roadmap

| Phase | What | State |
|---|---|---|
| 0–2 | Session trace and sidecar pool | Done |
| 3 | Supervisor | Built, off by default; measurement pending |
| 4 | Trimmer, triage, compaction | Built, off by default; measurement pending |
| 5 | Memory (fixes and preferences) | Built, off by default; measurement pending |
| 6 | Reasoning-only parallelism: several sidecars diagnose a hard step in parallel and a judge picks one | Planned |

A module becomes on by default only after measurement shows it helps.

## Documentation

| | |
|---|---|
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Every design decision and the reasoning behind it |
| [`docs/RESEARCH.md`](docs/RESEARCH.md) | Survey of the research behind each module, with verification status per claim |
| [`docs/INFERENCE_ENGINES.md`](docs/INFERENCE_ENGINES.md) | Engine features Exocortex uses, their fallbacks, and which engines have them |

## Acknowledgements

- [pi](https://github.com/badlogic/pi-mono), the coding agent Exocortex extends.
- [opencode](https://github.com/sst/opencode), whose compaction summary format the compaction module follows (see [`packages/mod-compaction/THIRD_PARTY_NOTICES.md`](packages/mod-compaction/THIRD_PARTY_NOTICES.md)).

## License

[GPL-3.0-or-later](LICENSE)
