# Recipe: telling DSH instances apart (coloured whale, quiet version chip)

Three Dock apps — **DSH** (live, `~/.dsh`), **DSH Preview** (`~/.dsh-preview`,
:3088) and **DSH Remote** (the remote Mac `<remote>`, `/dsh/tali/`) — open windows
that are pixel-identical inside: the same white whale, "DSH Local Build", and
a black version chip (`0.1.6-alpha.2-fc37f13-dirty`) that shouts. This recipe
records the `instance-identity` plugin that colours each instance's sidebar
whale (preview red, remotes blue, live stock) and turns the chip into dim,
box-less text — with no fork change, no client bundle and no rebuild.
Done 2026-09-21; supersedes `preview-identity.md` (2026-09-05).

Plugin: `~/github/tali-dash-plugins/plugins/instance-identity/`
(`tali-instance-identity`, host-only, plain ESM, `pnpm test` = `node --test`).
Its README owns the plugin; this file owns the system story.

## What the client gives us (survey, 2026-09-21)

Everything below was read from the checkout
(`packages/client/ui-sidebar/src/client/SidebarRoot.tsx` + `.module.css`):

- The brand row renders `sidebar.brand.mark` (fallback `<FishLogo>`, an SVG
  with `fill="currentColor"`) inside `span.brandMark`, and the collapsed rail
  renders the same slot inside `span.railMark` in the expand toggle. Both are
  `single` slots a client plugin could occupy — but colouring needs no
  occupant: the whale already inherits `color`.
- The chip is `span.buildVersion`: `background: var(--dsw-alias-label-primary)`,
  inverted text, 6 px mono, 3 px padding, 2 px radius. Its text is
  `process.env.DSH_CLIENT_VERSION` + commit + `-dirty`, **baked into the
  ui-sidebar bundle at build time** — a plugin occupying `sidebar.brand.name`
  could not reproduce it without a host route computing the same string.
  Restyling the existing span sidesteps that entirely.
- CSS modules compile to `<hash>_<local>` (`rIE9vq_buildVersion`); the hash is
  per package build, the `_local` suffix is stable, so `span[class*="_local"]`
  is the durable selector (the settings-shortcut plugin relies on the same
  fact). `element[attr]` = specificity (0,1,1) beats the module's single class
  (0,1,0); the rail's ink comes from `.collapsed .iconButton` (0,2,0), which is
  why the rail rule targets `span[class*="_railMark"]` (the whale's own
  wrapper) rather than the button.
- The sanctioned way to add a `<style>` to the boot HTML is the webserver's
  structured injection table: `ctx.on('webserver/index-inject', table =>
  table.push({ kind: 'style', text }))` (`packages/host/webserver/src/injections.ts`).
  `tapIndex` is the raw-string escape hatch and runs after the rows.

### What cannot be done from a host plugin (and why the old `<title>` tap was dead)

"DSH Local Build" is `t('brand.localBuild')` from the `common` locale
namespace; `LocaleRuntime.register` throws on a second occupant for a
namespace+locale, so a plugin cannot override the string. The window title
is `document.title`, rewritten by `ui-layout`'s `DocumentTitle` effect on
mount (`process.env.DSH_CLIENT_TITLE ?? t('brand.localBuild')`), so the
`<title>` replacement `preview-identity` did via `tapIndex` was overridden the
moment the client booted — it never showed in a Dock-app window. Dropped.
Per-instance names would need a client bundle occupying `sidebar.brand.name`
plus a `document.title` hook; not attempted.

## The plugin (config)

```yaml
- id: tali-instance-identity
  config:
    brandColor: '#E5484D'   # sidebar whale (row + rail) and /favicon.svg; '' = stock
    versionBadge: subtle    # subtle (default) | stock
    dockLabel: DSH-dev      # non-empty: replace /manifest.webmanifest for Safari "Add to Dock" installs
```

`brandColor` is validated (`#rgb`/`#rrggbb` or a colour name) because it is
spliced into a `<style>` row and an SVG attribute. House colours match the
native Dock icons `dsh-tailscale-remote` builds: preview `#E5484D`, remotes
`#0090FF` (`REMOTE_GLYPH_COLOR`, Radix blue-9), live stock.

## Where each instance gets it

| Instance | How loaded | Config |
|---|---|---|
| Preview (`~/.dsh-preview`, :3088) | absolute-path row in `cordis.dev.yml` | `brandColor: '#E5484D'`, `dockLabel: DSH-dev` |
| Live (`~/.dsh`) | bundle: `pnpm install-plugins` (now in the live set) | bundle default: stock whale, subtle chip |
| Remote (remote Mac, `~/.dsh` there) | bundle via that Mac's clone of this repo: `git pull && pnpm install-plugins`, then `- id: tali-instance-identity` / `config: { brandColor: '#0090FF' }` in its `~/.dsh/profiles/web/cordis.patch.yml`, restart | blue |

Never both forms for one home (duplicate id fails the boot). Host module
edits need a server restart: `launchctl kickstart -k
gui/$UID/io.github.taliesinb.dsh-web-relay.preview` for the preview (the relay
starts `dsh web` on the first request — `curl http://127.0.0.1:3085/` wakes
it), `…dsh-web-relay` for live. `bootstrap-mac.sh` no longer excludes the
plugin (it used to skip `preview-identity`).

## Verification (preview, 2026-09-21)

- `DSH_HOME=~/.dsh-preview pnpm dsh --profile web --patch cordis.dev.yml --dump-config`
  shows the row with its config, exit 0.
- `curl :3088/favicon.svg` → `fill="#E5484D"`; `/manifest.webmanifest` →
  `short_name: DSH-dev`, `id: /?instance=3088`.
- In Chrome at `https://laptop.example.ts.net/dsh-preview/`:
  `getComputedStyle(span[class*="_buildVersion"])` → `opacity 0.4`,
  transparent background, `padding 0`, text colour `rgb(249,250,251)`;
  `span[class*="_brandMark"]` and (collapsed) `span[class*="_railMark"]` →
  `rgb(229,72,77)`. Screenshots matched: red whale, dim plain version text.
- First attempt coloured only the expanded row: the rail wrapper is
  `_railMark`, not `_brandMark`. Fixed by targeting both.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Whale stock, chip still boxed | The `<style>` row is missing: plugin not loaded (check `--dump-config`), or the host was edited without a restart (no module HMR on the host) |
| Row loads, no effect after a client rebuild | The `_local` class suffix changed upstream — check `grep -o '[A-Za-z0-9]*_buildVersion' packages/client/ui-sidebar/lib/client.js` and adjust the selectors |
| Boot fails `brandColor must be a hex or named CSS colour` | Quote the value in YAML (`'#0090FF'` — a bare `#` starts a comment) |
| `duplicate loader entry id: tali-instance-identity` | Both the bundle and an absolute-path row in one home — drop one |
| Window title still "DSH Local Build" | Expected; see "What cannot be done" |
