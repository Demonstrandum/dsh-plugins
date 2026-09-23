# Re-branding the Web GUI from config (`brand-kit` plugin)

Done 2026-09-22 on the author's laptop, together with
[`dock-app-integrated-titlebar.md`](dock-app-integrated-titlebar.md). Goal:
replace the whale, the "DSH Local Build" wordmark and its version chip, the
empty-session headline ("Into the Unknown"), the running-turn label ("Deep
diving...") and the blue accent with a house brand — fonts included — for one
deployment, **without** the brand entering this public repo. Result: the
generic plugin `plugins/brand-kit` (README owns the config reference) plus a
private directory of assets and one YAML block in the profile patch.

## Shape of the solution

- **Everything is a config value or a file path.** Mark (`.svg`/`.png`),
  fonts directory + `@font-face` rows, typography, accent hex, three texts,
  one boolean. With no config the plugin is a no-op, so it can sit in the
  default bundle set (`pnpm install-plugins`) on every instance.
- **The brand is a configuration profile**, kept private: assets in a
  directory of the operator's choosing plus a snippet for the profile patch
  (`~/.dsh/profiles/web/cordis.patch.yml`, id-targeted override of the
  installed row). Absolute paths are unavoidable there and fine — it is
  config, not code.

## Findings that shaped it

1. **The shell has brand slots** — `sidebar.brand.mark`, `sidebar.brand.name`,
   `conversation.hero.brand.mark`, all `single`, so a registrant replaces the
   fallback. The name cell's fallback holds the product title *and* the
   version chip together, which is how "get rid of the version" falls out of
   "replace the wordmark".
2. **Two strings have no slot and cannot be overridden through locales.**
   `hero.headline` (ui-conversation) and `chat.deepDiving` (ui-chat) are
   dictionary entries; a locale namespace has one occupant. A MutationObserver
   that swaps the text node after mount works because React only rewrites a
   text node when its string prop changes, and these props are constant.
   The elements' only stable handles are `[class*="_titleGroup"] >
   span:first-child` and `[class*="_turnStatus"]` (CSS modules →
   `<hash>_<local>`); the observer touches the first text node only (the
   status also carries a clock span).
3. **The accent is a static ramp.** `--dsw-static-deepseek-50…950` (and a
   few direct `--dsw-static-blue-*` uses: context meter, trajectory gradient)
   feed every alias — links, info buttons, business state, user bubbles,
   active sidebar row, tab underline, send button. Redefining the ramp on
   `html>body` recolours all of it; lighter/darker steps are
   `color-mix(in oklab, …)` so one hex suffices (an optional `accentDark` for
   the 600 step). `html>body[data-ds-dark-theme]` is needed because the
   client's theme sheet loads *after* the index-inject rows — a specificity
   tie loses (the phone-ui recipe's cascade trap).
4. **A monochrome mark should follow the text colour** like the shipped whale
   (`fill=currentColor`). Inlining arbitrary SVG from a file is a sanitising
   problem; a CSS mask (`background:currentColor; mask:url(./brand-kit/mark.svg)`)
   gives the same result for any file, and `markMode: image` covers
   full-colour logos.
5. **Serving files document-relative.** `@font-face` URLs and the mask URL are
   `./brand-kit/…` so they resolve under the tailnet mount `/dsh/` as at the
   root (the webserver's own rows do the same).
6. **A new bundle row is picked up live.** `dsh plugin --profile web add`
   followed by the config in the profile patch (`patchReload: live`) took
   effect in the running server — the host module was new, so no module-cache
   staleness; the browser half hot-loaded. Editing an already-loaded
   `index.js` still needs a `dsh web` restart.

## Sequence on a Mac

```sh
cd <plugins>/plugins/brand-kit && pnpm install && pnpm build && pnpm test
cd <plugins>/deepseek-harness && node --import tsx/esm apps/cli/src/bin.ts plugin --profile web add <plugins>/plugins/brand-kit
# append the config block (README) with absolute paths to ~/.dsh/profiles/web/cordis.patch.yml
# check: curl -s <gui url> | grep -o '__DSH_BRAND_KIT__.*' ; curl -I <gui url>brand-kit/mark.svg
```
(`pnpm dsh …` fails inside the DSH shell sandbox: pnpm 12 wants to install the
pinned pnpm into a temp dir it may not create — call the CLI through node.)

## What was replaced

The first cut (same day) was a private plugin with the brand hard-coded —
mark paths inline, fonts in its `assets/`, texts as defaults, accent ramp
hand-picked. It worked but violated "no brand in code": moving anything meant
editing the plugin. It was deleted once this generic plugin reproduced the
look pixel-for-pixel from config (verified in the live GUI: name, mask mark
24px with `background: rgb(15,17,21)`, hero mark, headline, badge
`display:none`, `--dsw-static-deepseek-500` = the configured hex, fonts
`loaded`).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Load fails with `brand-kit: mark file not found` / `fontsDir not found` | paths must be absolute and exist on the *server's* machine; fix the profile patch (it reloads live) |
| Wordmark shows but in the wrong font | `fonts[].family` must equal the family used in `brandFont.family`; check `document.fonts` status in the console — `unloaded` means the URL 404s (file name typo) |
| Accent unchanged | the config block is a later layer and REPLACES the whole `config` — a partial block drops `accent`; or the theme sheet won: check that the row's `html>body` rule is present in `<head>` |
| Headline/turn status not swapped | the shipped string changed upstream (the observer matches it verbatim: see `SHIPPED` in index.js) |
| Mark invisible in `mask` mode | the SVG has no filled geometry (strokes only) or a `viewBox` that crops it; try `markMode: image` to see the file as-is |
