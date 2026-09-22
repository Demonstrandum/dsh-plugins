# tali-phone-ui

A chat-only Session on phone-width viewports. Two halves: a host `<style>`
row inside a `max-width` media query that strips the desktop chrome (plus a
head script that lets iOS Safari finish loading), and a browser bundle that
replaces the composer card with a bottom **tongue** + full-screen text entry.

## Why

The shipped client has no responsive CSS. At iPhone width (390–430 CSS px —
the full GUI, or the chrome-less `?embed=<sessionId>` page the per-session
QR code opens) a Session still carries its desktop chrome:

- the **Session header** — title, agent-preset chip, `…` menu, right-dock
  toggle, plus the **Chat | Trajectory** tab strip (Trajectory is useless on
  a phone);
- an **icon row under every message** — copy, feedback thumbs, branch,
  usage/time pills, clock — under assistant turn tails and user bubbles;
- the **composer dock** — "N turns M steps · tok/s", "N tok · Cache hit",
  and the context-meter ring.

Together that is ~130px of a 740px viewport that says nothing a phone user
needs. Below the configured width this plugin hides all three; the
transcript, the composer card (with its attach / permission / model
controls), approvals and the queue dock are untouched, and anything wider
(iPad portrait is 768–834 px) keeps the full chrome.

It also tightens what remains: the transcript's **32px side padding**
becomes 8px (the composer card follows, so it stays flush with the text —
48px more text per line on a 390px phone), every fenced code block loses
its **banner row** (`python … Copy`, also on language-less blocks), and
the **corner radius** of code blocks (12→6px) and of your own message
bubbles (22→6px) is cut to the code-block radius.

## Config

| key | default | meaning |
|---|---|---|
| `maxWidth` | `640` | the media query's `max-width` in CSS px, integer `320`–`1200` |
| `header` | `true` | hide the Session header (title row + view tabs) |
| `messageActions` | `true` | hide the per-message icon rows (assistant turn tails and user/steering bubbles — the user row's clock goes with it) |
| `stats` | `true` | hide the composer dock (stats pills + context meter) |
| `sideMargin` | `8` | transcript and composer-card side padding, CSS px, integer `0`–`64`. Stock is 32 (text) / 16 (card); `32` leaves both alone |
| `codeHeaders` | `true` | hide the code-block banner row (language label + Copy) |
| `halfRadius` | `true` | 6px corners on code blocks (12→6px) and user bubbles (22→6px) |
| `compactBlocks` | `true` | less padding inside boxed blocks: code blocks 16→8/10px, tool-card IN/OUT sections and command-card bodies 12/16→8/10px, context-injection bodies, table cells 10/16→6/10px, blockquote indent 14→8px, user bubbles 10/16→6/10px |
| `deferHmrStream` | `true` | open the client-HMR `/plugins/events` SSE stream 250 ms after `load` instead of mid-load (see below). Not a width rule |

All flags `false` and `sideMargin: 32` disables the plugin (no rows).

## The mobile composer (browser half)

In mobile mode the stock composer card is hidden and replaced by:

- **Tongue** — a grey tab (`--dsw-specific-input-major`) flush with the
  bottom edge, centred, 14px top corners, carrying a chevron-up. While the
  agent runs a **red stop square** sits beside it (the session's `cancel()`,
  what the stock stop button calls). ChatView's back-to-bottom control moves
  to the bottom-right corner, level with the tongue.
- **Entry sheet** (tap the chevron) — full-screen, same grey, a plain
  `<textarea>`: no placeholder, no attach / permission / model controls, no
  slash menu; **Enter inserts a newline**; 16px font (iOS does not zoom).
  Bottom bar, all 40px tall with 8px corners: **⌄ minimise** (40px, framed,
  far left) folds back to the tongue keeping the text *and the caret*;
  **✕ Abandon message** (80px, solid red) asks "Abandon message?" with
  Cancel / Abandon before clearing; **↑ Send** (80px, blue) is the only way
  to submit and is disabled while empty or while the input machine is
  mid-submission. The sheet is sized to `window.visualViewport`, so when the
  iOS keyboard comes up it shrinks above the keys and the bar stays visible
  (iOS covers the layout viewport instead of shrinking it). The ↑ ↓ ✓ strip
  above the keys is Safari's own form-accessory bar; web content cannot
  remove it.

Send goes through the session's public input actions (`setDraft` +
`submit`), so admission, queueing while a turn runs and steering behave
exactly as a stock submission does; minimise writes the text to the session
draft as well, so it persists like any draft. The component is mounted on
`conversation.input.dock` (session scope) and renders through portals to
`<body>`; while active it stamps `<html data-tali-phone-composer>`, and the
stock bar is hidden under that attribute only — a missing or failed bundle
leaves the normal composer in place.

## iOS Safari "never finishes loading" (`deferHmrStream`)

iOS Safari keeps its page-loading indicator running for as long as a
server-sent-events stream that was opened *during* the load stays open. The
shipped `client-hmr` plugin opens `/plugins/events` in its `apply`, mid-load,
so a DSH page on an iPhone looked permanently loading (the Dock app's
WKWebView has no indicator, so it never showed there). The host half injects
a head `<script>` that wraps `window.EventSource`: for that one URL, while
`document.readyState !== 'complete'`, it hands back a stand-in that creates
the real stream 250 ms after `load` and forwards `add/removeEventListener`,
`close`, `readyState` and the `on*` handlers; every other EventSource, and
any created after load, is untouched (the HMR client only uses
`addEventListener('message')` + `close()`). The stand-in has a plain
prototype on purpose — `EventSource.prototype`'s accessors are brand-checked.

