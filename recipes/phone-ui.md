# Phone UI — chat-only Session chrome on phone-width viewports

**Plugin:** `plugins/phone-ui/` (`tali-phone-ui`, host-only, no client
bundle). **Date:** 2026-09-23. **Status:** under trial on the preview
server (row in `cordis.dev.yml`); not in the live profile.

## The complaint

A phone screenshot of a Session opened from the per-session QR code
(`recipes/per-session-qr-code.md`, `?embed=<sessionId>`) showed the desktop
chrome intact at 430 CSS px: the header row (`per-session-qr-code ·
Standard mode · … · right-dock toggle`) with the `Chat | Trajectory` tabs
under it, the copy / thumbs / branch / usage / clock icon row under the
assistant turn, and the `2 turns 93 steps · 23M tok · Cache h… · 30%`
dock under the composer. Wanted, on mobile, in the full GUI as well as the
embed page: hide the header and tabs entirely (Trajectory is pointless on a
phone), hide the message action row, hide the stats line. Second round
(same day, from a CleanShot measuring the transcript's left margin at
32px): 8px side margins, no `python … Copy` banner row on fenced blocks
(incl. language-less ones such as an "Output (example)" block), and half
the corner rounding on code blocks and on the user's own message bubbles.
The collapsed sidebar rail in the full GUI is out of scope here.

