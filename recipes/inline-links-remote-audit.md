# Inline links in agent output vs. DSH Remote / hybrid frames — audit

**Status (2026-09-23):** documentation audit only; no code changed. Written so
the next agent can design a fix without re-deriving what the client does with
links. Companion plugins: `foreign-link-opener`, `dsh-tailscale-remote`
(Dock app), `dsh-remote-workspaces` (hybrid frame).

## The question

The DSH client turns various things an agent writes into clickable links.
When the agent runs on **another host** — a standalone **DSH Remote** instance
on the shared remote machine viewed through the Dock app / Safari, or a remote
session framed in the local GUI by `dsh-remote-workspaces` — a link such as
`http://127.0.0.1:5173/` or `localhost:3080` refers to the *remote's*
loopback, which the viewer's browser cannot reach. What does the documented
behaviour actually do with such links, and where are the seams?

All paths below are relative to the DSH checkout (`<dsh-src>`, the
`deepseek-harness/` submodule) unless they start with `plugins/`.

## 1. What the client auto-links (the actual "spec")

The renderer is `MarkdownText` in `packages/client/ui-primitives`
(README §"Rendering agent output"); the grammar is plain micromark **GFM**
(+ math once the message settles) — `src/markdown/parse.ts`. There is **no
custom linkifier**. The complete vocabulary:

| Agent writes… | Rendered as | Rule / where |
|---|---|---|
| `[label](https://…)`, `[label](http://…)`, `mailto:` | `<a target=_blank rel=noopener noreferrer>` with a site glyph | protocol allowlist `http/https/mailto`; anything else is **unwrapped to plain text** — `src/markdown/render.tsx` `sanitizeUrl` |
| bare `https://x`, `http://x`, `www.x`, e-mail | anchor | GFM autolink literals only. **`localhost:3080/foo` and `127.0.0.1:3080` are NOT autolinked** (GFM needs a scheme or `www.`) |
| `` `http://127.0.0.1:3080/` `` — inline code that is *exactly* an absolute http(s) URL | code chip that is also an anchor | `render.tsx` `inlineCodeHttpUrl`; `` `localhost:3080` `` stays inert (`new URL` gives protocol `localhost:`) |
| `[label](src/foo.ts)`, `[label](/abs/path#L24)`, `#L24-L30` | **file link button** (a `<button>`, never navigates the browser) | `src/markdown/file-link.ts`; only after the message settles, only when an `openFile` delegate exists; `?`, non-`#L` fragments and scheme-like prefixes → inert. Decision: `.agents/notes/implemented/feature/2026-09-15-markdown-file-preview-links.md` |
| `` `foo.ts` `` inline code naming a produced/delivered file (exact path, or unique basename) | file-mention button | `chatFileMentions` service from `packages/client/ui-deliverables` (README §"Inline-code links"); limited to files this turn wrote via `write`/`edit`/`present` |
| images | absolute http(s) only, or a `pathImages` vocabulary; raw HTML never enters the DOM | ui-primitives README |
| `web_search` / `web_fetch` result links (`WebBlock`) | plain `<a target=_blank>` — no delegate, native behaviour | `src/WebBlock.tsx` |

Side effect of the allowlist worth knowing: a "site-relative" link like
`[Settings](/settings)` is not a URL to DSH — it parses as an **absolute file
path** and becomes a file-preview button for `/settings`.

### Prompt side — why the agent emits such links

- The `app:web-surface` prompt section and the managed `$DSH_WEB_URL` bash
  variable tell the model "You are interacting with the user through the
  DeepSeek Harness Web GUI at `http://127.0.0.1:<port>`"
  (`packages/bundle/web-app/README.md`, expected text in
  `apps/web/tests/expected/web-runtime-context/web-surface-prompt.expected.md`;
  origin: `docs/postmortem/0003-web-agent-gui-feedback-loop.md`).
  `localWebUrl()` in `packages/bundle/web-app/src/index.ts` **hard-codes
  `127.0.0.1`** + the webServer port. There is no advertised/public-URL
  setting, and none of our plugins override the section (grep of `plugins/`
  for `web-surface|DSH_WEB_URL` is empty — `dsh-tailscale-remote` knows the
  tailnet URL but never feeds it to the prompt).
