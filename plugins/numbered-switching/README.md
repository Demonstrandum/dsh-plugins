# tali-numbered-switching

The **five most recently viewed sessions** hold the numbers **1–5**, shown in
the sidebar's status column (the one the Workspace folder icon sits in) left
of their titles. **⌘1…⌘5** (Ctrl+digit off macOS)
switch to the holder of that number.

```
📂 dummy2
 1 gamma session          5min        ← digit green: finished while you were away
 5 beta coding session    5min
 ● Remote session          5min        ← not in the recent five
 2 Hello                  5min
```

## Rules

- **Stable numbers.** A session keeps its number for as long as it stays in
  the recent set; switching around with ⌘N or by clicking never renumbers
  anything, it only refreshes recency.
- **LRU eviction.** Opening a *novel* session — by click, search result or
  **New Session (+)** (⌘N only ever reaches holders) — seats it in the first
  empty slot; when all five are taken it takes the slot of the holder viewed
  **longest ago**. A New Session that is later sent keeps its number (same session id;
  the title just changes).
- **Gone means free.** A holder that is archived or otherwise disappears
  from the session list frees its slot.
- **Empty slot** → the chord is claimed but nothing happens.
- Pure browser state: nothing is written to the host. The slot table lives in
  `sessionStorage` (per window; survives ⌘R, dies with the window).

## Remote workspaces

With [`dsh-remote-workspaces`](../dsh-remote-workspaces/README.md) loaded,
sessions of mirrored remote hosts take part exactly like local ones: viewing
one numbers it, it evicts and gets evicted by the same LRU rule, its badge is
drawn on the remote row, and ⌘N brings its frame back (the remote panel).
Slot keys are `local:<sessionId>` and `remote:<workspaceId>:<sessionId>`
(`src/client/targets.ts`).

The coupling is optional and runtime-only: the remote plugin provides the
browser Cordis service `ctx.remoteWorkspaces` (`getSelection` / `has` /
`open` / `subscribe`) and stamps its rows with `data-remote-session`;
numbered-switching consumes it through `ctx.inject(['remoteWorkspaces'], …)`,
which runs only while that service exists. Without the remote plugin nothing
changes. While it is absent — not installed, or gone for a moment during a
bundle hot-swap, or not yet up at boot — remote holders are *kept* (unknown
is not gone): they show no row and ⌘N does nothing for them until the plugin
returns or the LRU rule evicts them. They are pruned only on positive
evidence from `has()`.

Embedded shells (`?embed=<id>`, what a remote frame is) run this plugin too
but bail out in `apply`: the frame is a same-origin iframe and shares the
tab's `sessionStorage`, so an active framed instance would overwrite the
outer window's table.

## Where the chord works

| Surface | ⌘1…⌘5 reach the page? |
|---|---|
| **DSH Dock app** (`~/Applications/DSH.app`, the WKWebView wrapper from `dsh-tailscale-remote`) | **yes** — its menu bar defines no ⌘digit equivalents, so AppKit hands the chord to the web view. Verified with real `CGEvent` keystrokes posted to the app. |
| Chrome | no — ⌘1…⌘8 select tabs, ⌘9 the last tab; never delivered to web content |
| Safari / Safari web app | no — ⌘1…⌘9 open Favorites (or tabs, per preference) before WebKit sees them |
| Electron `apps/desktop` | untested; nothing in its menu claims ⌘digit, so it should work |

Badges are drawn everywhere regardless — they are a useful "recent five"
marker even where a browser owns the chord — and the plugin claims the chord
wherever it *does* arrive.

## How it works

Browser-only plugin (`dsh.client.platform: web`); `index.js` (host half) just
logs. `src/client/`:

| file | role |
|---|---|
| `slots.ts` | pure slot model: `touch` (seat/bump with LRU eviction), `prune`, `slotOf`/`holderOf`, `restoreSlotState` (sessionStorage validation). Unit-tested. |
| `targets.ts` | slot-key codec: `local:<id>` / `remote:<ws>:<id>`. Unit-tested. |
| `index.ts` | `apply`: follows the selection (local + optional remote), owns the state, installs the keydown capture, wires the badges and the panel watcher. |
| `badges.ts` | DOM reconciler that draws the numbers on the sidebar rows (local and remote). |

**Current session.** ui-workspace keeps the selection private (its
`UiWorkspaceService.selection` store), but the Session Controller list
exposes it as local reference counts: the current session is the one row with
`retainedBy.mainView > 0` — the same derivation the Workspace browser uses
for its row highlight — counted only while no global main panel is showing
(`usePanelInfo().activePanelId === null`, read by a renderless
`shell.overlay` entry), so Settings or a remote frame covering the retained
local session does not make it "viewed". The plugin subscribes to
`sessions.list` (and `workspaces.list` for `archivedSessionIds`, and the
remote service when present) and turns every change of the current key into
one `touch`.

**Switching.** `ctx.uiWorkspace.openSession(id)` — the same verb a row click
runs (one UI navigation action; it also returns the main view to the
Conversation when a panel such as Settings is showing).

