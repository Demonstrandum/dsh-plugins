#!/usr/bin/env bash
# dev-overlay.sh — write cordis.dev.local.yml (gitignored) from cordis.dev.yml.
#
# The dev overlay's rows need ABSOLUTE module paths (a patch layer contributes
# config; the loader's `!!js` interpolation covers `config`, never `name`), so
# the committed file carries the placeholder prefix /Users/USER/github/tali-dash-plugins
# and this script replaces it with wherever this repo actually is. The preview
# relay and every `--patch` command load the generated file:
#
#   pnpm dev-overlay      # then: launchctl kickstart -k gui/$UID/io.github.taliesinb.dsh-web-relay.preview
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PLACEHOLDER="/Users/USER/github/tali-dash-plugins"
sed "s#$PLACEHOLDER#$HERE#g" "$HERE/cordis.dev.yml" > "$HERE/cordis.dev.local.yml"
n="$(grep -c "name: '$HERE/" "$HERE/cordis.dev.local.yml" || true)"
printf '▸ wrote %s (%s rows → %s)\n' "$HERE/cordis.dev.local.yml" "$n" "$HERE"
