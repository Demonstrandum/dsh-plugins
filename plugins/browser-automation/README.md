# tali-browser-automation

Per-chat Safari (Technology Preview) and Chrome automation for DSH with a
**curated tool set**: `safari_*` and `chrome_*` tools, per-session windows
addressed by id, isolated page readers, and element-aware screenshots. The
plugin owns the MCP forwarding itself — it holds private MCP SDK connections to
Apple's Safari MCP server (`safaridriver --mcp`) and Google's
`chrome-devtools-mcp`, and registers exactly the tools it wants. Nothing else
reaches the model: no `mcp__server__tool` names, no raw server tools, no
`dsh-mcp-client`. Host-only plugin, plain ESM JavaScript.

## Tools

41 tools, 20 Safari + 21 Chrome — full reference with every parameter, return value
and implementation note in **[`docs/tools.md`](docs/tools.md)** (generated from
the definitions by `pnpm run docs`; `pnpm run check` fails when it is stale).

| Area | Safari | Chrome |
|---|---|---|
| Windows | `safari_open`, `safari_close` | `chrome_open`, `chrome_close` |
| Navigation / reading | `safari_navigate`, `safari_get_page_content` (isolated reader or window), `safari_wait_for`, `safari_get_youtube_notes` | `chrome_navigate`, `chrome_snapshot`, `chrome_wait_for` |
| JavaScript | `safari_evaluate_expression`, `safari_evaluate_function` | `chrome_evaluate_expression`, `chrome_evaluate_function` |
| Interaction | `safari_interact` (batch), `safari_click`, `safari_hover`, `safari_press_key`, `safari_type_text` | `chrome_interact` (batch, same format), `chrome_click`, `chrome_fill`, `chrome_fill_form`, `chrome_hover`, `chrome_press_key`, `chrome_type_text` |
| Screenshots | `safari_get_screenshot` (inline, element crop), `safari_save_screenshot` | `chrome_get_screenshot`, `chrome_save_screenshot` |
| Diagnostics | `safari_console_messages`, `safari_network_requests`, `safari_get_network_request`, `safari_handle_dialog`, `safari_set_viewport_size` | `chrome_console_messages`, `chrome_network_requests`, `chrome_get_network_request`, `chrome_handle_dialog`, `chrome_set_viewport_size` |

Raw server names and schemas these forward to: `docs/server-tools.json`
(`pnpm run dump:tools` regenerates it).

## Windows and sessions (`windows.mjs`)

- Every agent (chat or subagent) that uses a browser gets a **session index**,
  consecutive over the plugin instance's lifetime. Windows are numbered from 0
  per browser within the session: `s:0:0`, `s:0:1`, `c:0:0`, …
- **Safari window = one `safaridriver --mcp` process** = its own automation
  session and its own STP window (fresh cookies/JS state). This is the only
  isolation Safari offers, and it is real: two windows on different pages keep
  independent tabs, `evaluate`, and screenshots (verified). The STP banner
  reads *"This window is controlled by DSH: ‹chat title› · s:0:1."* — the MCP
  handshake's `clientInfo.name`, which we set per window.
- **Chrome window = one page** of a single `chrome-devtools-mcp --isolated`
  instance per session, routed by `pageId`; windows share the session's
  cookies like tabs of one browser. Fresh temporary profile: no saved logins.
- Every window tool takes optional `windowId`. Omitted, the browser must have
  **zero or one** window in the calling session: zero opens one (`opened` is
  reported), one is used, more is an error naming the open ids. Ids are
  validated against the caller's session; a window of another chat is
  unreachable.
- Per-session behavior needs **no dynamic tool registration**: the tool set is
  static (registered per agent at `agent/created`, also for agents already
  live when the plugin loads) and every call reads `exec.agent`.

## Lifecycle

- Nothing is spawned until a tool needs it. Web sessions are never disposed by
  DSH, so a per-session idle timer (`idleMinutes`, reset by every tool call)
  closes a session's windows and injects a notice; agent disposal and plugin
  unload close everything.
