# `/reboot` — restart the DSH server from inside a session

Status: **built and verified end-to-end on the preview server 2026-09-23**
(8 model unit tests; in the preview GUI: dialog opens from the bare `/reboot`,
a running turn shows up as a blocker, **Wait** armed → the turn finished → the
process exited cleanly → the relay started it again → the page reloaded; then
**Reboot now** from a direct `127.0.0.1:3088` page, same comeback). **Not yet
installed into the live web profile** — see §6 for the two steps that need
(the tailscale-remote host half changed too). Plugin README:
[`plugins/reboot-command/README.md`](../plugins/reboot-command/README.md).

## 0. Why

Host-module edits need a `dsh web` restart (`AGENTS.md` → Host plugins: a
patch-row reload re-runs `apply` from Node's module cache). An agent that just
changed a host plugin cannot restart the server unprompted, and the maintainer's own way
to do it was Settings ▸ Tailscale remote ▸ Server pane ▸ *Restart* — blind:
no word about which sessions have a turn, a background job or a subagent in
flight, and no way to say "as soon as they are done". The maintainer asked (2026-09-23)
for a `/reboot` slash command: "are you sure?", the list of sessions whose
turns would be interrupted (polled), and a **Wait** button that reboots once
every session is idle.

## 1. What existed already (the survey)

- **No `/reboot` anywhere.** In-tree the only host slash command is
  `/compact` (`packages/compaction/command-compact`); `/file`, `/model`,
  `/feedback`, `/permission` are browser-side `commandUi` contributions or
  decorations. None of the 20 plugins here registered a command.
- **The restart action existed** in `dsh-tailscale-remote`'s Server pane:
  `server.mjs performAction('dsh/restart')` → answer the RPC, 400 ms later
  `process.kill(process.pid, 'SIGTERM')`; the relay
  (`io.github.taliesinb.dsh-web-relay[.preview]`) starts `dsh web` again on
  the next connection to it. `/reboot` fires the exact same thing.
- **The interruption logic existed as a pattern**, not a service: the Host's
  session move (`packages/api/session-controller/src/move.ts`, private
  `blockersOf(agent)`) refuses a live session with `session/move-live` and
  three blockers — `agent.status === 'running'` (turn), `ctx.get('jobs').list(agent)`
  running/stopping (jobs), `ctx.agents.isOwnedBy(child, agent)` (subagents,
  with a running count) — which `ui-workspace/rows/MoveDialogs.tsx` renders.
  It is evaluated once per move; `/reboot` needed it polled over every live
  agent, so `reboot.mjs busySessions()` re-implements those 15 lines over the
  same public services (`ctx.agents.list()`, `jobs`) and adds
  `agent.inbox.nextTurn.length` as a *queue* blocker (a queued follow-up would
  otherwise be lost silently, and "Wait" would fire between two turns).

## 2. Design decisions (the maintainer's answers, 2026-09-23)

| Question | Choice | Why |
|---|---|---|
| Command shape | **host command + client decoration** (not a client-only contribution) | logged as `command/run`/`command/done` like `/compact`; `/reboot now|wait|cancel` works typed anywhere, phone UI included; the bare `/reboot` gets the dialog via `commandUi.decorate` |
| Relay awareness | **optional inject from dsh-tailscale-remote** (not a `launchctl` shell-out here) | one owner of the LaunchAgent facts; `ctx.provide('tailscaleRemoteRelay', …)` there, `ctx.inject(['tailscaleRemoteRelay'], scoped => …)` here — the "absent is not gone" pattern from `numbered-session-switching-plugin.md`, so the plugin loads without the sibling and says "unknown" |
| Where "Wait" lives | **host-side armed state** | survives closing the dialog or the tab; every client sees the banner; `agent/status` + a 1 s poll re-evaluate; fires after 2 s of nobody busy |
| Comeback | dialog probes and reloads itself, **poking the relay's loopback URL** | a page served straight from dsh's port (`127.0.0.1:<port>`, like the local GUI) never goes through the relay, and the relay starts DSH only on a connection to *it* — without the poke the restart waits for the Dock app / a tailnet client to reconnect |

## 3. Pieces

- `plugins/reboot-command/reboot.mjs` — Cordis-free model: `busySessions`,
  `describeBlockers`, `parseArgs`, `RebootController` (injected `fire`,
  `now`, timers → `tests/reboot.test.mjs`, 8 tests).
- `plugins/reboot-command/index.js` — host: `inject = ['webServer',
  'connection', 'commands', 'agents']`; `ctx.commands.register({ name:
  'reboot', input: { hint: 'now | wait | cancel' }, handler })`; control
  channel `POST /reboot-command/{status,now,wait,cancel}` (the
  `client-request`/`server-response` envelope behind
  `ctx.connection.requestRejection`, as in `import-api-keys`); relay facts
  cached 5 s (`launchctl print` per 1 s poll would be silly).
- `plugins/reboot-command/src/client/index.tsx` → `lib/client.js` — the
  decoration + the `shell.overlay` dialog (Modal/Button from ui-primitives;
  session titles from `ctx.sessions.list.getSnapshot().byId[id].displayTitle`,
  so the host returns ids only).
- `plugins/dsh-tailscale-remote/index.js` — new `ctx.provide('tailscaleRemoteRelay',
  { instance, configured, wakeUrl, status() })` right after `relaySpec`.
- `cordis.dev.yml` — row `tali-reboot-command` (preview trial);
  `tools/install-plugins.sh` — `reboot-command` appended to the live set.

## 4. Verification (preview server, `~/.dsh-preview`, port 3088)

```sh
# compose without booting
cd ~/github/tali-dash-plugins/deepseek-harness
DSH_HOME=~/.dsh-preview pnpm dsh --profile web --patch ~/github/tali-dash-plugins/cordis.dev.yml --dump-config | grep reboot
# restart the preview (host rows are not hot-reloaded; this also loads the
# changed tailscale-remote host half)
launchctl kickstart -k gui/$UID/io.github.taliesinb.dsh-web-relay.preview
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3085/   # any request makes the relay start DSH; 401 = up
```

Then in Chrome at `http://127.0.0.1:3088/?token=…` (token: last line of
`~/.dsh-preview/logs/dsh-web-preview.log`):

1. `/reb` → the slash menu lists *reboot — Restart this DSH server…*; picking
   it (bare) opens the dialog: pid/port/`DSH_HOME`, "The relay is in front
   (LaunchAgent pid …)", "No session has work in flight".
2. Make a session busy in a way that outlives the poll: *"Run exactly this
   bash command and nothing else, then reply 'done': sleep 60"* (a plain
   story prompt finished before the dialog was open). `POST
   /reboot-command/status` from the page console →
   `busy: [{ sessionId, blockers: [{ kind: 'turn' }] }]`; the dialog shows
   *lighthouse-keeper-story (this session) ~/projects/dummy2 — a turn is
   running*, buttons *Wait for 1, then reboot* / *Interrupt 1 and reboot now*.
