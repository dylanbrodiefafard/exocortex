# Pi extension API notes for Exocortex

- **Pi package:** `@earendil-works/pi-coding-agent` v1.0.2 (`packages/coding-agent/package.json:3`). It was formerly `@mariozechner/pi-coding-agent`; the old names are still aliased (see §1).
- **Node:** `>=22.19.0` (`packages/coding-agent/package.json:105-106`).
- **Source:** `/home/user/ref/pi-mono` at HEAD `2003871` (`200387122ca4…`, committed 2026-10-04 02:41 +0200).
- **Written:** 2026-10-04.
- **Citations:** all paths are relative to `pi-mono/`. `ce/` means `packages/coding-agent/`, `ag/` means `packages/agent/` and `ai/` means `packages/ai/`. Line numbers refer to HEAD 2003871.
- Anything not confirmed in source is marked **UNVERIFIED**.

The BRIEF still names `@mariozechner/pi-coding-agent` and `badlogic/pi-mono`. The real package is `@earendil-works/*`. Import from `@earendil-works/pi-coding-agent`; the `@mariozechner/*` specifiers keep working through aliases.

---

## 1. Extension packaging and loading

### Discovery
`discoverAndLoadExtensions` is at `ce/src/core/extensions/loader.ts:828-876`. It searches these locations in order and de-duplicates by resolved path:
1. `<cwd>/.pi/extensions/` (`loader.ts:849-851`). These are project extensions and load only after project trust is granted (`ce/docs/configuration.md:3`, `ce/docs/extensions.md:50`).
2. `<agentDir>/extensions/`, by default `~/.pi/agent/extensions/` (`loader.ts:853-855`). `PI_CODING_AGENT_DIR` overrides the agent dir (`ce/docs/environment-variables.md:81`).
3. Configured paths: the `extensions` array in `settings.json` (`ce/docs/settings.md:152`), `packages` entries (`ce/docs/packages.md`), and the CLI flag `-e/--extension <path>`, which is repeatable (`ce/docs/cli.md:184-187`).

Rules within a directory (`loader.ts:782-823`):
- Direct `*.ts` and `*.js` files are loaded.
- In a subdirectory, a `package.json` with `"pi": {"extensions": [...]}` wins; otherwise `index.ts` or `index.js` is used (`loader.ts:749-780`).
- Discovery goes one level deep only.

Built-in extensions are `builtin:mcp`, `builtin:llama.cpp`, `builtin:codemode` and `builtin:tool-search`. They load by default, and `-builtin:<name>` in settings disables one (`ce/docs/settings.md:160`).

### Entrypoint shape
The module's default export is a factory:
```ts
// ce/src/core/extensions/types.ts:2004
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
```
- The loader calls `jiti.import(path, { default: true })` and rejects a non-function export with "does not export a valid factory function" (`loader.ts:581-585`, `:648-650`).
- An async factory is awaited before startup continues (`ce/docs/extensions.md:56`).
- Do **not** start timers, sockets or processes in the factory. Start them in `session_start` and close them in an idempotent `session_shutdown` (`extensions.md:58-60`).
- A factory that throws records a load error for that extension only; other extensions still load (`loader.ts:634-659`, `:695-703`).

### TypeScript and dependencies via jiti
- **`.ts` files load directly** with jiti, with no build step (`extensions.md:38`, `loader.ts:576-581`). The module cache is off (`moduleCache: false`), so `/reload` re-imports.
- **Host packages** are mapped to pi's own copies:
  - On the npm/Node build: jiti `alias` (`loader.ts:69-124`).
  - In compiled Bun/SEA binaries: `virtualModules` (`virtual-modules.ts:43-67`, `loader.ts:571-575`).
  - Mapped packages: `@earendil-works/pi-coding-agent`, `pi-agent-core`, `pi-tui`, `pi-ai` (which resolves to the **compat** entry), `pi-ai/oauth`, `pi-ai/providers/all`, `typebox` (also aliased as `@sinclair/typebox`), and all of these under `@mariozechner/*`.
  - Declare these as `peerDependencies: "*"`, never as `dependencies` (`ce/docs/packages.md:125-139`).
- **Your own npm dependencies** go in a nearby `package.json` and resolve from the extension's own `node_modules` (`extensions.md:48`; example `ce/examples/extensions/with-deps/package.json`, which declares `"pi": {"extensions": ["./index.ts"]}` and `dependencies: {ms}`).
  - Pi installs dependencies for npm and git package sources.
  - It does **not** install them for local paths; you run `npm install` yourself (`packages.md:135`).
- **Workspace packages** (`@exocortex/core` imported from `@exocortex/pi-adapter`): resolution is ordinary Node resolution from the extension file, so a workspace symlink in `node_modules` works.
  - **VERIFIED 2026-10-04 (Phase 0):** jiti does load `.ts` workspace packages through `node_modules` symlinks whose `exports` point at `.ts` (`@exocortex/pi-adapter` → `@exocortex/core`). No build step is needed. See `packages/pi-adapter/test/pi-cli.integration.test.ts`.
  - Safest approach: build `core` to JS, or test the import early.
- **Native modules / SQLite:** in compiled Bun binaries the extension runs under Bun, so a native addon such as `better-sqlite3` may not load. `node:sqlite` is available on Node ≥22.13 (pi requires 22.19). **UNVERIFIED** for Bun-binary installs; prefer the npm install of pi.

### Importing types
```ts
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { isBashToolResult, convertToLlm, serializeConversation, CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
```
These are exported at `ce/src/index.ts:7,49,96,204,219`.
- **Verified in Phase 4:** runtime (value) imports work from an extension loaded by path. In Node mode, jiti aliases `@earendil-works/pi-coding-agent` to pi's own entry (`dist/core/extensions/loader.js:37-63`, `getAliases`), so the extension shares pi's module instance. The module host calls `convertToLlm` (`dist/core/messages.d.ts:76`) and `serializeConversation` (`dist/core/compaction/utils.d.ts:37`; it labels `[User]`, `[Assistant]`, `[Assistant thinking]`, `[Assistant tool calls]`, `[Tool result]` and truncates each tool result, `utils.js:101-141`). This is the same serialization pi's default compaction uses (`compaction.js:520-521,728-729`).
- `CompactionPreparation.fileOps` is `{read, written, edited}` of `Set<string>` (`dist/core/compaction/utils.d.ts:6-10`); `turnPrefixMessages` holds the split turn's start when `isSplitTurn` (`compaction.d.ts:118-134`).

### CLI flags registered by an extension
```ts
// types.ts:1650-1667
registerFlag(name: string, options:
  | { description?: string; type: "boolean"; default?: boolean }
  | { description?: string; type: "string";  default?: string }): void;
getFlag(name: string): boolean | string | undefined;   // only for flags this extension registered (loader.ts:374-378)
```
- Parsing: unknown `--long` options are collected (`ce/src/cli/args.ts:240-253`). After extensions load, they are matched against registered flags (`ce/src/core/agent-session-services.ts:90-128`).
- Anything still unmatched is an error. Unknown **short** options are always rejected (`args.ts:254-255`).
- **Gotcha:** the parser does not know the flag's type yet, so `--exo-debug somePrompt` **swallows the next positional as the flag's value** (`args.ts:246-249`). The boolean is still set to `true` (`agent-session-services.ts:105-108`), but the prompt is lost.
  - Use `--exo-debug=1`, put the flag after the prompt, or put it before `--`.
- **Env vars:** extensions read `process.env` directly. Pi exports `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_MODEL` and related variables **only into the bash tool's children** (`environment-variables.md:20-49`), not into the pi process itself.

---

## 2. Events

### Dispatch semantics (applies to every event)
- **Order:** handlers run sequentially in extension load order, then registration order (`runner.ts:269-271`, `:1093-1115`). `pi.on()` returns an unsubscribe function (`loader.ts:272-289`).
- **Awaited:** every handler is `await`ed. The agent loop `await`s every listener for every event (`ag/src/agent.ts:609-611`, `agent-loop.ts` uses `await emit(...)` throughout), and `AgentSession._handleAgentEvent` awaits the extension runner before persisting (`ce/src/core/agent-session.ts:1110-1112`).
  - **A slow handler blocks the main loop.** This includes `message_update` and `provider_stream_event` per token (`extensions.md:111`).
