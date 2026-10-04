# Working on Exocortex

Read `docs/DECISIONS.md` before you change anything. It overrides `docs/BRIEF.md`. Record every new design choice, and every deviation from the brief, as a new `D-NNN` entry there.

## Commands
- `npm run check`: lint (Biome) + typecheck (tsc, strict) + knip + vitest. It must pass before every commit.
- `npm run format`: apply formatting and safe lint fixes.

## Rules
- **`@exocortex/core` never imports pi** (`@earendil-works/*`); a test enforces this. Pi-specific code lives in `@exocortex/pi-adapter`.
- **Read pi's source before using a pi API.** `docs/PI_API_NOTES.md` has verified signatures. Add to it, with file:line citations, when you verify something new.
- **An Exocortex bug must never break or stall a pi session.**
  - Every hook catches its own errors and has a time budget.
  - No unhandled promises: an uncaught async error exits interactive pi.
- **Prompt-cache stability:**
  - Never mutate earlier messages, the system prompt, or the active tool set.
  - Inject only through persisted `custom_message` entries or `tool_result` rewrites (D-029).
- **Tag synthetic content:**
  - Messages: `customType` starting with `exo.`.
  - Rewrites: merge `details.exo`, never replace `details`.
- **No build step.** Packages export `src/*.ts`, so use only type-strippable TS (no enums or namespaces; `erasableSyntaxOnly`). Import with `.ts` extensions.
- **Tests:** unit tests need no model server. Use `@exocortex/testkit` fakes. Pin pi versions exactly.
- **Sidecar prompts:** keep them in versioned files under `packages/*/prompts/`, not inline strings.
- **Git:**
  - Use Conventional Commits.
  - Use short-lived branches, squash-merged to `main`.
  - Tag each phase once its acceptance check passes (D-022).