## Answer: one media-queried `<style>` row, no fork, no client bundle

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
  { border-radius: 11px }
}
```

Contributed through `webserver/index-inject`, exactly like
`transcript-grace-margin` and `instance-identity`. Config: `maxWidth`
(default 640, integer 320–1200), `header` / `messageActions` / `stats` /
`codeHeaders` / `halfRadius` booleans (default all `true`), `sideMargin`
(default 8, integer 0–64; 32 = stock). README: `plugins/phone-ui/README.md`.

## DOM facts (checkout `<dsh-src>`, measured live on the preview)

There is no responsive CSS in the client (`per-session-qr-code.md` already
noted this), and none of the three targets carries a data attribute of its
own. What *is* stable:

- **The slot outlets.** Every rendered slot is wrapped in
  `<div data-slot="<slot name>" style="display:contents">` (the
  `renderSlot` machinery), and chain fallbacks in
  `<div data-chain-overlay-fallback="…">`. These are unhashed and follow
  the slot names in `docs/subsystems/slots.md`, so they are the best hooks
  for chrome that has no attribute of its own:
  `[data-slot="conversation.session.header"]`,
  `[data-slot="conversation.chat.node"]`,
  `[data-slot="conversation.composer.bar"]`,
  `[data-slot="conversation.composer.dock"]`.
- **Header.** `ConversationSessionHeader`
  (`packages/client/ui-conversation/src/client/skeleton/ConversationSession.tsx`)
  renders `<header class=<hash>_header>` with the title row and, when the
  Session has more than one view, `<div role="tablist">` — both inside the
  one header element, so hiding the header hides the tabs. Its children
  carry `data-conversation-header-leading` / `-corner`, but the header
  itself has nothing; `[data-slot="conversation.session.header"] > header`
  is the anchor.
- **Assistant actions.** `TurnTailNodeView.tsx` renders
  `<div data-turn-tail=<n> data-actions-reveal="always|hover">` containing
  the `conversation.chat.turnTail` slot outlet (deliverables, galleries)
  and then the `MessageIconActions` row (copy, `conversation.chat.assistant-actions`
  slot = feedback thumbs, branch, TurnUsage/TurnTime pills, clock). The row
  is the only child without `data-slot`. Tails of interrupted turns
  (`closing === null`) have no `data-actions-reveal` and no row.
- **User / steering actions.** `MessageItem.tsx` `UserStyleBubble`:
  `<div class=userRow>` → `<div class=userStack>` (attachments, bubble,
  reference summary) + the actions row (copy + clock). Second child of the
  first div under the node outlet. Hiding it also drops the user message's
  timestamp — deliberate; flip `messageActions: false` to keep the rows.
- **Stats dock.** `InputBar.tsx` renders `<div class=root>` →
  `<div data-composer-card>` + `<div class=dock>`; the dock holds the
  `conversation.composer.dock` slot outlet (ui-chat's `StatsPills`: gauge
  pill = turns/steps/tok-s, database pill = tokens/cache hit) and, as a
  sibling *inside* the dock, the `ContextMeter` ring (the `30%`). Hiding the
  wrapper via `div:has(> [data-slot="conversation.composer.dock"])` takes
  the meter with it. In the hero variant the dock slot is not rendered, so
  the rule does not fire there.
- **Side margin.** The 32px is ChatView `.scroll`
  (`packages/client/ui-chat/src/client/chat/ChatView.module.css`):
  `padding: 16px calc(var(--dsh-composer-side-clearance) + 16px)` —
  "the transcript stays exactly 32px narrower than the input card". The
  variable is defined on ConversationContent's `.body`
  (`ConversationRoot.module.css`, 16px; 8px in `.embeddedBody`, which is the
  *embedded-occurrence* variant, not the `?embed=` page) and read by the
  InputBar root's padding. Setting both the variable and `.scroll`'s
  padding to 8px puts text and card on one edge. `.scroll` has no
  attribute; it is the parent of `[data-chat-flow]`.
- **Code blocks.** `ui-primitives/src/markdown/CodeBlock.tsx` renders
  `div.block.md-code-block > (div.bannerWrap > div[data-code-block-banner]
  (lang, Copy)) + div[data-code-block-content] > pre`. `md-code-block` is
  the only unhashed class. `.block` sets
  `--dsl-code-block-border-radius: 12px` on itself; banner, block and `pre`
  read it, so one variable override re-rounds everything. The `pre` carries
  only the *bottom* radii (comment in the CSS: `overflow:hidden` on the
  block would kill the sticky banner) — with the banner hidden its opaque
  fill squares the top corners unless the top radii are added. The
  "Output (example)" block is the same component with `lang` undefined:
  empty label, Copy button, same banner — one rule covers both.
- **User bubble.** `MessageItem.module.css` `.bubble { border-radius: 22px }`
  inside `userRow > userStack`, whose other possible children are the
  attachments row (`[data-message-attachments]`) and the reference-summary
  line (radius harmless). The composer card's own 22px is untouched.
- **Cascade trap.** The client's CSS is injected into `<head>` *after* the
  `index-inject` style rows, so a selector that merely ties the stock
  rule's specificity loses: `[data-conversation-content]` (0,1,0) vs
  `.body` (0,1,0) left the clearance at 16px on the real page although the
  console-appended trial (which lands *last*) had worked.
  `[data-conversation-content][data-content-phase]` (0,2,0) wins. Rule of
  thumb for this mechanism: out-rank the stock rule by one attribute, and
  re-measure after the relay restart, not only in the console.
- Measured at 390×844 (STP): header 0→hidden, scrollport top at y=0; text,
  composer card and code blocks all at x=8, 364px wide; blocks 6px, bubbles
  11px; 4 of 4 banners `display:none`. At 1100×800 every selector reports
  its normal value.

## Trial procedure (what was done)

1. Opened the preview (`http://127.0.0.1:3088/?token=…` from
   `~/.dsh-preview/logs/dsh-web-preview.log`) in a `browser-automation` STP
   window, `safari_set_viewport_size 390×844`, and loaded
   `?embed=session-<id>` of the longest preview session (find it with
   `du -sk ~/.dsh-preview/sessions/*/session-*`). This reproduces the phone
   layout exactly — no device emulation needed; the client has no
   UA-dependent code.
2. Injected the rule as a `<style>` from the console first; screenshot
   confirmed all three groups gone before any plugin code was written.