- The `ui:deliverable-file-references` section asks for a Markdown link on
  every existing-file mention (`…/file-reference-prompt.expected.md`) — the
  file-link rule every Web agent sees in its system prompt.

## 2. What a click does (documented, single-host GUI)

- **HTTP(S), plain left click** → Chat's `openExternalLink` → a new
  right-Sidebar **Browser tab** when `ui-sidebar-browser` is mounted, else
  `window.open(url, '_blank', 'noopener,noreferrer')`; modified clicks keep
  native anchor behaviour (`packages/client/ui-chat/README.md` §"Reference
  previews", `src/client/apply.ts`).
- The Browser tab is an **iframe**
  (`sandbox="allow-scripts allow-forms allow-same-origin allow-popups
  allow-popups-to-escape-sandbox"`). Its address parser accepts http/https
  "including loopback targets", rejects `file:`, credentials, and **the DSH
  application origin** (compared against `window.location.origin`) —
  `packages/client/ui-sidebar-browser/README.md`, `src/client/browser/url.ts`.
  Documented limitations: an HTTPS application blocks HTTP iframes as mixed
  content and the per-tab sandbox toggle does not bypass that; "the package
  performs no Host-side URL probe or proxy"
  (`.agents/notes/implemented/feature/2026-09-16-sidebar-browser.md`, which
  also records that proxying pages through the Host was *rejected* for
  SSRF/rewriting reasons).
- **File links** → `dsh-resource://file/session/<id>/<path>` →
  `ctx.sidebarRight.openResource` → Document Preview through the **Host**
  file service, resolved against the viewed Session's cwd (`ui-chat`
  `apply.ts`, `docs/subsystems/sidebar-right.md`).

**Key fact:** nothing in DSH rewrites or reinterprets hosts. "Loopback" in
every client doc means *the browser's* loopback — the machine the client runs
on. No client doc distinguishes server-side from client-side loopback. File
links, by contrast, always travel through the serving Host and are therefore
naturally server-relative.

## 3. Scenario A — DSH Remote (standalone `dsh web` on the remote Mac behind `dsh-tailscale-remote`, viewed in the WKWebView Dock app or Safari at `https://<remote>.example.ts.net/dsh/<user>/`)

- The remote agent is prompted with `http://127.0.0.1:<port>` — the
  *remote's* loopback. Wrong for the viewer **by construction**; no override
  exists (§1).
- A `http://127.0.0.1:XXXX` / `localhost` link → Browser tab iframe → the
  **client Mac's** port: connection refused, a different service, or (the
  page is HTTPS) blocked as mixed content before it even tries. All three are
  consistent with the documented limitations, but no doc says "loopback means
  yours, not the server's".
- Modified click, or the `window.open` fallback, in the **Dock app**:
  `Scope` = the remote URL + fallback URL (scheme + host + port + `/dsh/…`
  prefix); any out-of-scope main-frame link or popup →
  `NSWorkspace.shared.open` → default browser on the client Mac
  (`plugins/dsh-tailscale-remote/dock-app/Sources/main.swift`: `Scope`,
  `decidePolicyFor navigationAction`, `createWebViewWith`; README §Dock app).
  Same result: the client's localhost.
- `foreign-link-opener` does **not** help and is deliberately inert here:
  `loopbackOnly: true` (default) disables it when the GUI host is not
  loopback, precisely because its host half runs `open -a Safari` **on the
  DSH host** — "a phone using DSH through the reverse proxy never opens Safari
  on the Mac" (`plugins/foreign-link-opener/README.md`). Ironically that
  server-side `open` is the only existing mechanism that *would* interpret a
  server-relative `localhost` link correctly — by opening it on the remote's
  screen, useless for a headless remote.
- **File links work correctly**: the served page's `./api/...` is
  document-relative (fork branch `fix/tailscale-mounting`, recipe
  `tailscale-remote-plugin.md`), so Document Preview reads the remote's
  files.

## 4. Scenario B — hybrid frame (`/remote/<id>/?embed=<sessionId>` inside the local GUI via `dsh-remote-workspaces`)

- The embed shell **keeps the right column**: "the center, the right column,
  and `shell.overlay` stay, so approvals and the right dock work inside the
  frame" (`packages/client/ui-layout/README.md`). So an HTTP link in a framed
  remote session opens a Browser tab **inside the frame** (iframe-in-iframe),
  fetched by the client browser → client-relative localhost, exactly as in A.
