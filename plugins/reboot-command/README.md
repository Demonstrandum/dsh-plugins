# tali-reboot-command

`/reboot` restarts **this** `dsh web` server from inside a session — the same
graceful SIGTERM-to-self the Tailscale-remote Server pane's *Restart* sends,
with the confirmation, the interruption list and the "wait until idle" option
that pane does not have.

```
/reboot            → the dialog (bare invocation; also from the / menu)
/reboot now        → interrupt whatever is running and reboot
/reboot wait       → arm: reboot once every session is idle for 2 s
/reboot cancel     → drop an armed reboot
/reboot status     → one-line status as a command card (same as bare on a
                     client without the browser half)
```

Whether a reboot is a **restart** or a **quit** depends on what fronts the
process: with the always-on relay of `dsh-tailscale-remote` the next
connection starts `dsh web` again and the page comes back through *Starting
DSH…*; without it DSH just stops. The dialog and the command reply say which.

## What the dialog shows

- **Relay verdict** — restart (relay LaunchAgent loaded, pid) · quit (no
  relay configured, or its LaunchAgent not loaded) · unknown (the
  `dsh-tailscale-remote` plugin is not loaded on this server).
- **Sessions with work in flight**, polled once a second: each with its
  sidebar title, workspace, and the blockers a reboot would interrupt —
  *a turn is running*, *N queued messages*, *N background jobs: labels*,
  *N subagents loaded, k running* (the Host's own `session/move-live`
  vocabulary from `session-controller/src/move.ts blockersOf`, plus the
  queue). "(this session)" marks the one you typed in; a subagent row says
  whose it is.
- **Armed state** — a when-idle reboot is host-side, so it survives closing
  the dialog or the tab and is visible from every client; the banner names
  when and from which session it was armed.

Buttons: **Cancel** · **Wait for N, then reboot** / **Reboot when idle** ·
**Interrupt N and reboot now** / **Reboot now** (red when it interrupts). While
armed: **Close** · **Cancel armed reboot** · **Interrupt N and reboot now**.

After firing, the dialog stays up ("Rebooting DSH…") and brings the page back
itself: it waits until a status poll fails (the process is gone), then every
2 s pokes the relay's loopback URL and probes its own origin, reloading once
that answers with anything but the relay's 503 splash. The relay poke matters
for a page served straight from dsh's port (`http://127.0.0.1:<port>/`): the
relay starts DSH on the next connection to **it**, which would otherwise be
whenever the Dock app or a tailnet client reconnects. `reload-on-restart`, if
installed, reloads too; the two are idempotent.

## Pieces

| File | Half | Role |
|---|---|---|
| `reboot.mjs` | host, no Cordis | `busySessions()`, `describeBlockers()`, `parseArgs()`, `RebootController` (arm / cancel / now; 1 s poll + 2 s idle grace) — unit-tested in `tests/` |
| `index.js` | host | `ctx.commands.register('reboot')`; control channel `POST /reboot-command/{status,now,wait,cancel}` behind DSH's request gate; `agent/status` → re-evaluate; optional `ctx.inject(['tailscaleRemoteRelay'])` for the relay facts (5 s cache — `launchctl print` per poll would be wasteful) |
| `src/client/index.tsx` | browser | `commandUi.decorate({ name: 'reboot', ui: { kind: 'action' } })` so the bare command opens the dialog; the dialog itself in the `shell.overlay` slot |

The control channel is the same `client-request` / `server-response`
envelope `dsh-tailscale-remote` and `import-api-keys` use, gated by
`ctx.connection.requestRejection(req)` (Host/Origin fence + browser-session
cookie), so the proxy forwards it for any admitted connection.

## Relay coupling (optional)

`dsh-tailscale-remote` provides `ctx.provide('tailscaleRemoteRelay', {
instance, configured, wakeUrl, status() })`. This plugin injects it
*optionally* (`ctx.inject([...], scoped => …)`, not top-level `inject`), so
it loads with or without the sibling; absent → "unknown" verdict, no wake
poke. Both are host halves: after changing either, restart `dsh web` (the
preview: `launchctl kickstart -k gui/$UID/io.github.taliesinb.dsh-web-relay.preview`).

## Caveats

- Interrupted sessions resume **cold** on the new process, like a forced
  move; a pending `ask_user_question` / approval in them is lost and has to
  be asked again (`recipes/client-bundle-rebuild-kills-pending-prompts.md`).
- The reboot fires 400 ms after the reply so `command/done` and the RPC
  response land first. The SIGTERM path is `dsh web`'s ordinary graceful
  shutdown — the same one the relay uses.
- On a **direct-remote** page (`dsh-remote-workspaces` frame, DSH Remote
  app) the command reboots the server the page is connected to, i.e. the
  remote — the dialog names pid, port and `DSH_HOME` so that is visible.
- Developing the browser half against the **live** profile hot-swaps the
  live GUI; trial in the preview (recipe: `recipes/reboot-command.md`).

## Build / test

```sh
pnpm install          # links the checkout, builds lib/client.js (prepare)
pnpm test             # node --test tests/*.test.mjs (the controller/model)
pnpm typecheck        # tsc against the checkout's d.ts
pnpm watch            # rebuild lib/client.js on save (hot-swaps the preview)
```
