# tali-dash-plugins

<p align="center">
  <img src="assets/logo.svg" alt="tali-dash-plugins logo — a bucket hat and glasses" width="360">
</p>

Out-of-tree work on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(DSH), a coding-agent harness with a web GUI. Everything lives in this one repo:

| | Where | What |
|---|---|---|
| **Plugins** | `plugins/<name>/` | Nineteen DSH plugins — agent tools, remote access, native OS apps, GUI tweaks, model plumbing. One installable npm package each. [Below](#plugins). |
| **The fork** | `deepseek-harness/` (git submodule) | [the custom fork of DSH](https://github.com/taliesinb/deepseek-harness), branch `feat/embed-session`, pinned to the commit the plugins were last tested against. A handful of features needed changes no plugin can make. [Below](#the-fork). |
| **macOS apps** | built by `plugins/dsh-tailscale-remote` | Native WKWebView Dock apps for the local server, the preview server and remote Macs, with loopback port forwarding. [Below](#native-os-apps). |
| **Tooling** | `tools/`, `package.json` scripts | Fresh-machine bootstrap, plugin bundle install, deploy-to-remote, remote control. |
| **Recipes** | `recipes/` | One Markdown file per completed setup / change / diagnosis, written so a future agent (or human) with zero context can reproduce it. Index in `AGENTS.md`. |

`AGENTS.md` is the development guide (how DSH plugins work, house rules,
recipe index); **`INSTALLING.md`** is the fresh-machine guide (fork build,
plugins, Apple on-device model, Tailscale route, Dock app);
**`QUICKSTART.md`** is the one-page version for colleagues (thin client, full
install, update / switch version / remove).

## Quick start

### Manual build and run

To build and run a DSH server locally:

```sh
git clone --recurse-submodules https://github.com/taliesinb/dsh-plugins tali-dash-plugins
cd tali-dash-plugins/deepseek-harness && pnpm install && pnpm run build   # the fork
cd .. && for p in plugins/*/; do (cd "$p" && pnpm install); done           # plugin deps (build client plugins: pnpm build)
pnpm install-plugins                     # all live plugins into ~/.dsh/profiles/web as bundles
cd deepseek-harness && pnpm dsh web      # run
```

### Mac

Or, on a fresh machine, the one-command version of all of the above plus the
optional layers (`tools/bootstrap-mac.sh`, see `INSTALLING.md`):

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/taliesinb/dsh-plugins/main/tools/bootstrap-mac.sh)"
```

An existing DSH on the Mac is taken over (stopped, apps/CLI removed, `~/.dsh`
kept) unless `--no-replace`. Only want a Dock app that opens a DSH running on
**another** Mac of your tailnet (your instance on a shared server), without
building anything locally? The thin client, minutes instead of an hour
(`tools/bootstrap-mac-thin-client.sh`; `<host>` is that Mac's tailnet name):

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/taliesinb/dsh-plugins/main/tools/bootstrap-mac-thin-client.sh)" <host>
```

And the way back (`tools/uninstall-mac.sh`, no checkout needed): stops every
DSH process, unloads the launch-at-login relays, removes this user's tailnet
routes, moves the DSH apps to the Trash (Dock tiles too), removes a global
`dsh` CLI — asking before each group unless `--force`; `~/.dsh` and the
checkouts stay:

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/taliesinb/dsh-plugins/main/tools/uninstall-mac.sh)" uninstall [--force]
```

### Linux with Nix

To run the thin client via Nix (from a graphical desktop with Tailscale connected):

```sh
nix run github:taliesinb/dsh-plugins
# Or, from a local checkout: nix run .
```

On the first launch it will prompt you to provide your remote instance's URL.

Alternatively, it's possible to pass the server directly to `nix run`:

```sh
# Supply the server on the first launch:
nix run github:taliesinb/dsh-plugins -- https://host.example.ts.net/dsh/user/
# Or use a short tailnet host name and remote account (uses tailscale status):
nix run github:taliesinb/dsh-plugins -- remote user
```

[Client documentation](plugins/dsh-tailscale-remote/linux-app/README.md) · [NixOS setup](recipes/nixos-thin-client.md).

### Tooling

Tooling: `pnpm install-plugins` / `remove-plugins`, `pnpm bootstrap-remote user@host`
(the bootstrap over ssh), `pnpm deploy-remote user@host` (ship the built fork
to another Mac as a headless remote), `pnpm remote-app <host>` (a Dock app
straight to a remote), `pnpm remote-status|logs|restart|stop`.

## The fork

DSH is built to be extended by mounting plugins, and almost everything here
is a plugin. The submodule `deepseek-harness/` is nevertheless a **fork**
([`taliesinb/deepseek-harness`](https://github.com/taliesinb/deepseek-harness), branch
[`feat/embed-session`](https://github.com/taliesinb/deepseek-harness/tree/feat/embed-session), ~30 commits over
upstream `master`, periodically rebased — `recipes/rebase-fork-on-upstream.md`)
because a few things live below any plugin seam:

- **Document-relative Host URLs.** Stock DSH anchors `/api/…`, the
  `/api/remote.mux` WebSocket, `/plugins/…` bundles and `<base href>` at the
  origin, so it cannot be served behind a path mount such as
  `https://<node>.ts.net/dsh/` (Tailscale Serve strips the prefix). The fork
  resolves every URL relative to the served document, so one build works at
  `http://127.0.0.1:3080/` and behind the mount. This is what the whole
  remote-access story stands on.
- **`?embed=<sessionId>`** — a chrome-less page presenting exactly one
  Session (no sidebar, no header). Used by the hybrid remote frames and by
  the per-session QR code on phones.
- **Sidebar and workspace seats** — a unary `workspace.list`, additive
  sidebar sections (`sidebar.workspaces.extra`, where the *Remotes* section
  sits) and header-action seats, so plugins can extend the session tree
  instead of replacing it.
- **Moving sessions between workspaces** — `session.move` / `moveMany`,
  *Move to…* / *Rehome…* dialogs, cross-workspace drag; a move refuses (naming
  the running turn / background jobs / subagents it would interrupt) or asks
  whether to inform the agent; **`POST /api/session.import`** receives an
  exported ZIP as sessions of a workspace; a `session-persistence/stored` event.
- **Slug session titles** — `session-title-llm` gains `style: slug`
  (`foo-bar-baz` titles, enforced, retried once).
- **Fixes found in the field** — the twice-loaded `dsh-tools` scheduler key
  (`Symbol.for`), JavaScriptCore's multi-line `[native code]` rendering that
  made every Dock-app session stick at "Loading history…", `openState`
  never left at `loading`, the document scroll pinned so the viewport cannot
  stick shifted, no text selection / native drag from the session tree, the
  preset hero chip following the session's projection.

Everything else — tools, remote access, apps, UI — is a plugin.

## Plugins

### Agent tools

- `fs-tools` — batch filesystem tools beside the built-ins: `list_dir` (directories
  included, depth, sizes), `read_many` (several files or line ranges per call,
  counted as "read" by the edit guard), `edit_many` (several literal replacements
  across files, all validated before anything is written), `search` (ripgrep
  with context, files/count modes, include/exclude globs, several roots and
  patterns). Motivated by transcript analysis showing `bash` mutating files
  more often than `edit`+`write`. Host-only.
- `wait-tool` — a `wait` tool replacing bash `sleep N`. Because the model
  states the duration, the chat renders the call as a live progress bar with
  **Skip** (return early, worded as the timeout having elapsed) and **Abort**
  (fails the call with "user aborted sleep", so the model stops and asks)
  buttons; a system-prompt line steers the model away from `sleep`. Host +
  browser halves.
- `chat-title` — the agent reviews the automatic chat title: a `rename_chat`
  tool over the harness's session-title service (titles in the in-tree
  titler's configured style; refuses in subagents and never overrides a title
  the human chose), a short system-prompt rule (rename when the automatic
  title is wrong or generic, when a better name appears in the first few
  turns, or when the subject changes) and a runtime-context line showing the
  current automatic title. Off for presets without tools. Host-only.
