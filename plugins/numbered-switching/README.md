# tali-numbered-switching

The **five most recently viewed sessions** hold the numbers **1–5**, shown in
the sidebar gutter left of their titles. **⌘1…⌘5** (Ctrl+digit off macOS)
switch to the holder of that number.

```
  dummy2
1 ● gamma session          5min
5   beta coding session    5min
  ● Remote session          5min        ← not in the recent five
2   Hello                  5min
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
| `index.ts` | `apply`: follows the selection, owns the state, installs the keydown capture, wires the badges. |
| `badges.ts` | DOM reconciler that draws the numbers on the sidebar rows. |

**Current session.** ui-workspace keeps the selection private (its
`UiWorkspaceService.selection` store), but the Session Controller list
exposes it as local reference counts: the current session is the one row with
`retainedBy.mainView > 0` — the same derivation the Workspace browser uses
for its row highlight. The plugin subscribes to `sessions.list` (and
`workspaces.list` for `archivedSessionIds`) and turns every change of that id
into one `touch`.

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
onto the rendered rows, like `session-title-slug` does. The row DOM carries no
session id and rows are ordered by manual order or recency, so each row is
mapped to its session through **React's fiber expando** (`__reactFiber$…` on
the row → walk `.return` to `SessionNodeItem` → `props.node.id`; stable since
React 16), with a fallback to the `_title` text when it names exactly one
listed session and exactly one visible row. A `MutationObserver` re-applies
after React re-renders (one reconcile per frame; a timer stands in for rAF
while the document is hidden, because a background window gets no frames).

Geometry: a session row is `padding-inline-start: calc(8px +
var(--dsh-workspace-indent))` then a 16px status slot then the title; the
badge is `position: absolute` over exactly that padding box (`width:
calc(8px + var(--dsh-workspace-indent, 0px))`), so the digit sits in the
gutter left of the status dot and the row's own layout is untouched. Rows
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
| Badges in the wrong place | Rows.module.css changed the row padding / `--dsh-workspace-indent`; adjust `STYLE_TEXT` in `badges.ts`. |
| Numbering reset after ⌘R | `sessionStorage` unavailable (private mode) — numbering is per window and best-effort. |
| A New Session row shows a number but the session is not in its Workspace | The blank session already held a slot when + reused it — by design (same id). |
