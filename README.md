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

Exocortex is an extension for the [pi](https://github.com/badlogic/pi-mono) coding agent. It watches a session from the outside and helps in the places where a ~27B local model usually falls down: it checks whether the work is really finished, shows the agent why an edit failed and what each edit broke, cuts noisy build output down to the errors, notices when the agent is going in circles, writes better handovers at compaction, and remembers fixes and your preferences across sessions.

The main model does none of this work. Exocortex gives it no new tools and no extra instructions. The help comes from short side calls ("sidecars") to the same local server, using GPU slots the main agent isn't using.

> [!NOTE]
> **Status: experimental.** All six modules are built and tested, but every one ships **off by default**: the runs that would show how much each one helps have not been done yet, so there are no measured results to quote. You choose which to turn on. See the [roadmap](#roadmap).

## Why

A small local model running a coding agent is already at its limit on the task itself. It fails in a handful of predictable ways, and prompting it harder makes most of them worse because the prompt is more for it to keep track of.

| The problem | What Exocortex does | Module |
|---|---|---|
| The agent says "done" when it isn't, or when the tests it ran prove nothing | Compares your request with evidence from the workspace and drafts a follow-up listing what is missing | [Supervisor](#supervisor) |
| Pi keeps only the end of a long build log, so the first error is lost | Brings back the start from pi's saved copy, with the errors and their context, verbatim | [Trimmer](#trimmer) |
| An edit fails because its text doesn't match the file, and the agent guesses again; or an edit breaks the syntax and nobody notices until the build | Quotes what the file holds where the edit was aimed, numbers the lines of reads, and runs a quick check after each edit to show any error it introduced | [Tools](#tools) |
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

- **Six independent modules:** supervisor, tools, trimmer, triage, compaction and memory, each off until you enable it.
- **Sidecar pool:** a scheduler with priorities, per-call timeouts, token budgets and slots reserved for the main agent.
- **Prompt-cache stats:** how much of each prompt the engine served from its cache, for the main agent and for each module's sidecars (`/exo cache`).
- **Session traces:** every session is recorded to SQLite, with a CLI to inspect events, sidecar calls and what each module did.
- **Engine profiles:** works with any OpenAI-compatible server, with fallbacks for features an engine lacks.
- **Kill switches:** `/exo off` disables everything for the session; `/exo <module> off` disables one module.

### Supervisor

When the agent stops, the supervisor compares what you asked for (your messages, and a checklist kept from them) with evidence from the workspace: the diff, every command the agent ran in the task with its exit code, the agent's replies, and check commands: the ones in your config, and a test or build command your message names in backticks ("make sure `cargo test` passes"). It notes when the agent's last test run came before its last edit, or was piped so that its exit code proves nothing. Files that test runs leave behind (`__pycache__/`, `.pyc`, `node_modules/`, Cargo's `target/`) are left out. How much it reads is sized from the model's context window.

Each message you send updates the checklist: a new task starts a new one, "also add a --verbose flag" adds an item, "drop the CSV export" removes one, and "thanks, that's enough" closes the task, so it is not checked again. If you only chat and nothing changed, the last check stands and is not run again.

If something is missing, it puts a follow-up listing it in your editor. Press Enter to send it, or edit it first; what you add or delete in it updates the checklist too. If the evidence can't show whether something is done, it asks the agent once per task to check it and show the proof (`"verifyUncertain": false` turns that off). `/exo supervisor auto` lets it send follow-ups itself, at most 3 per task (`maxContinuations`); past that it still checks and tells you what it found.

When it can't do its job, it says so: the engine didn't answer, git failed, or two follow-ups in a row changed nothing.

The check runs in the background, so you have the session back as soon as the agent stops. The status line shows it working (`exo: checking the work…`), with no time limit: your test suite takes as long as it takes. Escape or a new message stops it.

**Review.** Once the supervisor finds the task complete, or can't tell, and the task changed files, it also reviews the changes for bugs, the way Cursor's Bugbot and Claude Code's code review do (`"review": false` turns it off):
- Five independent passes read the change, each with the files in a different order. Each changed function is shown whole, along with the other places that use a function whose signature changed.
- A finding counts only if it quotes a line the change added, or a line of a caller the change left behind, and at least two passes report it.
- A separate call then tries to disprove each one. Only findings it can't disprove are kept, at most 3, most severe first.
- What survives goes in your editor, with room for the agent to say a finding is not a bug.

The review's model calls think before they answer; without thinking, Qwen 3.8 missed a plain off-by-one in every pass. A review of a small change takes about a minute. It runs right after the verdict, in the same background job, with no time limit. Escape or sending a new message stops it, since the code it read is about to change.

If the review finishes while you're typing, your draft is left alone. A line above the editor says what was found, and `alt+r` (or `/exo add`) adds the findings below your message. If you send without them, they're dropped. The same applies to any follow-up that arrives while you're typing.

A task is reviewed once, and a bug already reported is not reported again. `/exo review` runs the same review whenever you ask, with the option on or off.

### Tools

Makes pi's own `read`, `edit` and `write` more useful to the model. It adds no tool: it adds to the result that just came back.

- **Failed edits.** When an edit's text isn't in the file, it quotes the closest lines from the file, with their line numbers, and says when only the indentation differs. It also notices when:
  - the change was already made;
  - the text carries line numbers copied from a read;
  - the text matches several places (it lists each one);
  - the file doesn't exist (it suggests paths that do).
- **Reads.** Read output gets line numbers (`cat -n` style). When pi's size limit stops a read before the end of a long file, it lists the functions, types and headings in the rest of it, with their line numbers, once per file. A read the agent limited itself gets no list.
- **Checks after edits.** After an edit or write, it runs a quick check on the file and shows the errors that weren't there at the check's last run. Syntax checks for Python, Go, shell and JavaScript work with nothing to set up. Add your own in `checks`, for example `cargo check` for `*.rs` or `ruff check {file}` for `*.py`. A check that covers the whole project runs in the background once the agent reads a file it covers, never while one of the agent's commands runs, so the first edit has something to compare with; without that, only the errors that name the edited file are shown. Nothing runs before an edit, so edits never wait on a check. The edit's result waits for its check as long as that check usually takes, up to 4 s (`checkHoldMs`). A slower check, like a full `cargo check`, keeps running, and its new errors reach the agent before its next step. A linter whose output has no recognisable error lines (ruff, shellcheck) still counts: its `file:line` lines, or its last lines, are shown.

Everything it shows is quoted from the file or the check's output. When it has nothing exact to say, it says nothing.

### Trimmer

Recovers the start of long build and test output, and shortens logs too long to read. It acts only where that clearly helps:

- **Output pi cut.** Pi keeps only the last 50 KB or 2,000 lines of a command's output. The trimmer reads pi's saved copy instead, so the first errors are not lost: the whole output when it fits in 40,000 characters (`maxChars`), else its first and last lines and every error with the lines under it.
- **Very long logs.** Output longer than 40,000 characters (`minChars`) that pi kept whole is shortened only if it reads as a log: the command failed, or it shows errors, passing tests or compile progress.

What it hides first is what a passing run prints (passing tests, compile progress), then long runs of near-identical lines (their first and last lines stay).

- Everything shown is verbatim. A failure's own lines are never cut short. Markers give the omitted line numbers, and a footer says where the full output is.
- Output you asked to read (`cat`, `grep`, `git diff`, a pipe into `tail`), output that is not a log, and `read`, `edit` and `write` results are left alone.
- Saved outputs are kept, so a resumed session can still read them, and removed after 7 days.

### Triage

Triage says nothing on a first failure. It steps in when the agent is not getting past one:

- **The same errors again.** From the second time a command reports the same errors, a sidecar diagnoses the failure and suggests a different next step. When your engine forks for free (`dylanbrodiefafard/ninfer`), the diagnosis is written from a fork of the agent's own conversation, so it reads everything the agent has seen; otherwise it reads the request, the output, the code the errors point at and the edits made since. The hint never makes the agent wait: it arrives before the agent's next step, even if the agent has already run the command again. It is dropped if the command passes, you speak, or the context is compacted first.
- **At three sightings** the result says the approach isn't working and names the edited files that did not change it. **At six**, it tells the agent to stop and report to you what is blocking it.
- **Not converging.** When a test command fails four runs in a row and none of its failing tests gets fixed (the messages change, the same tests fail), it says so once and asks for a diagnosis.
- A hint that names a file that does not exist, or a name found neither in its evidence nor in the project's files, is dropped.
- Fewer failing tests or a different message counts as progress, not a repeat. A test run that failed behind `| tail` still counts as a failure, and so does one whose exit code the agent echoed (`echo "exit=${PIPESTATUS[0]}"`).
- Once a command passes, its failures are forgotten. A full test run that passes forgets the failures of every test command; a run of some tests only forgets those it names, and a run that ran no test (a filter that matched nothing) forgets nothing. A failure that went away and came back is described as that, with no claim about the edits.
- Counting carries on through your own messages ("try again") and through `/reload`.
- It also notices loops with no error at all: the same call returning the same result, or a short cycle of calls ending the same way, three times running. If the loop reaches six rounds, it tells the agent to stop and report to you.

### Compaction

When pi compacts the conversation, a sidecar writes a structured handover (objective, important details, work state, next move, relevant files) and merges the previous summary into it on later compactions. Below it, the summary lists your requests verbatim, the files changed, which commands last failed (with their first error) and which succeeded.

If the sidecar's summary fails, is cut off, or ignores the format, pi writes its own summary and the requests, files and commands still follow it. You're told the first time this happens in a session, and `/exo status` lists why.

There's no time limit on the summary; the status line shows it growing, and pi's own abort stops it. Once the context is 70% of the way to where pi compacts, the summary is also written in the background whenever the agent stops. When compaction comes, only what happened since is added, so it rarely makes you wait. `"earlySummary": false` turns this off.

### Memory

Memory learns two kinds of things, and neither needs the agent to do anything.

**Fixes.** When a build or test run fails, the agent edits files, and a later run of the same tests passes (the whole suite, or just the tests that failed, however the output was piped), memory has a sidecar model read what happened and save a short lesson about the fix for this repo. The sidecar decides whether the edits explain the pass and whether the fix teaches anything; without a sidecar model nothing is saved. Memory itself refuses a fix when only tests were changed, a test was skipped or lost an assertion, or git put other code in place on the way (a checkout, a stash, a reset, a pull); other commands that changed files, such as a formatter or an install, are shown to the sidecar to weigh. A fix can span your messages to the agent. The next time the same problem appears (the same error naming the same tests or symbols, anywhere in the output), even in a later session, the lesson is added to the failing output as a past fix to check against the current code. Lessons that keep failing to help are retired automatically, and a lesson is replaced when its problem is later fixed through other files. A lesson also says which files were edited without the error going away the first time, so the agent can skip those dead ends. A lesson whose files are all gone (deleted, or not on this branch) is not shown, but it is kept in case they come back. `/exo memory cards` lists this repo's lessons and `/exo memory forget card <id>` removes one.

**Preferences** (`"preferences": true`). It reads only what you type. Say something as a standing rule ("always write the failing test first"), or give the same instruction in two sessions, and it becomes a preference. Before each prompt, a sidecar model picks the preferences that apply to it and that it does not already say, and those are added as a short visible note; your prompt wins on any conflict. If the sidecar cannot answer, nothing is added. It also learns what you expect of one kind of task from your corrections: tell the agent "don't refactor the code around it when you fix a bug" in two sessions, and later bug-fix prompts get "For bug fixes: Do not refactor nearby code."

`/exo memory interview` gets a new install started with eight multiple-choice questions and one open one, about a minute in total. `/exo memory preferences` lists what has been learned, and `/exo memory forget <id>` removes one. When the model reads one of your messages as withdrawing a preference, you are told, and `/exo memory restore <id>` brings it back.

Until Exocortex has a release, a store written by an older version is not converted: it is set aside as `memory.db.other-schema-<time>` next to the new one, you are told, and memory starts empty.

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

Inside pi, run `/exo` to see which modules are on, and `/exo doctor` to check the engine against its profile.

## Usage

Everything is controlled from pi with the `/exo` command. Toggles last for the current session; the config file sets the defaults.

| Command | What it does |
|---|---|
| `/exo` | Show status: config, active modules and sidecar pool statistics |
| `/exo cache` | Show how much of each prompt the engine served from its cache: main agent and sidecars |
| `/exo doctor` | Check the engine against what your profile says it can do: streaming, cached tokens, `ninfer.cache_write`, JSON schemas, forks, embeddings |
| `/exo doctor thinking` | Also check whether a fork can turn thinking off and keep the cache (costs one full prefill of the conversation when it can't) |
| `/exo off` · `/exo on` | Turn every module off, or back on |
| `/exo <module> on\|off` | Toggle one module: `supervisor`, `tools`, `trimmer`, `triage`, `memory`, `compaction` |
| `/exo supervisor suggest\|auto` | Draft the follow-up in your editor, or send it automatically |
| `/exo review` | Review the changes made so far for bugs in the background; the findings go in your editor |
| `/exo add` · `alt+r` | Add a follow-up that arrived while you were typing below your message |
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
| `<repo>/.exocortex/config.jsonc` | Per project: switches modules on or off and tunes them |

A project's file comes with the repository, so it is not yours until you have read it. It can switch Exocortex and its modules on or off and tune them. It cannot say where anything goes, what is run or where files are written: `engine`, `embeddings`, `pool`, `trace`, the supervisor's and the tools module's `checks`, memory's `dbPath` and the trimmer's `saveDir` count only in your own file. If a project's file sets one of them, Exocortex leaves it out, tells you which, and carries on.

When you quit pi, Exocortex waits up to 2 seconds for background work to finish (a lesson memory is still writing). `EXO_SHUTDOWN_DRAIN_MS=<ms>` changes that; `0` turns the wait off.

Set only what you want different from the defaults: a setting you leave out picks up a better default when Exocortex updates. [`exocortex.config.example.jsonc`](exocortex.config.example.jsonc) has the ones you are most likely to set, and each module's settings, with their defaults, are documented in `packages/mod-<module>/src/settings.ts`:

- **`engine`**: where sidecar calls go (`baseUrl`, `model`, `apiKey`) and which `profile` the server matches: `generic`, `vllm`, `sglang`, `llamacpp` or `dylanbrodiefafard/ninfer` (the fork linked above; upstream ninfer is `generic`). Unset fields fall back to pi's main model when it is an OpenAI-compatible provider.
- **`pool`**: `maxConcurrent` must equal the engine's real slot count, and `reservedForMain` is the number of slots sidecars never take. If the pool thinks it has more slots than the engine does, sidecars crowd out the main agent.
- **`modules`**: one block per module. All are off unless enabled here.
- **`embeddings`** (optional): any OpenAI-compatible `/embeddings` server, for example a small model on the CPU. Memory then recognises the same error said in different words. Without it, keyword matching is used.

- **`trace`**: `dbPath` is where sessions are recorded (a relative path is relative to the config file's directory), and `retentionDays` deletes sessions older than that when pi starts. The default, `0`, keeps everything.

Unknown keys, unknown modules, unknown module settings and invalid values disable Exocortex and show a warning in pi, so a typo cannot change behaviour silently. A setting that existed once but was removed is ignored instead, with a notice naming it.

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
            │   └─ modules: supervisor · tools · trimmer · triage ·      │
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

### Prompt cache

`/exo cache` shows how much of each prompt the engine served from its prefix cache, for the main agent's last request, the session so far and each module's sidecar calls. The status line shows the main agent's rate after each turn (`cache 93% · session 90%`). A sudden drop means something changed the start of the conversation and the server had to read it all again. If the engine doesn't report cached tokens, it says so instead of showing 0%.

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
| — | Tools: edit hints, numbered reads, checks after edits | Built, off by default; measurement pending |
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
