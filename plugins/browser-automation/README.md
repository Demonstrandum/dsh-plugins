# tali-browser-automation

One browser per chat, started on demand. Gives every DSH session two small
tools, `browser_open` and `browser_close`, which mount Apple's Safari MCP
server (`safaridriver --mcp`) or Google's `chrome-devtools-mcp` **into that
agent's own scope**. Each chat therefore drives its own browser and its own
page/tab list; concurrent chats never interfere. Host-only plugin (no client
half); plain ESM JavaScript.

## Why not just configure the MCP servers in `cordis.patch.yml`?

That works, but it is host-scoped: one server process shared by every session,
and both browser servers keep per-connection state (Chrome's "selected page",
Safari's "active tab"). Two chats using it at once clobber each other. Agent
presets do not help — a preset is a standing mount that sessions join. The only
per-session composition point in the Web GUI is the agent, and mounting there
is exactly what `dsh-acp` does for `session/new` `mcpServers`.

## Why lazy (`browser_open`) rather than a browser per session automatically?

Web sessions are never disposed by the session controller (a live agent lives
until the host exits) and continuable subagents stay resident, so an eager
mount on `agent/created` accumulates a `safaridriver` + `chrome-devtools-mcp`
pair per session for the host's lifetime (observed: 11 pairs after a few
minutes of normal use). `browser_open` costs nothing until a chat actually
needs a browser, an idle timer (default 30 min) reclaims it, and
`browser_close` frees it explicitly.

## Requirements

- **Safari**: Safari Technology Preview 247+ (or Safari 27) with Develop ▸
  Developer Settings ▸ *Allow Remote Automation* enabled. The driver launches
  STP itself if needed and opens its automation tab in a separate STP window
  **in the background** (not focused) — it never touches the user's regular
  Safari. There is no classic-Safari fallback: stable Safari 26's
  `/usr/bin/safaridriver` has no `--mcp` mode, so `browser_open safari`
  fails with an explanatory error when STP is missing.
- **Chrome**: `npm i -g chrome-devtools-mcp` (pinned 1.8.0 here) and Google
  Chrome. Always run `--isolated` (temporary profile per instance, deleted on
  close) because Chrome refuses to share a user-data-dir between instances; so
  no persistent logins. Chrome itself launches on the first navigation.

## Install

Dev overlay (already in `../../cordis.dev.yml`), or a permanent row in a
profile's patch layer (what the `web` profile uses):

```yaml
- insert:
    - id: tali-browser-automation
      name: '/Users/USER/github/tali-dash-plugins/plugins/browser-automation/index.js'
      config:
        subagents: true         # child agents get browser_open too (each its own browser)
        idleMinutes: 30         # 0 = never auto-close
        chrome:
          headless: false       # true = no visible Chrome window
          hideAutomationBanner: true   # drops --enable-automation (no infobar)
          disableCategories: [performance, emulation]   # fewer mcp__chrome__ tools
        # traceFile: /tmp/browser-automation-trace.log   # JSON lifecycle lines
```

Full config surface is documented at the top of `index.js`. Module code changes
need a host restart (`dsh web` has module HMR disabled; only the patch file is
live-reloaded). `pnpm run check` runs a keyless smoke test.

## `safari_get_page_content` — isolated page reads

`safari_get_page_content { url, format?, waitMs?, maxWordsPerParagraph?,
includeURLs?, script? }` reads one page with a real Safari engine and returns
its content, **without touching the chat's own `browser_open` session** — a
page the agent is working on is never changed underneath it.

- **Formats** `markdown | plainText | text | textTree | html | json` — the
  extraction is WebKit's own (`get_page_content` in Apple's MCP server); the
  plugin only passes options through. It overrides the server's
  `maxWordsPerParagraph` default of 15, which silently truncates prose, and
  always extracts `region: entire_page`.
