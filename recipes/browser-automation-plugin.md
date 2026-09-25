# Per-chat browser automation (Safari Technology Preview + Chrome) for DSH

Gives every DSH chat (and, optionally, every subagent) its own browser windows
through a curated set of `safari_*` / `chrome_*` tools, plus an isolated
"page reader" for `read this URL` requests that beats `web_fetch` on
JavaScript-rendered or bot-blocked pages (YouTube, docs sites, SPAs).

Plugin: `~/github/tali-dash-plugins/plugins/browser-automation` — **read its
`README.md` and `docs/tools.md` for the tool-level story**; this recipe owns
the system-level one. Built 2026-09, local-only (machine-specific paths).

## Why a plugin at all (and not just MCP config)

| Want | What it takes |
|---|---|
| One browser shared by the whole host | Config only: a `dsh-mcp-client` stdio row running `safaridriver --mcp` or `chrome-devtools-mcp`. Every chat drives the **same** window — concurrent agents collide. |
| A browser **per chat**, started lazily, closed when idle | A plugin: it must know agents (`ctx.agents.list()`, `agent/created`, `agent/disposed`), register tools per agent, and own the child processes. |

pi-web (the `rho` bridge) does the former: one bare `safaridriver --mcp` per
pi process, banner `rho-mcp-bridge`. The "exa" the maintainer remembered was
pi-web-access's Exa.ai *search* provider, unrelated to browsing.

## The Safari facts that shape the design

- Only **Safari Technology Preview** ships `safaridriver --mcp`
  (`/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver`).
  Stable `/usr/bin/safaridriver` (Safari 26.x) has no `--mcp`; there is no
  classic-Safari fallback, so the plugin fails with an explicit message.
- **One `--mcp` process = one automation session = one STP window** with the
  banner *"This window is controlled by ‹clientInfo.name›."* — the MCP
  handshake's client name is the label, so each window says which chat owns it.
- The first session launches STP (`--automation -ApplePersistenceIgnoreStateQuietly`)
  and only *that* session's teardown quits it → orphaned STP with no windows if
  other sessions were alive. The plugin counts live Safari connections and
  quits STP itself when the count hits zero (`osascript quit`, then SIGTERM).
- Clean stdin EOF exits the driver in ~20 ms and closes its window; SIGTERM
  leaks windows. The MCP SDK's `close()` does stdin-end → 2 s grace → SIGTERM,
  which is fine.
- `evaluate_javascript`'s `expression` is a **function body** (needs `return`).
  `get_page_content` defaults `maxWordsPerParagraph` to 15 (silently truncates
  prose) and spills results past ~40 kB to a temp file, answering
  `Saved large output to '<path>'` — follow the pointer.
- `requestAnimationFrame` does not fire in occluded windows; poll with
  `setTimeout`.
- WebKit's extractor returns only **rendered** text: closed `<details>`,
  collapsed accordions and unselected tab panels are absent; headings come out
  as plain lines; link text that also appears in the href is dropped
  (`[](https://npmjs.com/package/mcp-remote)`). The plugin's `page-read.mjs`
  works around all of these (expand / scope / markHeadings / clean) and adds
  `safari_get_page_structure` so an agent can target a section by selector.

`format: markdown` in both browsers is the plugin's own DOM serializer
(`dom-markdown.mjs`); WebKit's markdown survives as `webkitMarkdown`. Measured
on four real pages the serializer matched WebKit's speed and kept the code
fences, inline code, heading levels and tables WebKit's drops. It must walk
shadow DOM (MDN keeps code examples in `<mdn-code-example>` shadow roots) and
must not turn layout tables into pipe tables (Hacker News). Chrome has the same
read surface (`chrome_get_page_content`, `chrome_get_page_structure`);
`chrome-devtools-mcp` has **no text extractor** (its snapshot is the
accessibility tree), so it reuses that serializer and the same expand / scope /
probe scripts. Chrome hides closed `<details>` children with
`content-visibility`, which `getClientRects()` does not see — use
`element.checkVisibility()`. `chrome-devtools-mcp` also sets a bare process
title: `pgrep -f '--isolated'` never matches it; count your own node children.

