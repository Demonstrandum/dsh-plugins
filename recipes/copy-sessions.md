# Copying sessions — "Copy to…" beside "Move to…" (fork + `dsh-remote-workspaces`)

Status: **implemented 2026-09-24**, verified on a throwaway home; not yet
running in the live `dsh web` (needs a restart — see §6). Companion of the
move feature recorded in `notes/workspace-moving-ui.md`; this recipe covers
what a *copy* does differently and where the code lives.

## 1. What it does

Every place that offers **Move to…** now also offers **Copy to…**:

| surface | item | mechanism |
|---|---|---|
| local session row (fork `ui-workspace`) | **Copy to…** | Session Controller `session.copy` |
| local session row (plugin contribution) | **Copy to remote…** | plugin `sessions.copyAcross` (export → import `mode=copy`) |
| remote session row (plugin) | **Copy to…** | same remote: remote `session.copy` (`sessions.copy`); other host / local: `sessions.copyAcross` |

A copy is a **new session with a fresh id** (root and every subagent
descendant), stored under the destination workspace's directory; the source
is only ever *read* — no cancel, no retire, no archive, a running agent keeps
running. Because nothing is destroyed, the source's own workspace is a valid
destination (**Copy to… = Duplicate**; the fork dialog preselects it).

Decisions taken with the maintainer (2026-09-24):

- **Mid-turn source → offer to truncate, never to terminate.** The dialog's
  checkbox *Copy only up to the last completed turn* (ticked by default)
  drops the **whole turn in progress**: the log is cut just before its
  `turn/start` and the prompt still queued for that turn is cancelled out of
  the inbox (`agent/inbox/spliced { target: 'next-turn', removedCount, outcome:
  'canceled' }`) so the copy does not start running when opened; subagent
  logs whose header `createdAt` is after the cut are left out. Unticked, the
  copy keeps everything recorded so far and the open turn is closed with the
  existing crash-repair closers (`interruptedTurnClosers` from
  `@deepseek-ai/dsh-session`: error results for pending tool calls, `step/end`,
  `turn/end { reason: interrupted }`). Only suffixes are cut and only events
  appended, so seqs stay contiguous and `sourceEventSeqs` stay valid.
- **Title becomes "<title> (copy)"** by default — an editable field in the
  dialog; an unchanged title sends no `title` and the copy keeps the source's.
  Recorded as a `session/title` event with `source.kind: 'user'` (so the
  automatic titler leaves it alone).
- **Same workspace allowed.**
- **Fresh ids always**, even cross-host with a free id (a copy is a new
  session; a move keeps identity).

The agent of the copy gets one `agent/inbox/spliced` next-step notice
(`source.plugin: 'session-copy'`): "this session is a copy of session `<id>`
from <origin>, made on <ISO time> into the workspace `B` (/path)… The original
continues separately; nothing done here affects it." plus a clause about the
dropped / interrupted turn and (cross-host) the original-host file warning.

## 2. Fork (submodule `deepseek-harness/`, branch `feat/embed-session`)

Host:

- `packages/session-query/session-log-export/src/shape.ts` — `shapeCopiedLog(events, { truncate })`
  → `{ events, truncated, openTurn, cutTime? }` (pure; the algorithm above).
- `…/import.ts` — refactored: `parseLog` → `ParsedSessionLog`; the storing half
  is now `storeSessionLogs(ctx, { root, children }, target)` shared by
  `importSessionZip` (ZIP) and the same-host copy. `SessionImportTarget`
  gained `mode: 'move' | 'copy'`, `truncate`, `title`, `crossHost`;
  `SessionImportResult` gained `truncated`. `sessionCopyNoticeText` and
  `SESSION_COPY_NOTICE_PLUGIN` exported.
- `…/copy.ts` — `copyStoredSession(ctx, deps, sessionId, target)`: flush the
  live source (`sessions.flush`), read root + lineage
  (`sessionQuery.traceSession`) through persistence read handles, store as
  `mode: 'copy', crossHost: false`.
- `…/index.ts` — `POST /api/session.import` accepts `mode=copy`,
  `truncate=true`, `title=`.
- `packages/api/session-controller/src/copy.ts` — `SessionCopyController.copy`:
  destination via `resolveMoveDestination` (extracted from move.ts, as was
  `sessionMoveBlockers`), `session/copy-missing`, `session/copy-live` when the
  resident Agent has a `turn` blocker and `truncate` is undefined,
  `session/copy-error` for storage failures. `@Remote('copy')` in `index.ts`;
  `SessionCopyRequest` / `SessionCopyValue` + error details in `types.ts`.
  New peer/dev dependency `@deepseek-ai/dsh-session-log-export` (tsconfig
  reference to its `tsconfig.host.json`; run `pnpm install` after pulling).