- **Reader pool** (`reader-pool.mjs`, host-wide, starts empty): a read takes an
  idle reader or spawns one — its own `safaridriver --mcp` process, hence its
  own STP window labeled `DSH: page reader #n`, driven by a private MCP SDK
  client (nothing is registered into any agent). Concurrent reads (e.g.
  subagents) each get their own reader. Afterwards the reader closes its tab
  (window included; the driver session and STP stay warm, the next read opens
  a fresh tab) and returns to the pool; readers beyond `reader.maxIdle`
  (default 1) are disposed at once, the rest after `reader.idleMinutes`
  (default 30) unused. Cold start is serialized: two brand-new sessions
  navigating simultaneously can both launch STP and orphan an instance (seen
  once); the first reader finishes its navigation before others spawn.
- **`waitMs`** for lazily rendered pages; **`script`** (a JS function body,
  `return …`) runs in the loaded page and its value is returned as
  `scriptResult`, for structured data that is not in the rendered text.
- Output beyond `reader.maxChars` (120 000) is truncated and the full text
  saved to a temp file whose path is reported.

Live check (spawns STP): `pnpm run live:reader`.

## `safari_get_screenshot` / `safari_save_screenshot` — element-aware captures

Both act on the chat's own Safari session (auto-`browser_open` if needed) and
are **composite tools**: every MCP call runs through the DSH tool registry as a
nested execution of the composite (`ctx.tools.execute` with the composite's
`rootCallId`/`token` as parent, same agent and cancellation — the pattern
`run_code` uses), so nested calls keep DSH's policy, timeout and transcript
handling.

- `safari_get_screenshot { querySelector?, scrollTo?, fullPage? }` returns the
  image **inline** (stored in DSH's attachment store, same admission rule as the
  MCP bridge: the current model must declare image input, otherwise the PNG is
  written to a temp file and its path returned).
- `safari_save_screenshot { path, … }` writes the PNG to disk (relative to the
  session workspace) and returns path + size.
- With `querySelector`: an in-page script finds the element, scrolls it into
  view (`scrollTo`, default true), waits until its rect and the scroll offset are
  stable for three frames, and reports rect + devicePixelRatio + viewport; the
  viewport is captured; the rect is re-measured and, if it moved > 2 px, the
  capture is retaken once; the crop box is computed from the *actual* image
  size vs. the CSS viewport (exact for fractional DPR) and cut with sharp.
  Apple's own `screenshot` `node` parameter is a documented no-op, hence this.
  Verified pixel-exact on iana.org's `h1` (900×350 @2x, 214 ms) and a
  below-the-fold `footer` (`safari-screenshot.mjs`; live: `pnpm run live:screenshot [url] [selector]`).
- Cropping uses sharp, not `sips`: `sips --cropOffset 0 0` is treated as unset
  and center-crops (verified), which would silently break top-left elements.

The raw `mcp__safari__screenshot` stays visible — `ctx.tools.restrict()` masks
only global tools, and mounted MCP tools are scope-local — so the usage notes
steer the model to the composite tools instead. Chrome's tool set is trimmed
server-side via `chrome.disableCategories` (default `performance`, `emulation`
→ `--no-category-*`).

## `safari_get_youtube_notes` — show notes for a video

`safari_get_youtube_notes { url }` (watch / `youtu.be` / shorts / embed URL, or
a bare 11-character id) returns title, channel, duration, view count, publish
date, keywords, **chapters** parsed from timestamp lines, links, and the full
description. The rendered watch page never contains the full description
(collapsed behind "…more"), so the tool reads `videoDetails` out of the inline
`ytInitialPlayerResponse` script through an isolated reader
(`youtube-notes.mjs`; ~4–10 s depending on YouTube). Live check:
`pnpm run live:youtube [url]`.

## What the model sees

- `browser_open { browser: safari | chrome }` → mounts, waits for MCP tool
  discovery, returns usage notes; `mcp__safari__*` / `mcp__chrome__*` appear in
  the tool list on the next model step (the registry projects schemas at
  request time). A failed start (STP not running, server not installed) comes
  back as the tool error with a hint.
