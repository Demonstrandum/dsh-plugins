# tali-brand-kit

Re-brand the DSH Web GUI: a mark and a wordmark for the sidebar and the
empty-session hero, web fonts, typography, an accent colour, and the two
locale-owned strings the shell shows ("Into the Unknown", "Deep diving...").
**The plugin ships no brand and its row carries no brand.** A brand is a
*profile* — a directory under `$DSH_HOME/brand-profiles/<name>/` — managed
from the Plugins panel or `cli.mjs`. No active profile = the shipped DSH look,
so the plugin can sit in every default install untouched.

## A profile

```
$DSH_HOME/brand-profiles/
  state.json                 { "active": "Acme" }   ('' / absent = shipped look)
  Acme/
    profile.json
    mark.svg                 assets are flat, named from profile.json
    Serif-Light.woff2
```

```json
{
  "name": "Acme",                       // sidebar wordmark; '' keeps "DSH Local Build" + version chip
  "mark": "mark.svg",                   // .svg/.png in this directory; replaces the whale (sidebar, rail, hero)
  "markMode": "mask",                   // mask (default): monochrome, filled with the text colour | image: as-is
  "headline": "Into the Abyss",         // empty-session headline
  "turnStatus": "Working...",           // running-turn label under the transcript
  "hidePreviewBadge": true,             // drop the "Preview" pill after the headline
  "accent": "#7678ed",                  // re-points the shipped blue ramp (links, buttons, bubbles, tabs…)
  "accentDark": "#6163ea",              // optional 600 step (hover/pressed); derived when absent
  "fonts": [{ "file": "Serif-Light.woff2", "family": "My Serif", "weight": 300 }],   // style: normal | italic
  "brandFont":    { "family": "\"My Serif\", Georgia, serif", "weight": 300, "size": 22, "lineHeight": 24, "letterSpacing": 0, "offsetY": -1 },
  "headlineFont": { "family": "\"My Serif\", Georgia, serif", "weight": 300, "size": 32, "lineHeight": 36 }
}
```

Every key is optional. Defaults: `brandFont` 18px/24 weight 600 (the shell's
own), `headlineFont` 26px/32 weight 500. Names `[A-Za-z0-9][A-Za-z0-9 ._-]{0,40}`,
asset names `[A-Za-z0-9][A-Za-z0-9._-]*` with the known extensions, colours
`#rrggbb`, texts ≤ 80 chars without `< > " \`; 8 MB per file, 24 MB per
archive. A profile that fails validation is reported on the card and the
shipped look stands in — the GUI never loses its brand to a typo.

Plugin row config: only `profilesDir` (absolute; '' = `$DSH_HOME/brand-profiles`).

## Managing profiles

**GUI** — Plugins panel ▸ tali-brand-kit ▸ the **Brand** card:

| action | effect |
|---|---|
| **Active** select | which profile the GUI shows, or *None*. Changing it writes `state.json` and reloads the page (the brand is rendered into the boot document) |
| **New** / **New from current** | an empty profile (shipped look), or a copy of the active one |
| **Edit** | every key: wordmark, mark (upload `.svg`/`.png`, mask/image), headline, turn status, badge, accent (+ dark), font files (upload `.woff2/.woff/.ttf/.otf`, family/weight/style), wordmark & headline typography. **Save** validates on the host; saving the active profile reloads |
| **Duplicate / Rename / Delete** | on the directory; the active pointer follows a rename and clears on delete |
| **Export** | `<name>.brand.zip` (profile.json + assets) |
| **Import .brand.zip…** | a new profile from such an archive (or a hand-made one: profile.json + flat assets; one wrapping folder tolerated). Validated in a staging directory — a bad archive leaves nothing behind |

**CLI** — `node cli.mjs …` (honours `DSH_HOME`, or `--dir`), for provisioning
scripts and headless machines:

```sh
node cli.mjs import ./acme-brand --name Acme --apply      # a directory (profile.json + assets) or a .brand.zip
node cli.mjs list | active | apply <name|none> | export Acme acme.brand.zip
```

Both paths use the same store and validation; a change is visible on the next
page load, no restart.

Route (mirrored in `src/client/profiles-card.tsx`): `GET /api/brand-kit`
(state), `POST ?action=apply|create|save|duplicate|rename|delete|upload|import&name=…`,
`GET ?action=export&name=…`, and `GET /api/brand-kit/asset?s=<profile>&k=mark|font&f=<file>`
for the files the active profile names (nothing else is served).

## How it works

| What | Mechanism |
|---|---|
| Mark, wordmark, hero mark | Browser half occupies `sidebar.brand.mark`, `sidebar.brand.name`, `conversation.hero.brand.mark` (all `single` → replaces the shipped fallback). The name cell's fallback is the product title **and** the build-version chip, so both go. |
| `markMode: mask` | `.brand-kit-mark{background:currentColor;mask:url(./brand-kit/mark.svg) center/contain}` — theme-following like the shipped whale (`fill=currentColor`). `image` renders an `<img>`. |
| Headline / turn status | Locale-owned (`hero.headline`, `chat.deepDiving`; one occupant per namespace, no slot) → a MutationObserver swaps the text node in place after mount. React never rewrites a text node whose prop is constant, so it holds. Selectors: `[class*="_titleGroup"] > span:first-child`, `[class*="_turnStatus"]` (the shell's CSS modules compile to `<hash>_<local>`). |
| Fonts, typography, badge, accent | One `<style>` row on `webserver/index-inject`: `@font-face` with document-relative URLs (`./brand-kit/fonts/…`, so a path-stripping proxy mount like `/dsh/` works), `.brand-kit-name`, the headline selector, `_previewBadge{display:none}`, and the accent block. |
| Accent | The shipped `--dsw-static-deepseek-*` ramp (plus the `--dsw-static-blue-*` steps feature CSS uses directly) is redefined on `html>body` — outranking the theme sheet, which the client loads **after** index-inject rows — with lighter/darker steps `color-mix(in oklab, accent N%, white|black)`. |
| Files | One Fetch route, `/api/brand-kit/asset?s=&k=&f=`, serving only the files the active profile names; `cache-control: private, max-age=3600`. |
| Config → browser | A `global` row publishes `__DSH_BRAND_KIT__ = { name, headline, turnStatus, mark }`; the browser half reads it at apply time. |
| Profiles | `profiles.mjs` (`ProfileStore`): directory per profile, `state.json` for the active one, fflate for zip; `resolveProfile` makes the file names absolute and `normalizeConfig` validates. Read at every page render (`webserver/index-inject` is emitted per request), hence apply = reload. |
| Card | `plugins.bundle.config` keyed by the package name (the Plugins panel lists **bundles**, so a dev-overlay row shows no page — install with `dsh plugin add` to see the card); chrome classes `bk-*` come from the host style row. |

Install: `dsh plugin --profile web add ./plugins/brand-kit` (or
`pnpm install-plugins`), then import/apply a profile (GUI or CLI). Edits to
`index.js` need a `dsh web` restart; profile changes never do.

## Test

```sh
pnpm test        # node --test: profile validation + generated CSS, the store (write/validate, duplicate/rename/delete, zip round trip), the CLI
pnpm typecheck   # browser half against the checkout's slot types
```

Visual check on a throwaway home: `DSH_HOME=/tmp/x` → `dsh plugin --profile web
add ./plugins/brand-kit` (a bundle, so the Plugins panel shows the card), start
`dsh web`, then `DSH_HOME=/tmp/x node cli.mjs import <dir> --name X --apply`
and reload.
