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

- **Safari**: Safari Technology Preview 247+ (or Safari 27) running, with
  Develop ▸ Developer Settings ▸ *Allow Remote Automation* enabled. Stable
  Safari 26's `/usr/bin/safaridriver` has no `--mcp`.
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
        # traceFile: /tmp/browser-automation-trace.log   # JSON lifecycle lines
```

Full config surface is documented at the top of `index.js`. Module code changes
need a host restart (`dsh web` has module HMR disabled; only the patch file is
live-reloaded). `pnpm run check` runs a keyless smoke test.

## What the model sees

- `browser_open { browser: safari | chrome }` → mounts, waits for MCP tool
  discovery, returns usage notes; `mcp__safari__*` / `mcp__chrome__*` appear in
  the tool list on the next model step (the registry projects schemas at
  request time). A failed start (STP not running, server not installed) comes
  back as the tool error with a hint.
- `browser_close { browser? }` → disposes the mount(s); tools disappear.
- Idle close injects a `[browser-automation] …` notice so the model knows to
  reopen.

Tool names are DSH's fixed MCP convention `mcp__<server>__<tool>`
(`packages/mcp/mcp-client/src/tools.ts`, `publicToolName`): `__` because both
halves contain `_`, `mcp` so external tools are addressable as a class.

## Gotchas learned the hard way

- Safari's `evaluate_javascript` takes `expression` as a **function body**:
  `return …`. Each `--mcp` process is its own automation session with no tabs
  until the first `navigate_to_url`.
- The "Chrome is being controlled by automated test software" bar comes from
  Puppeteer's default `--enable-automation` switch; the server's
  `--ignoreDefaultChromeArg=--enable-automation` removes it (this plugin does so
  by default). Side effect: `navigator.webdriver` reads false.
- Chrome's `take_screenshot`: omit `filePath` — the image returns inline via
  DSH's attachment store; the server only writes under its cwd / temp dir.
- `ctx.logger` output of host plugins does not reach `/tmp/dsh-web.log` (only
  child stdio does); use `traceFile` to debug lifecycle.
- The `defineTool` parameter DSL rejects `required: false` — omit the key.
