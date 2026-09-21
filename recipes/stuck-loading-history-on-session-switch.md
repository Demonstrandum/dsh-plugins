# "Loading history…" forever when switching to a running session

**Symptom (2026-09-21).** Switching the web GUI (Dock app / WKWebView) to a
session whose agent is mid-turn (tool use in progress) sometimes shows only
`Loading history…` plus the turn-status pill (`Deep diving…`) and never
renders the transcript. A browser refresh fixes it. Idle sessions never do
this.

**Fix.** Fork commit `1ab8de08d2` (`feat/embed-session`) in
`<dsh-src>/packages/api/session-controller/src/client/sessions/session.ts`
plus tests in `tests/session.client.spec.ts`. Re-apply on every rebase
until upstream has it.

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
pnpm --filter @deepseek-ai/dsh-api-session-controller exec tsdown --env.DSH_BUILD_FACE client
# or the full promotion: pnpm run build:lib:client && pnpm run build:web
```

The host half is untouched; no `dsh web` restart is needed for this fix.

## What did not reproduce / was ruled out

- Rapid switching (24 switches between three sessions, one of them
  tool-running) in Chrome against `https://…/dsh/` did not reproduce it;
  no console errors. The user's Dock app has no readable console, and the
  live `dsh web` ran from a terminal, so nothing in `~/.dsh/logs`.
- Not a per-session host queue: `SessionController.follow` calls
  `history.follow` directly.
- Not a switch-away/switch-back instance race: `manager.drop()` removes the
  instance synchronously, so the return trip gets a fresh `Session`.
- Not the browser's 6-connection cap: streams are multiplexed on one WS.
- Not a missed notification: `Notifier` flushes `markDirty` in a microtask.
