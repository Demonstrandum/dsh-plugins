# tali-phone-ui

A chat-only Session on phone-width viewports. Host-only DSH plugin (no
client bundle): one injected `<style>` rule inside a `max-width` media
query.

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

## Config

| key | default | meaning |
|---|---|---|
| `maxWidth` | `640` | the media query's `max-width` in CSS px, integer `320`–`1200` |
| `header` | `true` | hide the Session header (title row + view tabs) |
| `messageActions` | `true` | hide the per-message icon rows (assistant turn tails and user/steering bubbles — the user row's clock goes with it) |
| `stats` | `true` | hide the composer dock (stats pills + context meter) |

All three flags `false` disables the plugin (no style row).

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
  [data-slot="conversation.composer.bar"] div:has(> [data-slot="conversation.composer.dock"])
  { display: none }
}
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
  Chrome ≥ 105.

Measured on the preview server (2026-09-23, Safari Technology Preview at
390×844): all four selectors resolve to `display:none`, the scrollport
starts at y=0, the composer card sits at the bottom edge; at 1100px nothing
changes.

## Test

```sh
pnpm test   # node --test tests/*.test.mjs, no DSH boot
```

Recipe with the investigation, the DOM facts and the trial procedure:
`recipes/phone-ui.md`.
