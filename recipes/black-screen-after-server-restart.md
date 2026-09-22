# Black window after a server restart (Dock apps / any browser) — `reload-on-restart`

**Date:** 2026-09-22. **Symptom:** the DSH Remote Dock app (and equally DSH /
DSH Preview, Safari, Chrome) shows a bare dark window with nothing in it after
the server it was talking to restarted. Expected instead: the relay's
"Starting DSH…" splash, then the GUI. **Cause:** not the Dock wrapper — the
DSH web client hot-swaps its entire plugin tree in place after reconnecting to
a new server process, and React crashes mid-swap. **Fix:** the client plugin
`plugins/reload-on-restart` (reload the page instead). Wrapper source for
reference: `plugins/dsh-tailscale-remote/dock-app/Sources/main.swift`.

## Diagnosis trail (so the next agent does not redo it)

1. **Wrapper log first.** Every Dock app appends page diagnostics
   (`console.error/warn`, uncaught errors, failed/non-2xx fetches, WebSocket
   closes) to `~/Library/Logs/DSH Dock/<app name>.log` (local time). Filter out
   the noise:
   ```sh
   grep -v -E '\[net\] POST .* → 200$|\[rpc\] ws (←|→)' ~/Library/Logs/DSH\ Dock/DSH\ Remote.log | cut -c1-200
   ```
   The incident read:
   ```
   00:29:42 [net] ws close wss://<remote>…/dsh/<user>/api/remote.mux code 1006
   00:29:42 [warn] [connection] connection lost, retry #1
   00:29:43 [net] POST …/api/session/list → 200            ← reconnected, server is UP
   00:29:45 [error] [client-store] subscriber failed: sessions@…/plugins/:56022
            … refreshLexicon ← sourceRemoved                ← plugins UNLOADING
   00:29:45 [error] Error: scope 'session-maybe' rendered without an installed adapter
   00:29:45 [error] Error: conversation.input: sessions service unavailable
   00:29:45 [net] ws close … code 1000 disposed             ← the client disposed its own socket
   00:29:45 [error] … cannot get required service "remote" in inactive context
   00:29:46 [error] locale subscriber crashed: binding …     (×8)
   00:29:47 [net] POST … → 200 (everything)                 ← plugins back, React root gone
   ```
   No navigation ever happened, so neither the relay splash (a 503 *page*)
   nor the wrapper's offline page (only on `didFailProvisionalNavigation`)
   could appear. The dark rectangle is the shell's `<body>` with the React
   root unmounted (an uncaught render error with no boundary above it).

2. **Server side.** The remote runs one DSH per macOS account (`/dsh/<user>/`,
   one port decade each; inventory in the private `extras/`); ssh as the
   *right* account. The relay log
   (`~/.dsh/logs/relay.log`) is **UTC** while the Dock log is local (BST here):
   `23:19:35 relay: dsh web exited (code 0) … started dsh web` = 00:19:35 BST.
   So the server had restarted **ten minutes before** the page noticed (the
   WebSocket through `tailscale serve` → relay → proxy did not close until
   00:29:42; the page carried on happily until then).

3. **Mechanism (checkout facts).**
   - `packages/client/hmr/src/client/index.ts`: an `EventSource` on
     `./plugins/events`; every `graph` frame → `ctx.modules.entries.sync(graph)`.
     The browser reconnects an EventSource by itself, and the host sends the
     current graph on every connect (`packages/client/hmr/src/index.ts`
     `connect()`), so a reconnect after a restart always delivers the new
     process's graph.
   - `packages/client/modules/src/index.ts:566`: `initialRevisionNonce =
     randomBytes(8)` per host process; every row's initial rev is
     `<nonce>-<n>`. Byte-identical bundles get new revs on every boot.
   - `packages/client/modules/src/client/entries.ts:92-98, 192-246`:
     `sync()` bumps the generation when any `[id, rev, inject, external]`
     differs and `reconcile()` calls `replace()` (tear down fiber → re-import
     → refresh) for every row whose rev changed — here, **all of them**.
   - Nothing in `packages/client/**` ever calls `location.reload()`: the
     in-place swap is the only recovery path upstream has.
   - Same mechanism as `client-bundle-rebuild-kills-pending-prompts.md`; that
     recipe saw it on a deliberate rebuild, this one on any restart.