- **No timeouts** exist anywhere in `ExtensionRunner`. Exocortex must enforce its own.
- **Not one at a time:** `tool_result` handlers for the calls of one parallel tool batch overlap (§15).
- **Error isolation:** each handler is wrapped in try/catch, and errors go to `emitError` → `onError`. The mode then reports them:
  - TUI: shows the error (`interactive-mode.ts:2022-2023`).
  - Print/json: `console.error` (`print-mode.ts:101-103`).
  - RPC: `{"type":"extension_error",...}` on stdout (`rpc-mode.ts:348-349`).
- **Exceptions to isolation:**
  - **`tool_call`:** `emitToolCall` has no try/catch (`runner.ts:1242-1260`). A throw propagates to `prepareToolCall`, which turns it into an error tool result, so the **tool is blocked** (`ag/src/agent-loop.ts:726-775`; `agent-session.ts:638-652`; `extensions.md:260`).
  - **`user_bash`:** a throw is rethrown and blocks the command (`runner.ts:1276-1285`).
- **Uncaught async errors** are not caught (timers, un-awaited promises). Interactive mode installs an `uncaughtException` handler that **exits pi** (`interactive-mode.ts:4298`, `:4351-4353`). Wrap all background sidecar work.

### Full event list: payload and allowed returns
The `ExtensionAPI.on` overloads are at `types.ts:1556-1623`. Payload types are at `types.ts:677-1146`, results at `types.ts:1402-1488`.

| Event | Payload (key fields) | Handler may return |
|---|---|---|
| `project_trust` | `{cwd}` | `{trusted: "yes"\|"no"\|"undecided", remember?}`. Only personal and `-e` extensions can handle it. |
| `resources_discover` | `{cwd, reason: "startup"\|"reload"}` | `{skillPaths?, promptPaths?, themePaths?}` |
| `session_start` | `{reason: "startup"\|"reload"\|"new"\|"resume"\|"fork", previousSessionFile?}` (`:732-738`) | — |
| `session_info_changed` | `{name}` | — |
| `session_before_switch` | `{reason: "new"\|"resume", targetSessionFile?}` | `{cancel?}` |
| `session_before_fork` | `{entryId, position: "before"\|"at"}` | `{cancel?, skipConversationRestore?}` |
| `session_before_compact` | see §9 | `{cancel?, compaction?: CompactionResult}` |
| `session_compact` | `{compactionEntry, fromExtension, reason, willRetry}` | — |
| `session_compact_failed` | `{reason, errorMessage?, aborted, willRetry, fromExtension}` | — |
| `session_shutdown` | `{reason: "quit"\|"reload"\|"new"\|"resume"\|"fork", targetSessionFile?}` | — |
| `session_before_tree` | `{preparation: TreePreparation, signal}` | `{cancel?, summary?, customInstructions?, replaceInstructions?, label?}` |
| `session_tree` | `{newLeafId, oldLeafId, summaryEntry?, fromExtension?}` | — |
| `mcp_servers_change` | `{servers}` | — |
| `input` | `{text, images?, source: "interactive"\|"rpc"\|"extension", streamingBehavior?}` (`:1130-1140`) | `{action: "continue"}` \| `{action: "transform", text, images?}` \| `{action: "handled"}` |
| `before_agent_start` | `{prompt, images?, readonly systemPrompt, systemPromptOptions}` (mutable, `:910-920`) | `{message?: {customType, content, display, details}, systemPrompt?}` (`:1455-1459`) |
| `agent_start` | `{}` | — |
| `turn_start` | `{turnIndex, timestamp}` | — |
| `context` | `{messages: AgentMessage[]}` (no system messages, `:862-865`) | `{messages?}`, or mutate in place |
| `context_with_system` | `{messages}` including the system message at index 0 | `{messages?}` |
| `before_provider_headers` | `{headers}` | mutate in place; `null` deletes a header; the return value is ignored (`:888-891`) |
| `before_provider_request` | `{payload: unknown}` (`:878-881`) | any non-undefined value **replaces the payload** (`runner.ts:1361-1390`) |
| `after_provider_response` | `{status, headers}` | — |
| `provider_stream_event` | `{provider, api, model, data}` (read-only) | — |
| `message_start` / `message_update` | `{message}` / `{message, assistantMessageEvent}` | — |
| `message_end` | `{message}` | `{message?}`: replaces the finalized message; the role must stay the same (`runner.ts:1144-1181`) |
| `tool_execution_start/update/end` | `{toolCallId, toolName, args, partialResult\|result, isError, parentToolCallId?}` | — |
| `tool_call` | `{toolName, toolCallId, input (mutable), parentToolCallId?}` | `{block?, reason?, terminate?}` (`:1413-1422`) |
| `tool_result` | `{toolName, toolCallId, input, content, details, structuredContent?, isError, usage?}` | `{content?, details?, structuredContent?, isError?, usage?}` (`:1442-1448`) |
| `turn_end` | `{turnIndex, message, toolResults, messageEntryId, toolResultEntryIds, entries, continue, context, outcome}` (`:1026-1033`) | `{entries?: SessionBoundaryDraft[], continue?}` (`:985-988`) |
| `agent_end` | `{messages}` | — |
| `agent_before_settle` | `BoundaryState` (`:991-993`) | `{entries?, continue?}` |
| `agent_settled` | `{}` | — |
| `model_select` | `{model, previousModel, source: "set"\|"cycle"\|"restore"}` (`:1093-1098`) | — |
| `thinking_level_select` | `{level, previousLevel}` | — |
| `user_bash` | `{command, excludeFromContext, cwd}` | `{operations}` \| `{result}` |
| `ui_prompt_start/end` | `{kind, title?}` | — |
| `cache_warming_decision` | see `cache-warmer.ts` | `{action: "warm"\|"stop"}` |

`session_switch` and `session_fork` events **do not exist** in this version. Use `session_before_switch`/`session_before_fork` followed by `session_shutdown`, then `session_start` with `reason: "new"|"resume"|"fork"`.

### Exact signatures Exocortex will use
```ts
// types.ts:1546
export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;
// types.ts:935-988 — boundary drafts for turn_end / agent_before_settle
export interface CustomEntryDraft { type: "custom"; customType: string; data?: unknown }
export interface CustomMessageEntryDraft { type: "custom_message"; customType: string;
  content: string | (TextContent | ImageContent)[]; display: boolean; details?: unknown }
export interface ContextEditEntryDraft { type: "context_edit"; targetId: string; replacement: ContextEditEntry["replacement"] }
export interface CompactionEntryDraft { type: "compaction"; summary: string; firstKeptEntryId: string | null; details?: unknown; usage?: Usage }
export interface BoundaryResult { entries?: SessionBoundaryDraft[]; continue?: boolean }
```

### Event order: one prompt, one tool call (interactive, idle start)
1. `input` (`agent-session.ts:1946`). Extension `/commands` are dispatched before this and skip everything below (`:1928-1936`).
2. `before_agent_start` (`:2015`).
3. `agent_start` and `turn_start` (`ag/src/agent-loop.ts:146-147` via `agent-session.ts:1255-1270`).
4. `message_start`/`message_end` in this order (`agent-loop.ts:211-216`):
   - an optional system-prompt delta message;
   - the user message;
   - pending `nextTurn` custom messages;
   - `before_agent_start` custom messages (`agent-session.ts:2032-2061`).
   
   Each one is persisted right after its `message_end` handlers return (`agent-session.ts:1114-1131`).
5. Request preparation (`agent-session.ts:759-816`) rebuilds the context from the session projection. Then `context` and `context_with_system` run (`ag/src/agent-loop.ts:388-395`, `sdk.ts:412-416`).
6. `before_provider_headers` (`ce/src/core/model-runtime.ts:673`), then `before_provider_request` (`ai/src/api/openai-completions.ts:366`), then `after_provider_response` (`:383`).
7. `message_start` (assistant), then `provider_stream_event`/`message_update`, then `message_end` (assistant; replaceable, then persisted).
8. The tool batch:
   1. `tool_execution_start`.
   2. **`tool_call`**, which fires after `tool_execution_start` (`agent-loop.ts:541-548`, `:707-775`).
   3. The tool executes.
   4. **`tool_result`** (`agent-loop.ts:853-904`).
   5. `tool_execution_end`, which carries the *rewritten* result.
   6. `message_start`/`message_end` for the toolResult, then it is persisted (`agent-loop.ts:910-940`).
   
   In parallel mode, every `tool_execution_start`/`tool_call` runs first in the preparation loop, then executions run concurrently, then result messages are emitted in order (`agent-loop.ts:586-660`).
