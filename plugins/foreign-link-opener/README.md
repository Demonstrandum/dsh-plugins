# tali-foreign-link-opener

When the DSH web GUI runs as a Safari **"Add to Dock"** web app, links that
leave the DSH server — a dev server an agent started on another port, any
other host — open in the **real Safari** (`open -a /Applications/Safari.app`)
instead of spawning another DSH-branded window.

## Why this is needed

Safari decides where a link opens by the web app's *scope*, and the default
scope is the **host** of the installing page — the port is not part of it
(Apple, WWDC23 "What's new in web apps"). A DSH app installed from
`http://127.0.0.1:3080` therefore treats `http://127.0.0.1:5173` as in-scope
and opens it inside the app; `window.open()` stays in the web app regardless
of scope. The manifest cannot express "same host, other port is foreign":
`scope` only narrows to a path prefix. Hence a plugin.

## How it works

- **Browser half** (`src/client/index.ts` → `lib/client.js`): a capture-phase
  `click` listener on `document` plus a wrapper around `window.open`. An
  http(s) link whose server is not this one is `preventDefault`ed and handed
  to the host route. "Same server" = same origin, or loopback aliases
  (`localhost` / `127.0.0.1` / `[::1]`) with the same protocol and port.
  Untouched: same-server links, non-http schemes (`dsh:`, `mailto:`), alt-clicks
  (Safari's download gesture), `<a download>`, clicks another handler already
  prevented. Propagation is never stopped, so React handlers still run. If the
  host refuses/fails, the URL falls back to the native `window.open` so a link
  is never swallowed.
- **Host half** (`index.js`): two authenticated `ctx.connection.fetch` GET
  routes below `/api`:
  - `GET /api/foreign-links/config` → `{ when, loopbackOnly }` for the client.
  - `GET /api/foreign-links/open?url=…` → `/usr/bin/open -a <app> <url>` via
    `execFile` (no shell). Requires header `x-dsh-foreign-links: 1` (a
    cross-site page cannot add it without a CORS preflight the server never
    answers; the auth cookie is also `SameSite=Strict`). Only http(s) URLs.

## Activation

| `when`   | behaviour |
|----------|-----------|
| `auto` (default) | only when the GUI runs as an installed web app: `navigator.standalone === true` or `display-mode` ≠ `browser`. In a normal tab a `target=_blank` link already opens a Safari tab, so nothing is done. A browser tab in macOS full-screen also matches `display-mode: fullscreen` — harmless, the link opens in Safari either way. |
| `always` | every foreign link, also in a normal tab — how the plugin is tested. |
| `never`  | inert. |

`loopbackOnly: true` (default) additionally requires the GUI's own hostname to
be a loopback alias, so a phone using DSH through the reverse proxy never
opens Safari on the Mac. The browser console logs one
`[foreign-link-opener] active|inactive (…)` line at boot — check it if links
still stay inside the app.

## Config

```yaml
- insert:
    - id: tali-foreign-link-opener
      name: '/Users/USER/github/tali-dash-plugins/plugins/foreign-link-opener/index.js'
      config:
        app: /Applications/Safari.app   # '' = system default handler (`open <url>`)
        when: auto                      # auto | always | never
        loopbackOnly: true
        traceFile: ''                   # e.g. /tmp/foreign-link-opener-trace.log
```

## Build / test

```sh
cd plugins/foreign-link-opener
pnpm install && pnpm build          # lib/client.js (esbuild, same format as the other client plugins)
pnpm typecheck && pnpm check
```

Isolated end-to-end check (no live config touched): a throwaway-home preview
with `when: always`, then dispatch a click on an injected foreign anchor and
watch the trace file / Safari:

```sh
cat > /tmp/foreign-link-test.patch.yml <<'EOF'
- insert:
    - id: tali-foreign-link-opener
      name: '/Users/USER/github/tali-dash-plugins/plugins/foreign-link-opener/index.js'
      config: { when: always, traceFile: /tmp/foreign-link-opener-trace.log }
EOF
cd ~/github/deepseek-harness
DSH_HOME=/tmp/foreign-link-test-home pnpm dsh web --patch /tmp/foreign-link-test.patch.yml --port 3083 --no-open
# open the tokened URL, then in the console:
#   const a = Object.assign(document.createElement('a'), { href: 'http://127.0.0.1:3084/', target: '_blank' })
#   document.body.appendChild(a); a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
```

The real Dock-app behaviour can only be confirmed by hand: install the GUI
via Safari ▸ File ▸ Add to Dock, click a link to another local port.