- `session-introspect` — `transcript_*` tools that let an agent read *other*
  agents' transcripts over the harness's own session query, never the zstd logs:
  `transcript_find` (by `workspace/title`, age), `transcript_outline` (per-turn
  table of contents), `transcript_read` (timeline), `transcript_grep`,
  `transcript_event` (one raw event), `transcript_tool_stats` (per-tool error
  rate, latency, what the agent did after each failure). Host-only.
- `browser-automation` — per-chat Safari (Technology Preview) and Chrome with a
  curated `safari_*` / `chrome_*` tool set: per-session windows addressed by id
  (`s:0:1`, `c:0:0`), isolated page readers (`safari_get_page_content`,
  `safari_get_youtube_notes`), element-aware inline screenshots. Owns the MCP
  forwarding (private SDK connections to `safaridriver --mcp` and
  `chrome-devtools-mcp`); host-only. See its README.
- `dash-docsets` — native `dash_list_docsets` / `dash_search` / `dash_get_page`
  tools over the loopback HTTP API of Dash 8 (macOS docs browser): fuzzy
  symbol search across installed docsets, pages (or just the anchored section)
  as Markdown with MathML → LaTeX; launches Dash hidden and enables its API
  server on demand. Host-only, no MCP. See its README.
- `<private-plugin>` — per-chat <private> Language kernels
  (`wl:<session>:<kernel>`) supervised over <private>'s own AgentTools MCP
  server: `<private>_eval` / `<private>_run` / `<private>_show` (retina plots shown
  inline to the user; `Manipulate` becomes an interactive widget; `Graphics3D`
  a native rotatable three.js scene) / `<private>_symbol` / `<private>_lint` /
  `<private>_kernel_*` lifecycle tools. Host + browser halves; no `mcp__*` names
  reach the model. See its README.