9. `turn_end` (dispatched from `finishTurn` as a boundary, `agent-session.ts:818-857`, `:859-869`).
10. `turn_start` for turn 2, then `context`, the provider events, and the assistant final `message_end`.
11. `turn_end`, then `agent_end`, then (after retry/compaction checks) `agent_before_settle`, then `agent_settled` (`agent-session.ts:1775-1844`, `:1846-1870`, `:1050-1071`).

---

## 3. Injecting into the current user turn without mutating prior messages

### How request context is built
Before **every** request, pi rebuilds the message list from the persisted session projection (`agent-session.ts:759-779`):
- `prepareRequest` uses `sessionManager.buildSessionProjection().messages`.
- The model therefore sees exactly what is in the session file (plus `context_edit` and compaction projection), then the `context` transforms.

### `before_agent_start` → `message`
- **What it creates:** the returned message becomes a `role:"custom"` `AgentMessage` placed **directly after the user's message** (`agent-session.ts:2047-2058`). Because it goes through the agent loop's `message_end`, it is **persisted** as a `custom_message` session entry (`agent-session.ts:1117-1124`).
- **Later turns replay it** from the session at the same position, so the prefix is stable. It is not re-injected each turn.
- **When it fires:** only on `prompt()`, meaning user input and `pi.sendUserMessage()` (which calls `prompt`, `:2345-2350`).
  - It does **not** fire on tool-loop turns, on `sendMessage({triggerTurn})` (which calls `_runAgentPrompt` directly, `:2271-2276`), or on `agent_before_settle` continuations.
- **Conversion to the LLM:** `convertToLlm` maps `custom` to `role:"user"` with the same content (`ce/src/core/messages.ts:162-169`). The user message and the injected note therefore reach the provider as **two consecutive `user` messages**; openai-completions does not merge them (`ai/src/api/openai-completions.ts:1256-1290`).
  - **UNVERIFIED:** some strict jinja chat templates reject non-alternating roles. Test the target llama.cpp model.
  - **Verified (D-060):** `pi-cli.integration.test.ts` runs real pi with memory's preference note. The provider receives `user` (the prompt) then `user` (the note), and the next request replays both unchanged as its prefix.
  - Alternative: the `input` event's `transform` folds text into the user message itself. Note that this text is persisted and shown in the UI as user text.
- **System prompt:** returning `systemPrompt`, or mutating `systemPromptOptions` sections or tools, produces a system-message **delta** appended to the transcript (`extensions.md:103`; `system-prompt.ts` `diffSystemPromptSections`).
  - For `openai-completions`, `supportsMidConvoSystemMessages` defaults to `false`, so later system messages are **folded into the leading system message** (`ai/src/types.ts:847`, default at `openai-completions.ts:1677`).
  - That **rewrites the prefix**. Exocortex must never vary the system prompt or the active tool set across turns.

### `context` event
- **Ephemeral, per request.** `emitContext` works on a `structuredClone` (`runner.ts:1298-1359`), and the result is used only for the outgoing request (`agent-loop.ts:388-395`). Nothing is persisted.
- Any non-deterministic change here **breaks prefix caching** on the next request. Exocortex should not use it for injection; at most, use it for deterministic transforms.
- If the returned list differs from what it was given, pi re-attaches the current system message as a single head (`runner.ts:285-293`).

### Custom messages via `pi.sendMessage`
```ts
// types.ts:1690-1693 ; CustomMessage at ce/src/core/messages.ts:46-53
sendMessage<T = unknown>(message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
  options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }): void;
interface CustomMessage<T> { role: "custom"; customType: string; content: string | (TextContent|ImageContent)[];
  display: boolean; details?: T; timestamp: number }
```
- **Always sent to the LLM** as `role:"user"`. There is no flag to exclude a custom message from context.
- `display:false` only hides it in the TUI. `details` is **not** sent to the LLM; it is persisted (`session-format.md:176-187`, `session-manager.ts:146-165`).
- **Never sent to the LLM:** `pi.appendEntry()` custom entries (§8), and `bashExecution` with `excludeFromContext`.
- **Persistent edit mechanism:** `context_edit` entries (append-only content replacement or omission of an earlier entry in **future** context, `session-format.md:139-147`). They can be returned from `turn_end`/`agent_before_settle` as drafts. They change the prefix by design, so use them only for deliberate compaction-like operations.

---

## 4. Rewriting `tool_result`
- **Handlers can replace** `content`, `details`, `structuredContent`, `isError` and `usage`. Handlers compose, and each one sees the earlier changes (`runner.ts:1183-1240`).
  - Replacing `content` without `structuredContent` drops `structuredContent` (`types.ts:1437-1441`).
- **The rewritten version is what gets persisted** and what the model sees:
  - `_afterToolCall` returns the hook result (`agent-session.ts:656-697`).
  - `finalizeExecutedToolCall` applies it (`agent-loop.ts:853-904`).
  - `createToolResultMessage` builds the persisted message from it (`agent-loop.ts:922-935`).
  - `tool_execution_end.result` also carries the rewritten result.