3. **Wait** → banner *A when-idle reboot is armed (since 12:56:30 PM, from
   lighthouse-keeper-story)…*; buttons become *Close* / *Cancel armed reboot*.
   The turn ended at 12:57 → relay log: `dsh web exited (code 0, signal null)
   after 203s` then `started dsh web (pid …)` in the same second → the page
   came back as `performance.navigation.type === 'reload'` with a new server
   pid.
4. **Reboot now** on the idle server → the evaluate script that clicked it
   died with "Execution context was destroyed … navigation" (the reload) and
   the page came back on a third pid within ~10 s.
5. `/reboot status` typed → a command card in the chat: *No session has work
   in flight. No reboot is armed. The relay is in front… Usage: …*.

6. **Second pass on the copy** (the maintainer's screenshots of the first cut): dropped
   the pid/port/`DSH_HOME` paragraph, the always-present relay line and the
   "also: /reboot now…" footer (the `/` autocomplete lists those anyway);
   idle state is one info callout *Safe to reboot — no session has work in
   flight*; busy header *Rebooting now would interrupt:*; **Reboot when
   idle** hidden while nothing is busy; **Interrupt N and reboot now** →
   **Reboot now** (still red when busy); armed footer *Close · Cancel ·
   Reboot now*. Re-verified all three states in the preview; the armed reboot
   fired again on the turn's end (relay log: `started dsh web (pid 94564)`).

The model-facing `logger.info` lines of host plugins do not appear in
`dsh-web-preview.log` (only the CLI's own two lines land there); behaviour and
the relay log were the evidence.

## 5. What did not work / traps

- `tsc`: `Property 'slots' does not exist on type 'Context'` — the browser
  `ctx.slots` declaration rides `@deepseek-ai/dsh-client-ui-renderer/client`,
  so that package is a `link:` devDependency and a `import type {}` line even
  though nothing is imported from it (same for `ui-commands/client` →
  `ctx.commandUi`, `ui-layout/client` → the `shell.overlay` slot name).
- The first "busy" attempt used a story prompt; Haiku finished it in 11 s,
  before the dialog polled — hence the `sleep 60` tool call.
- `React.ReactNode` without a `React` import fails under `types: []`; import
  `type { ReactNode } from 'react'`.
- Host `logger.info` output is not in the relay's DSH log; do not wait for
  it as a readiness signal.

## 6. Installing into the live profile (not done yet — the maintainer's call)

Two host halves changed, and the live server only picks host code up on
restart, so the order is:

```sh
cd ~/github/tali-dash-plugins
dsh plugin --profile web add ./plugins/reboot-command      # or: pnpm install-plugins (whole live set)
# then restart the live server once BY HAND (Server pane ▸ Restart, or
# launchctl kickstart -k gui/$UID/io.github.taliesinb.dsh-web-relay) — this
# loads both the new plugin and tailscale-remote's tailscaleRemoteRelay face.
# From then on: /reboot.
```

Never keep the `cordis.dev.yml` row and a bundle install for the same home —
duplicate id fails the boot; the preview keeps the row, the live home the
bundle.

## 8. `if-idle`: the administrative form (2026-09-24)

A fleet redeploy (several DSH instances on a shared machine, one per account)
needs to restart a server only when that interrupts nobody. `/reboot now`
interrupts and `/reboot wait` arms, so a third form was added:

- `/reboot if-idle` (also `safe`) and `POST /reboot-command/if-idle`
  (Connection envelope like the other endpoints): the server re-checks
  `busySessions()` and restarts itself only if the list is empty; otherwise
  `ok: false`, code `reboot-command/busy`, `details.busy[]` = sessions with
  blockers (`turn` / `queue` / `jobs` / `subagents`) and the status snapshot.
  Never arms, never interrupts. `RebootController.rebootIfIdle()`, tested.
- Who may ask: DSH's admission, i.e. over the tailnet any login on the
  instance's allowed-user list (the `dsh-tailscale-remote` proxy forwards
  admitted requests to every non-control path). The allowed-user list can be
  changed live through the plugin's `set-users` control endpoint from the
  host itself (loopback + launch-token cookie), no restart.
- The private deploy tooling drives a whole host with it: a status script
  joins `GET /api/transcript/v1/sessions` (session-introspect: attached /
  running, workspace, title) with `POST /reboot-command/status` (blockers)
  into a per-server SAFE / BUSY verdict, and the sync script's
  `--restart-safe` asks `if-idle` after installing, leaving busy servers on
  the old code (they pick it up at their next restart). Details and the host
  inventory live in the private extras notes, never here.

## 9. Enter confirms, Escape cancels (2026-09-24)

Reported from the Dock app: Enter on the open `Reboot DSH?` dialog did
nothing. Cause, in the shipped `Modal`
(`packages/client/ui-primitives/src/Modal.tsx`): it turns Escape into
`onClose` through a document listener, but it neither handles Enter nor moves
focus into the dialog, so after a slash command the keyboard stays in the
composer behind the mask (the command popup's settle path even re-focuses
Lexical asynchronously). In-tree dialogs only get Enter where an `<input>`
wires it itself (`MoveDialogs.tsx`), so button-only confirms had no default
action anywhere.

Fix — `src/client/dialog-keys.ts` (`useDialogDefaultAction(open, stage?)` +
`DIALOG_DEFAULT`, spread onto the one primary `Button`): on open, focus goes to
the default button, or to the dialog card (`tabindex=-1`) while that button is
disabled (the reboot dialog until its first status poll), retried at 0/50/200
ms to outlast Lexical's refocus; Enter clicks the default button through the
DOM (`button[data-dialog-default]` inside the topmost
`[role=dialog][aria-modal]`), so a disabled button means Enter does nothing,
exactly like a click; focus returns to where it was when the dialog closes.
Enter is left alone on a focused button/link (the browser clicks *that*),
inside a textarea/contenteditable of the dialog, on menu/listbox rows or while
a shipped `Menu` popup is open, during IME composition, with Shift/Alt/Ctrl,
and whenever a handler already called `preventDefault` (inputs with their own
Enter → confirm keep working, no double fire). The shipped `Button` is not
`forwardRef` (React 18), hence the data attribute instead of a ref.

The same survey found the other plugin dialogs with a default button and no
Enter, and the identical file was copied into each (each plugin bundles its
own client; keep the copies in sync): `import-api-keys` (Import, both OK
cards), `import-sessions` (Import N, Close; the pick stage's path input keeps
its own Enter → Scan), `dsh-remote-workspaces` (Rename workspace, Remove
workspace, Move/Copy — Rename session and Add remote already handled Enter in
their inputs). The two screenshot Lightboxes and the QR popover have no default
action; Escape already closed them.

Verified on the preview with `import-sessions` (the only one of the four not
pnpm-linked into the live profile, so its rebuild hot-swaps nothing live):
focus lands on the card at the pick stage, Enter with the default disabled is
a no-op, Enter from a ticked checkbox clicks *Import 1 session* exactly once
(a capture-phase `click` probe with `stopImmediatePropagation` stood in for
the real import), Shift+Enter nothing, Enter on the focused *Back* button
clicks Back, Escape closes and the composer has the caret again.

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Slash menu has no *reboot* | host half not loaded (row missing, or added without restart) | check `--dump-config`; restart the server |
| Dialog says "No relay plugin is loaded" although tailscale-remote runs | tailscale-remote's host half predates the `tailscaleRemoteRelay` provide | restart the server once by hand |
| Dialog says the relay LaunchAgent is not loaded | `launchctl print gui/$UID/<label>` fails | install it from Settings ▸ Tailscale remote, or `launchctl bootstrap` the plist (`dsh-tailscale-remote/README.md`) |
| "Rebooting DSH…" never turns into a reload | page origin is not the relay and the relay poke is mixed-content-blocked (https page → http loopback), or nothing fronts DSH | open the relay/tailnet URL, or start `dsh web` by hand |
| Armed reboot never fires | a session keeps a running background job or a loaded subagent (both are blockers by design) | open the dialog: the list names it; kill the job or use *Reboot now* |
| Enter in the dialog does nothing | *Reboot now* is still disabled (first status poll pending, or an action in flight); or an old `lib/client.js` (before §9) | wait a beat; rebuild the plugin (`pnpm build`) — the live bundle hot-swaps |
