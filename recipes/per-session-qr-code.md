# Per-session QR code: one Session, chrome-less, on a phone

**Date:** 2026-09-22. **Plugin:** `plugins/dsh-tailscale-remote` (client half
`src/client/session-qr.tsx`, proxy fix in `proxy.mjs`). **Fork feature relied
on:** `?embed=<sessionId>` (branch `feat/embed-session`).

The Settings ▸ Tailscale remote QR code opens the *whole* GUI on a phone.
This adds a QR-glyph button to the top right of every Session window (beside
the `…` menu and the right-dock toggle) whose QR code / link opens *that one
Session* chrome-less — no sidebar, no other sessions, composer and approvals
intact. Main use: the instances on the shared remote machine ("DSH Remote",
inventory in the private extras notes), where each owner shares a session to
their phone.

## Decision: UI feature, not a security boundary

Investigated first (2026-09-22) and decided with the maintainer: the link rides the
**standing** access token (or the device's Tailscale identity). Whoever
scans a tokened code is admitted to the whole DSH exactly like the Settings QR
code; `?embed=` is a client-side presentation pin, not a permission. Real
per-session scoping would need the proxy to inspect `/api/*` bodies and
terminate + filter the `/api/remote.mux` WebSocket: `session.list`,
`session.control` and the `$events` stream (`packages/api/remotes/src/remote-events.ts`)
all carry every session; the mux frames are JSON `{type, streamId, endpoint,
payload}` / `{type:'item'|'end'|'error'}` (`packages/api/gateway/src/stream-server.ts`),
so it is doable, but a project of its own. Not warranted for a UI feature.

## How it works

1. **Link.** `https://<node>.example.ts.net/dsh/?token=<token>&embed=<sessionId>`
   ("Include access token", the default when the token is readable) or
   `…/dsh/?embed=<sessionId>` (identity-only). Base URL and token come from
   the plugin's control channel `status` snapshot (`url`, `tokenUrl`;
   operators only). Off the host the panel falls back to the document's own
   directory URL (`new URL('./', document.baseURI)`) token-less — in a tailnet
   tab or a direct-remote Dock app that *is* the public URL. On a loopback tab
   with the route off it shows why there is no address instead of a QR.
2. **Exchange.** The proxy's token exchange used to redirect to bare
   `<mount>/` (or `./`), dropping the query; it now strips only `token` and
   keeps the rest, mirroring DSH's own `authorizeIndex`
   (`packages/client/connection/src/browser-auth.ts`). Test: "keeps every
   other query parameter across the exchange" in `tests/proxy.test.mjs`. The
   proxy's trailing-slash head script already kept `location.search`; the
   relay is pure TCP.
3. **UI.** Slot `conversation.session.header.utilities` (`list`, scope
   `session` → the component gets `sessionId`), `order: 50` (after
   `ui-open-in-app` at −10; the right-dock toggle sits in the separate
   `corner` seat). Inline styles like the rest of the plugin (no CSS-module
   loader in `build.mjs`); QR rendered client-side with `uqr` (already a
   dependency, bundled); `useDismissOnOutsidePointer` + Escape close it.
   Not registered when `embedPresentation()` is set, so the phone's own view
   has no button. Type-only links added: `@deepseek-ai/dsh-client-store`
   (`embedPresentation`) and `@deepseek-ai/dsh-client-ui-conversation`
   (the slot declaration).

## Facts measured

- The embed shell at **390 × 760** already lays out well: header, Chat/
  Trajectory tabs, transcript, composer with model picker, footer stats.
  There is no responsive CSS in `ui-layout` (only `prefers-reduced-motion`);
  it is the absence of the sidebar that does it.
- Session ids carry the **`session-` prefix**. `?embed=<bare uuid>` falls
  through to the blank hero silently.
- The embedded page: `data-embedded` on the frame, `ctx.layout.embedSessionId`
  set, navigation pinned to the root Session + its subagent children
  (`packages/client/ui-workspace/src/client/navigation.ts`), persisted stores
  namespaced `embed:<id>:`.
- `curl` of the tokened link through the running preview proxy: `303` with
  `location: /dsh-preview/?embed=session-…` and the proxy cookie; the
  follow-up GET is `200` on the embedded page.
- Pre-existing, unrelated: the live GUI logs three 404s from stock-DSH
  origin-anchored routes (`/open-in-app/apps`, `/api/changes.summary`,
  `/api/present.host`) behind the `/dsh/` mount — fork mounting gaps.

## Trial and promotion procedure (what was done)

The live and preview profiles both resolve the plugin to the repo directory,
so `node build.mjs` in the repo hot-swaps the **live** GUI. Trial from a copy:

```sh
rsync -a --exclude node_modules --exclude lib --exclude dock-app/build plugins/dsh-tailscale-remote/ /tmp/tsr-preview/
ln -s "$PWD/plugins/dsh-tailscale-remote/node_modules" /tmp/tsr-preview/node_modules   # relative link: deps resolve from the real dir
(cd /tmp/tsr-preview && node build.mjs)
# ~/.dsh-preview/profiles/web/cordis.patch.yml: row tali-tailscale-remote → name: '/tmp/tsr-preview/index.js'
launchctl kickstart -k gui/$UID/io.github.taliesinb.dsh-web-relay.preview
# … verify at https://<node>.example.ts.net/dsh-preview/ …, then restore the row, kickstart again, and build in the repo.
```

Promotion: `node build.mjs` in the repo (live client hot-swaps; the Settings
section and the new button reload in place), then **restart the live `dsh
web`** for the proxy fix — host modules are not hot-reloaded (`launchctl
kickstart -k gui/$UID/io.github.taliesinb.dsh-web-relay`). Until that
restart a tokened per-session link lands on the full GUI. On the shared
remote Mac: `extras/bin/sync-host <host> --restart` after pushing.

## Traps

| symptom | cause / fix |
|---|---|
| `pnpm install` in the plugin dir wipes `node_modules` and aborts | `CI=true` makes pnpm purge without a TTY and then refuse a changed lockfile. Use `CI=true pnpm install --no-frozen-lockfile` after adding a `link:` dep. The running live server keeps its modules in memory, but a restart in between would fail to find `uqr`. |
| Tokened QR opens the whole GUI | Live host not restarted since the proxy fix (see above). |
| Panel says "Tailscale login required", no token checkbox | The control channel answered 403: the page is not an operator (token/cookie-admitted device, or `identityOperators: false`). Expected off-host. |
| QR shows the blank hero on the phone | Bare UUID in `embed=`; the id needs its `session-` prefix. |
| `edit` says the file changed since it was read | Another agent session is committing to the same checkout; re-read and re-apply. |

## Not done / to verify on a device

- iOS "Add to Home Screen" of a per-session link: home-screen web apps use a
  separate cookie store and the saved URL is the post-exchange one (token
  gone). The proxy cookie lasts 400 days, so after one exchange it should
  hold — check on a real phone.
- The right dock at phone width (it will cover the chat).
- A "Show QR code" item in the sidebar row's `…` menu
  (`ctx.uiWorkspace.contributeSessionMenu`) — the header button was enough.
