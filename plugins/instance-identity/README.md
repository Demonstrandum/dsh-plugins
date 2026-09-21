# tali-instance-identity

Tell one DSH web instance from another at a glance. Several `dsh web` servers
(the live one, the preview on `~/.dsh-preview`, a remote Mac's) ship the same
client build, so their windows are identical — same whale, same
"DSH Local Build" wordmark, same version chip. This host-only plugin (no
client bundle, nothing rebuilt) colours the instance and quietens the chip.

Successor of `tali-preview-identity` (2026-09-05 → 2026-09-21), which only
swapped the favicon/manifest/title for the preview server.

## Config

```yaml
- id: tali-instance-identity
  config:
    brandColor: '#0090FF'   # sidebar whale (expanded row + collapsed rail) and /favicon.svg; '' = stock
    versionBadge: subtle    # subtle (default): no box, text colour, 40 % opacity | stock: the shipped chip
    dockLabel: ''           # non-empty: replace /manifest.webmanifest (short_name + port-scoped id)
```

`brandColor` must be a hex (`#rgb`/`#rrggbb`) or a CSS colour name; anything
else fails the load loudly (it is spliced into a `<style>` row and an SVG
attribute). House colours, matching the native Dock apps that
`dsh-tailscale-remote` builds: live = stock (black/white), preview
`#E5484D` (red), remotes `#0090FF` (Radix blue-9).

## How it works

| What | Mechanism |
|---|---|
| Whale colour | A `{ kind: 'style' }` row on the webserver's `webserver/index-inject` table: `span[class*="_brandMark"],span[class*="_railMark"]{color:…}` (expanded row and collapsed rail). CSS modules compile to `<hash>_<local>` class names and the whale path is `fill="currentColor"`. |
| Subtle version chip | Same row: `span[class*="_buildVersion"]{color:inherit;background:none;opacity:.4;padding:0;border-radius:0}`. The `element[attr]` selector outranks the module's single-class rule — no `!important`. |
| `/favicon.svg` | `favicon-template.svg` (the stock whale, dark-mode `<style>` block removed) with `__BRAND_COLOR__` substituted, on an exact route. Named routes beat the static-frontend fallback that serves the built `dist/` copy. `cache-control: no-store`. |
| `/manifest.webmanifest` | Exact route, `short_name: <dockLabel>`, `name`/`id` carrying the port so macOS installs it as a *separate* Safari web app. Only when `dockLabel` is set. |

Not done: the wordmark text and window title ("DSH Local Build") come from the
`common` locale namespace (single occupant per namespace) and the client's
`DocumentTitle` rewrites `document.title` on mount, so the `<title>` tap the
old plugin had was overridden the moment the client booted; it is gone.
Renaming an instance would need a client bundle occupying `sidebar.brand.name`.

## Where it is loaded

- **Preview** (`cordis.dev.yml`, absolute-path row): `brandColor: '#E5484D'`,
  `dockLabel: DSH-dev`.
- **Live / remote profiles**: install as a bundle (`pnpm install-plugins`
  includes it); the bundle default is stock colour + subtle chip. A remote
  Mac sets `brandColor: '#0090FF'` by id in its profile patch.

## Test

```sh
pnpm test        # node --test against a fake ctx: style row, favicon recolour, manifest, config validation
```

Visual check: open the instance, the whale in the sidebar brand row takes the
colour and the version text under "DSH Local Build" is plain, dim text.
