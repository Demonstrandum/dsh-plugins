# Transcript grace margin — visible space at the end of an active session

**Plugin:** `plugins/transcript-grace-margin/` (`tali-transcript-grace-margin`,
host-only, no client bundle). **Date:** 2026-09-22.

## The complaint

Scrolled to the bottom of a long, active session, the last row (a `Think`
line, "Deep diving… 25s", the To-dos card) sits almost flush against the
input card. There is no margin that says "this is the end of the transcript";
the flow looks like it continues under the composer. Wanted: a 100–200px
"grace margin" below the last row. Question: is that achievable via a plugin,
or does it need a fork patch?

## Answer: one injected CSS rule, no fork, no client bundle

```css
[data-conversation-scroll] [data-chat-flow] { padding-bottom: 160px }
```

contributed through the webserver's structured `webserver/index-inject`
table — the same host-only mechanism `instance-identity` uses for its
wordmark/whale restyle (`recipes/instance-identity.md`). Default 160px,
`config.margin` 0–600 (0 disables). README: `plugins/transcript-grace-margin/README.md`.

## Why the geometry is what it is (checkout facts, `<dsh-src>`)

- Active phase (`.root[data-phase='active']`): the transcript and the sticky
  composer seat share one scroller, `.scrollBody` in
  `packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css`
  (`overflow-y:auto`, `scrollbar-gutter:stable`). `ConversationContent.tsx`
  renders it as `<div className={css.scrollBody} data-conversation-scroll="">`
  and the seat as `<div className={css.composerSeat} data-composer-seat="">`
  (`position:sticky; bottom:0; z-index:7`).
- The seat's background is a **fixed 36px fade band** at its top
  (`linear-gradient(… bg-base 0% at 0px, bg-base at 36px)`), so anything in
  the last ~36px above the card is already half-hidden.
- The chat view's own scroller `.scroll`
  (`packages/client/ui-chat/src/client/chat/ChatView.module.css`) has
  `padding: 16px …`, but inside `[data-conversation-scroll]` it is
  `overflow:visible; flex:0 0 auto` — the outer body scrolls, and the chat's
  16px bottom padding is all that separates the last row from the fade band.
  Measured: **16px** last-row-to-seat gap at the bottom.
- The message column is `<div className={css.column} data-chat-flow="">`
  (`ChatView.tsx`). `data-chat-flow` and `data-conversation-scroll` are the
  two **unhashed** hooks; the CSS-module classes compile to `<hash>_<local>`
  (`L5Dv-q_scroll`), and `[class*="_scroll"]` would also match `_scrollBody`,
  so the data attributes are the right selectors.

## Why padding on the column is safe for auto-follow

`ChatView.tsx` follows the live tail with `el.scrollTop = el.scrollHeight`
and decides "at bottom" from `scrollHeight - clientHeight - scrollTop`; a
`ResizeObserver` on the column (and on the composer seat) re-runs the follow
while the reader is pinned. Padding-bottom on the column is part of the
column's box, so it is in both the observed size and `scrollHeight`: the
follow lands on the padded end. The back-to-bottom control
(`.toBottomSlot`, `position:sticky; bottom:16px`) sits *after* the column in
`.scroll` and is sticky to the scrollport, so it is unaffected. Turn
navigation (`landOnRow`, `flowTop`) measures rows relative to the scroller,
also unaffected.

Scoping to `[data-conversation-scroll]` keeps the hero/blank composer layout
(no `[data-chat-flow]` rendered there) and embedded frames' own scrollers
alone.

## Verification (preview server, Chrome, 2026-09-22)

1. Live DOM experiment first, before writing any code: opened the preview
   (`http://127.0.0.1:3088/?token=…` from `~/.dsh-preview/logs/dsh-web-preview.log`),
   picked a session long enough to scroll ("<private> plot command"; most
   preview sessions are too short — check `scrollHeight > clientHeight`),
   appended a `<style>` with the rule from the console, scrolled to bottom:
   last-row-to-seat gap **16px → 176px**, `atBottom` true after
   `scrollTop = scrollHeight`.
2. Real path: row in `cordis.dev.yml`,
   `launchctl kickstart -k gui/$UID/io.github.taliesinb.dsh-web-relay.preview`,
   then **hit the relay once** (`curl http://127.0.0.1:3085/` → 503 while it
   boots DSH; `dsh web` starts on demand, the new `?token=` appears in the
   log ~15s later). Loading the page showed the
   `/* tali-transcript-grace-margin */` style in `<head>`, computed
   `padding-bottom:160px` on `[data-chat-flow]`.
3. Streaming: sent a 25-item prompt to Apple Foundation and sampled the
   scroller once per second for 16s — `atBottom: true` on every sample while
   `scrollHeight` grew 1965 → 2822.
4. `pnpm test` in the plugin: 4 node:test cases against a fake ctx.

## Alternatives considered

- **Client plugin** injecting a stylesheet from the browser `apply` — works
  too, but needs a built `lib/client.js`, and a host `<style>` row is present
  from the first paint with nothing to hot-swap.
- **Padding on `.scroll` / `.scrollBody`** instead of the column — the
  hashed class problem above; and padding on the scroller itself would also
  push the sticky seat, which rides the scroller's content box.
- **A fork patch** to `ChatView.module.css` — against the house rule ("no
  privileged core to patch"), and it would be lost on every rebase.

## Rollout

- Preview: overlay row in `cordis.dev.yml` (host row → relay restart).
- Live: not installed by this recipe (needs the maintainer's explicit go-ahead per the
  AGENTS.md live-home rule). To promote:
  `dsh plugin --profile web add ./plugins/transcript-grace-margin`, restart
  `dsh web`, and add `transcript-grace-margin` to `PLUGINS` in
  `tools/install-plugins.sh`; remove the overlay row from `cordis.dev.yml` if
  the preview home ever gets the bundle (duplicate id fails the boot).
- Changing `margin` later: it is stamped into `index.html` at page load, so
  a server restart + page reload, not a patch-row hot reload, shows the new
  value.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No extra space, no `tali-transcript-grace-margin` `<style>` in `<head>` | Plugin not loaded (row missing, or `dsh web` not restarted — host rows are not hot-reloaded) | Check `--dump-config`; kickstart the relay / restart `dsh web`; reload the page |
| Style present, no effect on a session | Session in hero/blank phase or too short to scroll — `[data-chat-flow]` is only padded when the outer scroller is active | Open a session that overflows; `document.querySelector('[data-conversation-scroll] [data-chat-flow]')` must be non-null |
| Boot fails: "margin must be an integer 0-600" | Non-integer / out-of-range / string `config.margin` in a patch | Use a bare integer |
| Preview returns 503 after kickstart | Relay answers first and boots DSH on demand | Wait ~15s and reload; read the new token from `~/.dsh-preview/logs/dsh-web-preview.log` |
