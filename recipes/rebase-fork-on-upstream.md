# Rebasing the DSH fork on upstream (trial of 2026-09-18)

How the `feat/embed-session` fork (24 commits) was rebased onto
`upstream/master` (`ddefc45fbc`, release 0.1.6-alpha.2, 882 commits ahead of
the fork's base `0d1f50007f`) **as a trial**: in a separate worktree, built,
tested, and verified end to end against a throwaway preview server with every
tali-dash-plugins plugin installed — without touching the live checkout, the
live home, or the standing preview. Result: branch `trial/rebase-upstream`
(pushed to `origin`), 26 commits = the 24 fork commits replayed + 2 fix-ups.
The live submodule is still pinned to `feat/embed-session` — promoting the
trial is a separate, deliberate step (see "Promoting" below).

## Why a worktree, and where things ran

- The live `dsh web` and the standing preview both run from the submodule
  checkout `~/github/tali-dash-plugins/deepseek-harness`. Rebasing *in place*
  rewrites source files under a running server (client-bundle rebuilds would
  hot-swap into the live GUI). So: `git worktree add -b trial/rebase-upstream
  ~/github/dsh-rebase-trial feat/embed-session` and everything below happened
  there. `pnpm install --frozen-lockfile` in the worktree took 11 s (shared
  pnpm store); `pnpm run build` ~2 min.
- The standing preview (`~/.dsh-preview`, :3088) runs from the submodule, so
  it cannot exercise a different checkout. The trial used the **ad-hoc
  throwaway server** pattern from `PREVIEWING.md` instead: home
  `/tmp/dsh-rebase-home`, port 3091, cwd = the worktree.

## Procedure

```sh
cd ~/github/tali-dash-plugins/deepseek-harness
git fetch upstream                                   # default branch is `master`, not main
git worktree add -b trial/rebase-upstream ~/github/dsh-rebase-trial feat/embed-session
cd ~/github/dsh-rebase-trial
git -c rerere.enabled=true rebase upstream/master    # 6 of 24 commits conflicted (below)
pnpm install --frozen-lockfile
pnpm run build                                       # build:native-system → build:lib (tsc host+client, tsdown) → build:web
pnpm exec vitest run                                 # full suite, ~5 min: 26119 passed
```

Throwaway home (copy of the preview home minus its tailscale-remote row —
that row binds :3085/:3086 and drives `tailscale serve`, which would collide
with the real preview):

```sh
H=/tmp/dsh-rebase-home; mkdir -p $H/profiles/web
cp ~/.dsh-preview/settings.yaml $H/; cp -R ~/.dsh-preview/{.agent-presets,sessions,storages} $H/
# $H/profiles/web/cordis.patch.yml: override-by-id rows only (local-model-supervisor,
# enforce-model-preset, session-title-llm style: slug) — the plugins come in as bundles:
P=~/github/tali-dash-plugins/plugins
DSH_HOME=$H pnpm dsh plugin --profile web add $P/enforce-model-preset $P/browser-automation \
  $P/dash-docsets $P/local-model-supervisor $P/<private-plugin> $P/foreign-link-opener \
  $P/session-introspect $P/fs-tools $P/settings-shortcut $P/session-title-slug $P/dsh-remote-workspaces
DSH_HOME=$H pnpm dsh --profile web --patch ~/github/tali-dash-plugins/cordis.dev.yml --dump-config | grep '^- id: tali-'
DSH_HOME=$H pnpm dsh --profile web --patch ~/github/tali-dash-plugins/cordis.dev.yml --port 3091 --no-open
```

(`pnpm install-plugins --checkout ~/github/dsh-rebase-trial` would do the same
but includes `dsh-tailscale-remote`, whose default ports 3083/3084 are the
live instance's — do not install it into a home that runs beside the live one.)

## The six conflicts and how they were resolved

| Fork commit | Conflict | Resolution |
|---|---|---|
| `fix(web): resolve Host URLs relative to the served document` | `api/gateway/src/client/stream-client.ts`: upstream added `__DSH_TRANSPORT__.streamBaseUrl` (desktop shell with a local asset origin) to the same line the fork made document-relative | Compose: the transport override wins, else `hostBase()` document-relative. Also **client-hmr**: upstream added a Node-side test where `document` is undefined → the fork's `new URL('./plugins/events', document.baseURI)` must fall back to the bare endpoint (`eventsUrl()` helper). |
| `feat(web): embedded presentation via ?embed=` | `session-controller/src/client/sessions/service.ts` rewritten upstream (557 lines): **view selection moved out of the Session Controller** into `ui-workspace`'s `UiWorkspaceService` (`navigation.ts`, persisted `dsh.sessions.current`, `retain`/`SessionReference` model). `ui-layout` `computeColumns` gained a `collapsedWidth` parameter (Windows titlebar) while the fork added `SIDEBAR_ABSENT`. | Take upstream's `service.ts` wholesale; **port the embed pin** into `navigation.ts`: `pinned = embedPresentation()?.sessionId`; `reconcile()` waits for the pinned id to be listed and never falls back to the recent Workspace; `replaceMain()` refuses another root Session unless it is a subagent child. `computeColumns(viewport, sidebar \| SIDEBAR_ABSENT, rightbar, collapsedWidth)`. README paragraph re-homed to ui-workspace. |
| `feat(session): session.move / moveMany` | `session-controller/README.md` paragraph (upstream reworded one sentence) | Upstream paragraph + fork's `move`/`moveMany` sentences re-inserted (python, not hand-merge — the paragraph is one 2 kB line). |
| `feat(ui-workspace): Move to… / Rehome… dialogs, cross-workspace drag` | `WorkspaceBrowser.tsx`: upstream restructured rendering into a recursive `renderGroup(group, depth)` (nested Workspace groups by folder), the fork's drag-to-move / menu-contribution logic lived in the old inline `groups.map`. Plus `Rows.tsx` (`containsCurrentDescendant` prop vs `extraItems`/`onExtra`), `contract/sessions.ts`, `service.ts` ctor, test-support `calls` union. | Take upstream's `renderGroup`, re-apply the fork's additions inside it: `foreignSessionDrag`/`foreignHover`, `onDragLeave`, foreign-branch `onDragOver`/`onDrop` (with `stopPropagation()` so the innermost nested group wins), `extraItems`/`onExtra`/`rehome` on `ProjectRowItem`, the "marker on another group's key is a move target" guard in the row drag `end`, `onMove`/`extraItems`/`onExtra` on `SessionNodeItem`. `move`/`moveMany` stay on `ISessions` (upstream's `service.ts` ctor + `private readonly remotes`). |
| `fix(session): move retires an idle resident agent silently` | README sentence | word-level re-application |
| `feat(session): move refusal names the work it would interrupt` | README sentence | same — **trap**: a `grep -o "…[^;]*;[^;]*;"` grabbed too much and duplicated the paragraph tail; fixed with a `--fixup` + `rebase -i --autosquash`. Diff the README against the fork commit afterwards. |

Everything else (embed store namespace, scroll-pin, `workspace.list`, sidebar
seats, session import route, `session-persistence/stored`, projection-cache
seeding, slug titles, MoveDialogs.tsx) auto-merged.

## Post-rebase fix-ups (2 commits)

1. `test(ui-workspace)`: upstream's `FakeSessions` double (`workspaces-service.client.spec.ts`)
   must implement the fork's `move`/`moveMany` — found by `tsc -b tsconfig.client.json`
   inside `pnpm run build` (the client typecheck includes tests).
2. `docs(catalog)`: upstream's `cordis-catalog` gate now requires **every
   service-signature type** to be classified (`LINK_MAP` / `TYPE_LINK_EXEMPTIONS`
   in `scripts/gen-cordis-catalog.ts`) and every event scope to have an
   `EVENT_SCOPE_PAGE` entry. Fork additions: `SessionMove{Request,Value}`,
   `SessionMoveMany{Request,Value}` → `session.md`; `SessionRelocate{Request,Result}`
   → `persistence.md`; `WorkspaceBaseline` → `workspace.md`; scope
   `session-persistence` → `persistence.md`. Then `pnpm gen-cordis-catalog`
   regenerates 14 artifacts (docs/subsystems/*.md + .zh.md + .i18n.yaml,
   `tool-cordis/src/api-catalog.ts`) — commit them.

Full suite after fix-ups: 3 files failed → 1 (`apps/desktop/tests/main-startup.spec.ts`,
15 timeouts in the desktop update flows). **That one fails identically on
pristine `upstream/master`** (checked in a second worktree: `git worktree add
--detach /tmp/dsh-upstream-check upstream/master && pnpm install --frozen-lockfile
--ignore-scripts && pnpm exec vitest run apps/desktop/tests/main-startup.spec.ts`
→ 15 failed there too), so it is upstream's, not the rebase's.

## What was verified in the throwaway GUI (:3091, Chrome via browser-automation)

- Boot, all 58 in-tree + 5 external client bundles served 200, console clean.
- Full agent turn on Apple Foundation; slug title (`session-title-llm style: slug`).
- **Move to…** dialog (session row menu) → moved `dummy1 → dummy2`: log dir
  relocated on disk, row moved in the sidebar, the *open* session stayed
  usable and the next turn ran cold in `/Users/USER/projects/dummy2`.
- **Rehome workspace…** dialog opens with the right options.
- `?embed=session-<uuid>` renders chrome-less (`data-embedded`, grid
  `0px 1200px 0px`), pinned to the session, store keys namespaced
  `embed:<id>:dsh.sessions.current`. **Trap: the id needs the `session-` prefix**
  (`?embed=10480439-…` silently shows the blank page; the pin waits for a
  listed id forever).
- **Path mount** (the reason the fork exists): a 30-line prefix-stripping
  proxy (`/tmp/mount-proxy.mjs`: `/dsh-trial/*` on :3092 → `/*` on :3091,
  Host/Origin rewritten, WebSocket upgrades forwarded) — every shell URL stayed
  under `/dsh-trial/` (RPC, `/plugins/events`, bundles, assets) and a turn
  streamed through the `remote.mux` WebSocket. Two escapes: `/open-in-app/apps`
  (404) from upstream's **new** `ui-open-in-app` package (root-relative; the
  fork's document-relative rule predates it — a follow-up for the fork) and
  `/favicon.svg` from `preview-identity`'s own manifest (`icons.src: '/favicon.svg'`).
- Plugins page lists all 11 installed plugins; dev-overlay `preview-identity`
  serves its favicon/manifest/title tap.

## Plugin breakages the new upstream exposed (fixed in this repo)

| Plugin | Symptom | Cause / fix |
|---|---|---|
| `agent-status-indicator` | `useSessionPendingInteraction is not a function` in `conversation.input.dock` | upstream folded that share into `useSessionStatus` (`.agents/notes/…/2026-09-15-client-session-references.md`). **Deleted** (demo plugin, per the maintainer). |
| `<private-plugin>` | `list slot "conversation.chat.turnTail" requires options.id` — the plugin's *client half failed to activate* | `conversation.chat.turnTail` changed **chain → list** (`577e4a036d`). Registration now carries **both** `id` (list) and `select` (chain) and `ShownGallery` derives its images from the owner props when `matched` is absent, so one bundle serves the live (old) and rebased DSH. Rebuilding this bundle hot-swaps the live GUI — a chain-only DSH throws `requires options.select` if `select` is dropped. |
| `foreign-link-opener` | `GET /api/foreign-links/config` → 400 | Pre-existing (same on the live DSH): exact Fetch routes never declared `requestBody: 'buffered'`; the node:http bridge then builds a *streaming* GET `Request`, which throws → webserver's last-resort 400. Host module, so the live server picks it up on its next restart. |

## Promoting the trial (not done)

1. `cd ~/github/tali-dash-plugins/deepseek-harness && git fetch origin && git checkout trial/rebase-upstream`
   (or fast-forward `feat/embed-session` to it and force-push — the fork branch
   is the maintainer's own), `pnpm install --frozen-lockfile && pnpm run build`.
2. Rebuild the plugin bundles whose types moved: `(cd plugins/<private-plugin> && pnpm build)` etc.
3. Restart the live server (`launchctl kickstart -k gui/$UID/io.github.taliesinb.dsh-web-relay`) and the preview relay.
4. `git add deepseek-harness && git commit` in this repo to bump the submodule pin.
5. Follow-up worth a fork commit: make `ui-open-in-app`'s `/open-in-app/…` URLs document-relative (`hostUrl()` from client-connection), and give `preview-identity`'s manifest `./favicon.svg` / `./` paths.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `fatal: ambiguous argument 'upstream/main'` | upstream's default branch is `master` | `upstream/master` |
| Rebase seems to stop after a conflict but `git status` says no rebase | the remaining commits applied cleanly; the filtered output hid the "Successfully rebased" line | `git log upstream/master..HEAD` |
| `--amend` after the rebase changed the wrong commit | the rebase had already finished; HEAD was the last fork commit | `git commit --fixup <sha>` + `GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash upstream/master` |
| `pnpm run build` fails in `tsc -b tsconfig.client.json` on a `*.spec.ts` | the client typecheck covers tests; upstream test doubles must implement fork-added interface members | extend the double |
| `cordis-catalog.spec.ts`: "references unclassified type" / "event scope has no EVENT_SCOPE_PAGE entry" | new upstream gate | classify in `scripts/gen-cordis-catalog.ts`, run `pnpm gen-cordis-catalog`, commit the regenerated artifacts |
| Embedded page shows "Into the Unknown" | bare uuid in `?embed=` | use the full `session-<uuid>` id |
| A plugin's client half silently missing from the GUI | slot cardinality changed upstream; registration threw at activation | check the browser console for `list slot … requires options.id` / `chain slot … requires options.select` |