### Remote access, phones and Macs

- `dsh-tailscale-remote` — drive the GUI from any device on your tailnet at
  `https://<node>.ts.net/dsh/`: an authenticating loopback reverse proxy
  published with `tailscale serve`, a Tailscale-user allowlist, a *Tailscale
  remote* settings section (enable/disable, URL, allowed users, QR code with the
  access token), a **per-session QR button** in the Session header whose code
  opens *that one Session* chrome-less on a phone (`?embed`), an always-on relay
  LaunchAgent that starts `dsh web` on a cold open, **the Dock apps** and
  **loopback port forwarding** ([below](#native-os-apps)). Host + browser
  halves. See its README.
- `dsh-remote-workspaces` — **hybrid local/remote sessions**: mirror
  workspaces of *other* DSH servers in this GUI. A bottom-anchored *Remotes*
  sidebar section (a fork seat) lists each remote's workspaces and sessions
  (group by workspace / server / one flat list; manual, last-updated or
  last-created order; drag-to-reorder; hover cards); selecting a remote session
  frames its `?embed` page in an iframe served **same-origin** by this plugin
  through an egress proxy (`/remote/<server>/…`, HTTP + WebSocket) that holds the
  remote's credentials; create / rename / archive go host-to-host over the
  remote's RPC. Local and remote sessions sit in one sidebar and one window.
- `phone-ui` — a chat-only Session on phone-width viewports: hides the
  Session header, Chat/Trajectory tabs, per-message icon rows and the composer
  stats dock below a configurable width (default 640px), tightens margins and code-block chrome, and replaces
  the composer with a bottom "tongue" that opens a full-screen text entry
  (sized to `visualViewport`, since iOS covers rather than shrinks the layout
  viewport). Rules are keyed on the media query *and* on the Dock apps'
  `data-dsh-view="mobile"` flag. Host + browser halves.
- `foreign-link-opener` — when the GUI runs as a Safari "Add to Dock" web app,
  links that leave the DSH server (other ports, other hosts) open in the real
  Safari via `open -a` instead of another DSH-branded window (a web app's scope
  is host-only and `window.open` never leaves it). The WKWebView Dock apps do not
  need it — the wrapper sends out-of-scope links to the default browser itself.
- `import-api-keys` — `/import-api-keys` browser command: native file picker,
  reads pi's `auth.json` (or a flat key map / `.env`), shows what is new,
  unchanged or would be replaced, stores the keys as DSH credentials. Same in
  the local app, a hybrid remote frame and a direct-remote app.

### GUI

- `numbered-switching` — the five most recently viewed sessions hold stable
  numbers 1–5 shown in the sidebar gutter; ⌘1…⌘5 switch between them (LRU
  eviction when a sixth opens). Optionally couples to `dsh-remote-workspaces`
  so remote sessions take numbers too. Browser-only.
- `session-title-slug` — start the very first prompt of a New Session with
  `some-slug: ` to name the session; the sidebar row previews the slug live
  while you type. Browser-only.
- `settings-shortcut` — ⌘. (Ctrl+. off macOS) toggles the Settings panel in
  Chrome, Safari and the Dock apps. ⌘, is impossible in Safari (the app
  consumes it before the page sees it). Browser-only.
- `transcript-grace-margin` — a visible "end of transcript" margin under the
  last row of an active session, so the bottom of a long chat unmistakably
  reads as the end. Host-only `<style>` row.
- `instance-identity` — tell DSH instances apart: colour the sidebar whale
  (and `/favicon.svg`) per instance (preview red, remotes blue), relabel the
  wordmark and window title, quieten the build-version chip. Host-only; the
  Dock apps carry the same rules themselves.
- `reload-on-restart` — when the page reconnects to a *restarted* server
  (every client bundle revision re-minted at once), reload instead of letting
  client HMR hot-swap the whole plugin tree in place, which crashes the React
  root and leaves a black window. Browser-only.

### Models and presets

- `local-model-supervisor` — host local model servers (AFM for Apple's
  on-device model, llama.cpp, …) from DSH itself: start on first
  `model/selection` for a carried provider, reuse across sessions, adopt (and
  never kill) externally started instances, stop owned servers once idle and
  unselected. Host-only.
- `enforce-model-preset` — bind agent presets to model selections: on a
  committed `model/selection` in a still-blank session, switch its preset per a
  first-match rule table (`provider`/`model` → `preset`), so tiny local models
  get tiny compositions instead of the ~8.3k-token standard toolbelt.
- `no-global-tools` — an agent-preset row that hides every deployment-global
  tool (`ctx.tools.restrict({ allow: [] })`), for chat-only presets on tiny
  local models.

## Native OS apps

Not a plugin feature exactly — a ~350-line AppKit/WKWebView wrapper compiled
on the target Mac with `xcrun swiftc` (Command Line Tools suffice), built and
installed by `dsh-tailscale-remote`'s scripts (`pnpm dock-app:install`,
`pnpm remote-app <host>`) or by the bootstrap. Why not Safari's *Add to Dock*:
that web app authenticates with a 30-day cookie it has no URL bar to renew,
and Launch Services refuses any web-app bundle Safari did not create itself.
The wrapper needs no permission of any kind. Three flavours share one source:

| App | Glyph | Opens |
|---|---|---|
| **DSH** | black | this Mac's own server via the tailnet route, admitted by the node's *own* Tailscale identity (no token, no expiring cookie); falls back to the loopback relay + token when Tailscale is off; the relay starts `dsh web` on a cold open |
| **DSH Preview** | red | a second server on its own `~/.dsh-preview` home with the dev overlay of all plugins in this repo — for trialing plugin changes without touching the live GUI |
| **DSH \<Host\>** | blue | *direct-remote*: another Mac's DSH over the tailnet, identity admission or nothing — `dsh web` in a window, no hybrid frame |

What the wrapper does beyond showing a page:

- **Automatic loopback port forwarding.** An agent on the (remote) DSH host
  starts a dev server and writes `http://127.0.0.1:5173/`; in a remote app that
  URL would name *this* Mac's loopback. Before such a link loads, the app opens
  a listener on the same local port and tunnels every TCP connection through a
  WebSocket on the channel the page already uses (`/api/loopback-forward`,
  policed on the host by an allowlist, a reserved-port list and a uid guard), so
  the URL works verbatim — Host header, absolute paths, cookies, HMR socket.
  View ▸ *Forwarded Ports* lists and closes them.
- **View ▸ Desktop / Mobile** — resize to iPhone 390×844 and stamp
  `data-dsh-view="mobile"` so `phone-ui`'s rules apply, for trialing the phone
  layout on the Mac.
- Real second windows for in-scope `window.open` / `target=_blank`; every
  out-of-scope link goes to the default browser; a persistent data store per
  app (bundle ids differ, so cookies never mix); menu bar (reload, reconnect,
  zoom, full screen, open in browser, copy address); frame autosave; page
  diagnostics to `~/Library/Logs/DSH Dock/<app>.log`; the instance's name and
  colour carried into the page (wordmark, whale, window title); a native
  open-panel hint used by `/import-api-keys`; a WKWebView menu-focus fix
  without which Radix radio rows were unselectable.

Design notes and the traps met along the way: `recipes/dock-app-via-tailnet.md`,
`recipes/inline-links-remote-audit.md`, `recipes/phone-ui.md`,
`recipes/instance-identity.md`.

## Recipes

Every non-trivial task ends in a recipe under `recipes/` — exact paths,
config blocks and commands, the *why* behind non-obvious choices, and what
**failed** and why (the failed attempts are what save the next agent hours).
Thirty-odd so far, from `apple-foundation-model-provider.md` and
`bootstrap-mac-installer.md` through `rebase-fork-on-upstream.md` and
`<private-plugin>-graphics3d.md`; the annotated index is in `AGENTS.md`.

## Credits

The hat-and-glasses logo is by [Demonstrandum](https://github.com/Demonstrandum).
