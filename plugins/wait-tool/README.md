# tali-wait-tool

A `wait` tool for DSH agents that replaces `bash "sleep N; echo done"`.
Because the tool is *told* how long it waits, the chat renders the call as a
live progress bar with two buttons:

```
🕐 Wait  dev server to come up  ▕████████░░░░░░░░░░▏ 4 s / 10 s   [Skip] [Abort]
```

| Button | What the model receives |
|---|---|
| **Skip** | A normal result, early: `Wait skipped by the user after 4 s of the requested 10 s. Treat this exactly like the timeout having elapsed and carry on (…)`. For "I can see it's already done" or plain impatience. |
| **Abort** | An **error** result (code `USER_ABORTED_WAIT`): `user aborted sleep: the user pressed Abort after 4 s of the requested 10 s wait (dev server to come up). Do not start another wait; ask the user what they want to do instead.` The model stops and asks. |
| *(nothing)* | `Waited 10 s.` when the time elapses. |
| *Stop generating* | The turn's cancellation reaches the tool as `exec.signal`; the timer is cleared and the call settles with the registry's own `ABORTED` code (row reads "interrupted after …"). |

Settled rows keep a static bar: full for a completed wait, the elapsed fraction
in the accent colour for a skipped one, in the error colour for an aborted one.

## Tool

```
wait(seconds: number, reason?: string)
```

- `seconds` — `0 < seconds ≤ maxSeconds` (default 3600), fractions allowed. Over
  the cap → `INVALID_WAIT` telling the model to call again for longer periods.
- `reason` — a few words shown beside the bar ("dev server to come up").
- Concurrency-safe (`isConcurrencySafe: () => true`): may overlap sibling calls
  of the same batch.
- Global registration (stateless), so subagents get it too.
- Result value (also the row's `presentationMeta`): `{ outcome: 'completed' |
  'skipped', requestedSeconds, waitedSeconds, startedAt, endedAt }`.

A system-prompt line (`promptHint: true`) steers the model from bash `sleep` to
`wait`; it is emitted only for scopes that actually see the tool.

## How it works

- **Host half** ([`index.js`](index.js), [`wait.mjs`](wait.mjs)): `createWaitRegistry()`
  holds one entry per pending call (`callId → { sessionIds, startedAt,
  deadline, timer, settle }`); the tool body awaits the entry's promise. Two
  authenticated `ctx.connection.fetch` routes below `/api`:
  - `GET /api/wait/status?callId=…&sessionId=…` → `{ pending, startedAt,
    deadline, requestedMs, reason, now }` — `now` is the server clock so the
    browser can draw the bar against the clock that owns the deadline.
  - `POST /api/wait/control` `{ action: 'skip' | 'abort', callId, sessionId }`
    → `{ ok }`, `404` once settled, `403` when the session does not own the
    call (`sessionId` must be the agent's `session.id` or `agent.id`).
  Plugin unload fails every pending wait (`WAIT_UNLOADED`) so no call hangs.
- **Browser half** ([`src/client/index.tsx`](src/client/index.tsx) → `lib/client.js`):
  a keyed `tool.call.toolview` entry for `wait` on the shipped
  `DisclosureRow` chrome. Running: fetches the status once for the
  browser↔server clock offset (fallback: the `tool/call` event time on the
  block), ticks at 100 ms, holds the bar at 99 % until the `tool/result` event
  lands, POSTs the verdicts. Settled: classifies the block — `presentationMeta.dsh
  === 'wait'` → completed/skipped; `error.code` `USER_ABORTED_WAIT` → aborted;
  `ABORTED` / `ABORTED_BEFORE_DISPATCH` → interrupted; anything else → the
  first line of the error. One `<style>` element carries the hover states.

## Config

```yaml
- insert:
    - id: tali-wait-tool
      name: tali-wait-tool          # or the absolute path to index.js in a dev overlay
      config:
        maxSeconds: 3600            # longest single wait
        promptHint: true            # system-prompt line steering the model to `wait`
```

## Develop / test

```sh
pnpm install          # also builds lib/client.js (prepare)
pnpm check            # node --check + node:test over wait.mjs (11 tests)
pnpm typecheck        # client half against the checkout's d.ts
pnpm watch            # rebuild lib/client.js on save (hot-swaps a GUI serving it)
```

End-to-end with a real agent needs a throwaway home with forwarded credentials
— see `recipes/wait-tool-plugin.md`.

## Traps met while building it

- **Output schema DSL ≠ JSON Schema.** `defineTool`'s `output.schema` is the
  author DSL: requiredness is `required: true` *per property*; a `required:
  [...]` array fails with `UNSUPPORTED_SCHEMA`.
- **Rejecting with `signal.reason` prints `Error: [object Object]`.** The web
  GUI's cancel path aborts with a plain object, and the registry substitutes
  its canonical `ABORTED` result only for a body that *succeeded* after
  cancellation — a rejecting body keeps its own error. The registry therefore
  throws a `HarnessError` with code `ABORTED` itself.
- **The 16px leading box fits one glyph.** A `StateDot` beside the clock icon
  rendered squashed; state is carried by the bar and the verdict text instead.
- **React ignores synthetic `input` events** — when driving the GUI from
  Chrome automation, click the composer and *type* (`chrome_type_text`), do not
  `fill`.
