#!/usr/bin/env bash
#
# install-plugins.sh — install every live-profile plugin of this repo into a
# DSH profile as bundles, in one command (the "tali-plugins superplugin").
#
#   pnpm install-plugins [--profile web] [--checkout DIR] [--without NAME,NAME] [--remove] [--dry-run]
#
# --without drops plugins from the set for this run (directory names, e.g.
# `--without dash-docsets,<private-plugin>` on a Mac without Dash or
# <private> — tools/bootstrap-mac.sh does exactly that).
#
# Each plugin under plugins/ that is meant for a live profile declares
# `dsh.bundle.patch` (its cordis.patch.yml inserts its own `tali-*` row by
# package name), so `dsh plugin --profile <p> add <dir>...` pnpm-links the
# directories into $DSH_HOME/profiles/<p> and appends one bundle per plugin to
# dsh.profile.bundles. Rows resolve by package name from the profile's hoisted
# node_modules — no absolute paths in any patch file. Row configs are the
# plugins' schema defaults, which equal the maintainer's live settings; override by id
# in the profile's cordis.patch.yml when needed (a patch replaces the whole
# `config`).
#
# Why not a package whose dependencies list the plugins: pnpm does not install
# the dependencies of a `link:`-installed package into the profile, and the
# loader resolves every row from the profile directory, so such a package's
# rows would not resolve (measured 2026-09-18). Deep imports through it
# (`tali-plugins/plugins/x/index.js`) break the client-module scan, which
# attributes the row to the bare specifier's package.
#
# Idempotent: pnpm reports "Already up to date" and dsh does not duplicate a
# bundle already listed. A profile that ALSO inserts these rows by absolute
# path (the pre-2026-09-18 layout) must drop those inserts first: duplicate
# ids fail the boot.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE=web
CHECKOUT="${DSH_CHECKOUT:-$HERE/deepseek-harness}"
ACTION=add
DRY=0
WITHOUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --without) WITHOUT="$WITHOUT,$2"; shift 2 ;;
    --without=*) WITHOUT="$WITHOUT,${1#--without=}"; shift ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --profile=*) PROFILE="${1#--profile=}"; shift ;;
    --checkout) CHECKOUT="$2"; shift 2 ;;
    --checkout=*) CHECKOUT="${1#--checkout=}"; shift ;;
    --remove) ACTION=remove; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# The live set. instance-identity's bundle default is stock whale + subtle
# version chip; the preview overlay loads the same plugin by absolute path
# with its red colour — a home gets one or the other, never both.
PLUGINS=(
  dsh-tailscale-remote
  instance-identity
  enforce-model-preset
  browser-automation
  dash-docsets
  local-model-supervisor
  <private-plugin>
  foreign-link-opener
  session-introspect
  fs-tools
  settings-shortcut
  session-title-slug
  dsh-remote-workspaces
  numbered-switching
  import-api-keys
  reload-on-restart
  transcript-grace-margin
  phone-ui
  wait-tool
  reboot-command
)

log() { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✖\033[0m %s\n' "$*" >&2; exit 1; }

[ -f "$CHECKOUT/apps/cli/lib/bin.js" ] || [ -f "$CHECKOUT/apps/cli/src/bin.ts" ] \
  || die "DSH checkout not found at $CHECKOUT (set DSH_CHECKOUT or --checkout)"

if [ -n "$WITHOUT" ]; then
  KEPT=()
  for p in "${PLUGINS[@]}"; do
    case ",$WITHOUT," in *",$p,"*) log "leaving out $p (--without)" ;; *) KEPT+=("$p") ;; esac
  done
  PLUGINS=("${KEPT[@]}")
fi