Chrome side: `chrome-devtools-mcp`, pinned to an exact version in the plugin's
`package.json` and run by the host's `node` (was a Homebrew-npm global install
until 2026-09-15; see Troubleshooting "what to update"), with
`--isolated --no-usage-statistics --no-performance-crux --ignoreDefaultChromeArg=--enable-automation`
(the last one removes the "controlled by automated test software" bar). One
isolated instance per chat; "windows" are its pages, routed by `pageId`.

## Install / wire-up (what exists now)

1. Plugin code: `~/github/tali-dash-plugins/plugins/browser-automation`
   (`pnpm install` there; `@modelcontextprotocol/sdk` and `sharp` are ordinary
   npm dependencies pinned to the DSH checkout's versions since `5785d17` —
   they were `link:` paths into the checkout's `node_modules/.pnpm` before,
   which broke on every DSH dependency bump. Bump the pins when DSH bumps).
2. Live web profile row in `~/.dsh/profiles/web/cordis.patch.yml`:

   ```yaml
   - id: tali-browser-automation
     name: '/Users/USER/github/tali-dash-plugins/plugins/browser-automation/index.js'
     config:
       subagents: true      # each subagent may open its own browser
       idleMinutes: 30      # close a chat's windows after 30 min without a browser call
       chrome:
         headless: false
       traceFile: /tmp/browser-automation-trace.log   # remove when done debugging
   ```

   The profile hot-reloads (`patchReload: live`) but **module code does not**
   (`cordis-plugin-hmr` is disabled in this profile): every code change needs
   `dsh web` restarted by the maintainer. `ctx.logger` output never reaches
   `/tmp/dsh-web.log` (child stdio only) — that is what `traceFile` is for.
3. Also registered in the repo's `cordis.dev.yml` for the preview server
   (`tali-dash-plugins/PREVIEWING.md`); never load both overlays into the same
   host — duplicate loader id (`preview-identity.md`).

## Verify

```sh
cd ~/github/tali-dash-plugins/plugins/browser-automation
pnpm run check           # offline: config, 44 tools per agent, window ids, helpers, docs freshness
pnpm run live:windows    # two Safari + two Chrome windows, isolation, screenshots, zero leftover processes
pnpm run live:page-read  # expand / section / selectors / structure on a real docs page (Safari)
pnpm run live:chrome-read # the same through Chrome (headless), incl. warm reader instance + zero leftovers
```

From a fresh chat: `safari_open` twice on different sites, `safari_get_screenshot`
with `querySelector: "h1"` on the second, `safari_close`. Afterwards
`pgrep -fl "safaridriver --mcp"` should show only the host's warm pooled reader
(one process, disappears after `safari.reader.idleMinutes`).

## Failed attempts (don't repeat)