- **STP instance ownership** (`servers.mjs`): Apple's driver launches STP on a
  session's first navigation and terminates it only when *that* session ends
  — if other sessions were alive at that moment, the instance lingers forever
  with no windows (observed). We count live Safari connections host-wide; if
  the first one starts while no STP instance runs, the instance is ours, and
  when the count returns to zero we quit it after a 3 s grace period
  (osascript `quit`, then SIGTERM). A connection ending cleanly (stdin EOF —
  the driver exits in ~20 ms, inside the MCP SDK's 2 s grace before SIGTERM)
  closes its window; SIGTERM'd drivers leak windows.
- **Reader pool** (`reader-pool.mjs`): `safari_get_page_content` with a url and
  `safari_get_youtube_notes` read in isolated readers (own STP windows labeled
  `DSH: page reader #n`), never in a chat's window. Concurrent reads each get a
  reader; `reader.maxIdle` (1) stay warm (a warm read is ~1.5–2 s vs ~4 s
  cold); the rest close after `reader.idleMinutes`. Cold start is serialized
  (two brand-new sessions navigating simultaneously can both launch STP).

## Screenshots (`safari-screenshot.mjs`)

Apple's `screenshot` captures the whole viewport (its `node` parameter is a
documented no-op). With `querySelector` we: find the element, `scrollIntoView`
(`scrollTo`), poll with `setTimeout` until rect and scroll offset are stable for
three samples (**not** `requestAnimationFrame` — it does not fire in occluded
windows, e.g. a second stacked STP window, and hung the loop until the 30 s
script timeout), capture the viewport, re-measure (retake once if it moved
> 2 px), and crop with **sharp** at device-pixel precision (scale = image
width ÷ CSS viewport, exact for fractional DPR). Not `sips`: its
`--cropOffset 0 0` is treated as unset and center-crops (verified). Inline
images go through DSH's attachment store under the same admission rule as the
MCP bridge (the model must declare image input; otherwise a temp file path is
returned). Verified pixel-exact on iana.org's `h1` and a below-the-fold
`footer`. Chrome element capture uses the server's native `uid` screenshots.

## Requirements

- **Safari**: Safari Technology Preview 247+ (or Safari 27) with Develop ▸
  Developer Settings ▸ *Allow Remote Automation*. STP is launched on demand,
  in the background; the user's regular Safari is never touched. There is no
  classic-Safari fallback (stable Safari's driver has no `--mcp`); tools fail
  with an explanatory message when STP is missing.
- **Chrome**: `npm i -g chrome-devtools-mcp` (1.8.0 here) and Google Chrome.
  Launched with `--isolated`, `--no-usage-statistics`, and
  `--ignoreDefaultChromeArg=--enable-automation` (no "controlled by automated
  test software" bar; `chrome.hideAutomationBanner`).

## Install

Dev overlay (`../../cordis.dev.yml`) or a permanent row in a profile's patch
layer (what the `web` profile uses):

```yaml
- insert:
    - id: tali-browser-automation
      name: '/Users/USER/github/tali-dash-plugins/plugins/browser-automation/index.js'
      config:
        subagents: true         # child agents get their own sessions too
        idleMinutes: 30         # 0 = never auto-close
        chrome:
          headless: false
        # traceFile: /tmp/browser-automation-trace.log   # JSON lifecycle lines
```

Full config surface: top of `index.js`. Module code changes need a host
restart (`dsh web` has module HMR disabled; only the patch file is
live-reloaded).

## Checks

- `pnpm run check` — offline smoke: config, preflight messages, the 41
  registered tools per agent (child filter, disposal), window-id rules
  (numbering, ambiguity, cross-session, browser mismatch), YouTube and
  geometry helpers; plus a freshness check of `docs/tools.md`.
- `pnpm run docs` — regenerate `docs/tools.md` after changing a tool.
- `pnpm run live:windows` — the live matrix through the real tool executes:
  two Safari windows, isolation, zero-or-one rule, window/isolated reads,
  element screenshot, save, auto-open, two Chrome windows, snapshot/evaluate/
  screenshots, cleanup to zero processes.
- `pnpm run live:reader`, `live:youtube [url]`, `live:screenshot [url] [selector]`.

## Gotchas learned the hard way

- `ctx.logger` output of host plugins does not reach `/tmp/dsh-web.log` (only
  child stdio does); use `traceFile`.
- The `defineTool` DSL rejects `required: false` (omit the key) and requires
  explicit `additionalProperties` on nested object schemas.
- `ctx.tools.restrict()` masks only global tools — one more reason to own the
  forwarding rather than mount raw MCP tools and try to hide some.
- pi-web's bridge (`rho/extensions/mcp.ts`) runs one bare `safaridriver --mcp`
  per pi process: all its sessions share one automation window, labeled
  `rho-mcp-bridge`.