# The optional private layer (extras/dsh-extras.yml): plugins with `install: true` whose `requires.command`
# (if any) is present join the set. Absent submodule → nothing added. NB: macOS's /bin/bash is 3.2, where
# "${EMPTY[@]}" under `set -u` is an error (fixed in 4.4) — an empty array must be expanded as
# ${ARR[@]+"${ARR[@]}"}; that is exactly the no-extras case (a fresh account without the deploy key).
EXTRA_DIRS=()
if [ -f "$HERE/extras/dsh-extras.yml" ] && [ -f "$HERE/tools/extras-manifest.mjs" ] && [ -z "${NO_EXTRAS:-}" ]; then
  while IFS=$'\t' read -r epath ebundle einstall ereq; do
    [ "$einstall" = yes ] || continue
    if [ "$ereq" != "-" ] && ! command -v "$ereq" >/dev/null 2>&1; then log "extras: $ebundle skipped (requires \`$ereq\`)"; continue; fi
    [ -f "$epath/package.json" ] || { log "extras: $ebundle skipped (not checked out: $epath)"; continue; }
    EXTRA_DIRS+=("$epath")
  done < <(node "$HERE/tools/extras-manifest.mjs" "$HERE" 2>/dev/null)
fi

DIRS=(); NAMES=()
for p in "${PLUGINS[@]}" ${EXTRA_DIRS[@]+"${EXTRA_DIRS[@]}"}; do
  case "$p" in /*) dir="$p"; p="extras:$(basename "$dir")" ;; *) dir="$HERE/plugins/$p" ;; esac
  [ -f "$dir/package.json" ] || die "missing plugin directory: $dir"
  name="$(node -p "require('$dir/package.json').name")"
  bundle="$(node -p "require('$dir/package.json').dsh?.bundle?.patch ?? ''")"
  [ -n "$bundle" ] || die "$p declares no dsh.bundle.patch — it cannot be installed as a bundle"
  if [ "$ACTION" = add ]; then
    client="$(node -p "require('$dir/package.json').dsh?.client ? 'yes' : ''")"
    [ -z "$client" ] || [ -f "$dir/lib/client.js" ] || die "$p is a client plugin but lib/client.js is not built — run: (cd $dir && pnpm install && pnpm build)"
    [ -d "$dir/node_modules" ] || [ "$(node -p "Object.keys(require('$dir/package.json').dependencies ?? {}).length")" = 0 ] \
      || die "$p has dependencies but no node_modules — run: (cd $dir && pnpm install)"
  fi
  DIRS+=("$dir"); NAMES+=("$name")
done

log "$ACTION ${#DIRS[@]} plugins (${#EXTRA_DIRS[@]} from extras) → profile '$PROFILE' (DSH_HOME=${DSH_HOME:-~/.dsh}) via $CHECKOUT"
if [ "$ACTION" = add ]; then
  CMD=(pnpm dsh plugin --profile "$PROFILE" add "${DIRS[@]}")
else
  CMD=(pnpm dsh plugin --profile "$PROFILE" remove "${NAMES[@]}")
fi
if [ "$DRY" = 1 ]; then printf '  %q' "${CMD[@]}"; echo; exit 0; fi
(cd "$CHECKOUT" && "${CMD[@]}")

log "composed rows in profile '$PROFILE':"
(cd "$CHECKOUT" && pnpm dsh --profile "$PROFILE" --dump-config 2>/dev/null | grep -E '^- id: tali-' | sed 's/^/  /') || true
if [ "$ACTION" = add ]; then
  n="$(cd "$CHECKOUT" && pnpm dsh --profile "$PROFILE" --dump-config 2>/dev/null | grep -cE '^- id: tali-' || true)"
  [ "$n" -ge "${#PLUGINS[@]}" ] || log "warning: expected ${#PLUGINS[@]} tali- rows, dump shows $n"
  for d in ${EXTRA_DIRS[@]+"${EXTRA_DIRS[@]}"}; do (cd "$CHECKOUT" && pnpm dsh --profile "$PROFILE" --dump-config 2>/dev/null | grep -qE "^- id: $(node -p "require('$d/package.json').name")") && log "extras: $(basename "$d") composed" || log "warning: extras plugin $(basename "$d") not in the composed profile"; done
fi
log "done"