4. **Reproduction (preview server, Chrome, no live instance touched):**
   ```sh
   # open https://laptop.example.ts.net/dsh-preview/ in a browser, then
   kill -TERM "$(pgrep -f 'bin.ts --profile web --patch .*cordis.dev.yml')"   # relay respawns it
   ```
   Within ~10 s the page logs exactly the cascade above and
   `document.body.innerText === ''`. Comparing `window.__DSH_BOOT__.entries[*].rev`
   (`a6d1f937258924bf-*`) with the first frame of `./plugins/events`
   afterwards (`d2901a337faae82b-*`) shows every rev re-minted. The `pgrep`
   pattern matters: the process argv has no `web` token (profile form), so
   `pgrep -f 'bin.ts web'` finds nothing.

## The fix: `plugins/reload-on-restart`

Browser-only client plugin (`inject = ['modules']`). It wraps
`ctx.modules.entries.sync` — the exact method client-hmr calls — and
`entries.reload`, keeps `id → rev` as the page runs them (seeded from
`ctx.modules.manifest`), and classifies each incoming graph
(`src/client/detect.ts`): **every** known row changed → new server process →
`location.reload()` and swallow the frame; **some** changed → ordinary HMR,
pass through; **none** → pass through. Tests: `pnpm test` (node --test over
the pure logic and the wrapper against a fake `modules`).

Why a plugin, not a fork commit: it is a policy on top of a mechanism upstream
considers correct, `entries.ts` moves on every rebase, and the plugin degrades
to a console warning if `ctx.modules.entries.sync` ever disappears.

Verified on the preview (2026-09-22): plugin row in `cordis.dev.yml`, kill the
DSH process, page `performance.timeOrigin` changes ~3 s after the relay reports
"proxy port is back", GUI fully rendered, no errors. A single-bundle rebuild
(`pnpm build` in the plugin dir) still hot-swaps in place — the plugin's own
"watching …" line appears a second time with the same `timeOrigin`.

## Deployment

| Where | How | Note |
|---|---|---|
| preview | row in `cordis.dev.yml` (done) | `launchctl kickstart -k gui/$UID/io.github.taliesinb.dsh-web-relay.preview` |
| this Mac, live | `pnpm install-plugins` (list includes it) or `pnpm dsh plugin --profile web add plugins/reload-on-restart` from the checkout | bundle rows are **boot-time**: takes effect at the next `dsh web` start; pages open at that restart still run the old client and will black-screen once → ⌘R |
| `<user>@<remote>` | `cd ~/github/tali-dash-plugins && git pull && (cd plugins/reload-on-restart && pnpm install && pnpm build) && (cd deepseek-harness && pnpm dsh plugin --profile web add ../plugins/reload-on-restart)`, then `kill -TERM $(pgrep -f 'bin.ts web --no-open --port <web port>')` (relay respawns); today `extras/bin/sync-host <host> --restart` does this for every account | same one-time ⌘R caveat for the DSH Remote Dock app; each account's instance is separate |

## Troubleshooting

| Symptom | Meaning / action |
|---|---|
| black window, log shows `sessions service unavailable` cascade with no `[reload-on-restart]` line | the page predates the plugin install (or the profile lacks it): ⌘R once; check `pnpm dsh --profile web --dump-config \| grep reload-on-restart` |
| page reloads on every bundle rebuild during development | only if *every* row changed at once — a profile with a single client plugin under `pnpm watch`; trial such plugins in the preview, whose graph has ~60 rows |
| `[reload-on-restart] ctx.modules.entries.sync not found` | the shell's module system changed (rebase): re-read `packages/client/modules/src/client/{manifest,entries}.ts` and adjust `ModulesLike` |
| reload lands on "DSH is unreachable" (wrapper page) | the reload raced a relay that was itself down; the wrapper retries every 5 s and on app activation |
| Dock app never noticed a restart for minutes | expected: the WebSocket through `tailscale serve` can outlive the backend; the plugin acts whenever the graph frame finally arrives |