- Extra twist: the frame is **same-origin** with the local GUI (served by the
  egress proxy at `/remote/<id>/`), so `window.location.origin` is the
  **local** origin. The `application-origin` refusal therefore compares a
  remote agent's `http://127.0.0.1:3080` link against the *local* server:
  same port → the click is refused with a misleading "application origin"
  error; different port → it loads whatever the client has on that port.
- Modified click / `window.open` from the frame → a popup out of the local
  GUI → in the Dock app the scope check sends it to the default browser →
  client localhost.
- **File links work correctly**: the framed shell resolves
  `dsh-resource://file/session/<remoteSessionId>/…` through its own
  `./api/...` → egress proxy → the remote's Host file service
  (`notes/remote-workspaces-plan.md` §document-relative URLs).
- `plugins/dsh-remote-workspaces/README.md` §"Titles of framed sessions"
  states the framed page "is a separate document with **no channel back** to
  this plugin"; there is no seam today through which the frame could hand a
  link to the outer shell. Neither that README, the plan, nor
  `recipes/remote-workspaces-plugin.md` mention link handling at all — an
  undocumented gap, not a documented behaviour.

## 5. Summary

| | file links (`[x](path#L…)`, code mentions) | http(s) links, esp. `127.0.0.1` / `localhost` |
|---|---|---|
| Local GUI | ✅ Host-resolved | ✅ client == server |
| DSH Remote (Dock app / Safari) | ✅ Host-resolved via document-relative API | ❌ interpreted on the **client**; mixed content blocks HTTP iframes; Dock app hands them to the client's default browser |
| Hybrid frame | ✅ via the egress proxy | ❌ as above, plus the `application-origin` check is against the **local** origin |

Facts that fix the design space for a fix:

1. The only place the agent learns "its" URL is the hard-coded loopback
   `app:web-surface` / `$DSH_WEB_URL` (`localWebUrl`).
2. The only client-side seams are Chat's `openExternalLink` delegate (one
   `MarkdownDelegateProvider` around the node list; nested providers replace
   it) and the Sidebar Browser's URL parser (`parseBrowserAddress`, rejects on
   `applicationOrigin`). `WebBlock` links bypass both.
3. `dsh-remote-workspaces` has no frame→outer channel; the frame and the outer
   shell are same-origin, so `postMessage` / shared storage would be cheap to
   add (the README already lists "postMessage from the embed" as a later
   item).
4. The Sidebar Browser decision record rejected Host-side proxying of
   arbitrary pages (SSRF, URL/CSP/cookie rewriting). A *loopback-only* egress
   through the existing `/remote/<id>/` proxy is a narrower case it did not
   consider — and the Dock app's `Scope` would need to learn about it.
5. The remote Mac hosts one DSH per account (mount `/dsh/<user>`, one port
   decade per account — inventory in the private extras notes), so any
   "translate remote loopback to a reachable URL" scheme has to be per
   instance, not per host.

## Implementation: transparent loopback forwarding in the Dock app (2026-09-23)

Priority was the DSH Remote Dock app, and the chosen mechanism is the one the
summary above points at: **TCP-over-WebSocket through DSH's own authenticated
channel**, so the URL the agent printed works *verbatim* on the client (Host
header, absolute paths, cookies, HMR socket). Rejected on the way: Tailscale
Serve publishing (`Host` stays the tailnet FQDN — measured in
`tailscale-remote-plugin.md` — so Vite's default `allowedHosts` blocks it, and
the URL changes), a path mount under `/dsh/<user>/` (absolute paths break),
SSH `-L` over Tailscale SSH (works, zero DSH code, but needs `tailscale up
--ssh` + an ACL rule and per-account SSH process management — kept as the
fallback idea).