- **The original is not preserved by pi.** To keep it:
  - Capture `event.content` inside the handler (it is the original when Exocortex's handler runs first among handlers that change content).
  - Write it to Exocortex's trace store, or to `pi.appendEntry("exo.toolresult.orig", {...})`, or into `details`.
- **`details` caveats:**
  - `details` is persisted and not sent to the LLM.
  - Built-in renderers read `details`, so merge rather than replace: `{...event.details, exo: {...}}`.
- **`structuredContent` is not persisted:** `createToolResultMessage` copies only content, details, usage and isError (`agent-loop.ts:922-935`).
- **Error behavior:** a throwing `tool_result` handler is isolated per handler (`runner.ts:1216-1225`). If the whole `afterToolCall` throws, the result becomes an error result (`agent-loop.ts:892-895`).

---

## 5. Continuing without the user
```ts
// types.ts:1700-1706
sendUserMessage(content: string | (TextContent | ImageContent)[],
  options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean }): void;
appendEntry<T = unknown>(customType: string, data?: T): void;
```

### `sendCustomMessage` behavior (`agent-session.ts:2246-2282`)
| Call | Effect |
|---|---|
| `deliverAs: "nextTurn"` | Queued; attached after the next user prompt. |
| Streaming, `triggerTurn !== false` | `steer` (default): delivered after the current tool batch, before the next LLM call. `followUp`: delivered when the agent would stop. |
| Not streaming, `triggerTurn: true` | Starts a new run immediately. `input` and `before_agent_start` do not fire. |
| Streaming, `triggerTurn: false` | Deferred to the end of the current turn, so it never sits between a tool call and its result. |
| Idle, no trigger | Appended to the session only. |

### `sendUserMessage` behavior
- It goes through `prompt()` with `source: "extension"` and `expandPromptTemplates: false` by default (`:2318-2351`).
- While streaming, **it requires `deliverAs`**. Without it, `prompt()` throws (`:1966-1971`), and the throw is reported as an `extension_error` (`:3350-3357`); it does not crash pi.
- Both calls are fire-and-forget (`void`).

### Designed continuation hook
`agent_before_settle` (and `turn_end`) return `{entries: [{type: "custom_message", ...}], continue: true}` to append context and force **one** more model request (`extensions.md:117`; `agent-session.ts:1846-1870`).
- Validation: continuing requires runnable context. An invalid request is reported and ignored (`agent-session.ts:973-1009`).
- Guard against loops; unconditional continuation loops forever.
- **Supervisor continuation should use this hook** instead of `sendUserMessage` from `agent_end`.

### Idle, abort and detecting user input
- **Idle and signals:** `ctx.isIdle()` (`types.ts:348`) and `ctx.hasPendingMessages()`. `ctx.signal` is the current run's AbortSignal (undefined when idle, and already undefined in `agent_before_settle`, §15). `ctx.abort()` aborts the run; queued messages return to the editor (`how-pi-works.md:13`).
- **User submitted input:** an `input` event with `source === "interactive"` (or `"rpc"`). Its `streamingBehavior` is set when the user typed during a run. Ignore `source === "extension"`: Exocortex's own `sendUserMessage` also emits `input`.
- **User is typing (not yet submitted):** `ctx.ui.onTerminalInput(handler)` gives raw keystrokes in the TUI only (`types.ts:162-163`). It is a no-op in RPC (`rpc-extension-ui.md:17`).

---

## 6. UI

`ExtensionUIContext` is at `types.ts:149-300`. The most relevant methods:
```ts
select(title, options: string[], opts?: {signal?, timeout?}): Promise<string | undefined>;
confirm(title, message, opts?): Promise<boolean>;
input(title, placeholder?, opts?): Promise<string | undefined>;
editor(title, prefill?): Promise<string | undefined>;
notify(message, type?: "info" | "warning" | "error"): void;
setStatus(key: string, text: string | undefined): void;
setWidget(key, lines: string[] | undefined, { placement?: "aboveEditor" | "belowEditor" }): void;
setWorkingMessage(message?: string): void;
pasteToEditor(text: string): void;  setEditorText(text: string): void;  getEditorText(): string;
onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
custom<T>(factory, { overlay?, overlayOptions?, onHandle? }): Promise<T>;
```

- **`select` titles may span lines.** The TUI renders the title as one `Text` (`modes/interactive/components/extension-selector.js:29`), and pi's own `confirm` passes `` `${title}\n${message}` `` to the selector (`modes/interactive/interactive-mode.js:2119`). Line numbers are in the installed `dist/`.
- **Cancel:** the selector's cancel callback resolves `select` with `undefined` (`interactive-mode.js:2092-2095`). In RPC a `cancelled` response resolves `select` and `input` with `undefined` (`modes/rpc/rpc-mode.js:84-86`). **UNVERIFIED:** the TUI's `input` on Escape; its declared type allows `undefined` (`core/extensions/types.d.ts:78`).

### Shortcuts
```ts
// types.ts:1642-1648
registerShortcut(shortcut: KeyId, options: { description?: string; handler: (ctx: ExtensionContext) => Promise<void> | void }): void;
```
- `KeyId` is a string like `"ctrl+shift+u"`; `Key.ctrlShift("u")` builds one (example `preset.ts:352`; type at `packages/tui/src/keys.ts:152`).
- Shortcuts that collide with reserved app keys (interrupt, submit, model cycling and others) are **skipped** with a warning (`runner.ts:96-115`, `:685-716`).

### Availability by mode
| Mode | `ctx.mode` | `ctx.hasUI` | UI behavior |
|---|---|---|---|
| TUI | `"tui"` | `true` | Full UI. |
| RPC | `"rpc"` | `true` | Dialogs and fire-and-forget calls are forwarded (§12). `custom()` returns undefined. `getEditorText()` returns `""`. `pasteToEditor` becomes `setEditorText` (`rpc-extension-ui.md:12-25`). |
| print (`-p`) | `"print"` | `false` | Every call is a no-op (`noOpUIContext`, `runner.ts:324-355`). `confirm` returns `false` and `select`/`input` return `undefined`. |
| json | `"json"` | `false` | Same as print. |

`types.ts:323`, `:331`; `extensions.md:248-251`.

### Pre-fill and one-key accept
- **Pre-fill: yes.** `ctx.ui.setEditorText(suggestion)` puts the text in the editor, and the user presses Enter to accept it (example `handoff.ts:180`).
- **One-key accept: yes.** Call `setWidget("exo", ["Suggested: … (ctrl+y to send)"])` and register a shortcut whose handler calls `pi.sendUserMessage(text)`.
  - Pass `deliverAs: "followUp"` if the agent is streaming.
- **Watch out:** a pre-filled editor competes with real user typing. Check `getEditorText()` is empty first.

---

## 7. Slash commands
```ts
// types.ts:1528-1534, 1639
registerCommand(name: string, options: {
  description?: string;
  getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}): void;
// AutocompleteItem = { value: string; label: string; description?: string }  (packages/tui/src/autocomplete.ts:249-253)
```
- **Arguments:** `args` is the raw text after the first space (`agent-session.ts:2069-2088`).
- **Timing:** commands run immediately, even while streaming, and errors are caught (`:2069-2088`). They also work from RPC `prompt` and print-mode prompts.
- **Name collisions** get `:n` suffixes (`runner.ts:807-841`).
- **`ExtensionCommandContext`** (`types.ts:401-435`) adds `waitForIdle`, `newSession`, `fork`, `navigateTree`, `switchSession`, `reload` and `getSystemPromptOptions`. These are command-only because calling them from event handlers can deadlock (`extensions.md:214-215`).
- Example with autocomplete: `ce/examples/extensions/commands.ts:18-22`.

---

## 8. Sessions

### Storage and format
- **Location:** `~/.pi/agent/sessions/--<cwd with / replaced by ->--/<timestamp>_<sessionId>.jsonl` (`session-manager.ts:589-598`; `session-format.md:10-14`).
  - Overrides: `--session-dir`, then `PI_CODING_AGENT_SESSION_DIR`, then the `sessionDir` setting (`sessions.md:50`).
  - `--no-session` keeps the session in memory only.
- **IDs:** session IDs are UUIDv7 (`session-manager.ts:264-266`). Entry IDs are short hex.
- **Lazy file creation:** the file is created only once a user or assistant message exists. After that, every entry is appended synchronously (`session-manager.ts:1160-1188`).
- **Format:** JSONL, version 3. Line 1 is the `SessionHeader` `{type:"session", version, id, timestamp, cwd, parentSession?}`. Every other entry has `{type, id, parentId, timestamp}` and forms a **tree** whose leaf is the active branch.
- **Entry types** (`session-manager.ts:43-195`):
  - `message` (holding an `AgentMessage`, including `role:"system"` prompt/tool deltas)
  - `model_change`, `thinking_level_change`, `usage`
  - `compaction`, `branch_summary`, `context_edit`
  - `custom`, `custom_message`
  - `label`, `session_info`
- **Branch context:** the context for a branch is built by `buildContextEntries` → `buildSessionProjection` → `buildSessionContext` (`session-format.md:224-248`).

### Access from an extension
- **Session:** `ctx.sessionManager` is a `ReadonlySessionManager` (`session-manager.ts:245-262`). It provides `getSessionId()`, `getSessionFile()`, `getCwd()`, `getLeafId()`, `getEntry()`, `getBranch()`, `getEntries()`, `getTree()`, `buildSessionProjection()`, `getHeader()` and `getSessionName()`.
- **Other context:** `ctx.cwd`, `ctx.model` (`Model<any> | undefined`), `ctx.thinkingLevel`, `ctx.getContextUsage()` and `ctx.getSystemPrompt()` (`types.ts:325-365`).
- **Messages:** `ctx.sessionManager.buildSessionProjection().messages` gives model-visible messages. `getBranch()` gives raw entries. `agent_end.messages` gives the run's new messages.
- **Rebuilding state on resume:** reconstruct branch-sensitive state from `getBranch()` in `session_start`. Do not use all entries, because abandoned branches are included (`extensions.md:233-234`).

### `pi.appendEntry(customType, data)`
- Writes a `custom` entry (`agent-session.ts:3359-3365`).
- It is persisted on the current branch and **never sent to the LLM** (`session-format.md:164-172`).
- It emits an `entry_appended` session event, which also appears in the json/RPC stream (`json.md:122`).
- Exocortex writes two kinds (D-078): `exo.overrides` (the `/exo` toggles) and `exo.<module>.state` (a module's saved state). Both are read back from `getBranch()` at `session_start`; the last one of each type wins.
- Use it for Exocortex markers and state, such as an injection ledger and original tool outputs.

---

## 9. Compaction
- **Auto trigger:** when `contextTokens > contextWindow - reserveTokens`, with `reserveTokens` defaulting to 16384 and `keepRecentTokens` to 20000 (`compaction.md:27-41`; `compaction.ts:126-130`).
  - **When it is checked:**
    - between turns, before the next assistant response (`agent-session.ts:748-757`);
    - before a new prompt (`:2005-2010`);
    - on overflow or length recovery.
  - Manual compaction: `/compact` or `ctx.compact(opts)`.
  - Settings: `compaction.enabled`, `reserveTokens`, `keepRecentTokens` and `modelOverrides` (`compaction.md:417-463`).
- **Overflow recovery** (`dist/core/agent-session.js:2335-2370`): pi compacts with `reason: "overflow"` when the last assistant message is a context overflow (`isContextOverflow`, `pi-ai/dist/utils/overflow.d.ts:57`) **or** a recoverable length stop, then retries the turn once. A second overflow in a row emits `session_compact_failed` with `reason: "overflow"` and `errorMessage` "Context overflow recovery failed after one compact-and-retry attempt…" (`:2346-2364`).
  - `SessionCompactFailedEvent` is `{reason: "manual"|"threshold"|"overflow", errorMessage?, aborted, willRetry, fromExtension}` (`dist/core/extensions/types.d.ts:600-613`). The trace records it as `compaction.failed` (D-059).
  - `isContextOverflow` matches known providers' error texts. A custom provider's overflow error may not match (`overflow.d.ts:44-52`); the turn then just ends with `stopReason: "error"` and no compaction.
- **`session_before_compact` payload** (`types.ts:762-772`):
  - `preparation: CompactionPreparation` (`compaction.ts:772-788`): `{firstKeptEntryId, messagesToSummarize, turnPrefixMessages, isSplitTurn, tokensBefore, previousSummary?, fileOps, settings}`.
  - `branchEntries`, `customInstructions?`, `reason: "manual"|"threshold"|"overflow"`, `willRetry`, `signal`.
- **Return values:**
  - `{cancel: true}` cancels the compaction.
  - `{compaction: {summary, firstKeptEntryId, tokensBefore, usage?, details?}}` supplies a custom summary (`CompactionResult`, `compaction.ts:105-114`). Example: `ce/examples/extensions/custom-compaction.ts:79-104`.
- **What is kept:**
  - the summary, as a user-role `compactionSummary` (`messages.ts:176-183`);
  - entries from `firstKeptEntryId` onward;
  - a full system checkpoint.
  
  Raw entries stay in the file. Compaction necessarily resets the prompt-cache prefix.

---

## 10. Providers, models and request shaping

### `models.json` (`~/.pi/agent/models.json`)
The schema is at `ce/src/core/model-config.ts:195-256`; docs at `models.md:45-66`.
```json
{ "providers": { "local": {
    "baseUrl": "http://127.0.0.1:8080/v1", "api": "openai-completions", "apiKey": "none",
    "headers": { "X-Static": "v" },
    "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false, "supportsStore": false,
                "maxTokensField": "max_tokens", "thinkingFormat": "qwen-chat-template" },
    "models": [ { "id": "qwen3-coder", "reasoning": true, "contextWindow": 32768, "maxTokens": 8192,
                  "samplingParams": { "cache_prompt": true, "top_k": 20 } } ] } } }
```
- **Field levels:** provider-level fields are `name, baseUrl, apiKey, api, headers, compat, authHeader, models, modelOverrides`. Model-level fields add `reasoning, thinkingLevelMap, input, contextWindow, maxTokens, samplingParams, samplingParamsByThinkingLevel, headers, compat, promptCache`.
- **API types** include `openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai` and `mistral-conversations` (`ai/src/api/*`).
- **Static extra body fields:** `samplingParams` is a free-form record (`model-config.ts:66`) that is `Object.assign`ed into the request **last** (`openai-completions.ts:1003-1007`, `ai/src/api/simple-options.ts:24-34`). It works for `cache_prompt`, `id_slot` and similar fields, and only applies to the openai-completions and openai-responses APIs (`models.md:125`).
- **Defaults for a localhost endpoint** (`openai-completions.ts:1642-1689`):
  - `supportsDeveloperRole` is **true**, so a `reasoning:true` model gets its prompt with role `developer` (`:1233`). Many llama.cpp templates dislike that; set it to `false`.
  - `supportsStore` is true, so `store:false` is sent.
  - `max_completion_tokens` is used.
  - `thinkingFormat` is `"openai"`, so `reasoning_effort` is sent when `reasoning:true`.
  - **Pi's built-in llama.cpp provider** instead sets `supportsDeveloperRole:false`, `supportsReasoningEffort:false`, `maxTokensField:"max_tokens"` and `thinkingFormat:"qwen-chat-template"`. That sends `chat_template_kwargs: {enable_thinking, preserve_thinking:true}` (`ce/src/extensions/llama/provider.ts:118-128`; `openai-completions.ts:901-905`).
- **Other thinking formats:** `"chat-template"` with `compat.chatTemplateKwargs` (using `{"$var":"thinking.enabled"}` and similar), `"qwen"` (`enable_thinking`), `"deepseek"` and others (`ai/src/types.ts:812-828`; `openai-completions.ts:880-977`).
- **Thinking budget field:** `thinkingTokenBudgetField: "thinking_budget_tokens"` serves llama.cpp (`types.ts:836-842`).
- **Session affinity and cache keys:**
  - `prompt_cache_key` is sent only to api.openai.com, or with long retention.
  - Session-affinity headers are sent only for OpenRouter by default (`openai-completions.ts:776-786`, `:826-831`).

### Dynamic, per-session or per-request shaping from an extension
- **Headers:** `before_provider_headers` mutates the headers of every main-agent request (`types.ts:888-891`; wired at `sdk.ts:330-340`).
- **Body:** `before_provider_request` receives the full provider payload. For openai-completions that is `ChatCompletionCreateParamsStreaming` with `messages`, `tools`, `stream_options`, sampling and reasoning fields. Returning an object replaces it (`openai-completions.ts:357-368`).
  - **This is the exact outgoing request body**, modulo later handlers in load order and the OpenAI SDK's own serialization.
- **Provider registration:** `pi.registerProvider(name, {baseUrl, apiKey, api, headers, models, ...})` can also be called at runtime and takes effect immediately (`types.ts:1817`, `runner.ts:516-538`).
- **Scope of these hooks:** they fire only for the main agent's requests, which go through `sdk.ts` `streamFn` (`sdk.ts:395-416`).
  - **UNVERIFIED:** whether cache-warming refresh requests also pass `onPayload`. Warming is disabled unless the model declares `promptCache`.

### Usage and cache telemetry
- `AssistantMessage.usage: Usage` is `{input, output, cacheRead, cacheWrite, reasoning?, totalTokens, cost}` (`ai/src/types.ts:429-450`, `:548-572`). It is visible in `message_end`, `turn_end` and `agent_end`, and persisted.
- For openai-completions, `cacheRead` is taken from `usage.prompt_tokens_details.cached_tokens`, then `prompt_cache_hit_tokens`, then `cached_tokens` (`openai-completions.ts:1519-1556`). `input` excludes cached tokens.
- **UNVERIFIED:** whether the user's llama.cpp build emits `prompt_tokens_details.cached_tokens`. If it does not, `provider_stream_event.data` exposes the raw parsed chunks (for example llama.cpp `timings`).

---

## 11. Sidecar LLM calls from an extension
- **Recommended:** `ctx.modelRegistry`, which resolves auth and headers at request time (`ce/src/core/model-registry.ts:89-161`):
  ```ts
  complete<TApi extends Api>(model: Model<TApi>, context: Context, options?: ModelsApiStreamOptions<TApi>): Promise<AssistantMessage>;
  streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream;
  find(provider: string, modelId: string): Model<Api> | undefined;
  getApiKeyAndHeaders(model): Promise<{ok, apiKey?, headers?, baseUrl?, error?}>;
  // Context = { systemPrompt?: string; messages: Message[]; tools?: Tool[] }   (ai/src/types.ts:734-738)
  ```
  - Usage pattern: `custom-compaction.ts:79-88` calls `ctx.modelRegistry.complete(model, {messages}, {maxTokens, signal, cacheRetention: "none", sessionId})`.
  - These calls **do not** pass through `before_provider_request` or the other hooks, because those are wired only into the agent `streamFn`. So sidecar traffic never pollutes the main trace hooks.
  - Pass `signal` for cancellation. `samplingParams` and `onPayload` in options can add body fields such as `id_slot` (`OpenAICompletionsOptions`).
- **Raw fetch** is also reasonable for llama.cpp-specific endpoints such as `/completion`, grammar, `n_probs` or slot control. Built-in classification through `ctx.modelRegistry.classify()` exists for llama.cpp models (`llama-cpp.md:89-98`).
- **Concurrency:** pi has no concurrency limiter for these calls. Exocortex's pool owns that.

---

## 12. Headless: RPC and print/json modes

### RPC mode
- **Launch:** `pi --mode rpc --no-session [--model provider/id] [-e ./exo.ts]` (`rpc.md:12-20`). It uses JSONL over stdin/stdout, LF-only framing; do **not** use Node `readline` (`rpc.md:50-56`).
- **Commands** (`ce/src/modes/rpc/rpc-types.ts:22-74`): `prompt{message, images?, streamingBehavior?}`, `steer`, `follow_up`, `abort`, `clear_queue`, `new_session{parentSession?}`, `get_state`, `get_messages`, `set_model{provider, modelId}`, `cycle_model`, `get_available_models`, `set_thinking_level`, `cycle_thinking_level`, `get_available_thinking_levels`, `set_steering_mode`, `set_follow_up_mode`, `compact`, `set_auto_compaction`, `set_auto_retry`, `abort_retry`, `bash`, `abort_bash`, `get_session_stats`, `export_html`, `switch_session`, `fork`, `clone`, `get_fork_messages`, `get_entries{since?}`, `get_tree`, `get_last_assistant_text`, `set_session_name`, `get_commands`.
  - Responses take the form `{id?, type:"response", command, success, data|error}`.
  - The `prompt` response's `data.disposition` is `"started"|"queued"|"handled"` (`rpc-commands.md:36-40`).
  - `get_state` returns `sessionFile` and `sessionId` (`rpc-commands.md:155-185`).
- **Events:** the same shapes as json mode (`json.md`): `agent_start`, `turn_start`, `message_start`, `message_update` (delta-only, with cumulative `usage`), `message_end`, `tool_execution_*`, `turn_end`, `agent_end{messages, willRetry}`, `agent_settled`, `queue_update`, `entry_appended`, `compaction_start/end`, `auto_retry_*` and `extension_error`.
- **Completion:** **wait for `agent_settled`**, not `agent_end`, because retries, compaction or continuations can follow `agent_end` (`rpc.md:58-71`; `json.md:48`).
- **Extension UI** surfaces as `{"type":"extension_ui_request", id, method, ...}`:
  - Dialogs (`select`, `confirm`, `input`, `editor`) block until the client sends `{"type":"extension_ui_response", id, value|confirmed|cancelled}`.
  - Fire-and-forget methods are `notify`, `setStatus`, `setWidget`, `setTitle` and `set_editor_text` (`rpc-extension-ui.md:1-195`).
  - **An eval harness must auto-answer or cancel dialogs**, or pass `timeout` in the dialog options.
- **Shutdown:** close stdin (`rpc.md:91-95`).
- **TypeScript client:** `RpcClient` is exported (`ce/src/index.ts:421`). It provides `promptAndWait` and options `{cliPath, cwd, env, provider, model, args}` (`rpc-client.ts:28-41`).

### Print/json mode (simpler eval)
- **Verified gotcha:** `pi -p` waits on stdin when stdin is not a TTY and not closed. Spawn it with stdin set to `ignore`, or redirect `</dev/null`.
- **Invocation:** `pi --mode json "prompt"` writes a session header line, then the events, then exits after all prompts finish (`json.md:1-46`; `print-mode.ts:120-157`). `pi -p "prompt"` prints only the final text.
- **Extensions** load with `mode: "json"|"print"` and `hasUI = false`.
- **Error reporting:** extension errors go to stderr (`print-mode.ts:101-103`).
- **Waiting:** `prompt()` awaits the full run, including `agent_before_settle` continuations and actions deferred from `agent_settled` (`agent-session.ts:1775-1805`, `:1050-1071`). Print mode therefore waits for Exocortex continuations that use the boundary API.

### Clean-eval flags (`cli.md:109-205`)
| Flag | Effect |
|---|---|
| `-ne` / `--no-extensions` | Disables discovered, configured **and built-in** extensions. Explicit `-e` still loads. The built-in `llama.cpp` provider is also disabled; use `models.json` or `-e builtin:llama.cpp`. |
| `-ns` | No skills. |
| `-np` | No prompt templates. |
| `--no-themes` | No themes. |
| `-nc` / `--no-context-files` | No AGENTS.md or CLAUDE.md. |
| `-na` | Ignore project-local `.pi` config. |
| `--offline` | No network catalog refresh. |
| `--no-session` or `--session-dir <tmp>` | Session isolation. |
| `--tools read,bash,edit,write` | Fix the tool set. |
| `PI_CODING_AGENT_DIR=<tmp>` | Isolate settings, models.json and auth. |
| `--system-prompt` / `--append-system-prompt` | Override or extend the prompt. |

---

## 13. Built-in tools and result shapes

The default active tools are `read, bash, edit, write`. `grep, find, ls` and `powershell` are also available (`cli.md:128-139`). Inputs and details are exported as types (`types.ts:86-101`).

### Result rules
- A tool **throws** → `isError: true`, and the content is the error message (`agent-loop.ts:833-847`).
- A tool returns `isError: true` → that result is marked as an error.
- A tool returns an object without it → not an error (`extensions.md:138-146`).
- The `isError` flag is on `tool_result`, `tool_execution_end` and the persisted `toolResult` message (`ai/src/types.ts:596-610`).

### `bash` (`ce/src/core/tools/bash.ts`)
| Outcome | `isError` | Content |
|---|---|---|
| Exit 0 | `false` | Output text. |
| Non-zero exit | `true` | Output, then `"\n\nCommand exited with code N"` (`:400-406`). |
| Timeout | thrown → `true` | `"Command timed out after N seconds"` (`:378-379`). |
| Abort | thrown → `true` | `"Command aborted"` (`:374-375`). |
| No exit code | thrown → `true` | `"Command terminated without an exit code"` (`:386-387`). |

- `details` is `BashToolDetails {truncation?, fullOutputPath?}` (`:66-69`).
- `structuredContent` is `{output, truncated, full_output_path?, exit_code, wall_time_seconds}` (`:53-62`, `:391-399`).
  - It is available in `tool_result` and `tool_execution_end`, but **not persisted** (§4).
  - **This is the deterministic exit-code signal for error triage.**
- **Long output** (read in the installed 1.0.2 build, `dist/core/tools/bash.js` and `output-accumulator.js`; line numbers are the `.js` files'):
  - The text is the **last** 2,000 lines or 50 KB, whichever is hit first (`truncate.js:10-11`; `output-accumulator.js:70-74` uses `truncateTail`). The start of a long output never reaches the model.
  - Once either limit is passed, every raw chunk is also written to a temp file (`output-accumulator.js:46-54`, `:205-207`), and the file is closed before the result is built (`bash.js:224-231`: `finishOutput` awaits `closeTempFile`). So at `tool_result` time `details.fullOutputPath` names a complete file.
  - The file holds the command's raw output only. The notice `\n\n[Showing lines S-E of T (50.0KB limit). Full output: <path>]` (`bash.js:246-249`) and the status `\n\nCommand exited with code N` (`bash.js:254`, `:297`) are appended to the text afterwards, in that order, and are not in the file.

### Other tools
- **`read`:** `ReadToolDetails {truncation?}`.
- **`edit`:** `EditToolDetails {diff, patch, firstChangedLine?}` (`edit.ts:70-77`).
- **`grep`:** `{truncation?, matchLimitReached?, linesTruncated?}`.
- **`find`:** `{truncation?, resultLimitReached?}`.
- **`ls`:** `{truncation?, entryLimitReached?}`.
- **`write`:** details `undefined`.
- **Failures** of edit, read and write (missing file, non-unique match and so on) throw, so they arrive as `isError: true` with the message text. **UNVERIFIED:** I did not enumerate the error strings.
- **Other error sources:** blocked calls (`tool_call` `{block}`), unknown tools, schema-validation failures and truncated (`stopReason: "length"`) calls all become `isError: true` results with explanatory text (`agent-loop.ts:477-502`, `:707-775`).

---

## 14. Other relevant findings
- **System prompt:**
  - **Contents:** a structured set of sections: `preamble`, `tools` (one-line snippets), `rules`, `docs` (pi doc paths), `addendum`, `project_context` (AGENTS.md files), `skills`, `cwd` and custom sections (`ce/src/core/system-prompt.ts:116-191`).
  - **Size:** about 2-3k chars before context files and skills. **UNVERIFIED** estimate; I did not render it.
  - **Persistence and deltas:** the first request persists a system message. Later changes are persisted as deltas, and for openai-completions they are folded into the head (§3).
  - **Context files:** `AGENTS.md`/`CLAUDE.md` are loaded from the agent dir, cwd and its parents without needing trust (`configuration.md:41-47`). `-nc` disables them.
- **Codemode and tool_search** are built-in extensions whose tools are registered inactive. They are off unless enabled or an MCP server turns them on (`cli.md:141-172`).
- **MCP** is built in (`builtin:mcp`). It connects servers from `mcp.json` or `pi.registerMcpServer`.
- **No server architecture** in the shipped CLI. `pi server`/`pi client` exist only with `PI_EXPERIMENTAL=1` (`ce/src/experimental/commands.ts:84-86`), and `dist/experimental` is excluded from the package (`ce/package.json:29-33`).
  - `packages/server`, `durable`, `client` and `protocol` are experimental.
  - Extensions run **in the pi process** in every mode.
- **Virtual models** (`pi.registerVirtualModel`) route each request to a physical model. They are an alternative way to wrap the main model (`types.ts:1861-1873`, `docs/virtual-models.md`).
- **`message_end` replacement** can rewrite an assistant message before it is persisted. That is useful for normalizing provider errors, not for injection.
- **Retries:** automatic retries on retryable provider errors, and an overflow compact-and-retry (`agent-session.ts:1169-1184`, `compaction.md:85-98`), make `agent_end` fire more than once per user prompt.
- **Stale contexts:** after `/reload` or a session switch, old `pi`/`ctx` objects throw "stale". Re-capture them in `session_start` (`runner.ts:722-735`). §15 has what follows from it.

---

## 15. Behaviour the adapter's hook dispatcher relies on (D-078)

Read in the installed 1.0.2 build under `node_modules/@earendil-works/`. Paths are relative to `pi-coding-agent/dist/` unless they start with `pi-agent-core/` or `pi-tui/`; line numbers are the `.js` files'. The integration test "pi behaves as the hook dispatcher assumes" (`packages/pi-adapter/test/pi-cli.integration.test.ts`) runs real pi with a probe extension and checks the items marked **tested**.

### Session replacement and stale objects
- **The extension factory runs again for every new, resumed or forked session and on `/reload`.**
  - `newSession`, `switchSession` and `fork` call `teardownCurrent` and then `createRuntime` (`core/agent-session-runtime.js:127-173`). `createRuntime` builds new services (`main.js:587-600`), which make a new `DefaultResourceLoader` and reload it (`core/agent-session-services.js:63-69`), and loading an extension calls its factory (`core/extensions/loader.js:524-533`). The loader caches the imported factory function, not the result of calling it (`loader.js:461-467`).
  - `/reload` reloads the resource loader and builds a new `ExtensionRunner` (`core/agent-session.js:2899-2921`).
  - So everything the factory creates (Exocortex's `Runtime`, the trace store, `/exo` overrides held in memory) is per session, and anything the old instance leaves open is never closed. The adapter closes the trace store at every `session_shutdown` and keeps overrides in the session (§8).
- **The old `pi` and `ctx` throw after that.** `session.dispose()` and `reload()` call `invalidate()` on the old runner (`core/agent-session.js:977-988`, `:2899-2903`), after the `session_shutdown` handlers have returned (`core/agent-session-runtime.js:102-113`).
  - From then on every method of the old `pi` throws, **including `getFlag`** (`core/extensions/loader.js:295-300`, `assertActive` at `:194-199` and `:112-116`), and so does every getter and method of an old `ctx` (`core/extensions/runner.js:612-680`).
  - Work still running from the old session (a background sidecar call, a `.catch` handler) must therefore not touch `pi`: a throw there is an unhandled rejection, which exits interactive pi (§2). The adapter's `onError` and `log` never throw and fall back to the last debug level read.
  - During `session_shutdown` itself the old objects still work, so `pi.appendEntry` is allowed there.

### `tool_result` runs concurrently (tested)
- Tool execution is parallel by default (`pi-agent-core/dist/agent.js:145`; sequential only when configured or when a tool asks for it, `pi-agent-core/dist/agent-loop.js:366-372`).
- In parallel mode each call's execute-then-finalize is its own promise and they are awaited together (`agent-loop.js:432-453`). Finalizing calls `afterToolCall` (`agent-loop.js:593-606`), which is where pi emits `tool_result` (`core/agent-session.js:336-351`, `core/extensions/runner.js:900`).
- So `tool_result` fires as each tool finishes, in completion order, and **a handler that awaits is interleaved with the handlers of the other calls in the batch**. Result messages are still emitted in call order afterwards (`agent-loop.js:453-456`). The adapter queues its own `tool_result` work so modules see one result at a time.

### Abort, and what `agent_before_settle` can know
- **`ctx.signal` is the running agent loop's signal and nothing else** (`getSignal: () => this.agent.signal`, `core/agent-session.js:2720`; `pi-agent-core/dist/agent.js:214-216`). It is defined during `tool_call`/`tool_result`/`turn_end` and **undefined in `agent_before_settle`** (tested): the loop has returned and cleared its run (`agent.js:381-387`) before `_runBeforeSettleBoundary` is called (`core/agent-session.js:1354-1366`). It is also undefined in `before_agent_start` and `session_before_compact` (which has its own `event.signal`).
- **`session.abort()` waits for the settle hook.** It sets a flag, aborts the (already finished) loop and awaits `waitForIdle()` (`core/agent-session.js:1873-1884`); the session is idle only after `agent_settled` (`:672-673`, `:1038-1040`). Escape in the TUI while `isStreaming` (`modes/interactive/interactive-mode.js:2374-2377`, `:3842-3843`), RPC `abort` (`modes/rpc/rpc-mode.js:327-330`) and every session replacement (`core/agent-session-runtime.js:102-105`) go through it. **Pi gives the handler no signal or event for this.**
  - What an extension can see: `session_before_switch` and `session_before_fork` fire before the teardown (`core/agent-session-runtime.js:78-100`, `:129`, `:148`, `:176`); `session_shutdown` fires for `/reload` and quit without an abort first (`core/agent-session.js:2899-2902`, `core/agent-session-runtime.js:296-303`); and in the TUI `ctx.ui.onTerminalInput` sees raw keys before pi handles them (`pi-tui/dist/tui.js:685-695`, `interactive-mode.js:1985-1992`). The interrupt key is Escape unless rebound (`core/keybindings.js:28`). In RPC `onTerminalInput` is a no-op (`modes/rpc/rpc-mode.js:97-100`), so an RPC `abort` during the settle hook waits until the hook returns.
  - **Entries returned after an abort are still persisted:** `_runBeforeSettleBoundary` commits the drafts (`core/agent-session.js:1423`) before it checks the abort flag (`:1426`), and then does not continue. A handler that was interrupted must return nothing.
- `isStreaming` stays true through the settle hook (`core/agent-session.js:1034-1036`, `:1352`, `:673`), so the TUI's spinner and working message are still shown then.

### `agent_before_settle` payload
- `event.outcome` is `"completed" | "aborted" | "error"` (`core/extensions/types.d.ts:719`, `:753-758`). It is derived from the last assistant message's `stopReason` at each `turn_end` (`core/agent-session.js:475-477`) and starts as `"completed"` (`:125`).
- `event.context.llmMessages` is `convertToLlm` over the projection of the persisted session plus the drafts returned so far (`core/agent-session.js:603-614`; type `BoundaryContextPreview`, `types.d.ts:746-752`). Custom messages appear in it with role `user` (§3), so the last `assistant` entry is the agent's final message.

### `input.streamingBehavior`
- Set only when the input arrives while the agent runs (`this.isStreaming ? options?.streamingBehavior : undefined`, `core/agent-session.js:1502`; type at `types.d.ts:881-882`): `"steer"` or `"followUp"`. Undefined means a new prompt on an idle agent. `before_agent_start` does not fire for a steered or follow-up message (§3).

### Smaller facts
- **`ctx.modelRegistry.getApiKeyForProvider(provider)`** resolves `string | undefined` and never rejects: failures are caught and become `undefined` (`core/model-registry.js:105-112`; `model-registry.d.ts:52`). It can take as long as the auth lookup does; the adapter gives it 2 s.
- **Exit codes:** only `bash` reports one, as `structuredContent.exit_code` (`core/tools/bash.js:44`, `:292`); a process killed by a signal reports `128 + signal` (`:113`). No pi tool reports `exitCode`; the adapter's camel-case fallback is for other extensions' tools.
- **`pi.appendEntry` makes the entry the new leaf** (`core/session-manager.js:901-912`, `:815-820`), also in the middle of a tool batch. The projection skips it, so the request prefix is unchanged (tested: the next request's messages start with the previous request's).
- **Compaction entries keep `details`** (`core/session-manager.d.ts:46-59`), and `session_before_compact` hands over `branchEntries` (`core/extensions/types.d.ts:579-589`), so an extension can read back the details it returned with the previous compaction.

---

## Answers to Exocortex open questions

**(a) Injecting into the current user turn without altering earlier messages.**
- **Main mechanism:** return `{message: {customType: "exo.*", content, display: false, details}}` from `before_agent_start`.
  - Pi appends it right after the user's message.
  - It is persisted as a `custom_message` entry and replayed at the same position on later requests, so the prefix stays stable.
  - It is sent as an additional `user`-role message.
- **Mid-run injection:**
  - `pi.sendMessage(..., {deliverAs: "steer"})` during streaming lands after the current tool batch, before the next LLM call.
  - Alternatively, return `custom_message` drafts from `turn_end`/`agent_before_settle`.
  - Both are persisted.
- **What to avoid:** the `context` event, which is per-request and ephemeral, and any change to the system prompt or tools, which is folded into the head on openai-completions.

**(b) Can `tool_result` rewrites preserve the original output for the trace?**
- Pi persists only the rewritten result. The original is not kept anywhere by pi.
- The handler sees the original `event.content` (and `structuredContent`/`details`). Exocortex must copy it into its own trace, `pi.appendEntry`, or merged `details` (persisted, not sent to the LLM).

**(c) Can the adapter observe the exact outgoing LLM request?**
- **Yes.** `before_provider_request` receives the final provider payload: for openai-completions, the full `ChatCompletionCreateParams` including `messages` and `tools`.
- `before_provider_headers` exposes the headers, `after_provider_response` the status and headers, and `provider_stream_event` the parsed chunks.
- **Two caveats:**
  - Extensions that run later in load order can still change the payload.
  - The OpenAI SDK serializes it afterwards.

**(d) Can the UI pre-fill the editor or offer a one-key accept?**
- **Yes, in TUI.**
  - `ctx.ui.setEditorText(s)` pre-fills; Enter accepts.
  - Or show `setWidget` with a hint and register a shortcut (for example `ctrl+y`) that calls `pi.sendUserMessage(s)`.
- **RPC:** `set_editor_text` is forwarded to the client.
- **Print/json:** there is no UI (`hasUI = false`).

**(e) Can per-session headers or body fields be attached to the main agent's requests?**
- **Yes.**
  - Headers: mutate them in `before_provider_headers`.
  - Body: return a modified payload from `before_provider_request`, e.g. `{...payload, id_slot, cache_prompt: true}`.
  - Both run for every main-agent request.
- **Static alternatives:** `models.json` `headers` and `samplingParams`, which are merged into the body last.

**(f) Where are sessions stored, and in what format?**
- **Path:** `~/.pi/agent/sessions/--<cwd-dashed>--/<timestamp>_<uuidv7>.jsonl`. Override with `--session-dir`, `PI_CODING_AGENT_SESSION_DIR` or the `sessionDir` setting.
- **Format:** JSONL v3. A header line comes first, then tree entries with `id`/`parentId`.
- **Entry types:** `message`, `custom_message`, `custom`, `compaction`, `context_edit`, `branch_summary`, `model_change` and others.
- **Access from an extension:** `ctx.sessionManager.getSessionFile()` and `getSessionId()`. The file is written lazily, once a user message exists.

**(g) Can injected messages be marked so Exocortex's own extraction excludes them?**
- **Yes, for injected messages.** They are `role: "custom"` (in the session, `type: "custom_message"`) with Exocortex's own `customType` (for example `"exo.inject"`) and a `details` payload that is never sent to the LLM. Filter on these.
- **Partly, for tool-result rewrites.** They carry no flag on the message; mark them in merged `details.exo` or keep an `appendEntry` ledger keyed by `toolCallId`.
- **Not, for `input` transforms of user text.** Avoid them, or record them in the ledger.
- **For the model:** wrap injected text in a recognizable tag, because the LLM sees custom messages as plain user text.

---

## Compaction: where the summariser's usage goes (D-079)

Verified in `node_modules/@earendil-works/pi-coding-agent/dist/core/` (1.0.2) for the eval's token counts.

- **The summary is a direct model call, not a turn.** `completeSummarization` calls `completeSimple` (or the agent's stream function and takes `.result()`), with `cacheRetention: "none"` (`compaction/compaction.js:477-489`). No `turn_start`, `turn_end` or `message_end` is emitted for it, so the usage a `turn_end` carries (the turn's assistant message, `trace-recorder.ts` in the adapter) never includes it.
- **Its usage is returned, and stored on the compaction entry.**
  - `generateSummaryWithUsage` returns `{text, usage: response.usage}` (`compaction/compaction.js:511-538`).
  - `compact()` returns `usage: summaryUsage`; for a split turn that is the history summary's usage and the turn-prefix summary's combined (`:686-720`).
  - Auto-compaction passes it to `sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage)` (`agent-session.js:2480-2488`); manual compaction does the same (`:2189-2199`).
  - `appendCompaction` writes it as `entry.usage` (`session-manager.js:880-895`; `CompactionEntry.usage?: Usage`, `session-manager.d.ts:45-58`).
- **`session_compact` hands the saved entry to extensions** as `compactionEntry` (`agent-session.js:2205-2212`, `:2494-2501`), so the trace's `compaction` event, which records the whole entry, has `data.entry.usage` as `{input, output, cacheRead, cacheWrite, totalTokens, cost}`.
- **A summary an extension supplies** carries whatever `usage` the extension returned, or none (`agent-session.js:2470-2477`). Exocortex's compaction module returns none: its calls are sidecar calls.
- **A failed compaction's usage is lost.** `session_compact_failed` has no usage field (`agent-session.js:649-652`; payload in §9), so tokens spent on a summary that was then discarded are not counted anywhere.
- **What the eval does:** `computeTraceMetrics` adds `data.entry.usage` of every `compaction` event with `fromExtension !== true` to the main input, cached and output tokens, and reports the sum as `compactionTokens`.

## RPC: a prompt that starts no run (D-079)

- **Every session event reaches stdout in RPC mode,** `turn_start` included: `session.subscribe((event) => output(toJsonEvent(event)))` (`dist/modes/rpc/rpc-mode.js:265-270`); the loop emits `turn_start` before each turn (`pi-agent-core/dist/agent-loop.js:51`, `:69`, `:113`). The eval's driver uses a `turn_start` after the last allowed `turn_end` as the sign that the agent went over its turn limit.
- **A prompt whose response has `data.disposition === "handled"` starts no run,** so no `agent_settled` follows (`dist/modes/rpc/rpc-client.js:130-137`). The driver settles at once on it.
