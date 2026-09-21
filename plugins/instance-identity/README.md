# tali-instance-identity

Tell one DSH web instance from another at a glance. Several `dsh web` servers
(the live one, the preview on `~/.dsh-preview`, a remote Mac's) ship the same
client build, so their windows are identical — same whale, same
"DSH Local Build" wordmark, same version chip. This host-only plugin (no
client bundle, nothing rebuilt) names and colours the instance and quietens
the chip: the wordmark and window title read "DSH" / "DSH Preview" / …

Successor of `tali-preview-identity` (2026-09-05 → 2026-09-21), which only
swapped the favicon/manifest/title for the preview server.

## Config

```yaml
- id: tali-instance-identity
  config:
    label: DSH Remote        # wordmark above the version line + product part of the window title; default DSH
    brandColor: '#0090FF'   # sidebar whale (expanded row + collapsed rail) and /favicon.svg; '' = stock
    versionBadge: subtle    # subtle (default): no box, text colour, 40 % opacity | stock: the shipped chip
    dockLabel: ''           # non-empty: replace /manifest.webmanifest (short_name + port-scoped id)
```

`label` is 1–32 of letters, digits, space, `.`, `_`, `-` (it lands in a CSS
`content` string); `label: DSH Local Build` opts out of renaming.
`brandColor` must be a hex (`#rgb`/`#rrggbb`) or a CSS colour name; anything
else fails the load loudly (it is spliced into a `<style>` row and an SVG
attribute). House colours, matching the native Dock apps that
`dsh-tailscale-remote` builds: live = stock (black/white), preview
`#E5484D` (red), remotes `#0090FF` (Radix blue-9).

## How it works

| What | Mechanism |
|---|---|
| Wordmark | Same `{ kind: 'style' }` row: the wordmark span (`_localBuildTitle`, or `_fallbackBrandName` when no version is baked in) gets `display:flex;font-size:0` and a `::before{content:"<label>"}` at the shipped size (12px/13px, or 17px/24px). `display:flex` drops the zero-size text strut, so the box stays 13px. |
| Window title | A `{ kind: 'script', placement: 'body' }` row: a `MutationObserver` on the `<title>` element substitutes the label for "DSH Local Build" whenever the client's `DocumentTitle` rewrites it (`"<session> — DSH Preview"`). Inside a dsh-tailscale-remote Dock app, `globalThis.__DSH_DOCK__.name` (set by the wrapper at document start) wins over the server's label. |
| Whale colour | A `{ kind: 'style' }` row on the webserver's `webserver/index-inject` table: `span[class*="_brandMark"],span[class*="_railMark"]{color:…}` (expanded row and collapsed rail). CSS modules compile to `<hash>_<local>` class names and the whale path is `fill="currentColor"`. |
| Subtle version chip | Same row: `span[class*="_buildVersion"]{color:inherit;background:none;opacity:.4;padding:0;border-radius:0}`. The `element[attr]` selector outranks the module's single-class rule — no `!important`. |
| `/favicon.svg` | `favicon-template.svg` (the stock whale, dark-mode `<style>` block removed) with `__BRAND_COLOR__` substituted, on an exact route. Named routes beat the static-frontend fallback that serves the built `dist/` copy. `cache-control: no-store`. |
| `/manifest.webmanifest` | Exact route, `short_name: <dockLabel>`, `name`/`id` carrying the port so macOS installs it as a *separate* Safari web app. Only when `dockLabel` is set. |

Why not rename it properly: "DSH Local Build" is `t('brand.localBuild')` from
the `common` locale namespace (single occupant per namespace — a plugin cannot
override it) and `DocumentTitle` rewrites `document.title` on mount (so the
`<title>` tap the old plugin had was overridden the moment the client booted).
A slot occupant for `sidebar.brand.name` would need the baked-in version
string recomputed host-side; restyling the existing spans needs nothing.

The Dock apps built by `dsh-tailscale-remote` inject the same rules themselves
(`!important`, from their own name + `glyphColor`), so a server without this
plugin still reads right inside its Dock app — see that plugin's README.

## Where it is loaded

- **Preview** (`cordis.dev.yml`, absolute-path row): `label: DSH Preview`,
  `brandColor: '#E5484D'`, `dockLabel: DSH-dev`.
- **Live / remote profiles**: install as a bundle (`pnpm install-plugins`
  includes it); the bundle default is `label: DSH`, stock colour, subtle chip.
  A remote Mac sets `label: DSH Remote` + `brandColor: '#0090FF'` by id in its
  profile patch (browser tabs; its Dock app already says so by itself).

## Test

```sh
pnpm test        # node --test against a fake ctx: style row, favicon recolour, manifest, config validation
```

Visual check: open the instance — the wordmark reads the label, the whale in
the sidebar brand row takes the colour, the version text under it is plain,
dim text, and the tab/window title is "<session> — <label>".
