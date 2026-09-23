# tali-brand-kit

Re-brand the DSH Web GUI from configuration: a mark and a wordmark for the
sidebar and the empty-session hero, web fonts served from a directory,
typography, an accent colour, and the two locale-owned strings the shell
shows ("Into the Unknown", "Deep diving..."). **The plugin ships no brand**:
with an empty config it changes nothing; every part is independently
optional. Brand assets and the config that references them live wherever
the deployment keeps its private things (this repo's owner keeps theirs in
`extras/brand/<name>/`), never in the plugin.

## Config

```yaml
- id: tali-brand-kit
  config:
    name: Acme                          # sidebar wordmark; '' keeps "DSH Local Build" + version chip
    mark: /abs/path/mark.svg            # .svg or .png; replaces the whale (sidebar, rail, hero)
    markMode: mask                      # mask (default): monochrome, filled with the text colour
                                        # image: drawn as-is (full-colour logos)
    headline: Into the Abyss            # empty-session headline
    turnStatus: Working...              # running-turn label under the transcript
    hidePreviewBadge: true              # drop the "Preview" pill after the headline
    accent: '#7678ed'                   # re-points the shipped blue ramp (links, buttons, bubbles, tabs…)
    accentDark: '#6163ea'               # optional 600 step (hover/pressed); derived when absent
    fontsDir: /abs/path/fonts           # served at /brand-kit/fonts/<file>
    fonts:                              # @font-face rows (file must be in fontsDir)
      - { file: Serif-Light.woff2, family: My Serif, weight: 300 }   # style: normal | italic
    brandFont:    { family: '"My Serif", Georgia, serif', weight: 300, size: 22, lineHeight: 24, letterSpacing: 0, offsetY: -1 }
    headlineFont: { family: '"My Serif", Georgia, serif', weight: 300, size: 32, lineHeight: 36 }
```

Defaults: `brandFont` 18px/24 weight 600 (the shell's own), `headlineFont`
26px/32 weight 500. Paths must be absolute and exist, colours `#rrggbb`,
texts ≤ 80 chars without `< > " \` — anything else fails the load loudly.
A row's `config` in a later patch layer replaces the whole value, so put the
complete block in the profile patch (`~/.dsh/profiles/web/cordis.patch.yml`).

## Profiles (Plugins panel ▸ tali-brand-kit)

The bundle's page in the Plugins panel carries a **Brand** card. A *profile*
is a directory `$DSH_HOME/brand-profiles/<name>/` with `profile.json` (the
config above in portable form: `mark` and `fonts[].file` are file names in
the directory, no `fontsDir`) plus those files. The card offers:

| action | effect |
|---|---|
| **Active** select | which profile the GUI shows, or *Plugin config* (the row's `config`) / *None*. Changing it writes `state.json` and reloads the page — the brand is rendered into the boot document |
| **New from current** | a profile copied from whatever is active now (assets copied) |
| **Edit** | every key: wordmark, mark (upload `.svg`/`.png`, mask/image), headline, turn status, badge, accent (+ dark), font files (upload `.woff2/.woff/.ttf/.otf`, family/weight/style), wordmark & headline typography. **Save** validates on the host; saving the active profile reloads |
| **Duplicate / Rename / Delete** | on the directory; the active pointer follows a rename and clears on delete |
| **Export** | `<name>.brand.zip` (profile.json + assets) |
| **Import .brand.zip…** | a new profile from such an archive (or a hand-made one: profile.json + flat assets; one wrapping folder tolerated). Validated in a staging directory — a bad archive leaves nothing behind |

Limits: names `[A-Za-z0-9][A-Za-z0-9 ._-]{0,40}`, asset names
`[A-Za-z0-9][A-Za-z0-9._-]*` with the known extensions, 8 MB per file, 24 MB
per archive. An active profile that fails validation (edited by hand, file
gone) is shown on the card and the row config stands in — the GUI never
loses its brand to a typo.

Route (mirrored in `src/client/profiles-card.tsx`): `GET /api/brand-kit`
(state), `POST ?action=apply|create|save|duplicate|rename|delete|upload|import&name=…`,
`GET ?action=export&name=…`, and `GET /api/brand-kit/asset?s=<profile|''>&k=mark|font&f=<file>`
for the files the effective brand names (nothing else is served).

## How it works

| What | Mechanism |
|---|---|
| Mark, wordmark, hero mark | Browser half occupies `sidebar.brand.mark`, `sidebar.brand.name`, `conversation.hero.brand.mark` (all `single` → replaces the shipped fallback). The name cell's fallback is the product title **and** the build-version chip, so both go. |
| `markMode: mask` | `.brand-kit-mark{background:currentColor;mask:url(./brand-kit/mark.svg) center/contain}` — theme-following like the shipped whale (`fill=currentColor`). `image` renders an `<img>`. |
| Headline / turn status | Locale-owned (`hero.headline`, `chat.deepDiving`; one occupant per namespace, no slot) → a MutationObserver swaps the text node in place after mount. React never rewrites a text node whose prop is constant, so it holds. Selectors: `[class*="_titleGroup"] > span:first-child`, `[class*="_turnStatus"]` (the shell's CSS modules compile to `<hash>_<local>`). |
| Fonts, typography, badge, accent | One `<style>` row on `webserver/index-inject`: `@font-face` with document-relative URLs (`./brand-kit/fonts/…`, so a path-stripping proxy mount like `/dsh/` works), `.brand-kit-name`, the headline selector, `_previewBadge{display:none}`, and the accent block. |
| Accent | The shipped `--dsw-static-deepseek-*` ramp (plus the `--dsw-static-blue-*` steps feature CSS uses directly) is redefined on `html>body` — outranking the theme sheet, which the client loads **after** index-inject rows — with lighter/darker steps `color-mix(in oklab, accent N%, white|black)`. |
| Files | One Fetch route, `/api/brand-kit/asset?s=&k=&f=`, serving only the files the *effective* brand names (row config or active profile); `cache-control: private, max-age=3600`. |
| Config → browser | A `global` row publishes `__DSH_BRAND_KIT__ = { name, headline, turnStatus, mark }`; the browser half reads it at apply time. |
| Profiles | `profiles.mjs` (`ProfileStore`): directory per profile, `state.json` for the active one, fflate for zip; the store re-validates through the same `normalizeConfig`. Read at every page render (`webserver/index-inject` is emitted per request), hence apply = reload. |
| Card | `plugins.bundle.config` keyed by the package name (the Plugins panel lists **bundles**, so a dev-overlay row shows no page — install with `dsh plugin add` to see the card); chrome classes `bk-*` come from the host style row. |

Install: `dsh plugin --profile web add ./plugins/brand-kit` (or
`pnpm install-plugins`), then the config block in the profile patch. The
profile patch is live-reloaded; a brand-new row was picked up by a running
`dsh web` without a restart (2026-09-22), edits to `index.js` still need one.

## Test

```sh
pnpm test        # node --test: config validation, generated CSS, payload; profile store (write/validate, duplicate/rename/delete, zip round trip)
pnpm typecheck   # browser half against the checkout's slot types
```

Visual check on a throwaway home: from the checkout,
`DSH_HOME=/tmp/x TMPDIR=/tmp/x/tmp node --import tsx/esm apps/cli/src/bin.ts --profile web --patch <patch> --port 3097 --no-open`
with a patch inserting this `index.js` by absolute path and the config above.