## Trialing on the Mac: `<html data-dsh-view="mobile">`

Every host rule is emitted twice: inside the `max-width` media query, and
again prefixed with `html[data-dsh-view="mobile"]`; the browser half watches
the same attribute plus a `matchMedia` on the width the host publishes as
`--tali-phone-ui-max-width`. Anything that stamps that attribute on `<html>`
gets the phone view at any window width. The DSH Dock
apps do it from **View ▸ Mobile** (which also resizes the window to
390×844 so the real media query fires; **View ▸ Desktop** undoes both) —
see `plugins/dsh-tailscale-remote/README.md`. In any browser:

```js
document.documentElement.dataset.dshView = 'mobile'   // delete it to go back
```

Bundle install:

```sh
dsh plugin --profile web add ./plugins/phone-ui
```

Override in the profile's `cordis.patch.yml` (a later layer replaces the
whole `config` value):

```yaml
- id: tali-phone-ui
  config:
    maxWidth: 480
    messageActions: false
```

Dev-overlay row (absolute path, see the repo's `cordis.dev.yml`):

```yaml
- id: tali-phone-ui
  name: '<plugins>/plugins/phone-ui/index.js'
```

Host rows are not hot-reloaded and the style is stamped into `index.html`
at page load: restart `dsh web` (or the preview relay) and reload the page
after changing the config.

## How it works

The plugin listens on the webserver's structured `webserver/index-inject`
table and pushes one style row:

```css
@media (max-width: 640px) {
  [data-slot="conversation.session.header"] > header,
  [data-turn-tail][data-actions-reveal] > div:not([data-slot]),
  :is([data-chat-flow-kind="user"],[data-chat-flow-kind="steering"])
    > [data-slot="conversation.chat.node"] > div > div:nth-child(2),
  [data-slot="conversation.composer.bar"] div:has(> [data-slot="conversation.composer.dock"]),
  [data-chat-flow] .md-code-block > div:has(> [data-code-block-banner])
  { display: none }

  [data-conversation-content][data-content-phase] { --dsh-composer-side-clearance: 8px }
  [data-conversation-scroll] div:has(> [data-chat-flow]) { padding-left: 8px; padding-right: 8px }
  [data-chat-flow] .md-code-block pre { border-top-left-radius: var(--dsl-code-block-border-radius);
                                        border-top-right-radius: var(--dsl-code-block-border-radius) }
  [data-chat-flow] .md-code-block { --dsl-code-block-border-radius: 6px }
  :is([data-chat-flow-kind="user"],[data-chat-flow-kind="steering"])
    > [data-slot="conversation.chat.node"] > div > div:first-child > div:not([data-message-attachments])
  { border-radius: 6px }
}
/* … and the same rules once more, each selector prefixed html[data-dsh-view="mobile"] */
```

Every hook is an **unhashed attribute** the client renders itself, so the
rule survives client rebuilds (CSS-module classes compile to
`<hash>_<local>` and are deliberately not used). The `data-slot="…"`
outlets are the slot system's own `display:contents` wrappers, present
around every rendered slot:

- `[data-slot="conversation.session.header"] > header` — the header
  element, tabs inside it (`ui-conversation` `ConversationSession.tsx`);
- `[data-turn-tail][data-actions-reveal] > div:not([data-slot])` — the turn
  tail's built-in actions row, its only non-slot child; the
  `conversation.chat.turnTail` outlet beside it (galleries, deliverables)
  stays (`ui-chat` `TurnTailNodeView.tsx`);
- the user bubble is `userRow > (userStack, actions)`; the second child is
  the copy/clock row (`ui-chat` `MessageItem.tsx` `UserStyleBubble`);
- the InputBar's `.dock` wrapper is identified by the dock slot outlet it
  contains, so the ContextMeter beside the pills goes too
  (`ui-conversation` `InputBar.tsx`). `:has()` needs Safari ≥ 15.4 /
  Chrome ≥ 105;
- ChatView's `.scroll` (`padding: 16px calc(var(--dsh-composer-side-clearance) + 16px)`)
  is the parent of `[data-chat-flow]`; the variable itself is defined on
  ConversationContent's `.body` (`[data-conversation-content]`) and read by
  the InputBar root, so overriding it moves the card with the text;
- `md-code-block` is the one unhashed class on `ui-primitives` `CodeBlock`;
  the block defines `--dsl-code-block-border-radius: 12px` on itself and the
  banner, block and `<pre>` all read it. The banner wrapper is the child
  holding `[data-code-block-banner]`. With the banner gone the `<pre>`'s
  opaque fill needs the top radii it normally leaves to the banner.

**Cascade trap:** the client's stylesheets are injected *after* this
`<style>`, so a selector that only ties the stock rule's specificity
(`[data-conversation-content]` vs `.body`) loses. Every rule here out-ranks
its stock counterpart by at least one attribute/class; a console-appended
trial style does not reproduce this because it lands last.

Measured on the preview server (2026-09-23, Safari Technology Preview at
390×844): all hide selectors resolve to `display:none`, the scrollport
starts at y=0, text / composer card / code blocks all start at x=8 and are
364px wide, code blocks and bubbles report 6px radius, no banner on
any of the four fenced blocks; at 1100px nothing changes.

## Build / test

```sh
pnpm build      # esbuild → lib/client.js (the shell's factory-registration format)
pnpm watch      # rebuild on save; the server hot-swaps the bundle
pnpm typecheck  # tsc against the checkout's d.ts (link: devDependencies)
pnpm test       # node --test tests/*.test.mjs (host half), no DSH boot
```

Recipe with the investigation, the DOM facts and the trial procedure:
`recipes/phone-ui.md`.
