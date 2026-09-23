#!/usr/bin/env bash
#
# bootstrap-mac-thin-client.sh — the THIN CLIENT only: a Dock app "DSH <Host>" on
# this Mac that opens a DSH running on another Mac of your tailnet (your instance
# on the shared server, mounted there at /dsh/<user>). Nothing local is built or
# run: no DSH fork, no plugin builds, no Homebrew, no pnpm, no ~/.dsh. Minutes,
# not the better part of an hour — tools/bootstrap-mac.sh is the full install
# (its `thin-client` step does the same thing on top of a local DSH).
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/taliesinb/dsh-plugins/main/tools/bootstrap-mac-thin-client.sh)" hub
#   bash -c "$(curl -fsSL …/bootstrap-mac-thin-client.sh)" thin-client hub jo
#   # from a clone:  tools/bootstrap-mac-thin-client.sh [HOST [USER]] [flags]
#
# HOST is the tailnet name of the Mac running DSH (hub, or hub.<tailnet>.ts.net),
# USER your instance there (the app opens https://HOST/dsh/USER/). Both are asked
# for when not given: an empty HOST ends the script (nothing to build), USER
# defaults to the local part of your tailnet login (jo@example.com → jo).
# In `bash -c "$(curl …)" hub`, bash makes the first word after the script
# $0, not $1 — so a bare word there (not a shell or a path) is taken as HOST.
#
# Flags
#   --host HOST, --user USER  the same as the positionals
#   --name NAME           Dock app name (default "DSH <Host>", e.g. DSH Hub)
#   --dir DIR             where the plugin sources go (default ~/.dsh-thin-client/dsh-plugins; a shallow clone,
#                         3 MB — the Dock app's Swift sources and the node script that builds it live there)
#   --yes                 take every default without asking
#   --dry-run             print what each step would do, change nothing
#   --no-launch           do not open the app once installed
#   --tailscale-timeout S give up waiting for the Tailscale login after S seconds (default 180)
#   --repo URL            clone URL (default https://github.com/taliesinb/dsh-plugins)
#
# What it needs and installs: the Xcode Command Line Tools (swiftc compiles the
# WKWebView wrapper; ~500 MB, headless via softwareupdate, sudo once) — Tailscale,
# installed, connected and logged in (the app has no token: the server admits
# you by your tailnet identity, and the host name is resolved through MagicDNS)
# — node (an existing node ≥ 20 is used; otherwise the official tarball goes to
# ~/.dsh-thin-client/node, no sudo, no Homebrew) — a shallow clone of the plugins
# repo. Then: node plugins/dsh-tailscale-remote/scripts/cli.mjs dock-app:remote HOST/dsh/USER
# (`pnpm remote-app` in a full clone). Idempotent: re-run to rebuild or to add a
# second host. Everything it puts on the Mac: ~/.dsh-thin-client/, the CLT,
# Tailscale, ~/Applications/DSH <Host>.app (+ a Dock tile).
#
# Why a wrapper app and not Safari's "Add to Dock": that web app holds only a
# 30-day cookie it has no URL bar to renew, and Launch Services refuses to run a
# web-app bundle Safari did not create itself (plugins/dsh-tailscale-remote/README.md).
set -euo pipefail

REPO="https://github.com/taliesinb/dsh-plugins"
THIN="${DSH_THIN_CLIENT_DIR:-$HOME/.dsh-thin-client}"
DIR=""
HOST=""
RUSER=""
NAME=""
YES=0
DRY=0
LAUNCH=1
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
TS_TIMEOUT=180
POS=()

