# Recipe: distinguishable preview server — superseded

Superseded on 2026-09-21 by [`instance-identity.md`](instance-identity.md):
the `preview-identity` plugin (red `/favicon.svg` + "DSH-dev" manifest +
`<title>` tap for the Safari "Add to Dock" preview of 2026-09-05) became the
configurable `instance-identity` plugin, which also colours the sidebar whale
per instance and quietens the build-version chip, and is installed in live
profiles too.

Still-true facts from the original recipe, kept here for the cross-references
in other recipes:

- Named webserver routes (`WebServer.register`, `kind: 'exact'`) are matched
  before the static-frontend fallback, so `/favicon.svg` and
  `/manifest.webmanifest` can be overridden without touching the checkout.
- macOS reads a web-app manifest at install time — re-add a Safari Dock app
  after changing icon or label. Moot since the native Dock apps
  (`dock-app-via-tailnet.md`) carry their own `AppIcon.icns`.
- The dev overlay is a **complement** to the profile patch of the home it
  runs against: a plugin present in both fails the boot with
  `duplicate loader entry id`; renaming the overlay id loads it twice.
