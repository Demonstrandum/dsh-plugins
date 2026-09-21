# Recipe: ⌘1…⌘5 between the five most recent sessions (`numbered-switching` plugin)

**Goal (the maintainer, 2026-09-21):** the five most recently viewed sessions acquire
stable numbers 1–5, drawn in the sidebar gutter left of the session name;
⌘1…⌘5 switch between them. Numbers stay put; a novel session (click, or
New Session +) evicts the least-recently-viewed slot. Browser-side only, no
host persistence. Supporting only the built-in macOS app was acceptable.

Plugin: `~/github/tali-dash-plugins/plugins/numbered-switching/` (README owns
the rules and mechanics; this recipe owns the system-level story, the
survey, and how it was verified).

## Survey: what the checkout offers (fork `feat/embed-session` @ `9384b80976`, rebased on upstream 0.1.6-alpha.2)

| Fact | Where |
|---|---|
| **Selection moved out of the Session Controller** in the rebase: `SessionListState` has no `current`; selection is `UiWorkspaceService`'s private `createSnapshotStore<MainSelection>` persisted as `dsh.sessions.current` (localStorage). | `packages/client/ui-workspace/src/client/navigation.ts` |
| The current session is still derivable from the list: the one row with `retainedBy.mainView > 0` (local reference-source counts; `mainView` is declared by ui-session). The Workspace browser highlights rows with exactly this. | `ui-workspace/src/client/rows/WorkspaceBrowser.tsx` `SessionTree`, `ui-session/src/client/index.ts` |
| Opening a session = `ctx.uiWorkspace.openSession(target)` — the row-click verb; `ctx.uiWorkspace` is a cordis service (inject `'uiWorkspace'`), typed through `import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'`. | `navigation.ts` `UiWorkspace` |
| No per-row slot: `sidebar.workspaces` is `single`; the only row seams are `sidebar.workspaces.headerAction`, `sidebar.workspaces.extra` (extra *groups*) and `contributeSessionMenu` (a menu item). | `ui-workspace/src/client/contract/slots.ts` |
| Session rows carry **no id** in the DOM (`div role="treeitem" aria-selected` + `[hash]_[local]` classes); order is manual or recency, so position is no key. | `rows/Rows.tsx` `SessionNodeItem`, `tree.ts` |
| React 18 leaves `__reactFiber$<rand>` on every host element; `row → .return ×3 → SessionNodeItem`, `memoizedProps.node = { id, title, blank, … }`. Measured chain: `div → span (HoverCard wrapper) → SC (HoverCard) → SessionNodeItem`. | runtime, verified in the preview |
| Row geometry: `padding-inline-start: calc(8px + var(--dsh-workspace-indent))` (`depth * 12px`, set on the group), then a 16px `.slot` holding the status dot, then the title (`margin: 0 6px 0 4px`). `.sessionRow` has a 150 ms `row-in` opacity animation on mount. | `rows/Rows.module.css`, `rows/WorkspaceBrowser.tsx:460` |
| DSH has no keybinding registry; a plugin installs its own capture `keydown` (same as `settings-shortcut`). | `recipes/settings-keyboard-shortcut-plugin.md` |
| **The "built-in macOS app" is the WKWebView Dock app** `~/Applications/DSH.app` (`dsh-tailscale-remote/dock-app/Sources/main.swift`). Its menu bar defines ⌘R/⌘0/⌘+/⌘−/⌘W/⌘Q/⌘H/⌘M/⇧⌘O/⇧⌘C/⌃⌘F — **no ⌘digit**, so AppKit's key-equivalent pass falls through to the web view and the page gets `keydown` with `metaKey`. | `main.swift` `buildMenu` |
| Chrome (⌘1–8 tabs, ⌘9 last tab) and Safari (⌘1–9 Favorites/tabs) consume ⌘digit before web content — unfixable from a page, like ⌘, . | browser behaviour |

Consequences: a browser-only client plugin, no fork change, no Swift change.
Selection tracking = subscribe to `sessions.list` and diff the `mainView`
holder; switching = `uiWorkspace.openSession`; badges = DOM patch with a
fiber-walk for row identity (title-text fallback).

## Remote workspaces (same day)

The maintainer: must play nicely with `dsh-remote-workspaces`, detected at runtime,
never required. Facts:

| Fact | Where |
|---|---|
| Remote selection is the remote plugin's persisted view store (`selected`, `remoteActive`); its rows are `div role="treeitem" aria-selected` too, click = `openRemoteSession` → `model.select` + `ctx.layout.selectPanel('remote-session')`. Switching back to a local session runs the shell's `openSession`, which resets the panel and flips `remoteActive` false (`FramePool` → `hideAll`). | `dsh-remote-workspaces/src/client/{store,ui,index}.ts*` |
| A browser plugin can `ctx.provide('name', value)` (function-form plugin, same as `ui-theme`'s `ctx.provide('theme', …)`); a consumer's `ctx.inject(['name'], scoped => …)` is a sub-plugin that starts when the service appears and is disposed when it goes — the idiomatic optional dependency, better than the slug plugin's `globalThis` convention. | `vendor/cordis/src/reflect.ts` `provide`, `registry.ts` `inject` |
| `activePanelId` is exposed only as the `usePanelInfo` root hook of slot components (`ctx.layout` has no observable) — read it with a renderless `shell.overlay` entry. | `ui-layout/src/client/index.ts:142` |
| Local session rows under a **top-level** Workspace have an **8px** gutter (`--dsh-workspace-indent` = `depth * 12px`, depth 0), not 20px as the first cut assumed; remote rows are `padding: 0 8px` — parity already. | `WorkspaceBrowser.tsx:460`, remote `ui.tsx` `S.sessionRow` |
| The remote frame is a **same-origin iframe** (`/remote/<id>/?embed=<sid>`) running the full shell incl. this plugin, and iframes share the tab's `sessionStorage`. | `dsh-remote-workspaces` README |

Design: the remote plugin provides `ctx.remoteWorkspaces` (`getSelection` /
`has` / `open` / `subscribe`) and stamps rows with `data-remote-session`;
numbered-switching keys slots as `local:<id>` / `remote:<ws>:<id>`
(`targets.ts`), injects the service optionally, and reads the badge width
from each row's computed padding. Two bugs the preview caught, both worth
remembering for any plugin with an optional sibling:

1. **"Absent" is not "gone".** The first cut pruned remote holders whenever
   the service was missing. A bundle hot-swap of the remote plugin removes
   and re-adds its service within one tick, and at boot it may come up after
   this plugin — both wiped the remote slots. Rule now: prune only on
   positive evidence (`has()` false with data loaded and the workspace
   fetched); unknown keeps the slot.
2. **The embedded shell runs your plugin too, on the same `sessionStorage`.**
   The framed instance saw its pinned session as current, pruned every other
   holder and overwrote the outer table. `apply` now returns immediately when
   `ctx.layout.embedSessionId !== undefined`. (Applies to the real remote case
   just the same — the frame is same-origin by design.)

Preview test without touching live: the preview mirrors **itself**
(`servers.probe` / `workspaces.add` on the control channel
`POST /remote-workspaces/<method>` with `payload: { args: {…} }`, url
`http://127.0.0.1:3085/` + the standing token from
`~/.dsh-preview/tailscale-remote-preview.json`; state persists in
`~/.dsh-preview/remote-workspaces.json`). Verified: remote rows take slots
and badges, LRU eviction across kinds, ⌘N brings the frame back
(`remoteActive` true), Settings open/close touches nothing, table stable with
three live frames after the embed guard.

## Design choices worth remembering

- **Badge in the padding box, not the status slot.** The 16px slot carries
  the running/pending/completed dot; replacing it would hide status. The
  digit is `position: absolute` over the row's indent padding
  (`width: calc(8px + var(--dsh-workspace-indent, 0px))`), so a depth-1 row
  shows it centred in a 20px gutter, left of the dot, and no layout shifts.
- **Slot table in `sessionStorage`**, not localStorage: per window, survives
  the ⌘R every plugin install needs, and two windows do not fight over one
  numbering. Nothing on the host.
- **Blank sessions take slots** (New Session + is a selection change). The
  slot survives the first prompt because the id does not change; only the
  title does.
- **Timer fallback for rAF.** A hidden document (background/occluded window)
  gets no animation frames, so the reconciler would never run and badges
  would be stale when the window is next seen. `document.hidden ? setTimeout : rAF`.

## Build / trial

```sh
cd ~/github/tali-dash-plugins/plugins/numbered-switching
pnpm install && pnpm build && pnpm typecheck && pnpm test
```

Row added to `cordis.dev.yml` (id `tali-numbered-switching`); preview via
`launchctl kickstart -k gui/$UID/io.github.taliesinb.dsh-web-relay.preview`,
`https://laptop.example.ts.net/dsh-preview/`.

**The preview relay LaunchAgent was missing** (its plist gone since the
2026-09-17 shutdown; `~/.dsh-preview` and `DSH Preview.app` were intact).
Reinstalled with PREVIEWING.md step 2 (`pnpm relay:install --instance
preview …` from `plugins/dsh-tailscale-remote`) — idempotent, preview-only.

## Verifying the real chord in the WKWebView app (reusable method)

A synthetic `KeyboardEvent` proves only the handler; the question was whether
AppKit hands ⌘digit to the page at all. Doing it with real keystrokes hit
two traps:

1. **System Events cannot tell the two Dock apps apart.** Both
   `DSH.app` (live) and `DSH Preview.app` run an executable named `DSH`;
   `first application process whose bundle identifier is "…preview"` and
   even `whose unix id is <preview pid>` **returned the live process** (its
   `bundle identifier` read back as the live one, its window listed the live
   sessions). Sending `keystroke` there would have hit the user's live GUI.
   **Never GUI-script "DSH" by name or by System Events filters.**
2. rAF/animations freeze in hidden windows (see above) — screenshots of the
   occluded STP window came back blank and newly mounted rows sat at
   `opacity: 0` (DSH's own `row-in` animation, badge or not).

What worked — a tiny Swift driver keyed strictly by **PID** (Accessibility
API + `CGEvent.postToPid`), source kept at `/tmp/ns-drive/drive.swift`
during the session; recreate from this sketch:

```swift
// drive <pid> texts | press "<row text>" | cmd <digit>
let app = AXUIElementCreateApplication(pid)              // AX tree of THAT pid only
// texts: walk kAXChildrenAttribute, print AXStaticText values  → sanity: dummy1/dummy2 = preview
// press: find AXStaticText == text, climb parents until AXPress is offered, AXUIElementPerformAction
// cmd:   CGEvent(keyboardEventSource:virtualKey: 18/19/20/21/23 for 1-5, keyDown:) with .maskCommand
//        → event.postToPid(pid)   (delivered through the app's normal sendEvent/menu path)
```

`AXIsProcessTrusted()` was true for a binary compiled and run from the agent's
shell (approvals disabled / `danger-full-access`). Observe the result without
JS access: the persisted selection is in the app's WebKit LocalStorage,

```sh
DB=$(find ~/Library/WebKit/io.github.taliesinb.dsh-dock-app.preview -name localstorage.sqlite3)
cp "$DB" /tmp/ls.sqlite3; cp "$DB-wal" /tmp/ls.sqlite3-wal   # WAL holds the latest rows
sqlite3 /tmp/ls.sqlite3 "select hex(value) from ItemTable where key='dsh.sessions.current'" \
  | xxd -r -p | iconv -f UTF-16LE -t UTF-8        # → {"sessionId":"session-…"}
```

Result (2026-09-21, `DSH Preview.app`, pid-targeted): pressing two rows
seated slots 2 and 3; posted ⌘2 / ⌘3 / ⌘1 each changed `dsh.sessions.current`
to the expected holder; ⌘5 (empty slot) left it unchanged. Badges confirmed
visually in a window capture (`screencapture -l <CGWindowID>`; window ids by
owner pid via `CGWindowListCopyWindowInfo`).

In the STP window (Safari, chord owned by the browser) the same was checked
with dispatched `KeyboardEvent`s: ⌘3/⌘5/Numpad2 switch, ⇧⌘2 and ⌘7 are not
claimed; six sessions in sequence produced `[gamma, Hello, Hello how are you,
alpha, beta]` — the sixth evicted the LRU slot 1 and every other number
stayed put.

## Rejected alternatives

- Reading `list.current` — gone after the rebase (session-title-slug still
  references it; see its status when next touched).
- Title-text matching as the primary row→id route — duplicate titles are
  common (forks, "New Session"); kept only as a fallback that requires
  uniqueness on both sides.
- Placing the digit inside the 16px status slot — hides the status dot.
- A Swift menu with ⌘1…⌘5 items posting to the page — unnecessary: the
  chord already reaches the page; and it would only work in the Dock app,
  whereas the page listener also serves any other host that delivers it.
- Storing the slot table on the host / in the session log — explicitly not
  wanted; per-window `sessionStorage` is enough.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| ⌘N does nothing in Chrome / Safari | The browser owns ⌘digit. Use the Dock app (or Electron desktop, untested). |
| No badges but the console line is present | Row→id failed: React expando renamed, or `SessionNodeItem` no longer takes `node`. Inspect `Object.keys(row)` and the `.return` chain; README "How it works". |
| Badge overlaps the status dot | Row padding changed (`Rows.module.css`) — update `STYLE_TEXT` width in `badges.ts`. |
| Newly opened row invisible in a screenshot | DSH's `row-in` mount animation frozen in a hidden/occluded window; unrelated to the plugin. |
| System Events acts on the wrong "DSH" | Same-named processes; use PID-keyed AX / `CGEvent.postToPid` (above), never `keystroke` via System Events. |
| Preview relay "Could not find service …preview" | LaunchAgent plist missing; reinstall per PREVIEWING.md step 2. |

## Status

- Built, typechecked, unit-tested; verified end to end on the preview
  (badges, MRU/eviction, synthetic chords in STP, **real** ⌘digit keystrokes
  in `DSH Preview.app`).
- Remote workspaces integrated (optional service); `cordis.dev.yml` also
  carries `tali-remote-workspaces` for the preview, which mirrors itself.
- Row lives in `cordis.dev.yml` (preview). **Not installed live** — needs
  the maintainer's confirmation; the row for `~/.dsh/profiles/web/cordis.patch.yml` is
  in the README (then reload the GUI page once; remove the `cordis.dev.yml`
  row at the same time — duplicate id fails the preview boot).