Client:

- `session-controller/src/client/contract/sessions.ts` + `sessions/service.ts`:
  `ISessions.copy` (RemoteResult, not thrown). Test doubles updated:
  `test-support/client-runtime/src/sessions.ts`, `ui-conversation/tests/
  conversation-registry.client.spec.ts`, `ui-workspace/tests/workspaces-service.client.spec.ts`.
- `ui-workspace`: `contract/slots.ts` `copySession`; `rows/Rows.tsx` menu item
  `copy` (`IconCopyOutline16`); `rows/MoveDialogs.tsx` `CopySessionDialog`;
  `rows/WorkspaceBrowser.tsx` `copyTarget` state, lands on the copy via
  `open(sessionId)`; `locales.ts` `menu.copySession`, `copy.*` (en + zh).

Tests: `session-log-export/tests/copy.host.spec.ts` (shape, store in copy
mode, `copyStoredSession`), `session-controller/tests/copy.host.spec.ts`
(controller over a real JSONL backend incl. the running-source refusal),
`ui-workspace/tests/workspace-browser.client.spec.tsx` "copies a session from
the row menu…" (happy path + `session/copy-live` reveal).

Build: `pnpm run build:lib` (host `tsc -b` + tsdown, then client). The client
typecheck runs *after* the host build because `remotes.session.copy` comes
from the generated Typert stubs (`lib/typert.remote-client.js`).

## 3. Plugin (`plugins/dsh-remote-workspaces`)

- Host `index.js`: `importQuery(origin, copy)` builds the import query;
  `localImport`/`remoteImport` take an optional `copy` argument;
  `copySessionWithinRemote` (`sessions.copy`: remote `session.copy`, then
  poll the destination; answers `{ workspace, sessionId, truncated }`);
  `copySessionAcross` (`sessions.copyAcross`: liveness check only to raise
  `session/copy-live` once while `truncate` is undecided, then export →
  import `mode=copy`; never cancels or archives).
- Client: `api.ts` `copySession` / `copyAcross` (+ `CopyRequest`,
  `CopyResult`); `store.ts` `MoveRequest.mode`, `copySession`, `copyAcross`;
  `ui.tsx` row item **Copy to…**, `MoveRemoteDialog` in copy mode (title
  field, source workspace preselected and listed, truncate checkbox after
  `session/copy-live`, "Copied to … ; the original is untouched."); `index.tsx`
  contributes **Copy to remote…** (order 11) beside Move to remote….
- `pnpm typecheck && pnpm build && pnpm test` in the plugin directory.

**Trap (hit 2026-09-24):** the plugin is pnpm-linked into the live profile
(`~/.dsh/profiles/web/node_modules/dsh-remote-workspaces → this directory`),
so `pnpm build` hot-swaps the live GUI's bundle immediately, while the host
half (`index.js`) only changes on restart: until then the live client's
`sessions.copy` / `sessions.copyAcross` answer `unknown endpoint`. Build in a
`/tmp` copy when the live GUI must not be disturbed (see
`recipes/session-title-slug-plugin.md`).

## 4. Verification (throwaway home)

```sh
rm -rf /tmp/dsh-copy-home && cp -R ~/.dsh-preview /tmp/dsh-copy-home
# the copied profile: drop private bundles whose relative pnpm links broke
# (symba-dsh), drop the tailscale-remote row (ports/serve of the real preview),
# add an insert row for plugins/dsh-remote-workspaces/index.js (it is a live
# bundle, not in cordis.dev.yml)
cd <dsh-src> && DSH_HOME=/tmp/dsh-copy-home pnpm dsh --profile web \
  --patch <plugins>/cordis.dev.yml --no-open --port 3097
```

Then over HTTP with the printed token (cookie from `GET /?token=…`, Typert
envelope `{ type: 'client-request', rpcId, method: 'session/copy', payload: {
args: { request } } }` to `POST /api/session/copy`; the plugin channel is
`POST /remote-workspaces/<endpoint>`):

- cold copy A→B, A→A (duplicate), missing id → `session/copy-missing`;
  titles listed at once (projection cache seeded).
- running source (prompted, `running: true` in `session/list`): undecided →
  `session/copy-live` with `blockers: [{ kind: 'turn' }]`; `truncate: true` →
  log `… session/title, inbox(prompt), inbox(cancel outcome=canceled),
  session/title(copy), notice`; `truncate: false` → `… request/context,
  step/end, turn/end(interrupted), session/title, notice`; the source log
  untouched and still streaming.