# `bash -c "$(curl …)" hub`: bash takes `hub` as $0 (the script name), not $1. A $0 that is a bare word —
# not a shell (bash, -bash, sh, zsh), not a path, not a script file, not the `thin-client` placeholder — is the host.
case "$0" in
  bash|-bash|sh|-sh|zsh|-zsh|*/*|*.sh|thin-client|thin|bootstrap|-*) ;;
  *) [[ "$0" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] && POS+=("$0") ;;
esac
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --host=*) HOST="${1#--host=}"; shift ;;
    --user) RUSER="$2"; shift 2 ;;
    --user=*) RUSER="${1#--user=}"; shift ;;
    --name) NAME="$2"; shift 2 ;;
    --name=*) NAME="${1#--name=}"; shift ;;
    --dir) DIR="$2"; shift 2 ;;
    --dir=*) DIR="${1#--dir=}"; shift ;;
    --yes|-y) YES=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --no-launch) LAUNCH=0; shift ;;
    --tailscale-timeout) TS_TIMEOUT="$2"; shift 2 ;;
    --tailscale-timeout=*) TS_TIMEOUT="${1#--tailscale-timeout=}"; shift ;;
    --repo) REPO="$2"; shift 2 ;;
    --repo=*) REPO="${1#--repo=}"; shift ;;
    -h|--help) [ -f "$0" ] && sed -n "2,45p" "$0" || echo "usage: bootstrap-mac-thin-client.sh [HOST [USER]] [--name N] [--dir D] [--yes] [--dry-run] [--no-launch] (full help: the header of tools/bootstrap-mac-thin-client.sh)"; exit 0 ;;
    --*) echo "unknown argument: $1 (try --help)" >&2; exit 2 ;;
    *) POS+=("$1"); shift ;;
  esac
done
[ -n "$HOST" ] || HOST="${POS[0]-}"
[ -n "$RUSER" ] || RUSER="${POS[1]-}"
[ -n "$DIR" ] || DIR="$THIN/dsh-plugins"; DIR="${DIR/#\~/$HOME}"

# ---------------------------------------------------------------------------
# helpers (the same as tools/bootstrap-mac.sh)
BOLD=$'\033[1m'; BLUE=$'\033[1;34m'; GREEN=$'\033[1;32m'; YELLOW=$'\033[1;33m'; RED=$'\033[1;31m'; DIM=$'\033[2m'; NC=$'\033[0m'
LOGDIR="${TMPDIR:-/tmp}/dsh-bootstrap"; mkdir -p "$LOGDIR"
LOG="$LOGDIR/thin-client-$(date +%Y%m%d-%H%M%S).log"
TODO=()
step_no=0

log()  { printf '%s▸%s %s\n' "$BLUE" "$NC" "$*" | tee -a "$LOG"; }
ok()   { printf '%s✓%s %s\n' "$GREEN" "$NC" "$*" | tee -a "$LOG"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$NC" "$*" | tee -a "$LOG"; }
die()  { printf '%s✖%s %s\n' "$RED" "$NC" "$*" | tee -a "$LOG" >&2; echo "   log: $LOG" >&2; exit 1; }
todo() { TODO+=("$*"); warn "to do by hand: $*"; }
banner() { step_no=$((step_no+1)); printf '\n%s━━ %d. %s ━━%s\n' "$BOLD" "$step_no" "$*" "$NC" | tee -a "$LOG"; }
run() {
  if [ "$DRY" = 1 ]; then printf '  %swould run:%s %s\n' "$DIM" "$NC" "$*" | tee -a "$LOG"; return 0; fi
  printf '  $ %s\n' "$*" >>"$LOG"
  "$@" 2>&1 | tee -a "$LOG" | sed 's/^/    │ /'
}
has_tty() { { : </dev/tty; } 2>/dev/null; }
ask() {
  local __var="$1" prompt="$2" default="$3" answer=""
  if [ "$YES" = 1 ] || ! has_tty; then answer="$default"; printf '  %s [%s] %s(auto)%s\n' "$prompt" "$default" "$DIM" "$NC"
  else read -r -p "  $prompt [$default] " answer </dev/tty; answer="${answer:-$default}"; fi
  printf -v "$__var" '%s' "$answer"
}
confirm() { local a; ask a "$1 (y/n)" "$2"; case "$a" in y|Y|yes) return 0 ;; *) return 1 ;; esac; }
have_brew() { [ -x /opt/homebrew/bin/brew ] || [ -x /usr/local/bin/brew ]; }
brew_bin() { if [ -x /opt/homebrew/bin/brew ]; then echo /opt/homebrew/bin/brew; else echo /usr/local/bin/brew; fi; }
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK=1 HOMEBREW_NO_INSTALL_CLEANUP=1 \
       HOMEBREW_NO_ENV_HINTS=1 HOMEBREW_NO_ANALYTICS=1
# ts_field state|login|dns over `tailscale status --self --json` (empty on any failure). python3 ships with the CLT.
ts_field() {
  "$TS" status --self --json 2>/dev/null | python3 -c '
import json,sys
try:
    j=json.load(sys.stdin); w=sys.argv[1]; s=j.get("Self") or {}
    if w=="state": v=j.get("BackendState")
    elif w=="login": v=((j.get("User") or {}).get(str(s.get("UserID"))) or {}).get("LoginName")
    else: v=(s.get("DNSName") or "").rstrip(".")
    sys.stdout.write(v or "")
except Exception: pass' "$1" 2>/dev/null || true
}
ts_state() { ts_field state; }
ts_login() { ts_field login; }
ts_dns()   { ts_field dns; }
ts_ready() { [ "$(ts_state)" = Running ] && [ -n "$(ts_login)" ] && [ -n "$(ts_dns)" ]; }
# Same default name dock-app:remote uses: "DSH " + the host's first label title-cased on -/_ (hub → DSH Hub).
default_name() { printf 'DSH %s' "$(printf '%s' "${1%%.*}" | tr '_-' '  ' | awk '{for(i=1;i<=NF;i++) $i=toupper(substr($i,1,1)) substr($i,2)}1')"; }

# ---------------------------------------------------------------------------
echo "${BOLD}DSH thin client${NC} — log: $LOG"; [ "$DRY" = 1 ] && warn "dry run: nothing will be changed"

# ===========================================================================
banner "Preflight"
[ "$(uname -s)" = Darwin ] || die "macOS only"
[ "$(id -u)" != 0 ] || die "run as your normal user, not root (the app goes to ~/Applications)"
ARCH="$(uname -m)"
ok "macOS $(sw_vers -productVersion) on $ARCH, user $USER"
[ -n "$HOST" ] || ask HOST "Tailnet host name of the Mac running DSH (e.g. hub; empty = nothing to do)" ""
HOST="$(printf '%s' "$HOST" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
if [ -z "$HOST" ]; then log "no host given — nothing to build"; exit 0; fi
case "$HOST" in *@*) die "'$HOST' names a user; give the host only (the app admits you by tailnet identity) — the instance is asked next" ;; esac
[[ "$HOST" =~ ^[a-z0-9][a-z0-9.-]*$ ]] || die "not a host name: '$HOST'"
[ -n "$NAME" ] || NAME="$(default_name "$HOST")"

# ===========================================================================
banner "Xcode Command Line Tools (swiftc builds the Dock app)"
if xcode-select -p >/dev/null 2>&1 && xcrun --find swiftc >/dev/null 2>&1; then
  ok "present at $(xcode-select -p) — $(xcrun swift --version 2>/dev/null | head -1)"
elif [ "$DRY" = 1 ]; then log "would install the Command Line Tools (softwareupdate, ~500 MB, sudo once)"
else
  log "installing headlessly through softwareupdate (~500 MB; asks for your password once)"
  if ! sudo -n -v 2>/dev/null; then
    has_tty || die "sudo needs a password but there is no terminal — run 'sudo -v' first, then re-run"
    sudo -v </dev/tty || die "sudo failed"
  fi
  touch /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
  LABEL="$(softwareupdate -l 2>&1 | grep -o 'Label: Command Line Tools for Xcode.*' | sed 's/^Label: //' | sort -V | tail -1 || true)"
  if [ -n "$LABEL" ]; then run sudo softwareupdate -i "$LABEL" --verbose || warn "softwareupdate failed"; fi
  rm -f /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
  if ! xcode-select -p >/dev/null 2>&1; then
    warn "falling back to the GUI installer; finish the dialog, then this script continues"
    xcode-select --install 2>/dev/null || true
    until xcode-select -p >/dev/null 2>&1; do sleep 5; done
  fi
  xcrun --find swiftc >/dev/null 2>&1 && ok "installed at $(xcode-select -p)" || die "Command Line Tools still missing (no swiftc)"
fi

# ===========================================================================
banner "Tailscale (required): installed, connected, logged in"
if [ ! -x "$TS" ]; then
  warn "Tailscale.app is not installed — the app reaches $HOST over the tailnet and is admitted by your tailnet identity."
  if [ "$DRY" = 1 ]; then log "would install Tailscale (brew cask, or wait for a manual install from tailscale.com)"
  elif have_brew && confirm "Install Tailscale now (brew install --cask tailscale-app)?" y; then
    run "$(brew_bin)" install --cask tailscale-app || die "Tailscale install failed — install it from https://tailscale.com/download/mac, log in, then re-run"
  else
    log "opening https://tailscale.com/download/mac — install Tailscale (drag it to /Applications), then this script continues"
    has_tty && open "https://tailscale.com/download/mac" 2>/dev/null || true
    waited=0
    until [ -x "$TS" ]; do
      sleep 5; waited=$((waited+5))
      [ $((waited % 60)) = 0 ] && log "still waiting for /Applications/Tailscale.app (${waited}s)…"
      [ "$waited" -lt 900 ] || die "Tailscale.app did not appear within 15 minutes — install it, log in, then re-run"
    done
  fi
  [ -x "$TS" ] || [ "$DRY" = 1 ] || die "Tailscale.app still missing after the install"
fi
if [ "$DRY" = 1 ] && [ ! -x "$TS" ]; then log "would connect/log in Tailscale and require a tailnet login"
else
  # The GUI app must be running for its CLI to talk to the backend (a network extension owned by the app).
  pgrep -xq Tailscale || { [ "$DRY" = 1 ] || { open -ga Tailscale 2>/dev/null || true; sleep 4; }; }
  state="$(ts_state)"
  log "backend state: ${state:-unknown} $( [ -n "$(ts_login)" ] && echo "(login $(ts_login))" )"
  if [ "$DRY" = 0 ] && ! ts_ready; then
    case "$state" in
      Stopped)
        log "Tailscale is logged in but disconnected — connecting (tailscale up)"
        "$TS" up --timeout 60s 2>&1 | sed 's/^/    │ /' || true ;;
      *)
        warn "Tailscale is not logged in. Log in as YOUR tailnet user (the server admits you by that identity)."
        UPLOG="$LOGDIR/tailscale-up.log"; : >"$UPLOG"
        ( "$TS" up >"$UPLOG" 2>&1 ) &
        UP_PID=$!
        waited=0; shown=0
        until ts_ready; do
          if [ "$shown" = 0 ]; then
            url="$(grep -o 'https://login.tailscale.com/[^[:space:]]*' "$UPLOG" 2>/dev/null | head -1 || true)"
            if [ -n "$url" ]; then
              printf '    %slog in here:%s %s\n' "$BOLD" "$NC" "$url" | tee -a "$LOG"
              has_tty && open "$url" 2>/dev/null || true
              shown=1
            fi
          fi
          kill -0 "$UP_PID" 2>/dev/null || { sleep 2; ts_ready && break; ( "$TS" up >"$UPLOG" 2>&1 ) & UP_PID=$!; }
          sleep 5; waited=$((waited+5))
          if [ "$TS_TIMEOUT" -gt 0 ] && [ "$waited" -ge "$TS_TIMEOUT" ]; then break; fi
          [ $((waited % 60)) = 0 ] && log "still waiting for the Tailscale login (${waited}s; state $(ts_state))…"
        done
        kill "$UP_PID" 2>/dev/null || true ;;
    esac
    [ "$(ts_state)" = NeedsMachineAuth ] && warn "this device needs approval by the tailnet admin (Machines → Approve) before it is usable"
  fi
  if ts_ready; then ok "Tailscale connected: $(ts_dns) as $(ts_login)"
  elif [ "$DRY" = 1 ]; then warn "a real run would ABORT here: Tailscale is not connected with a tailnet login (state: ${state:-unknown})"
  else die "Tailscale is not connected with a tailnet login (state: $(ts_state), login: '$(ts_login)'). Open Tailscale.app, log in, wait until it shows Connected, then re-run this script."; fi
fi
# The instance on HOST: asked now that the tailnet login is known (its local part is the usual account name).
if [ -z "$RUSER" ]; then
  default_user="$(ts_login | cut -d@ -f1 | tr '[:upper:]' '[:lower:]')"
  ask RUSER "Your instance on $HOST (its DSH is mounted at /dsh/<user>)" "${default_user:-$USER}"
fi
RUSER="$(printf '%s' "$RUSER" | tr -d '[:space:]')"
[ -n "$RUSER" ] || die "a user (your instance on $HOST) is needed"
TARGET="$HOST/dsh/$RUSER"

# ===========================================================================
banner "node (runs the build script)"
NODE=""
node_ok() { [ -x "$1" ] && [ "$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 20 ]; }
for cand in "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node "$THIN/node/bin/node"; do
  [ -n "$cand" ] && node_ok "$cand" && { NODE="$cand"; break; }
done
if [ -n "$NODE" ]; then ok "node $("$NODE" --version) at $NODE"
elif [ "$DRY" = 1 ]; then log "would download the official node 24 tarball into $THIN/node (no sudo, no Homebrew)"; NODE="$THIN/node/bin/node"
else
  case "$ARCH" in arm64) NARCH=arm64 ;; x86_64) NARCH=x64 ;; *) die "unsupported architecture $ARCH" ;; esac
  TARBALL="$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | grep -o "node-v[0-9.]*-darwin-$NARCH\.tar\.gz" | head -1 || true)"
  [ -n "$TARBALL" ] || die "could not find the node 24 tarball for darwin-$NARCH at nodejs.org"
  log "downloading $TARBALL → $THIN/node (~50 MB)"
  mkdir -p "$THIN"; rm -rf "$THIN/node" "$THIN/node.tmp"; mkdir -p "$THIN/node.tmp"
  curl -fsSL "https://nodejs.org/dist/latest-v24.x/$TARBALL" | tar xz -C "$THIN/node.tmp" --strip-components 1 || die "node download failed"
  mv "$THIN/node.tmp" "$THIN/node"
  NODE="$THIN/node/bin/node"
  node_ok "$NODE" || die "the downloaded node does not run ($NODE)"
  ok "node $("$NODE" --version) at $NODE"
fi

# ===========================================================================
banner "Plugin sources (shallow clone, no fork, nothing built)"
CLI="$DIR/plugins/dsh-tailscale-remote/scripts/cli.mjs"
if [ -d "$DIR/.git" ]; then
  if [ "$DRY" = 1 ]; then log "would update the clone at $DIR"
  else
    git -C "$DIR" fetch -q --depth 1 origin main 2>>"$LOG" && git -C "$DIR" reset -q --hard origin/main 2>>"$LOG" || warn "could not update $DIR — using what is there"
    ok "$DIR at $(git -C "$DIR" log -1 --format='%h %s' 2>/dev/null)"
  fi
elif [ "$DRY" = 1 ]; then log "would run: git clone --depth 1 $REPO $DIR"
else
  mkdir -p "$(dirname "$DIR")"
  run git clone -q --depth 1 --single-branch "$REPO" "$DIR" || die "clone failed"
  ok "$DIR at $(git -C "$DIR" log -1 --format='%h %s' 2>/dev/null)"
fi
[ "$DRY" = 1 ] || [ -f "$CLI" ] || die "$CLI missing — not a dsh-plugins clone?"

# ===========================================================================
banner "Build + install the Dock app \"$NAME\" → $TARGET"
CMD=("$NODE" "$CLI" dock-app:remote "$TARGET" --name "$NAME")
[ "$LAUNCH" = 1 ] || CMD+=(--no-launch)
if [ "$DRY" = 1 ]; then log "would run: ${CMD[*]}"
else
  run "${CMD[@]}" || die "Dock app build failed (${CMD[*]})"
fi

# ===========================================================================
banner "Verification"
APP="$HOME/Applications/$NAME.app"
if [ "$DRY" = 0 ]; then
  [ -d "$APP" ] || die "$APP is not there although the build reported success (see $LOG)"
  URL="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["url"])' "$APP/Contents/Resources/dsh-dock-app.json" 2>/dev/null || true)"
  ok "installed $APP → ${URL:-?}"
  if [ -n "$URL" ]; then
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$URL" || true)"
    case "$code" in
      200|303) ok "$URL → $code (the server admits you by identity)" ;;
      401) warn "$URL → 401: the route is live but $HOST does not admit $(ts_login) — ask its owner to add you (Settings → Tailscale remote → allowed users)" ;;
      000) warn "$URL → no answer: is $HOST online and serving /dsh/$RUSER? (MagicDNS + HTTPS certs must be enabled on the tailnet)" ;;
      *) warn "$URL → HTTP $code" ;;
    esac
  fi
fi
echo
if [ ${#TODO[@]} -gt 0 ]; then
  printf '%sStill to do by hand:%s\n' "$BOLD" "$NC"
  for t in "${TODO[@]}"; do printf '  • %s\n' "$t"; done
fi
printf '\n%sDone.%s app: %s · sources: %s · log: %s\n' "$GREEN" "$NC" "$APP" "$DIR" "$LOG"
echo "Rebuild, or an app for another host: re-run this script with HOST [USER]   (or: $NODE $CLI dock-app:remote HOST/dsh/USER)"
