# wait-tool plugin — a `wait` tool rendered as a progress bar with Skip / Abort

Status: **built and verified end-to-end 2026-09-23** (11 host unit tests; a
real Claude agent turn on a throwaway home exercised all four settlements:
elapsed, Skip, Abort, Stop-generating). Under trial in `cordis.dev.yml` (row
`tali-wait-tool`, preview server); **not** in the live profile — the maintainer decides
that. Plugin README: [`plugins/wait-tool/README.md`](../plugins/wait-tool/README.md).

## 0. Why

Agents `bash "sleep 30; echo done"` constantly (servers coming up, builds,
polling). A shell sleep is opaque to the GUI — the row says "bash", nothing
shows how long it will take, and the only way out is cancelling the whole
turn. The maintainer's idea (2026-09-23): a `wait` tool that *takes the duration as an
argument*, so the chat can draw a progress bar for it and offer two exits:

- **Skip** — return early, exactly like the timeout having elapsed (the user
  saw the thing was already done, or got impatient);
- **Abort** — return an *error* saying `user aborted sleep`, so the model
  stops and asks instead of waiting again.

## 1. What was built

`plugins/wait-tool/` — a client plugin (both halves):

| file | role |
|---|---|
| `index.js` | `inject = ['tools','connection']`; registers the tool, the two Fetch routes, the optional system-prompt hint (`ctx.inject(['systemPrompt'], …)` sub-fiber); `disposeAll()` on unload |
| `wait.mjs` | Cordis-free: `createWaitRegistry()` (pending waits keyed by `callId`, `start/skip/abort/get/disposeAll/onSettle`), `createWaitTool(registry, { maxSeconds })` via `defineTool`, `WaitError extends HarnessError`, `formatSeconds`, `renderWait` |
| `src/client/index.tsx` → `lib/client.js` | keyed `tool.call.toolview` for `wait`: running bar + Skip/Abort; settled bar + verdict |
| `tests/wait.test.mjs` | node:test over the registry and the tool body |
| `cordis.patch.yml` | bundle row `tali-wait-tool` for `dsh plugin add` |

### The wire, end to end

