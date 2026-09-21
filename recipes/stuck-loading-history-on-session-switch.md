# "Loading history…" forever when switching to a running session

**Symptom (2026-09-21).** Switching the web GUI (Dock app / WKWebView) to a
session whose agent is mid-turn (tool use in progress) sometimes shows only
`Loading history…` plus the turn-status pill (`Deep diving…`) and never
renders the transcript. A browser refresh fixes it. Idle sessions never do
this.

**Root cause (confirmed 2026-09-21, after the first fix made it visible):**
`Failed to load history: Assistant stream raw chunk must be a lossless JSON
object (gateway/internal)`. `@deepseek-ai/dsh-util-values`'s
"is this a plain object" test compared `Function.prototype.toString(Object)`
to V8's literal `function Object() { [native code] }`; JavaScriptCore
(Safari, the WKWebView Dock app) renders
`function Object() {\n    [native code]\n}`, so **every** object failed the
lossless-JSON test in that engine. The one browser path that runs it is
`expandAssistantStream` on a mid-turn follow snapshot's `activeAttempt`
baseline: any `chunk` record (`block-start`, `usage`, `finish`) threw. Hence
Dock app only, mid-turn sessions only, never reproducible in Chrome.

**Fixes.** Two fork commits on `feat/embed-session`; re-apply on every rebase
until upstream has them:

- `319dcb8a56` — `packages/util/values/src/index.ts`: whitespace-tolerant
  regexes for the native-constructor source (test in
  `packages/core/session/tests/json.spec.ts` patches
  `Function.prototype.toString` to JSC's rendering). The same literal
  comparison is duplicated host-side in `cordis-host-runner/src/guard.ts`,
  `core/tools/src/json-schema.ts` and `ptc-runtime-node/src/json-wire.ts`;
  those only ever run under V8 and were left alone.
- `1ab8de08d2` — `packages/api/session-controller/src/client/sessions/session.ts`:
  never leave `openState='loading'` (below). This is what turned the silent
  spinner into the error message that named the culprit.

## Where the state lives

| Piece | File | Note |
|---|---|---|
| The hint | `packages/client/ui-chat/src/client/chat/ChatView.tsx` (`openState === 'loading'`) | Renders `chat.loadingHistory`; `openState === 'error'` renders `chat.loadError` instead |
| `running` pill | same file, `TurnStatus` | Seeded from the sidebar list **before** history loads (`manager.ts` `get()` → `handleRunning(summary.running)`), so a stuck open still shows "Deep diving…" |
| `openState` | `packages/api/session-controller/src/client/sessions/session.ts` `doOpen` | `'loading'` until `events.open()` settles |
| First frame | `packages/api/gateway/src/client/journal-stream.ts` `open()` | Awaits the `snapshot` frame of `session.follow`; **no timeout** |
| Carrier | `packages/api/gateway/src/client/stream-client.ts` | One multiplexed WebSocket for every logical stream; the Connection layer's own generation source rides it too (`remote-events.ts`), so a *clean* socket close does trigger `streams.reconnect()` |
| Host side | `packages/api/session-controller/src/history.ts` `follow` | Synchronous for a live Session (`observeSession` → `live()`), so the host is not where it stalls |

## The two holes (before the fix)

1. **Silent local failure while installing the opening window.** `doOpen`
   turned only `RemoteError`s into `openState='error'`; any plain exception
   was rethrown, leaving `openState` at `'loading'`, and the retain path
   swallows the opening rejection (`ClientSessionReference`,
   `void this.ready.catch(() => {})`). Nothing reached the console. The one
   step specific to a session mid-turn is `assistantStream.replace(entries,
   baseline)`: a follow snapshot taken while the LLM is streaming carries an
   `activeAttempt` baseline that the client re-expands with
   `expandAssistantStream` (`packages/llm/llm/src/assistant-stream.ts`),
   which throws `TypeError` on any validation mismatch. Idle sessions have
   no baseline and never take this branch. `failEventStream` had the same
   hole for the live fold (rethrow into the consumer's catch → unhandled
   rejection, dead window that still read `'open'`).
2. **Opening frame never arrives.** The mux server serializes every write on
   the connection and awaits each flush (`stream-server.ts` `send`), so a
   large snapshot page queues head-of-line behind other streams; a half-dead
   socket (OPEN in the browser, nothing flowing) is never detected client
   side — only the server pings.

## What the commit does

- `openFailure(sessionId, phase, error)`: Remote failures pass through;
  local faults are logged with
  `console.error('[session-controller] <open|follow> failed locally for session <id>:', error)`
  and folded into `new RemoteError('gateway/internal', message, {}, { cause })`.
  `doOpen` and `failEventStream` both use it, so the view shows the load
  error and `open()` stays retryable (the next retain runs a fresh follow).
- Opening watchdog (`watchOpening`): `OPEN_STALL_WARN_MS = 15_000` →
  `console.warn`; `OPEN_STALL_RESTART_MS = 30_000` → one `events.restart()`
  (reissues the follow on the same logical stream, resetting its retry
  budget). Cleared when the open settles or the generation is superseded.

If the hint still appears after the fix, the console now says which hole
it was: an `[session-controller] open failed locally…` line (hole 1, with
the real exception) or the `…has not received its opening snapshot…`
warning (hole 2).

## Verifying

```sh
cd <dsh-src>
pnpm exec vitest run packages/api/session-controller/tests/   # 773 tests
pnpm run typecheck:contracts-ready
pnpm exec tsx scripts/run-oxlint.ts packages/api/session-controller
```

New cases in `session.client.spec.ts` ("Session open"): local fault in the
opening window → `openState='error'` + `console.error` + retryable; local
fault in the live fold → `'error'` not an unhandled rejection; watchdog
warns at 15 s and reissues the follow at 30 s (fake timers, second follow
answers); watchdog is cleared once the snapshot lands.

## Promoting to the live GUI

The change is browser-side: it lives in
`packages/api/session-controller/lib/client.js`, served by the host under
`/plugins`. **Rebuilding that bundle hot-swaps the live GUI immediately**
(it remounts the core `sessions` service in every open tab / the Dock app),
so do it when no turn you care about is running, or accept a reload:

```sh
cd <dsh-src>
pnpm run typecheck:contracts-ready       # tsc -b tsconfig.client.json → lib/types/**/*.js (the bundle input)
pnpm --filter @deepseek-ai/dsh-api-session-controller exec tsdown --env.DSH_BUILD_FACE client
# or the full promotion: pnpm run build:lib:host && pnpm run build:lib:client && pnpm run build:web
```

**Trap (cost 20 min):** the client bundle inlines `@deepseek-ai/dsh-util-values`
through its package `exports` → `lib/index.js`, which is a **host-face**
tsdown artifact (root `tsdown.config.ts`, workspace mode), *not*
`lib/types/index.js`. Rebuilding session-controller alone after editing
util-values re-inlines the stale `lib/index.js`. `tsdown -F <pkg>` reports
"No valid configuration found" for that root config, so either run the full
`pnpm run build:lib:host` or rebuild the one package by hand:

```sh
cd <dsh-src>/packages/util/values
pnpm exec tsdown lib/types/index.js --no-config --format esm --platform node --target es2024 --out-dir lib --no-clean
mv lib/index.mjs lib/index.js && rm -f lib/index.mjs.map && sed -i '' '/^\/\/# sourceMappingURL=index.mjs.map$/d' lib/index.js
```

then rebuild the session-controller client bundle. Verify what the live
server actually serves (the row's `rev` is a content hash) with
`grep -n 'native code' packages/api/session-controller/lib/client.js` and,
in the browser, by fetching the `/plugins/??…dsh-api-session-controller/client.js&rev=…`
URL from the freshly fetched boot page. Beware the probe string
`() { [native code] }` — the fixed source *comments* still contain it.

The host half is untouched; no `dsh web` restart is needed for either fix
(the host runs under V8 where the old comparison was correct).

## Verifying the engine fix

`safari_evaluate_expression` (browser-automation plugin) against
`https://…/dsh/` in Safari Technology Preview — the same JavaScriptCore as the
Dock app: `Function.prototype.toString.call(Object)` prints the multi-line
form; after the rebuild, opening the running session rendered 126 rows with
no `[class*="openError"]` element and no `[session-controller]` console
line. Note a probe like `innerText.match(/Failed to load history/)` will hit
the *transcript* when the conversation quotes the error — test the element.

## What did not reproduce / was ruled out

- Rapid switching (24 switches between three sessions, one of them
  tool-running) in **Chrome** against `https://…/dsh/` did not reproduce it;
  no console errors — Chrome is V8, where the comparison was right. Testing
  the Dock app's behaviour needs Safari/STP. The Dock app has no readable
  console, and the live `dsh web` ran from a terminal, so nothing in
  `~/.dsh/logs`.
- Not a per-session host queue: `SessionController.follow` calls
  `history.follow` directly.
- Not a switch-away/switch-back instance race: `manager.drop()` removes the
  instance synchronously, so the return trip gets a fresh `Session`.
- Not the browser's 6-connection cap: streams are multiplexed on one WS.
- Not a missed notification: `Notifier` flushes `markDirty` in a microtask.