Everything lives in `plugins/dsh-tailscale-remote`; the README's **Loopback
port forwarding** section is the authoritative description. In one paragraph:
`forward.mjs` registers `/api/loopback-forward?port=N` as an upgrade route on
the remote's DSH server (behind DSH's browser-session gate, forwarded by the
existing proxy like any admitted upgrade), applies `loopbackForward`
(`admitted` default / `operators` / `off`), refuses the instance's own ports
(`reserved`), and lets only ports through whose listener `lsof` shows as owned
by **the uid running that DSH** — on the shared remote machine with one DSH per
account that is exactly "a server this account's agent started", and other
accounts' ports are invisible to an unprivileged `lsof` (→ 404). Denials are
HTTP statuses before the 101 with `X-Dsh-Forward-Error`; then it pipes bytes.
`dock-app/Sources/PortForward.swift` recognises loopback URLs in
`decidePolicyFor` (subframes included — the Sidebar Browser iframe) and
`createWebViewWith`, probes the endpoint once (the refusal code arrives via
`URLSessionWebSocketTask.response`), binds `127.0.0.1:<same port>` with
`NWListener` (substitute port when busy; URL rewritten), and pumps each
accepted connection over its own WebSocket. A `reserved` refusal maps
`$DSH_WEB_URL`-style links onto the app's own mount. View ▸ Forwarded Ports.

Things that only a real run found:

| Symptom | Cause / fix |
|---|---|
| `NWListener` state `.failed(EINVAL)` on `start`, every parameter variant | no `newConnectionHandler` installed before `start` — set a placeholder first, the real one after init |
| `requiredLocalEndpoint(hostPort)` suspected | red herring; a standalone probe showed every variant binds; the interface-type form (`requiredInterfaceType = .loopback`) is kept as the supported spelling |
| multi-file `swiftc` build: "statements are not allowed at the top level" | only `main.swift` may hold top-level code; the smoke harness is staged under that name (`scripts/forward-smoke.mjs`); `dock-app.mjs` now compiles every `Sources/*.swift` |
| smoke test forwarded on a substitute port | expected on one Mac: the echo target already holds the port locally — the `EADDRINUSE → free port` path is what got exercised |

Verified: `pnpm check` (65 tests incl. real `lsof` and the route end to end
with Node's `WebSocket`), `pnpm forward:smoke` (Swift ↔ Node: refusal codes,
bind, 3 MiB in order, close propagation), and then **the real thing**:
deployed to one instance on the shared remote machine (`extras/bin/sync-host
<host> --restart --only <user>`), the Dock app rebuilt with `pnpm remote-app
<host>/dsh/<user> --name …`, and an agent in that instance asked to start six
servers (IPv4-only, IPv6-only, wildcard, Vite + HMR, hand-rolled WebSocket
echo, 8 s slow reply) and post the links in varied Markdown forms. Every link
forwarded (View ▸ Forwarded Ports listed the port; ⌘-click → Safari loaded
through the tunnel, HMR and WebSocket included). Two findings only a real run
gave: (1) **WKWebView blocks the `http://127.0.0.1` iframe inside the HTTPS
page as mixed content** — the Sidebar Browser pane stays blank — so the
plugin's browser half now takes plain clicks on loopback links before Chat
does (capture-phase listener, `window.open`) whenever `__DSH_DOCK__` is
present; no blank pane, same path as ⌘-click. (2) The proxy answered refused
upgrades with its own bare head, losing `X-Dsh-Forward-Error`; it relays
DSH's headers now. Also noticed: a bare `http://[::1]:8002/` is not
linkified by GFM (IPv6 literal), the Markdown-link form of it is.

Operational notes: the host route ships with the next restart of any
instance that has the plugin linked (`loopbackForward: off` disables it); the
browser half hot-swaps on the next `sync-host` build without a restart. The
remote agent's sandbox refused `~/.npm`, so Vite needed `npm_config_cache`
under its work dir; `ps` is blocked there while `lsof` is not.

## Troubleshooting (symptoms this audit explains)

| Symptom | Why |
|---|---|
| Agent says "open `http://127.0.0.1:3080`" from a DSH Remote session and the link is dead / opens something else | `localWebUrl` hard-codes the remote's loopback; the client interprets it locally |
| Clicking such a link in a hybrid frame shows the Browser's "application origin" refusal | frame is same-origin with the local GUI; local instance happens to use the same port |
| Browser tab stays blank for an `http://localhost:…` link opened from the tailnet URL | HTTPS page → HTTP iframe = mixed content; browsers emit no actionable error (documented Browser limitation) |
| `foreign-link-opener` console says `inactive (… host=<domain>)` on a remote | `loopbackOnly` refused a non-loopback GUI host — intended, or Safari would open on the server |
| `` `localhost:3080` `` in a reply is not clickable at all | not an absolute URL: neither GFM autolink nor the inline-code URL rule accepts it |
