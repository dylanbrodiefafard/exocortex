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
  "tags": ["hard", "spec-compliance"],
  "minTests": 14
}
```

Optional fields for the check guard (rule 3): `"protectTests": false`, `"protect": [...]`, and `"minTests"`, which `--validate --record-tests` writes for you.

Failure-mode tags, so results can be sliced by what a module targets:
- **`spec-compliance`**: many stated requirements, some untested in the visible tests. Measures "claims done but isn't" (supervisor).
- **`error-recovery`**: misleading or cascading errors (triage, repeated-error rate).
- **`noisy-output`**: large or noisy tool output (trimmer, context growth).
- **`navigation`**: the relevant code must be found in a larger repo (context, memory).
- **`algorithmic`**: benchmark-style exercises with tricky edge cases (calibration).

## Rules

1. **Validate:** `npm run eval -- --validate --tasks <id>` must print ✓. That means the pristine repo plus `hidden/` fails the check, and the solution plus `hidden/` passes it, both scored exactly as an agent's run is (rule 3). For a new task, run it once with `--record-tests` to write `minTests`.
2. **Hidden tests:**
   - Put acceptance tests the agent should not see in `hidden/`. They may overwrite a visible test file with a superset.
   - Every hidden requirement must be stated in the prompt or in the code's docs. Hidden tests check what was asked; they don't invent new requirements.
3. **The check guard (D-048, D-079)** runs after the agent stops and before `hidden/` is copied in. It makes the check test the agent's code and nothing else:
   - **Tests are restored.** Every test file of the fixture (`tests/`, `*_test.go`, `test_*.py`, …) is put back, so "don't change the tests" is enforced. If the prompt asks the agent to change existing tests, set `"protectTests": false` and put the expected tests in `hidden/`. `--validate` fails when `solution.patch` edits protected tests.
   - **Build and runner files are restored.** By default `Makefile`, `GNUmakefile`, `makefile`, `CMakeLists.txt`, `Cargo.toml`, `go.mod`, `go.work`, `conftest.py`, `pytest.ini`, `pyproject.toml`, `setup.cfg` and `tox.ini`, in any directory. One the agent adds is set aside. Set `"protect"` to your own list (names, or repo-relative paths) to change this, or `[]` to turn it off.
     - A file `solution.patch` itself changes is never restored, so the guard cannot fail the reference solution.
     - **Write fixtures so a correct solution need not touch these files.** A `Makefile` that lists its sources by name fails any solution that adds a source file. Use `$(wildcard …)`, or leave the `Makefile` out of `protect` and say why.
   - **Tests the agent added are set aside,** so a wrong one cannot fail a correct solution and none can collide with a hidden test. Rust files under `src/` stay (they are modules of the crate), as does anything under `build/`, `target/` and similar.
   - **A check that runs too few tests fails.** `minTests` is the number of tests the reference solution's check runs and passes, counted from the runner's summary (cargo, unittest, pytest, `go test`, CTest, TAP, or a `N tests, 0 failures` line). A check that exits 0 below it is a failure: something stopped the tests from running. `go test` without `-v` prints no test count, so the floor is passing packages there; prefer `-v` when the output is not too large. Lower `minTests` by hand if a correct solution may remove tests that live outside test files, such as a Rust `#[cfg(test)]` module or a doc-test.
4. **No network:** Python stdlib only, Go stdlib only, Rust with no crates (`cargo test --offline`), C++17 with `g++`/`make` only.
5. **Fast checks:** under ~60 s on a laptop. Prefer `-q` flags. A check that times out is run once more; a second timeout fails the run.
6. **No hints:** no comments pointing at the bug, no TODOs that give away the fix, no solution in git history (the repo is committed fresh).
7. **Realistic prompts:** write the way a developer would: state the goal and requirements, not the steps.
8. **Deterministic:** no wall-clock, randomness or ordering flakiness. Use injected clocks and fixed seeds. If `setup` generates large inputs, generation must be deterministic. Results must not depend on the toolchain version either. CI's Python is newer than many dev machines, and Python 3.12 changed float `sum()` to compensated summation, so use `math.fsum` wherever a float sum feeds a stored expected value (`h-py-weather-etl` hit this).
9. **Hard but fair:** a strong model should solve it in well under `maxTurns`, but it should need several coordinated edits, a non-obvious root cause, or careful handling of many requirements.