**Chord.** One capture-phase `keydown` listener on `window`: primary modifier
only (⌘ without ⌃ on Apple, ⌃ without ⌘ elsewhere; no ⌥/⇧; not `repeat`),
digit from `code` (`Digit1…`, `Numpad1…`) or `key`, so a non-Latin/AZERTY
layout and the keypad both work. `preventDefault` + `stopPropagation` before
any editor keymap sees it.

**Badges (DOM patch).** There is no per-row slot in the Workspace browser
(its only row seam is `contributeSessionMenu`), so the numbers are patched
onto the rendered rows, like `session-title-slug` does. A remote row is
identified by its `data-remote-session` attribute. The local row DOM carries
no session id and rows are ordered by manual order or recency, so each local
row is mapped to its session through **React's fiber expando**
(`__reactFiber$…` on the row → walk `.return` to `SessionNodeItem` →
`props.node.id`; stable since React 16), with a fallback to the `_title` text
when it names exactly one listed session and exactly one visible row. A `MutationObserver` re-applies
after React re-renders (one reconcile per frame; a timer stands in for rAF
while the document is hidden, because a background window gets no frames).

Geometry: a local session row is `padding-inline-start: calc(8px +
var(--dsh-workspace-indent))` (`depth * 12px`, 0 under a top-level
Workspace), a remote row `padding: 0 8px`; then a 16px status slot then the
title. The Workspace header has the same padding and a 16px icon slot, so the
digit goes **on the status slot** to line up with the folder/chevron: the
badge is a 16px-wide `position: absolute` span offset by the row's computed
`padding-inline-start` (read at reconcile time). The row's own layout is
untouched.

Status under a digit: whatever the slot shows (`StateDot`, the ongoing
pixel-chase, a remote running dot or spinner) is hidden (`visibility`,
marked `data-tns-hidden`, restored when the badge goes) and the digit takes
over its `data-state` color — green done, amber warning, red error, blue
*pulsing* ongoing — with the same tokens as `StateDot.module.css`. The hover
card still spells the status out. Rows
carry `data-tns-positioned` while badged (inline `position: relative`, the
value Rows.module.css already uses for drag markers) and the badge is
`<span data-tns-badge aria-hidden title="⌘3">3</span>`. Colours are the
shell's `--dsw-alias-label-tertiary` / `-secondary` (selected row).

Skipped rows: ghost rows from session-title-slug (`[data-tdsn-ghost]`,
fiber-less clones) and search results (`<button role="treeitem">`, whose
fiber carries `result`, not `node`).

## Build / test

```sh
cd plugins/numbered-switching
pnpm install && pnpm build && pnpm typecheck && pnpm test   # -> lib/client.js (gitignored; must exist before the server boots)
```

Trial on the standing preview (`PREVIEWING.md`): the row is in
`cordis.dev.yml`; `launchctl kickstart -k gui/$UID/io.github.taliesinb.dsh-web-relay.preview`,
open `https://laptop.example.ts.net/dsh-preview/` (or
**DSH Preview** in the Dock). Console shows
`[numbered-switching] ⌘1…⌘5 switch between the 5 most recent sessions`.

Live install: an absolute-path row in `~/.dsh/profiles/web/cordis.patch.yml`
(hot-reloads; then reload the page once — an open page only fetches bundles
listed in the boot graph it started with):

```yaml
    - id: tali-numbered-switching
      name: '/Users/USER/github/tali-dash-plugins/plugins/numbered-switching/index.js'
```

## Knobs

`SLOT_COUNT` in `src/client/index.ts` (default 5, max 9 — ⌘digit only has
nine). No runtime config.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Chord does nothing in Chrome/Safari | Expected: the browser owns ⌘digit. Use the Dock app. |
| No badges, console line present | Row→id mapping failed: React renamed its fiber expando or `SessionNodeItem` lost its `node` prop; the title fallback then only badges unique titles. Check `fiberSessionId(row)` in the console (`Object.keys(row)` should contain `__reactFiber$…`). |
| Badges in the wrong place | The badge sits on the 16px slot after the row's leading padding; if Rows.module.css moved or resized the status slot, adjust `SLOT_WIDTH_PX` / `setBadge` in `badges.ts`. |
| A numbered running session shows no dot | By design: the digit pulses blue instead (`data-state="ongoing"`); green/amber/red likewise replace the dot. |
| Remote rows never get a badge | Remote plugin absent, or `data-remote-session` missing from its rows (contract in its README). Console shows `remote workspaces joined the numbering` when the service was found. |
| Remote slots vanish after ⌘R or a rebuild | Should not happen since the unknown-keeps rule; check `has()` in the remote plugin's `index.tsx` still returns true before the first snapshot. |
| Numbering reset after ⌘R | `sessionStorage` unavailable (private mode) — numbering is per window and best-effort. |
| A New Session row shows a number but the session is not in its Workspace | The blank session already held a slot when + reused it — by design (same id). |