3. Wrote the plugin, added the overlay row to `cordis.dev.yml`, verified
   composition with `--dump-config`, `launchctl kickstart -k
   gui/$UID/io.github.taliesinb.dsh-web-relay.preview`, hit the relay once
   (`503` → DSH boots in ~2 s → `401`), exchanged the new token with a
   cookie jar and grepped the served `index.html` for `/* tali-phone-ui */`.
4. Screenshots at 390×844: the embed page (transcript from the very top,
   no rows under the user bubble, composer at the bottom) and the full GUI
   with the session open (same, plus the collapsed sidebar rail — out of
   scope). `pnpm test`: 7 node:test cases.
5. Round two followed the same loop (console trial → plugin → kickstart →
   served-CSS grep → DOM measurement) and is where the cascade trap above
   surfaced: only the post-restart measurement caught it.

## Alternatives considered

- **`(pointer: coarse)` / `(hover: none)` instead of width** — would spare
  a narrow desktop window, but desktop STP cannot simulate them, so the
  trial would have needed a real phone; width is also what actually runs
  out. `maxWidth` is configurable if 640 turns out to be wrong for a tablet.
- **A client plugin** toggling the `conversation.session.header` slot or
  the `ui-trajectory` view registration when `embedPresentation()` is set —
  real removal rather than CSS, but it would need a built bundle and would
  not cover the full GUI on a phone; the header also owns the QR button and
  `…` menu that a client plugin would have to re-home. Revisit if hidden
  chrome ever needs to come back on demand (e.g. a tap-to-reveal header).
- **A fork patch** adding responsive rules to `ConversationRoot.module.css`
  — against the house rule and lost on every rebase.

## Rollout

- Preview: overlay row in `cordis.dev.yml` (host row → relay restart).
- Live: not installed by this recipe. To promote: `dsh plugin --profile web
  add ./plugins/phone-ui`, restart `dsh web`, add `phone-ui` to `PLUGINS`
  in `tools/install-plugins.sh`, and drop the overlay row (duplicate id
  fails the boot). The shared remote machine gets it the same way
  (`extras/bin/sync-host`).

## Not done / next steps of the phone pass

- The collapsed sidebar rail (60px) in the full GUI at phone width.
- Safe-area / home-indicator padding under the composer card once the dock
  is gone (4px today); matters for a home-screen web app, not Safari.
- The right dock at phone width (still covers the chat if opened — but the
  toggle is now hidden with the header).
- A way to reach the header's actions (QR, `…` menu, agent-preset chip) on
  a phone if anyone misses them — the composer card keeps the model and
  permission pickers.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Chrome still there on the phone, no `tali-phone-ui` `<style>` in `<head>` | Plugin not loaded (row missing, or `dsh web` not restarted — host rows are not hot-reloaded) | `--dump-config`; kickstart the relay / restart `dsh web`; reload the page |
| Style present, chrome still there | Viewport wider than `maxWidth` (iPad, landscape phone > 640, desktop window) | Lower/raise `maxWidth`; check `innerWidth` in the console |
| Header hidden but `Chat \| Trajectory` visible | Cannot happen with this DOM — the tablist is inside the header; if it does, the client moved the tabs: re-measure with the DOM script in this recipe | |
| Stats gone but the `30%` ring remains | The client moved `ContextMeter` out of the `.dock` wrapper | Add its new hook to `SELECTORS.stats` |
| Boot fails: "maxWidth must be an integer 320-1200" / "sideMargin must be an integer 0-64" / "… must be a boolean" | Malformed `config` in a patch | Bare integer / bare boolean |
| Text at 8px but the composer card still 16px in | A variable override that ties the stock rule's specificity (see Cascade trap) | Out-rank with a second attribute; check `getComputedStyle(el).getPropertyValue('--dsh-composer-side-clearance')` on `[data-conversation-content]` |
| Code block has square top corners | Banner hidden but the `pre` top-radius rule missing/overridden | `codeHeaders` emits both rules together; check `.md-code-block pre` radii |