| Attempt | Why it failed |
|---|---|
| Host-scoped `dsh-mcp-client` rows for Safari/Chrome | One browser for all chats; concurrent agents fought over it. |
| Eager per-agent MCP mounts at `agent/created` | 11 process pairs leaked — Web sessions are never disposed by the session controller. Mount lazily on first tool call, close on idle. |
| Hiding raw MCP tools with `ctx.tools.restrict()` | It masks only global tools. Own the forwarding instead and register only curated tools. |
| `mcp__safari__*` tool names | DSH does not require the prefix (only `dsh-mcp-client` produces it); plain `safari_*` won. |
| `sips --cropOffset 0 0` for element crops | Offset 0 is treated as unset (center-crops). Use `sharp`. |
| rAF-based "settled" loop for screenshots | Hangs in occluded windows. `setTimeout` polling, 3 stable samples. |
| `h.textContent = '## ' + text` to mark headings | Destroys React-owned nodes; the next re-render throws and unmounts content (bodies vanished from the extraction). Write into the first text node's `data` instead, and put a layout tick between mutations and extraction. |
| `format: json` in window mode | Failed with "value is not lossless JSON": the 40 kB spill pointer wasn't followed and `undefined` fields leaked. Fixed in `servers.mjs` `unwrapPageContent`. |
| Treating "no image block" from `take_screenshot` as failure | chrome-devtools-mcp 1.8.0 (`build/src/tools/screenshot.js:256`) writes any capture ≥ 2 MB to `mkdtemp(<tmp>/chrome-devtools-mcp-XXXXXX)/screenshot.png` and answers with **text only** ("Took a screenshot of the current page's viewport.\nSaved screenshot to …"). A retina viewport of a colourful page (tensatory's plasma slider, 2400×1884, 2.6–4.1 MB PNG) hit it on every plain viewport shot, and the plugin reported the server's *success* line as `chrome screenshot failed: Took a screenshot …` — nothing for the agent to act on. Fixed 2026-09-15: `captureChrome` reads the spilled file back (`servers.mjs` `savedFileOf`) and removes the per-call temp dir; failures now quote the server, name the target/request and append a remedy (`explainFailure` / `FAILURE_HINTS` in `curated-tools.mjs`). Regression case in `scripts/smoke-config.mjs`. |

## Failure reporting (what an agent sees when a tool fails)

Every `safari_*`/`chrome_*` failure passes through `explainFailure` in
`curated-tools.mjs` (the same wrapper that strips `undefined`):

- `<curated tool>: server tool <raw name> failed: <server's own words>` — the
  raw MCP tool name (`take_snapshot`, `evaluate_javascript`, …) is kept for
  provenance because the model never sees those names otherwise.
- MCP-SDK timeouts (`-32001 Request timed out`) are explained in terms of
  `toolCallTimeoutMs` with the usual causes (blocking dialog, endless
  navigation, hung script) and the way out (`*_handle_dialog`, `*_close`).
- `Request: {…}` — the call's arguments, so the failure text is self-contained.
- `Hint: …` — the first matching remedy from `FAILURE_HINTS` (stale uid →
  re-snapshot; open dialog → handle it; page closed → reopen; not-interactive
  element → scroll/wait; `no element matches` → check the selector; model has
  no image input → `read_image`). `chrome_interact` step reports carry the
  same hint inline. Add a row there when a new opaque server message shows up.
- Screenshots additionally report size/format, whether the capture was read
  back from disk, and a `NOTE:` when the server says it captured something
  other than what was requested (uid asked, viewport delivered). Safari's
  capture checks that `safaridriver` actually wrote the file it claims to have
  written. Aborts (`AbortError`) pass through untouched so DSH still
  recognises a stopped turn.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Safari Technology Preview is required…` | STP not installed, or `safari.driver` points at classic `safaridriver`. |
| Windows stack at the same screen position | Expected: every `--mcp` session opens at the same coordinates. The banner tells them apart. |
| STP keeps running with no windows | An older build before `SafariInstanceOwner`; or a driver was SIGTERM'd. `osascript -e 'quit app "Safari Technology Preview"'`. |
| Read is missing a section that is visibly on the page | It is collapsed. Pass `expand: true` (window mode) or use `safari_get_page_structure` → `section:`. The header's `NOTE:` says what stayed collapsed. |
| `section: "#Reception"` on Wikipedia (any MediaWiki page) returns only the heading | Plugin build older than 2026-09-24. MediaWiki wraps every heading as `<div class="mw-heading"><h2 id=…/><span class="mw-editsection">edit</span></div>`; the section walker in `page-read.mjs` (`scopeScript`) only climbed out of a wrapper whose text *equalled* the heading's, so the `edit` span pinned the anchor to the `<h2>`, whose sole sibling is that span. Fixed: a parent counts as a heading wrapper when it holds exactly that one heading, no block content (`p, ul, table, section, …`), and ≤ 24 chars of decoration beside it (`edit`, `¶`, `#`). Restart `dsh web` to load it (host modules are not hot-reloaded). Verified headlessly on `Dune: Part Two` (`#Reception` → 16 k chars incl. its h3 subsections, stops before the next h2; `#Critical_response` → 6.5 k chars; window mode restores) plus the Notion docs page of `live:chrome-read`. The `[edit]` links themselves remain in the output, as in whole-page reads. |
| Chrome shows the automation infobar | `chrome.hideAutomationBanner` was turned off. |
| `chrome screenshot failed: Took a screenshot of the current page's viewport. Saved screenshot to /tmp/chrome-devtools-mcp-…/screenshot.png.` | Host is running a plugin build older than 2026-09-15: the capture was ≥ 2 MB and spilled to disk (see Failed attempts). Restart `dsh web` to load the fix; meanwhile `read_image` the quoted path, or request `format: "jpeg"` / a `uid` crop to stay under 2 MB. |
| Screenshot summary says `(≥ 2 MB: chrome-devtools-mcp wrote it to disk; read back by the plugin …)` | Informational. The image is fine; use `format: "jpeg"` or a `uid` crop if payload size matters. |
| `Element with uid N_M no longer exists on the page` / `Element uid "…" not found on page` | uids are minted by `chrome_snapshot` and die on re-render/navigation. Re-snapshot; never reuse a uid across a `chrome_navigate` or after clicking something that re-renders. |
| `MCP error -32001: Request timed out` | The browser server stalled for `toolCallTimeoutMs` (60 s default). Check for a blocking dialog (`chrome_handle_dialog` / `safari_handle_dialog list`), then `*_close` and reopen if it persists. |
| Leftover `/tmp/chrome-devtools-mcp-*/screenshot.png` (2–4 MB each) | Spilled captures from before the fix; the plugin now removes the per-call dir after reading. Safe to delete. |
| `pnpm dsh web` terminal spammed per Chrome launch: `Update available`, `exposes content of the browser instance…`, `Performance tools may send trace URLs…`, `did not negotiate the MCP roots capability…`, `ExperimentalWarning: localStorage…` | Plugin build older than 2026-09-15. Since then: `CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1`, `--no-performance-crux`, `roots` capability (session cwd) instead of `--allow-unrestricted-paths`, `NODE_OPTIONS=--localstorage-file=<tmp>/dsh-chrome-…-localstorage.json`, and piped+filtered stderr for the disclaimer (no flag exists). Table in the plugin README, "A quiet dsh web terminal". `chrome.quietStderr: false` shows everything again. Unfiltered lines appear as `browser-automation: chrome-devtools-mcp c:<n>: …` warnings and `chrome-stderr` trace events. |
| `Update available: 1.8.0 -> 1.9.0` — what to update? | Since 2026-09-15 the server is a **pinned exact dependency** of the plugin (`plugins/browser-automation/package.json`, `chrome-devtools-mcp: "1.9.0"`), run by the host's `node` (`chromeServer()` in `index.js`; `chrome.command: ''`). Upgrade: edit the version, `pnpm install` in the plugin dir, `pnpm run check` (asserts exact pin + bin present, greps nothing else), skim the upstream CHANGELOG for `screenshot.js` (the ≥ 2 MB spill) and `McpPage.js` uid messages (our `FAILURE_HINTS` match them), restart `dsh web`. The global `/opt/homebrew/bin/chrome-devtools-mcp` (1.8.0) is no longer used; `npm rm -g chrome-devtools-mcp` is safe, or point `chrome.command` at it to compare versions. The banner itself is suppressed by `CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS`. |

## Round three (2026-09-23): waits, selector targets, window recovery

`rsi/tool-analysis-03.md` made `chrome_evaluate_expression` the #2 tool of the
whole corpus (621 calls in a week): **68 % of them carried an in-page
`await new Promise(r => setTimeout(r, N))`** (median 3 s, p90 9.4 s; the 12–15 s
ones hit `MCP error -32001: Request timed out`), 292 of 776 were repeats of the
same normalised expression (hand-rolled polling), 45 % clicked via
`el.click()` because `chrome_click` needs a snapshot uid first, and two error
classes cost two extra calls each: `windowId … does not belong / is not open`
after a Chrome restart (15×, always followed by `chrome_open` + re-evaluate) and
`This session has N Chrome windows open; pass windowId` (8×, followed by
`chrome_close`). What changed:

| Finding | Change |
|---|---|
| in-page sleeps and repeated polls | `waiting.mjs`: one host-side engine — `{ text?, selector?, expression?, settleMs?, timeout? }` polled in ≤ 5 s in-page slices under a host deadline (default 30 s). Behind `chrome_wait_for` / `safari_wait_for` (now selector / expression / settle too, not just text) and a `wait` parameter on `*_evaluate_expression`, `*_get_screenshot`, `*_navigate`. Timeout is a **notice**, never an error; the main action still runs |
| `bash → chrome_navigate → chrome_evaluate_expression [→ screenshot]` ritual (111 / 63) | `*_navigate` gains `wait` and `then` (JS body run in the loaded page); `*_get_screenshot` gains `wait` (summary in the NOTE) |
| clicks via JS because uids need a snapshot | `chrome_click` / `chrome_fill` / `chrome_hover` accept `selector` (CSS) or `text` (visible) beside `uid` — found and acted on in the page (`el.click()`, value setter + input/change events, synthetic mouseover); `safari_click` / `safari_hover` / `safari_type_text` accept `selector`, resolved to the element's centre point for a real click |
| lost windows after a Chrome restart | pages remember `lastUrl`; `resolveChrome` reopens a lost id at that URL **under the same id** (also with no `windowId` when the session had windows); stale-page failures mid-call (`No page found`, `Page ids have changed`, `Target closed`) are retried once after a reopen (`withChrome`); result prefix `Chrome had restarted; reopened c:0:4 at <url> (page state was lost).` |
| several windows, no `windowId` → error | the most recently used window is used and the result names the others: `(2 windows open; used c:0:1, the most recently used — pass windowId for c:0:0)` |

Verification: `tests/waiting.test.mjs` (7 unit tests, now part of `pnpm check`),
the smoke's window-registry section (MRU default, lost bookkeeping), and
`pnpm run live:wait` — headless Chrome against a local page whose `#ready`
appears after 1.2 s: 24 checks incl. two SIGKILLs of the chrome-devtools-mcp
child followed by a successful `chrome_evaluate_expression` on the old id
(reopened in ~0.9 s). Restart `dsh web` to load it (host modules are not
hot-reloaded). Pre-existing drift fixed on the way: the smoke's preflight
needle (`Classic Safari…`).

Measure next week with `transcript_tool_stats sessions:["*"] split_at:<today>
sections:["all","args"] tools:["chrome_*","safari_*"]`: does the
`setTimeout` share in `chrome_evaluate_expression` args drop, do `wait` /
`then` / `selector` show up in the args section, do the `pass windowId` and
`does not belong` error groups vanish, and does `navigate → evaluate →
screenshot` shorten.

## Round four (2026-09-24): the screenshot card shows the picture

Symptom: expanding a `chrome_get_screenshot` / `safari_get_screenshot` card in
the chat showed `{"type":"image","attachment":{"attachmentId":"sha256:…"}}`
as text and no image anywhere — even though the model saw the capture fine.

Root cause (all in-tree, nothing wrong with the tool result):

- The chat dispatches each tool card through the **keyed** slot
  `tool.call.toolview` (`packages/client/ui-tool/src/client/contract/slots.ts`),
  keyed by wire tool name. There is no "any tool that returns an image" path.
- Only `read_image` claims a key that renders images
  (`toolviews/read-image-row.tsx`). Every unclaimed tool falls to
  `GenericToolCard`, which flattens non-text result blocks to JSON — the
  in-tree test `ui-tool/tests/tool-row.client.spec.tsx` pins exactly that.
- `browser-automation` was host-only, so nothing claimed those two keys.

Fix: a browser half in the same package (`src/client/index.tsx` →
`lib/client.js`, esbuild via `build.mjs` copied from `wait-tool`;
`package.json` gains `exports["./client"]`, `dsh.client: { platform: web }`,
`build`/`watch`/`typecheck` scripts and the `link:` client devDependencies).
It registers `tool.call.toolview` for `chrome_get_screenshot` and
`safari_get_screenshot` with one `ScreenshotRow`: collapsed = the tool's own
result text as a `·`-joined summary; expanded = the image at device pixels ÷ 2
through the `loadImage` loader every toolview receives, an in-page lightbox
(fit ↔ 1:1; never `window.open` — the Dock app's WKWebView loads it into its
only window), then the verbatim result text. The shared `tool.call.images`
gallery slot is `single` and owned by the read_image entry (a second declarer
throws at load), hence the own `<img>` — the same reasoning applies to any
plugin's own image rows. Because claiming a key suppresses the
generic card for every shape of that tool, the row covers running / ok /
file fallback (`saved to <path>` when the model has no image input) / error /
interrupted.

Facts worth keeping:

- **Takes effect at the next `dsh web` restart, not live**: client-module
  package metadata — including the negative "not a client package" verdict —
  is cached per Loader specifier until restart
  (`docs/subsystems/client-modules.md`, "The scan"). That is also what made
  it safe to build in the live-linked plugin directory. Afterwards a rebuilt
  `lib/client.js` hot-swaps the live GUI (see
  `client-bundle-rebuild-kills-pending-prompts.md`).
- `lib/` is gitignored; a `dsh.client` package whose `lib/client.js` is
  missing **fails activation loudly** at boot. `tools/install-plugins.sh`
  refuses to install such a plugin, and the bootstrap builds plugins, but on a
  machine that only pulls: `cd plugins/browser-automation && pnpm install &&
  pnpm build` before restarting.
- `pnpm install` in the plugin dir aborted with
  `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`: its `node_modules` had been
  created by pnpm's store **v10** and the machine now runs pnpm 11 (store
  v11), so any install purges and reinstalls. `CI=true pnpm install
  --no-frozen-lockfile` does it non-interactively (the flag because the
  lockfile changed). The live host kept its loaded `sharp` /
  `@modelcontextprotocol/sdk`; the chrome-devtools-mcp bin under
  `node_modules` was missing for the ~2 s of the reinstall.
