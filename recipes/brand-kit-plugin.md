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

## Profiles in the GUI (same day, second cut)

"Every knob configurable" invited the next question — a UI to add, duplicate,
export and modify brands. Built as the bundle's configuration card in the
Plugins panel (`plugins.bundle.config`, the seam `<private-plugin>`
uses) over a Fetch route, with profiles as directories under
`$DSH_HOME/brand-profiles/`. Findings:

- **Apply = reload, not restart.** `webserver/index-inject` is emitted fresh
  for every index render (`collectIndexInjections`), so the host reads
  `state.json` per request and the card just calls `location.reload()`.
- **Serve assets through one Fetch route, not exact routes per file** — the
  active brand changes at runtime and `ctx.webServer.register` rows are
  registration-time. `/api/brand-kit/asset?s=&k=&f=` serves only files the
  effective config names, so it is not a directory listing.
- **Portable JSON**: profile.json keeps file *names*; `resolveProfile()` makes
  them absolute and runs the same `normalizeConfig`, so profile validation and
  row-config validation cannot drift.
- **Import validates in a staging directory** (`<name>.importing-<pid>`) and
  renames into place; a bad archive leaves nothing behind (tested).
- **fflate** for zip (pure JS, tiny; Node has no archive API). Ordinary
  dependency, not a link.
- **The Plugins panel lists bundles only**: a plugin loaded as a dev-overlay
  row has no page and hence no card. Trial it with `dsh plugin --profile web
  add` into the throwaway home (row config then goes in the home's profile
  patch as an id-targeted override).
- **Card chrome without CSS modules**: the classes (`bk-*`) ride the plugin's
  own host style row — theme tokens, no inline styles, no cross-plugin import.
- Verified end to end on a throwaway home: create → upload mark + font →
  save → apply (page shows the profile) → export zip (3 entries) → import as
  a second profile → invalid save rejected with a message → card edit +
  Save-and-reload → Active switched back to the row config.

## Third cut: profiles are the only way

Having both a row `config` and profiles meant two representations of one
thing, the weaker one (YAML in the profile patch, absolute paths, no
export) being the default. Retired the same day: the row now carries only
`profilesDir`; a brand exists only as a profile directory; no active profile
= the shipped look. Consequences:

- **Provisioning is `cli.mjs`**, not a YAML block: `node cli.mjs import <dir
  or .brand.zip> --name X --apply` (honours `DSH_HOME`), same store and
  validation as the GUI, visible on the next page load. A private brand is a
  plain directory (`profile.json` + flat assets) in the deployment's private
  repo; the bootstrap can call the CLI.
- **Directory import copies only assets** (known extensions) plus
  `profile.json` — a README or `source/` artwork beside them stays behind.
- **Migration on a live instance**: `cli.mjs import … --apply`, then delete
  the row's config block from the profile patch (live-reloaded). Between the
  two steps the old host half still serves the row config; after the second
  step and a `dsh web` restart the profile is what renders.
- The card's *Active* select reads *None (shipped DSH look)* / profiles —
  there is no "plugin config" entry any more.

## Sequence on a Mac

```sh
cd <plugins>/plugins/brand-kit && pnpm install && pnpm build && pnpm test
cd <plugins>/deepseek-harness && node --import tsx/esm apps/cli/src/bin.ts plugin --profile web add <plugins>/plugins/brand-kit
node <plugins>/plugins/brand-kit/cli.mjs import <brand dir or .brand.zip> --name Acme --apply
# check: curl -s <gui url> | grep -o '__DSH_BRAND_KIT__.*' ; curl -I '<gui url>api/brand-kit/asset?s=Acme&k=mark&f=mark.svg'
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
| Card shows *Active profile not applied: … not found* | a file named in profile.json is missing from the profile directory; upload it in Edit or fix the JSON |
| Wordmark shows but in the wrong font | `fonts[].family` must equal the family used in `brandFont.family`; check `document.fonts` status in the console — `unloaded` means the URL 404s (file name typo) |
| Card missing on the bundle's page | the plugin is loaded as a dev-overlay row, not a bundle — the Plugins panel lists bundles only |
| Accent unchanged | the theme sheet won: check that the plugin's `html>body` rule is present in `<head>`; or the active profile failed validation (card shows the error) |
| Headline/turn status not swapped | the shipped string changed upstream (the observer matches it verbatim: see `SHIPPED` in index.js) |
| Mark invisible in `mask` mode | the SVG has no filled geometry (strokes only) or a `viewBox` that crops it; try `markMode: image` to see the file as-is |