- `browser_close { browser? }` → disposes the mount(s); tools disappear.
- `safari_get_screenshot` / `safari_save_screenshot` → element-aware captures, see above.
- `safari_get_page_content { url, … }` → isolated read, see above.
- `safari_get_youtube_notes { url }` → structured show notes, see above.
- Idle close injects a `[browser-automation] …` notice so the model knows to
  reopen.

Tool names are DSH's fixed MCP convention `mcp__<server>__<tool>`
(`packages/mcp/mcp-client/src/tools.ts`, `publicToolName`): `__` because both
halves contain `_`, `mcp` so external tools are addressable as a class.

## Safari Technology Preview: what can be controlled (investigated)

Sources: `strings` over STP's bundled `WebDriver.framework` (which holds the
`--mcp` server), `Safari.framework`, and live experiments with concurrent
`safaridriver --mcp` clients. pi-web's bridge (`rho/extensions/mcp.ts`) runs
plain `safaridriver --mcp` with inherited env, one connection per pi process —
nothing beyond what this plugin does.

| Lever | Effect | Verdict |
|---|---|---|
| `safaridriver --mcp` | MCP server over stdio (STP 247+ / Safari 27 only) | used |
| `-p/--port`, `-b/--bidi`, `--enable`, `--diagnose` | classic WebDriver mode only | n/a |
| `SAFARI_MCP_DIAGNOSE` (env, undocumented) | MCP diagnostics logging (`mcpDiagnosticsEnabled`) | debugging only |
| `SAFARI_MCP_AGENT_NAME` (env, undocumented) | agent name **fallback** when the client sends no `clientInfo`; ignored otherwise | not useful (DSH always sends clientInfo) |
| MCP `initialize` `clientInfo.name` | Safari's per-window banner: *"This window is controlled by \<name\>."* | **used** — `safari-mcp-shim.mjs` rewrites it per chat |
| Safari launch switches (`--automation`, `--resetSafari`, `--page-load-test`, …) | internal test hooks; the driver launches STP itself with `--automation` | none applicable |
| Window position | no MCP tool and automation windows are hidden from AppleScript/Accessibility (only `set_viewport_size` exists) | not controllable |

Observed session/window semantics (STP 251):

- Each `--mcp` process is its own automation session **with its own STP
  window** — tabs, "active tab", `evaluate_javascript`, and `screenshot` are
  fully isolated between sessions (verified with two concurrent sessions on
  different pages). All windows open at the same screen position, so they
  stack; the banner label is how you tell them apart.
- A session that ends cleanly (stdin EOF; the driver exits in ~10–20 ms, inside
  the MCP SDK's 2 s grace before SIGTERM) closes its window. A SIGTERM'd
  session **leaks its window** until STP quits.
- The first session launches STP if needed; STP quits when the last session
  ends. Another session's clean close never disturbs a live one.
- MCP ("agentic") sessions allow user interaction in the window, unlike
  WebDriver sessions.
- There is no classic-Safari path: stable Safari's driver has no `--mcp`.

## Gotchas learned the hard way

- Safari's `evaluate_javascript` takes `expression` as a **function body**:
  `return …`. A session has no tabs (and no window) until the first
  `navigate_to_url`.
- The "Chrome is being controlled by automated test software" bar comes from
  Puppeteer's default `--enable-automation` switch; the server's
  `--ignoreDefaultChromeArg=--enable-automation` removes it (this plugin does so
  by default). Side effect: `navigator.webdriver` reads false.
- Chrome's `take_screenshot`: omit `filePath` — the image returns inline via
  DSH's attachment store; the server only writes under its cwd / temp dir.
- `ctx.logger` output of host plugins does not reach `/tmp/dsh-web.log` (only
  child stdio does); use `traceFile` to debug lifecycle.
- The `defineTool` parameter DSL rejects `required: false` — omit the key.
