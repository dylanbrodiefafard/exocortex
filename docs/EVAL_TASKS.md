# Writing eval tasks

Eval tasks live in `tasks/<id>/` and are run by `npm run eval`. There are two tiers:

| Tier | Tag | Purpose | Target baseline (all modules off) |
|---|---|---|---|
| Smoke | `smoke` | Fast regression check that the harness and agent work end to end | ~100% |
| Hard | `hard` | Measures whether a module helps. Each task targets a failure mode a module claims to fix | **30–70%** on the owner's model (D-034) |

A hard task that the baseline solves 3/3 or fails 0/3 gives no signal. Rework it or drop it.

## Layout

```
tasks/<id>/
  task.json        spec (below)
  repo/            starting code the agent works in (copied to a temp dir and git-committed)
  hidden/          optional: files copied OVER the workspace after the agent finishes, before the check
  solution.patch   reference fix (`git diff` from repo/ to a solved copy); applied in validation only
```

`task.json`:
```json
{
  "id": "h-go-ratelimiter",
  "language": "go",
  "prompt": "…what a user would actually type…",
  "check": "go test -race ./...",
  "setup": "optional shell command run before the agent starts",
  "maxTurns": 40,
  "timeoutSec": 1200,
  "checkTimeoutSec": 300,
  "tags": ["hard", "spec-compliance"]
}
```

Failure-mode tags, so results can be sliced by what a module targets:
- **`spec-compliance`**: many stated requirements, some untested in the visible tests. Measures "claims done but isn't" (supervisor).
- **`error-recovery`**: misleading or cascading errors (triage, repeated-error rate).
- **`noisy-output`**: large or noisy tool output (trimmer, context growth).
- **`navigation`**: the relevant code must be found in a larger repo (context, memory).
- **`algorithmic`**: benchmark-style exercises with tricky edge cases (calibration).

## Rules

1. **Validate:** `npm run eval -- --validate --tasks <id>` must print ✓. That means the pristine repo plus `hidden/` fails the check, and the solution plus `hidden/` passes it.
2. **Hidden tests:**
   - Put acceptance tests the agent should not see in `hidden/`. They may overwrite a visible test file with a superset.
   - Every hidden requirement must be stated in the prompt or in the code's docs. Hidden tests check what was asked; they don't invent new requirements.
3. **No network:** Python stdlib only, Go stdlib only, Rust with no crates (`cargo test --offline`), C++17 with `g++`/`make` only.
4. **Fast checks:** under ~60 s on a laptop. Prefer `-q` flags.
5. **No hints:** no comments pointing at the bug, no TODOs that give away the fix, no solution in git history (the repo is committed fresh).
6. **Realistic prompts:** write the way a developer would: state the goal and requirements, not the steps.
7. **Deterministic:** no wall-clock, randomness or ordering flakiness. Use injected clocks and fixed seeds. If `setup` generates large inputs, generation must be deterministic.
8. **Hard but fair:** a strong model should solve it in well under `maxTurns`, but it should need several coordinated edits, a non-obvious root cause, or careful handling of many requirements.
