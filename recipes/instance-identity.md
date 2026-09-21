# Recipe: telling DSH instances apart (name, coloured whale, quiet version chip)

Three Dock apps — **DSH** (live, `~/.dsh`), **DSH Preview** (`~/.dsh-preview`,
:3088) and **DSH Remote** (the remote Mac `<remote>`, `/dsh/tali/`) — opened
windows that were pixel-identical inside: the same white whale, the same
"DSH Local Build" wordmark and window title, and a black version chip
(`0.1.6-alpha.2-fc37f13-dirty`) that shouts. This recipe records the two
layers that fix it, both without a fork change, a client bundle or a rebuild
of DSH: the `instance-identity` DSH plugin (server side: wordmark + title =
its `label`, whale colour, dim box-less chip) and the same rules carried by
the **Dock app wrapper itself** (`dsh-tailscale-remote/dock-app`), so an
instance whose server has no plugin — DSH Remote today — still reads right
inside its app. Done 2026-09-21; supersedes `preview-identity.md`.

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

### The name: why not a locale override, and how it is done instead

"DSH Local Build" is `t('brand.localBuild')` from the `common` locale
namespace; `LocaleRuntime.register` throws on a second occupant for a
namespace+locale, so a plugin cannot override the string. The window title
is `document.title`, rewritten by `ui-layout`'s `DocumentTitle` effect on
mount (`process.env.DSH_CLIENT_TITLE ?? t('brand.localBuild')`), so the
`<title>` replacement `preview-identity` did via `tapIndex` was overridden the
moment the client booted — it never showed in a Dock-app window. Dropped.
A proper occupant of `sidebar.brand.name` would have to reproduce the version
line, whose text is baked into the ui-sidebar bundle at build time
(`process.env.DSH_CLIENT_VERSION`), i.e. a host route recomputing
`package.json` version + `git rev-parse --short` + dirty, plus a client
bundle and its toolchain. Instead:

- **Wordmark**: the existing span (`_localBuildTitle`; `_fallbackBrandName`
  when no version is baked in) gets `display:flex;font-size:0` and a
  `::before{content:"<label>"}` at the shipped size. `display:flex` matters:
  with the span left inline, the zero-size text strut still spans a line box
  and the row measured 17.5px instead of 13px (the `.localBuildBrand` column
  is 24px: 13 + 1 gap + 10 chip).
- **Window/tab title**: a `{ kind: 'script', placement: 'body' }` row (after
  `<body>` opens so `<title>` exists) with a `MutationObserver` on the title
  element substituting the label whenever `DocumentTitle` writes
  "… — DSH Local Build". `label` is validated (`/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$/`)
  because it lands in a CSS string and a JS literal.

### The Dock app wrapper carries the same identity

`dsh-tailscale-remote/dock-app/Sources/main.swift` already injected a
document-start `WKUserScript` (`__DSH_TRANSPORT__.ownsHost`). It now also
sets `globalThis.__DSH_DOCK__ = { name, glyphColor }` and appends a `<style>`
with the same three rule groups (wordmark = app name, whale = icon glyph
colour unless `#000000`, quiet chip), all `!important` so the app's name wins
over whatever the server says; and the `webView.title` observer substitutes
the app name for "DSH Local Build" in `window.title`. The installer writes
`glyphColor` into `Contents/Resources/dsh-dock-app.json`. The plugin's title
script reads `__DSH_DOCK__.name` first, so server label and app name never
fight over `document.title` in an app. Consequence: **DSH Remote reads "DSH
Remote" with a blue whale and a quiet chip although the <remote> server runs no
identity plugin** (verified by evaluating the wrapper's generated script in
Chrome against `https://<remote>.example.ts.net/dsh/tali/`; `screencapture -l`
of the real window is denied to an agent shell without Screen Recording).

## The plugin (config)

```yaml
- id: tali-instance-identity
  config:
    label: DSH Preview      # wordmark + product part of the window title; default DSH; 'DSH Local Build' opts out
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
| Preview (`~/.dsh-preview`, :3088) | absolute-path row in `cordis.dev.yml` | `label: DSH Preview`, `brandColor: '#E5484D'`, `dockLabel: DSH-dev` |
| Live (`~/.dsh`) | bundle: `pnpm install-plugins` (now in the live set) | bundle default: `label: DSH`, stock whale, subtle chip |
| Remote (remote Mac, `~/.dsh` there) | **not installed** (2026-09-21, by choice) — its Dock app supplies the identity itself. For browser tabs to the remote: on that Mac `git pull && pnpm install-plugins`, then `- id: tali-instance-identity` / `config: { label: DSH Remote, brandColor: '#0090FF' }` in `~/.dsh/profiles/web/cordis.patch.yml`, restart | blue |

### Rebuilding the three Dock apps (done 2026-09-21)

The wrapper is compiled from `main.swift` on install (mtime-cached); a
changed wrapper reaches an app only through a reinstall with its existing
spec, read back from `~/Applications/<name>.app/Contents/Resources/dsh-dock-app.json`:

```sh
cd ~/github/tali-dash-plugins/plugins/dsh-tailscale-remote
node scripts/cli.mjs dock-app:remote <remote>/dsh/<user> --name "DSH Remote" --no-launch          # blue, id …remote-<remote>-dsh-tali
node scripts/cli.mjs dock-app:install --instance preview --name "DSH Preview" \
  --url https://laptop.example.ts.net/dsh-preview/ --fallback http://127.0.0.1:3085/ \
  --token-file ~/.dsh-preview/tailscale-remote-preview.json --glyph-color '#E5484D' --no-launch
node scripts/cli.mjs dock-app:install --name DSH --url https://laptop.example.ts.net/dsh/ \
  --fallback http://127.0.0.1:3083/ --token-file ~/.dsh/tailscale-remote.json                # live; quits + relaunches DSH.app
```

`installDockApp` quits a running copy and (without `--no-launch`) relaunches
it; it re-pins a Dock tile when none points at the path (DSH Preview got
re-pinned this way). Bundle ids and URLs reproduced exactly (`bundleIdFor`,
`remoteInstance('<remote>.example.ts.net','/dsh/tali')` → `remote-<remote>-dsh-tali`).

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
- With `label: DSH Preview`: wordmark `::before` content `"DSH Preview"`,
  span height 13px (17.5 before `display:flex`), `.localBuildBrand` 24px;
  `document.title` "DSH Preview" and, with a session open, "Hello — DSH Preview".

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Whale stock, chip still boxed | The `<style>` row is missing: plugin not loaded (check `--dump-config`), or the host was edited without a restart (no module HMR on the host) |
| Row loads, no effect after a client rebuild | The `_local` class suffix changed upstream — check `grep -o '[A-Za-z0-9]*_buildVersion' packages/client/ui-sidebar/lib/client.js` and adjust the selectors |
| Boot fails `brandColor must be a hex or named CSS colour` | Quote the value in YAML (`'#0090FF'` — a bare `#` starts a comment) |
| `duplicate loader entry id: tali-instance-identity` | Both the bundle and an absolute-path row in one home — drop one |
| Wordmark renamed but title still "DSH Local Build" in a browser tab | The script row is body-placed and needs the `<title>` element; check the boot HTML carries `tali-instance-identity` rows (`curl -s :<port>/ \| grep -c instance-identity` needs the auth cookie — use the browser's view-source) |
| Dock app says one name, a browser tab to the same server another | By design: the app's `__DSH_DOCK__.name` + `!important` rules win inside the app; set the server `label` to the same string to make tabs agree |
| Dock app still shows the old look after `dock-app:build` | Building only refreshes `dock-app/build/`; reinstall the app with its spec (above) |