- `GET /api/session.export` → `POST /api/session.import?mode=copy&truncate=true&title=…` → 200 `{ …, truncated }`.
- plugin: mirror the instance as its own remote (`workspaces.add { url,
  token, remoteWorkspaceId }`), then `sessions.copyAcross` local→remote,
  `sessions.copy` within the remote, `sessions.copyAcross` remote→local.
- Chrome: row menu shows Rename / Fork / Move to… / **Copy to…** / Archive /
  Move to remote… / **Copy to remote…**; the fork dialog (own workspace
  preselected, "Runner (copy)") copies and lands on the copy; the plugin
  dialog reports "Copied to self-copy-ws-b on self (25 KB); the original is
  untouched."

Observed, not fixed: a session that arrives through the HTTP import lists as
the directory basename until the next list refresh (the projection cache is
seeded, but the `session-persistence/stored` upsert carries no hints) — the
same gap the import notes already record. Note the copied preview home now
carries cloud providers (Haiku answered the test prompt, ~34K tokens).

## 4a. One dialog for local rows: contributed destinations (2026-09-24, later the same day)

The maintainer asked for the local rows' Move to… / Copy to… to list remote
destinations too, tree-shaped (*This machine* first, remotes last, as in the
sidebar). Done as a fork seam rather than a plugin-owned dialog:

- **Fork** `ui-workspace`: `ctx.uiWorkspace.contributeDestinations({ id,
  order?, groups, run })` (`navigation.ts`; registry + observable
  `destinationContributions`, mirrored from `menuContributions`).
  `WorkspacePickFlow` gained a tree mode (`externalGroups`, `localLabel`,
  `selectedExternal`, `onPickExternal`): a `label` row per machine, rows
  indented (`indented()` wraps icon + title; the Menu's `detail` carries the
  path), contributed groups after the local list, the pinned "Add
  workspace…" footer unchanged. `MoveDialogs.tsx` now works on a
  `DialogDestination` (`local` | `external`), hands an external pick to the
  contributor's `run`, and shows its `summary` before closing. The
  contributor's answer is **structural** (`DestinationRunResult`), not a
  `RemoteResult`: `RemoteFailure` requires a `RemoteError` instance with a
  declared code, which an out-of-tree client plugin cannot construct (no
  runtime imports of `@deepseek-ai/*` besides the platform modules). Locales
  `move.destination.local/external`, `copy.destination.external`. Test:
  "lists contributed destinations as a tree…" (refusal → truncate → summary).
- **Plugin**: `index.tsx` replaces the two contributed menu items with one
  `contributeDestinations` (groups derived from the runtime snapshot, one per
  server, memoized per snapshot so `getSnapshot` is referentially stable;
  `run` → `transferSession` / `copyAcross`, `RemoteApiError` → `{ ok: false,
  code, message, details }`); `notify` now threads through to the import
  (`importQuery(origin, copy, notify)`). Its own dialog stays for remote
  sources and got the same tree (`e6e3ecb`).
- Verified on the throwaway (self-mirror remote): local row → Copy to… →
  picker shows *This machine* (6 rows, current checked) then `<remote>` (the throwaway mirroring itself)
  (2 rows) then Add workspace…; copy to the remote answers "Copied to … (13
  KB); the original is untouched."; Move to… the remote answers "Moved to …;
  the original is archived here." Screenshot in the session workspace
  (`consolidated-picker.png`).
- Menu placement: with a tall list in a 900px-high window the popover shifts
  up over the anchor to fit the viewport — the `Menu` primitive's behaviour,
  not ours.

## 5. Semantics worth remembering

- `truncate` matters only when the source log has an open turn; a cold
  session with a crashed open tail is closed as interrupted (as resume would)
  without asking. The refusal fires only for an Agent whose `status` is
  `running`; an idle resident Agent asks nothing (its log is the whole truth).
- Copies are never marked as forks (`isSeeded`/`parentSession` are carried
  over from the source unchanged), so cross-host lineage never dangles.
- Attachments are content-addressed: a same-host copy needs no attachment
  work; the cross-host path re-saves the ZIP's `media/` and `files/`.

## 6. Going live

The fork host changes need a `dsh web` restart (`/reboot` or the relay); the
client bundles (`ui-workspace`, `session-controller`) are rebuilt by
`build:lib:client` and hot-swap on the next connection. Restart, then
`pnpm install-plugins` is *not* needed (the plugin is linked); the plugin's
host half also loads on that restart. Nothing was restarted as part of this
work.
