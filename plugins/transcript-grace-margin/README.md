# tali-transcript-grace-margin

A visible "you are at the end" margin under a Chat transcript. Host-only DSH
plugin (no client bundle): one injected `<style>` rule.

## Why

In the shipped client the last row of the transcript stops **16px** above
the sticky input card, and the card's 36px fade band covers most of that. At
the bottom of a long, active session the flow therefore looks like it
continues under the composer — nothing says "this is the end". With this
plugin the last turn sits clear of the card with empty space beneath it.

## Config

| key | default | meaning |
|---|---|---|
| `margin` | `160` | px of empty space between the transcript's last row and the input card's fade band. Integer `0`–`600`; `0` disables the rule. |

Bundle install (default 160px):

```sh
dsh plugin --profile web add ./plugins/transcript-grace-margin
```

Override in the profile's `cordis.patch.yml` (a later layer replaces the
whole `config` value):

```yaml
- id: tali-transcript-grace-margin
  config:
    margin: 200
```

Dev-overlay row (absolute path, see the repo's `cordis.dev.yml`):

```yaml
- id: tali-transcript-grace-margin
  name: '<plugins>/plugins/transcript-grace-margin/index.js'
```

Host rows are not hot-reloaded and the style is stamped into `index.html`
at page load: restart `dsh web` (or the preview relay) and reload the page
after changing the margin.

## How it works

The plugin listens on the webserver's structured `webserver/index-inject`
table and pushes one style row:

```css
[data-conversation-scroll] [data-chat-flow] { padding-bottom: <margin>px }
```

Both hooks are **unhashed data attributes** the client renders itself, so
the rule survives client rebuilds (the CSS-module class names compile to
`<hash>_<local>` and are deliberately not used):

- `[data-conversation-scroll]` — the active-phase scrollport
  (`packages/client/ui-conversation/src/client/skeleton/ConversationContent.tsx`);
- `[data-chat-flow]` — the message column inside it
  (`packages/client/ui-chat/src/client/chat/ChatView.tsx`).

Padding on the column grows the scrollport's `scrollHeight`; ChatView's
follow logic (`scrollTop = scrollHeight`, at-bottom =
`scrollHeight - clientHeight - scrollTop < ε`) and its `ResizeObserver` on
the column read that same height, so auto-follow while streaming, the
back-to-bottom control (sticky to the scrollport, placed after the column)
and turn navigation are unaffected. Scoping to the active-phase scroller
leaves the hero/blank composer layout and embedded frames' own scrollers
alone.

Measured on the preview server (2026-09-22, Chrome): last-row-to-card gap
16px → 176px at the bottom; `atBottom` still true after
`scrollTop = scrollHeight`.

## Test

```sh
pnpm test   # node --test tests/*.test.mjs, no DSH boot
```

Recipe with the investigation and the alternatives considered:
`recipes/transcript-grace-margin.md`.