- Verification without touching the live server: `tests/client-row.test.mjs`
  loads the built bundle under a fake `window.__ModuleLoader__` with stub
  primitives (React comes from the checkout through the linked
  `ui-primitives` package), asserts the two registrations and renders every
  shape; then a **throwaway home** — `/tmp/ba-home` holding a copy of one real
  session's `session.v3.jsonl.zstd` plus the one attachment object it
  references (`attachments/v1/objects/<2 hex>/<sha256>`; the store is
  content-addressed, no index to copy) and a `settings.yaml` with just
  `ui-onboarding.welcomeNoticeVersion`, an overlay inserting the plugin by
  absolute path, `DSH_HOME=/tmp/ba-home node --import tsx/esm
  apps/cli/src/bin.ts --profile web --patch /tmp/ba-overlay.yml --no-open
  --port 3090` from the checkout. The index's `__DSH_BOOT__` graph listed
  `tali-browser-automation/client.js`; in Chrome, the copied session's
  "69 tool calls" fold expanded to 23 `Safari screenshot` rows, the first
  opened to the real 390×740-pt image (blob URL from the session loader), and
  the lightbox opened and closed on Escape. `Load earlier` had to be clicked
  to the top first, and the settled turn's tool rows sit inside the
  `N tool calls · M messages` fold button.