1. Model calls `wait({ seconds: 25, reason: "dev server" })`. The loop logs
   `tool/call` (the browser's `RunningToolCall.time`), then the body runs:
   `registry.start({ callId, sessionIds: [agent.session.id, agent.id],
   requestedMs, reason, signal: exec.signal })` and awaits.
2. The browser's toolview mounts for the running block, fetches
   `GET /api/wait/status?callId&sessionId` once → `{ startedAt, deadline,
   now }` on the **server clock**; it keeps `offset = now − Date.now()` and
   ticks at 100 ms. Before the answer (or if it 404s) it draws against
   `block.time`. The bar is held at 99 % until the `tool/result` event lands.
3. Skip/Abort → `POST /api/wait/control { action, callId, sessionId }`. The
   host checks the session owns the call (`403` otherwise; `404` once settled)
   and settles the entry: Skip resolves `{ outcome: 'skipped' }`, Abort rejects
   with `WaitError('user aborted sleep: …', 'USER_ABORTED_WAIT')`.
4. `tool/result` arrives; the same toolview now renders the settled shape from
   `presentationMeta` (`{ dsh: 'wait', outcome, waitedSeconds, … }`) or
   `error.code`.

Model-facing texts: `Waited 25 s.` / `Wait skipped by the user after 13 s of
the requested 2 min. Treat this exactly like the timeout having elapsed and
carry on (…)` / `Error: user aborted sleep: the user pressed Abort after 10 s of
the requested 1 min 30 s wait (abort test). Do not start another wait; ask the
user what they want to do instead.` In the trial the model did exactly that
("Per that instruction, I'm stopping here — what would you like to do next?").

## 2. Verification

1. `cd plugins/wait-tool && pnpm install && pnpm check && pnpm typecheck`.
2. End to end (needs a model with tools, so **not** the standing preview —
   its default model has none): a throwaway home with forwarded credentials.
   ```sh
   H=/tmp/wait-tool-home; mkdir -p $H /tmp/wait-tool-ws
   cp ~/.dsh/settings.yaml ~/.dsh/.credentials.yaml $H/
   cat > /tmp/wait-tool-overlay.yml <<'YML'
   - insert:
       - id: tali-wait-tool
         name: '<plugins>/plugins/wait-tool/index.js'
         config: { maxSeconds: 600 }
   YML
   cd <dsh-src>
   SSH_TTY=/dev/preview DSH_HOME=$H pnpm dsh --profile web --patch /tmp/wait-tool-overlay.yml --port 3090 --no-open
   ```
   `SSH_TTY` keeps the workspace picker in the browser (otherwise "Add
   workspace" opens a native `osascript … choose folder` dialog the agent
   cannot see — `pkill -f "choose folder"` if it already did). Open the
   tokened URL printed on stdout in a `chrome_*` window, Add workspace → Edit
   path → `/tmp/wait-tool-ws` → Open, **click the composer and type** (a
   `fill` does not reach React), send `Please wait 25 seconds (reason: "trial"),
   then tell me exactly what the wait tool returned.` — then repeat with a
   longer wait and click Skip, again and click Abort, again and press Stop
   generating. Check `document.querySelectorAll('[data-tool="wait"]')`:
   `data-tool-state` and the `.tali-wait-fill[data-outcome]` width.
3. The trial's four rows read: `waited 25 s` (full bar) · `skipped after 13 s
   of 2 min` (11 % accent) · `aborted by user after 10 s of 1 min 30 s` (red)
   · `interrupted after 4.2 s of 1 min` (amber).

## 3. Facts learned (verify against the checkout before relying on them)

- **`defineTool` output schema is the author DSL**, not JSON Schema: object
  properties carry `required: true` each; a `required: [...]` array throws
  `UNSUPPORTED_SCHEMA` at registration (`packages/core/tools/src/schema.ts`).
  `defineTool` also validates the *arguments* first — a non-finite or
  non-number `seconds` is `INVALID_ARGS` before the body sees it.
- **Cancellation vs. a rejecting body.** `dispatchToolBody`
  (`packages/core/tools/src/index.ts`) replaces the outcome with the canonical
  `ABORTED` result only when the body *resolved* after the signal fired; a body
  that rejects keeps its own error (`toolErrorResult(error)`). The web GUI's
  cancel aborts the signal with a **plain object**, so rejecting with
  `signal.reason` logged `Error: [object Object]` and no `error.code`. Fix: the
  registry throws `WaitError('tool call aborted', 'ABORTED')` itself.
- **`HarnessError` must come from `@deepseek-ai/dsh-llm`** (link dependency),
  as fs-tools found; `instanceof` matched in the live run (`error.code`
  reached the client), so the src/lib duplicate-module trap did not bite here.
- **`ctx.connection.fetch` routes take POST** (`ConnectionFetchMethod = 'GET' |
  'HEAD' | 'POST'`, `packages/client/connection/src/rpc.ts`); `requestBody:
  'buffered'` is mandatory or the node:http bridge 400s a GET.
- **The running block carries `time`** (`RunningToolCall.time`, epoch ms of
  the `tool/call` event) and the settled node carries `callTime` and `time`,
  so a toolview can show elapsed time with no host help; the status route
  exists only for the server-clock offset.
- **The session id the browser sees** (`PropsRuntime<'tool.call.toolview'>`
  → `sessionId`, e.g. `session-fe60…`) equals the agent's `session.id` /
  `agent.id` for a root agent — the status route answered 200 in the trial.
- **`DisclosureRow`'s leading box is 16 px** — one glyph. Keep state in the
  content, not in a second icon.
- Only tools that declare `timeoutMs` get a deadline
  (`packages/guard/timeout-policy`); a one-hour wait is not cut short by any
  default.

## 4. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Row shows `Error: [object Object]` after Stop generating | Pre-fix build rejecting with `signal.reason`; rebuild/restart — the body now throws a coded `ABORTED` WaitError. |
| Skip/Abort do nothing, network shows `403` | The browser's `sessionId` is not among the call's `sessionIds` — a subagent's call viewed from another session. Verdicts must come from the session that owns the call. |
| `404` on the control route | Already settled (double click, or the timer fired first). Harmless. |
| Bar sits at 0 s | Status fetch failed *and* `block.time` missing — check the console for the fetch and that the host row loaded (`grep wait-tool` in the server log: `wait-tool: registered wait`). |
| Registration fails with `UNSUPPORTED_SCHEMA` | Someone re-added a `required: [...]` array to `output.schema`. |
| A `dsh.client` row boots with a missing `lib/client.js` → boot failure | Run `pnpm install` / `pnpm build` in the plugin first. |

## 5. Not done / ideas

- No **custom message with Abort** (a text field "why?"); the model asks
  instead, which was the intent.
- No PTC (`run_code`) path was exercised — a sub-dispatched `wait` has a
  `parentCallId`; the toolview should still render (same key), unverified.
- Adoption measurement: after a week in a profile, `transcript_tool_stats`
  over `bash` calls matching `sleep` vs `wait` calls.
