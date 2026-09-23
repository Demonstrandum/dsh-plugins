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

## How it works

| What | Mechanism |
|---|---|
| Mark, wordmark, hero mark | Browser half occupies `sidebar.brand.mark`, `sidebar.brand.name`, `conversation.hero.brand.mark` (all `single` → replaces the shipped fallback). The name cell's fallback is the product title **and** the build-version chip, so both go. |
| `markMode: mask` | `.brand-kit-mark{background:currentColor;mask:url(./brand-kit/mark.svg) center/contain}` — theme-following like the shipped whale (`fill=currentColor`). `image` renders an `<img>`. |
| Headline / turn status | Locale-owned (`hero.headline`, `chat.deepDiving`; one occupant per namespace, no slot) → a MutationObserver swaps the text node in place after mount. React never rewrites a text node whose prop is constant, so it holds. Selectors: `[class*="_titleGroup"] > span:first-child`, `[class*="_turnStatus"]` (the shell's CSS modules compile to `<hash>_<local>`). |
| Fonts, typography, badge, accent | One `<style>` row on `webserver/index-inject`: `@font-face` with document-relative URLs (`./brand-kit/fonts/…`, so a path-stripping proxy mount like `/dsh/` works), `.brand-kit-name`, the headline selector, `_previewBadge{display:none}`, and the accent block. |
| Accent | The shipped `--dsw-static-deepseek-*` ramp (plus the `--dsw-static-blue-*` steps feature CSS uses directly) is redefined on `html>body` — outranking the theme sheet, which the client loads **after** index-inject rows — with lighter/darker steps `color-mix(in oklab, accent N%, white|black)`. |
| Files | Exact routes `/brand-kit/mark.<ext>` and `/brand-kit/fonts/<file>`, `cache-control: public, max-age=86400`. |
| Config → browser | A `global` row publishes `__DSH_BRAND_KIT__ = { name, headline, turnStatus, mark }`; the browser half reads it at apply time. |

Install: `dsh plugin --profile web add ./plugins/brand-kit` (or
`pnpm install-plugins`), then the config block in the profile patch. The
profile patch is live-reloaded; a brand-new row was picked up by a running
`dsh web` without a restart (2026-09-22), edits to `index.js` still need one.

## Test

```sh
pnpm test        # node --test: config validation, generated CSS, payload
pnpm typecheck   # browser half against the checkout's slot types
```

Visual check on a throwaway home: from the checkout,
`DSH_HOME=/tmp/x TMPDIR=/tmp/x/tmp node --import tsx/esm apps/cli/src/bin.ts --profile web --patch <patch> --port 3097 --no-open`
with a patch inserting this `index.js` by absolute path and the config above.
