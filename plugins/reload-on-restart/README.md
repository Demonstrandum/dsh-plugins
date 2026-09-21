# tali-reload-on-restart

DSH client plugin (browser-only; the Node half is an empty `apply`). When the
web GUI reconnects to a **restarted** DSH server, it reloads the page instead of
letting the shell hot-swap every client plugin in place — the swap crashes the
React root and leaves a bare dark window (the Dock apps' "black screen").

System-level story, diagnosis and deployment:
`recipes/black-screen-after-server-restart.md`.

## What it does

`ctx.modules.entries.sync(graph)` is what `client-hmr` calls for every `graph`
frame on the `/plugins/events` SSE channel. This plugin wraps that method (and
`entries.reload`, which delivers single rebuilt bundles) and keeps a table of
row id → rev as the page currently runs them, seeded from
`ctx.modules.manifest`. For each incoming graph:

| rows in common whose rev changed | verdict | action |
|---|---|---|
| none | unchanged (first frame after boot; rows only added/removed) | pass through |
| some | partial — ordinary HMR of rebuilt bundles | pass through, log |
| **all** | **server restart** (revs are `<per-process nonce>-<n>`) | `location.reload()`, swallow the frame |

A restart reload lands either on the fresh GUI or, if the new process is still
booting, on the relay's self-reloading 503 splash — the behaviour the Dock
apps were built around.

## Commands

```sh
pnpm install && pnpm build      # lib/client.js
pnpm test                       # node --test over src/client/detect.ts and the wrapper
pnpm typecheck
```

Install like the other live plugins (`pnpm install-plugins` from the repo root
includes it) or trial it through `cordis.dev.yml` in the preview server.

## Console lines

- `[reload-on-restart] watching N client bundle revisions; …` — armed.
- `[reload-on-restart] the server restarted (all N client bundle revisions re-minted); reloading the page …` — fired.
- `[reload-on-restart] k/N bundles changed; letting client-hmr hot-swap them` — normal HMR passed through.
- `[reload-on-restart] ctx.modules.entries.sync not found …` — the shell's module system changed shape; plugin inactive, nothing else affected.
