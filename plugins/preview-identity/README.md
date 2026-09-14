# tali-preview-identity

Make the preview/dev `dsh web` server visually distinct from the live one:
a **red whale** icon and a **"DSH-dev"** Dock label, so two Dock-installed
instances can be told apart at a glance.

Load it **only** in `cordis.dev.yml` — never in the live profile, whose
identity should stay stock.

## How it works

The shipped web app serves `/favicon.svg` and `/manifest.webmanifest` from its
built `dist/` through the webserver's **fallback** seat
(`@deepseek-ai/dsh-host-frontend-static`). Named routes are matched *before*
the fallback (`WebServer.register`, `kind: 'exact'`), so this plugin overrides
both paths without touching the DSH checkout or rebuilding the web app:

| Path | Served instead |
|---|---|
| `/favicon.svg` | `favicon-preview.svg` — the stock whale path recoloured `#E5484D`, with the stock `prefers-color-scheme: dark` style block removed so it stays red on any background |
| `/manifest.webmanifest` | `short_name: "DSH-dev"`, `name`/`id` carrying the port, so macOS installs the preview as a **separate** app rather than the same one |
| `<title>` | replaced via `ctx.webServer.tapIndex` (the manifest does not change the tab/window label) |

Both responses send `cache-control: no-store` — the Dock and browsers cling to
icons otherwise.

## Verified (2026-09-05)

Booted with `pnpm dsh web --patch <overlay> --port 3087 --no-open`:

- `/manifest.webmanifest` → 200, `application/manifest+json`, `short_name:
  "DSH-dev"`;
- `/favicon.svg` → 200, `image/svg+xml`, `fill="#E5484D"`, no `<style>` block;
  rendered through `qlmanage` to confirm the whale shape survives the recolour.

The `<title>` tap could not be curl-verified because the index requires
browser authentication (401); it registers without error.

## Installing to the Dock

Open the preview URL in Safari → File → Add to Dock. macOS reads the manifest
at install time, so the icon/label are captured then — re-add the app after
changing them.

## Known repo issue this surfaced (resolved)

`dsh web` loads the profile patch **and** the `--patch` overlay, so a plugin
row present in both fails the boot with `duplicate loader entry id`. Renaming
the overlay id is NOT a fix — it loads the plugin twice. Resolution: the dev
overlay is now a **complement** to the live profile — plugins installed live
(enforce-model-preset, browser-automation, local-model-supervisor,
reverse-proxy) are no longer repeated in `cordis.dev.yml`; it only carries the
not-yet-live `agent-status-indicator` and this preview-only identity plugin.
See `~/projects/deepseek-harness/preview-identity.md`.
