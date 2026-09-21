#!/usr/bin/env bash
#
# bootstrap-mac.sh — bring a fresh Apple Silicon Mac from nothing to a running
# DSH (the custom fork + plugins) in one sitting: INSTALLING.md Part A + C1–C5,
# in order, interactively, in a Terminal.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/taliesinb/dsh-plugins/main/tools/bootstrap-mac.sh)"
#   # or, from a clone:  tools/bootstrap-mac.sh [flags]
#
# Flags
#   --dir DIR             where the tali-dash-plugins clone goes (asked otherwise; default ~/github/tali-dash-plugins)
#   --yes                 take every default without asking (headless / VM runs)
#   --dry-run             print what each step would do, change nothing
#   --skip STEP[,STEP]    leave steps out;  --only STEP[,STEP]  run just these
#   --no-apps             do not offer to install Safari Technology Preview / Chrome (Tailscale is always required)
#   --no-tailnet          skip the relay LaunchAgent, the tailnet route and the Dock app
#   --no-apple            skip afm + the Apple on-device provider/preset
#   --rebuild             rebuild the fork and the plugins even if built artifacts exist
#   --tailscale-timeout S give up waiting for the Tailscale login after S seconds (default 10: the login is a
#                         precondition, not something this script waits around for)
#   --force               proceed even though DSH already seems installed or running on this Mac (see below)
#   --replace             REDEPLOY: stop the existing DSH (both LaunchAgents, the listeners), delete the
#                         deploy-remote.sh tree (~/dsh, ~/.dsh/deploy) and reinstall from scratch, keeping
#                         ~/.dsh (settings, credentials, sessions, tailscale-remote.json) and any clone at --dir
#   --repo URL            clone URL (default https://github.com/taliesinb/dsh-plugins)
#   --list                list the step names and exit
#
# Steps (in order): preflight clt brew tools apps tailscale clone fork plugins
#                   home install-plugins preset apple tailnet verify
#
# Two hard gates. (1) This is a FRESH-Mac installer: preflight aborts when DSH
# already appears to be installed or running here (a dsh process or listener on
# :3080/:3083/:3084, an existing $DSH_HOME/profiles, a DSH LaunchAgent,
# ~/Applications/DSH.app, a built checkout at the target directory) unless it
# is a resume of this very script (marker $DSH_HOME/bootstrap-mac.json, written
# once preflight passes) or --force is given. (2) Tailscale must be installed,
# connected and reporting a tailnet login before anything is cloned: the
# `tailscale` step installs the cask if you agree, reconnects a stopped
# backend with `tailscale up`, and drives a login (prints/opens the auth URL,
# waits) — and refuses to continue otherwise.
#
# Why a shell script and not a .pkg: Installer.app runs postinstall as root
# with no terminal — it cannot ask where the checkout goes, cannot wait for a
# Tailscale login or a sudo password, hides ten minutes of build output behind
# "Running package scripts…", and Homebrew refuses to run as root anyway. A
# Terminal script does all of that natively, and `curl | bash` sidesteps
# Gatekeeper (no quarantine flag), which an unsigned .pkg would not.
#
# Idempotent: every step checks its own postcondition first (app present,
# artifact built, file written, service answering) and skips when satisfied,
# so re-running after fixing a failure resumes where it stopped. Steps that
# only a human can finish (Apple Intelligence toggle, STP licence, provider
# keys in the GUI, tailnet ACL) are collected into a to-do list at the end.
set -euo pipefail

REPO="https://github.com/taliesinb/dsh-plugins"
DIR=""
YES=0
DRY=0
APPS=1
TAILNET=1
APPLE=1
REBUILD=0
FORCE=0
REPLACE=0
TS_TIMEOUT=""
SKIP=""
ONLY=""
STEPS=(preflight clt brew tools apps tailscale clone fork plugins home install-plugins preset apple tailnet verify)

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --dir=*) DIR="${1#--dir=}"; shift ;;
    --yes|-y) YES=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --skip) SKIP="$SKIP,$2"; shift 2 ;;
    --skip=*) SKIP="$SKIP,${1#--skip=}"; shift ;;
    --only) ONLY="$ONLY,$2"; shift 2 ;;
    --only=*) ONLY="$ONLY,${1#--only=}"; shift ;;
    --no-apps) APPS=0; shift ;;
    --no-tailnet) TAILNET=0; shift ;;
    --no-apple) APPLE=0; shift ;;
    --rebuild) REBUILD=1; shift ;;
    --force) FORCE=1; shift ;;
    --replace) REPLACE=1; shift ;;
    --tailscale-timeout) TS_TIMEOUT="$2"; shift 2 ;;
    --tailscale-timeout=*) TS_TIMEOUT="${1#--tailscale-timeout=}"; shift ;;
    --repo) REPO="$2"; shift 2 ;;
    --repo=*) REPO="${1#--repo=}"; shift ;;
    --list) printf '%s\n' "${STEPS[@]}"; exit 0 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1 (try --help)" >&2; exit 2 ;;
  esac
done
[ -n "$TS_TIMEOUT" ] || TS_TIMEOUT=10

# ---------------------------------------------------------------------------
# helpers
BOLD=$'\033[1m'; BLUE=$'\033[1;34m'; GREEN=$'\033[1;32m'; YELLOW=$'\033[1;33m'; RED=$'\033[1;31m'; DIM=$'\033[2m'; NC=$'\033[0m'
LOGDIR="${TMPDIR:-/tmp}/dsh-bootstrap"; mkdir -p "$LOGDIR"
LOG="$LOGDIR/bootstrap-$(date +%Y%m%d-%H%M%S).log"
TODO=()
step_no=0

log()  { printf '%s▸%s %s\n' "$BLUE" "$NC" "$*" | tee -a "$LOG"; }
ok()   { printf '%s✓%s %s\n' "$GREEN" "$NC" "$*" | tee -a "$LOG"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$NC" "$*" | tee -a "$LOG"; }
die()  { printf '%s✖%s %s\n' "$RED" "$NC" "$*" | tee -a "$LOG" >&2; echo "   log: $LOG" >&2; exit 1; }
todo() { TODO+=("$*"); warn "to do by hand: $*"; }
banner() { step_no=$((step_no+1)); printf '\n%s━━ %d. %s ━━%s\n' "$BOLD" "$step_no" "$*" "$NC" | tee -a "$LOG"; }

# run CMD...: execute (streamed, indented, logged) unless --dry-run, in which case print it.
run() {
  if [ "$DRY" = 1 ]; then printf '  %swould run:%s %s\n' "$DIM" "$NC" "$*" | tee -a "$LOG"; return 0; fi
  printf '  $ %s\n' "$*" >>"$LOG"
  "$@" 2>&1 | tee -a "$LOG" | sed 's/^/    │ /'
}
# run_in DIR CMD...: `run` from another directory (dry-run prints even when DIR does not exist yet).
run_in() {
  local d="$1"; shift
  if [ "$DRY" = 1 ]; then printf '  %swould run (in %s):%s %s\n' "$DIM" "$d" "$NC" "$*" | tee -a "$LOG"; return 0; fi
  (cd "$d" && run "$@")
}
# quiet variant: log only, print the tail on failure.
runq() {
  if [ "$DRY" = 1 ]; then printf '  %swould run:%s %s\n' "$DIM" "$NC" "$*" | tee -a "$LOG"; return 0; fi
  printf '  $ %s\n' "$*" >>"$LOG"
  local out; out="$(mktemp)"
  local rc=0
  "$@" >"$out" 2>&1 || rc=$?        # not `if cmd; then …; fi; rc=$?` — that reads the if's status (0) and masks failures
  cat "$out" >>"$LOG"
  [ "$rc" = 0 ] || tail -25 "$out" | sed 's/^/    │ /'
  rm -f "$out"; return $rc
}
# ask VAR "prompt" default  — reads an answer from the terminal (/dev/tty, so it
# works under `curl | bash`); takes the default with --yes or without a terminal.
has_tty() { { : </dev/tty; } 2>/dev/null; }
ask() {
  local __var="$1" prompt="$2" default="$3" answer=""
  if [ "$YES" = 1 ] || ! has_tty; then answer="$default"; printf '  %s [%s] %s(auto)%s\n' "$prompt" "$default" "$DIM" "$NC"
  else read -r -p "  $prompt [$default] " answer </dev/tty; answer="${answer:-$default}"; fi
  printf -v "$__var" '%s' "$answer"
}
# confirm "question" y|n → 0 for yes
confirm() { local a; ask a "$1 (y/n)" "$2"; case "$a" in y|Y|yes) return 0 ;; *) return 1 ;; esac; }
wants() { # wants STEP → should the step run?
  local s="$1"
  [ -n "$ONLY" ] && { case ",$ONLY," in *",$s,"*) ;; *) return 1 ;; esac; }
  case ",$SKIP," in *",$s,"*) return 1 ;; esac
  return 0
}
wait_http() { # wait_http URL CODE SECONDS
  local i code=000
  for _ in $(seq 1 "$3"); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$1" || true)"
    [ "$code" = "$2" ] && return 0
    sleep 1
  done
  return 1
}
macos_major() { sw_vers -productVersion | cut -d. -f1; }
have_brew() { [ -x /opt/homebrew/bin/brew ]; }
brew_env() { have_brew && eval "$(/opt/homebrew/bin/brew shellenv)"; }
pkg_field() { node -p "const p=require('$1/package.json'); $2" 2>/dev/null; }

# ---------------------------------------------------------------------------
echo "${BOLD}DSH bootstrap${NC} — log: $LOG"; [ "$DRY" = 1 ] && warn "dry run: nothing will be changed"

# ===========================================================================
if wants preflight; then
  banner "Preflight"
  [ "$(uname -s)" = Darwin ] || die "macOS only"
  [ "$(uname -m)" = arm64 ] || die "Apple Silicon only (the fork, afm and the Dock app are built for arm64)"
  [ "$(id -u)" != 0 ] || die "run as your normal user, not root (Homebrew refuses root; ~/.dsh must be yours)"
  MAJOR="$(macos_major)"
  if [ "$MAJOR" -lt 26 ]; then warn "macOS $(sw_vers -productVersion): Safari Technology Preview (cask needs ≥ 26) and afm will be skipped"; fi
  dseditgroup -o checkmember -m "$USER" admin >/dev/null 2>&1 || warn "$USER is not an admin — Homebrew and the Command Line Tools install will fail without sudo"
  ok "macOS $(sw_vers -productVersion) on $(uname -m), user $USER"

  # Fresh-machine gate: refuse to run on top of an existing DSH unless resuming (marker) or --force.
  DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
  MARKER="$DSH_HOME_DIR/bootstrap-mac.json"
  [ -n "$DIR" ] && DIR="${DIR/#\~/$HOME}"
  FOUND=()
  if [ "$REPLACE" = 1 ]; then
    # Redeploy: stop whatever DSH runs here and remove the deploy-remote.sh (Path B) tree; ~/.dsh stays.
    banner "Replace the existing DSH install (--replace)"
    [ -f "$MARKER" ] && rm -f "$MARKER"
    if [ "$DRY" = 0 ]; then
      confirm "Stop DSH here, remove ~/dsh and ~/.dsh/deploy (deploy-remote.sh tree) and reinstall? ~/.dsh settings/sessions/token are kept" y \
        || die "aborted"
    fi
    for la in ai.symbolica.dsh-remote io.github.taliesinb.dsh-web-relay; do
      if [ -f "$HOME/Library/LaunchAgents/$la.plist" ] || launchctl print "gui/$(id -u)/$la" >/dev/null 2>&1; then
        log "stopping LaunchAgent $la"
        [ "$DRY" = 1 ] || { launchctl bootout "gui/$(id -u)/$la" 2>/dev/null || true; rm -f "$HOME/Library/LaunchAgents/$la.plist"; }
      fi
    done
    for port in 3080 3083 3084; do
      pids="$(lsof -ti tcp:$port -sTCP:LISTEN 2>/dev/null || true)"
      [ -z "$pids" ] || { log "stopping listener on :$port (pid $pids)"; [ "$DRY" = 1 ] || { echo "$pids" | xargs kill 2>/dev/null || true; }; }
    done
    if [ "$DRY" = 0 ]; then
      for _ in $(seq 1 20); do lsof -ti tcp:3080 -sTCP:LISTEN >/dev/null 2>&1 || lsof -ti tcp:3084 -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 1; done
      pgrep -f 'apps/cli/(lib/bin\.js|src/bin\.ts)' | xargs kill 2>/dev/null || true
    fi
    if [ -f "$HOME/dsh/checkout/apps/cli/lib/bin.js" ]; then
      log "removing the deploy-remote.sh tree: ~/dsh (checkout, plugins, deps, logs) and ~/.dsh/deploy"
      [ "$DRY" = 1 ] || rm -rf "$HOME/dsh" "$DSH_HOME_DIR/deploy"
    fi
    if [ "$DRY" = 0 ]; then
      lsof -ti tcp:3080 -sTCP:LISTEN >/dev/null 2>&1 && die "something still listens on :3080 after the teardown"
      pgrep -f 'apps/cli/(lib/bin\.js|src/bin\.ts)' >/dev/null 2>&1 && die "a dsh process survived the teardown"
    fi
    ok "old install stopped and removed; ~/.dsh kept$( [ -d "$HOME/Applications/DSH.app" ] && echo '; the Dock app will be rebuilt' )"
  elif [ -f "$MARKER" ]; then
    ok "resuming an earlier bootstrap run ($MARKER)"
    if [ -z "$DIR" ]; then DIR="$(node -p "require('$MARKER').dir" 2>/dev/null || python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["dir"])' "$MARKER" 2>/dev/null || true)"; fi
  else
    for port in 3080 3083 3084; do
      pid="$(lsof -ti tcp:$port -sTCP:LISTEN 2>/dev/null | head -1 || true)"
      [ -n "$pid" ] && FOUND+=("a server is listening on 127.0.0.1:$port (pid $pid: $(ps -o comm= -p "$pid" 2>/dev/null))")
    done
    pgrep -f 'apps/cli/(lib/bin\.js|src/bin\.ts)' >/dev/null 2>&1 && FOUND+=("a dsh process is running ($(pgrep -f 'apps/cli/(lib/bin\.js|src/bin\.ts)' | head -1))")
    [ -d "$DSH_HOME_DIR/profiles" ] && FOUND+=("$DSH_HOME_DIR/profiles exists (DSH home already initialised)")
    for la in io.github.taliesinb.dsh-web-relay ai.symbolica.dsh-remote; do
      [ -f "$HOME/Library/LaunchAgents/$la.plist" ] && FOUND+=("LaunchAgent $la is installed")
    done
    [ -d "$HOME/Applications/DSH.app" ] && FOUND+=("$HOME/Applications/DSH.app exists")
    command -v dsh >/dev/null 2>&1 && FOUND+=("a 'dsh' command is on PATH ($(command -v dsh))")
    CAND="${DIR:-$HOME/github/tali-dash-plugins}"
    [ -f "$CAND/deepseek-harness/apps/cli/lib/bin.js" ] && FOUND+=("a built DSH checkout exists at $CAND")
    if [ ${#FOUND[@]} -gt 0 ]; then
      for f in "${FOUND[@]}"; do warn "$f"; done
      if [ "$FORCE" = 1 ]; then warn "--force given: continuing anyway (every step still skips what is already in place)"
      elif [ "$DRY" = 1 ]; then warn "a real run would ABORT here: DSH already appears to be installed or running on this Mac (use --force to override); continuing the dry run"
      else die "DSH already appears to be installed or running on this Mac. This is a fresh-machine installer: use the existing setup (INSTALLING.md day-to-day commands), remove it first, or re-run with --force to layer on top."; fi
    else ok "no existing DSH found on this Mac"; fi
  fi

  if [ "$DRY" = 0 ] && { ! have_brew || ! xcode-select -p >/dev/null 2>&1; }; then
    log "some steps need sudo (Homebrew install, Command Line Tools); asking for your password once now"
    if ! sudo -n -v 2>/dev/null; then
      has_tty || die "sudo needs a password but there is no terminal — run 'sudo -v' first, then re-run"
      sudo -v </dev/tty || die "sudo failed"
    fi
  fi
  # Resume marker (so a re-run after a mid-way failure passes the gate above).
  if [ "$DRY" = 0 ] && [ ! -f "$MARKER" ]; then
    mkdir -p "$DSH_HOME_DIR"
    printf '{ "tool": "tali-dash-plugins/tools/bootstrap-mac.sh", "started": "%s", "dir": "%s" }\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${DIR:-}" >"$MARKER"
  fi
fi

# ===========================================================================
if wants clt; then
  banner "Xcode Command Line Tools (git, swiftc for the Dock app)"
  if xcode-select -p >/dev/null 2>&1 && xcrun --find swiftc >/dev/null 2>&1; then
    ok "present at $(xcode-select -p) — $(xcrun swift --version 2>/dev/null | head -1)"
  else
    log "installing headlessly through softwareupdate (~500 MB)"
    if [ "$DRY" = 0 ]; then
      touch /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
      LABEL="$(softwareupdate -l 2>&1 | grep -o 'Label: Command Line Tools for Xcode.*' | sed 's/^Label: //' | sort -V | tail -1 || true)"
      if [ -n "$LABEL" ]; then
        run sudo softwareupdate -i "$LABEL" --verbose || warn "softwareupdate failed"
      fi
      rm -f /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
      if ! xcode-select -p >/dev/null 2>&1; then
        warn "falling back to the GUI installer; finish the dialog, then this script continues"
        xcode-select --install 2>/dev/null || true
        until xcode-select -p >/dev/null 2>&1; do sleep 5; done
      fi
    fi
    xcode-select -p >/dev/null 2>&1 && ok "installed at $(xcode-select -p)" || [ "$DRY" = 1 ] || die "Command Line Tools still missing"
  fi
fi

# ===========================================================================
if wants brew; then
  banner "Homebrew"
  if have_brew; then ok "present: $(/opt/homebrew/bin/brew --version | head -1)"
  else
    log "installing Homebrew (official installer, non-interactive; needs sudo)"
    [ "$DRY" = 1 ] || NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" 2>&1 | tee -a "$LOG" | sed 's/^/    │ /'
    have_brew || [ "$DRY" = 1 ] || die "Homebrew did not install"
  fi
  # The relay LaunchAgent starts DSH through `zsh -lc "pnpm dsh web"`, so brew must be on the LOGIN-shell PATH
  # even when Homebrew was already here (a bare install leaves ~/.zprofile untouched).
  if ! grep -qs 'brew shellenv' "$HOME/.zprofile" "$HOME/.zshenv" 2>/dev/null; then
    [ "$DRY" = 1 ] || echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >>"$HOME/.zprofile"
    ok "added brew shellenv to ~/.zprofile (login-shell PATH for the relay)"
  fi
  brew_env || true
fi
brew_env || true

# ===========================================================================
if wants tools; then
  banner "node, pnpm, git"
  have_brew || die "Homebrew missing (run the brew step)"
  # node/pnpm come from brew; Apple's git (Command Line Tools) is fine.
  MISSING=()
  for f in node pnpm; do brew list --formula "$f" >/dev/null 2>&1 || MISSING+=("$f"); done
  command -v git >/dev/null 2>&1 || MISSING+=(git)
  if [ ${#MISSING[@]} -gt 0 ]; then run brew install "${MISSING[@]}" || die "brew install failed"; fi
  brew_env
  if command -v node >/dev/null 2>&1 && command -v pnpm >/dev/null 2>&1; then
    NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
    [ "$NODE_MAJOR" -ge 24 ] || die "node $(node --version) is too old (the fork needs ^22.19 || >=24)"
    ok "node $(node --version), pnpm $(pnpm --version), git $(git --version | awk '{print $3}')"
  fi
fi

# ===========================================================================
if wants apps && [ "$APPS" = 1 ]; then
  banner "Third-party apps (Homebrew casks)"
  have_brew || die "Homebrew missing (run the brew step)"
  # app name | cask | why | minimum macOS major   (Tailscale is handled by the mandatory `tailscale` step)
  APP_TABLE=(
    "Safari Technology Preview|safari-technology-preview|safari_* tools (only STP ships safaridriver --mcp)|26"
    "Google Chrome|google-chrome|chrome_* tools (chrome-devtools-mcp)|13"
  )
  # Not offered: Dash and <private> are paid apps — their plugins are installed
  # only when the app is already there (see plugin_exclusions below).
  for row in "${APP_TABLE[@]}"; do
    IFS='|' read -r app cask why minmac <<<"$row"
    if [ -d "/Applications/$app.app" ] || [ -d "$HOME/Applications/$app.app" ]; then ok "$app.app present"; continue; fi
    if [ "$(macos_major)" -lt "$minmac" ]; then warn "$app: cask needs macOS ≥ $minmac — skipped"; continue; fi
    if confirm "Install $app ($why)?" y; then
      run brew install --cask "$cask" || warn "$cask failed to install (continuing)"
    else
      todo "install $app yourself (or: brew install --cask $cask)"
    fi
  done
  if [ -d "/Applications/Safari Technology Preview.app" ]; then
    # STP must be launched once to accept its licence before safaridriver --mcp works.
    if [ ! -d "$HOME/Library/Containers/com.apple.SafariTechnologyPreview" ] && [ ! -d "$HOME/Library/Safari Technology Preview" ]; then
      [ "$DRY" = 1 ] || open -ga "Safari Technology Preview" || true
      todo "Safari Technology Preview was launched in the background — accept its licence once, then quit it"
    fi
  fi
fi

# Plugins that only make sense with a paid app already on the Mac: left out of
# the build and the bundle install when the app is absent (re-run
# `pnpm install-plugins` after installing the app to add them).
# Detect by bundle id through LaunchServices, not by path: Dash may live in
# /Applications/Setapp/Dash.app (com.kapeli.dash-setapp) or come from the App
# Store / a direct download (com.kapeli.dashdoc) — the plugin accepts both.
app_by_id()   { local b; for b in "$@"; do osascript -e "id of application id \"$b\"" >/dev/null 2>&1 && return 0; done; return 1; }
has_dash()    { app_by_id com.kapeli.dash-setapp com.kapeli.dashdoc || [ -d /Applications/Dash.app ] || [ -d /Applications/Setapp/Dash.app ]; }
has_<private>() { [ -d /Applications/<private>.app ] || [ -d /Applications/<private>.app ] || command -v <private>script >/dev/null 2>&1 || app_by_id com.<private>.<private> com.<private>.<private>; }
EXCLUDED=()
has_dash    || EXCLUDED+=(dash-docsets)
has_<private> || EXCLUDED+=(<private-plugin>)
EXCLUDED+=(preview-identity)   # dev-overlay only, never in a live profile (install-plugins.sh omits it too)
excluded() { case " ${EXCLUDED[*]} " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# ===========================================================================
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
# ts_field state|login|dns over `tailscale status --self --json` (empty on any failure). python3 (Command Line
# Tools) rather than node: this runs before brew node exists on a fresh machine.
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
ts_state() { ts_field state; }                                              # Running | Stopped | NeedsLogin | NeedsMachineAuth | NoState | ""
ts_login() { ts_field login; }                                              # e.g. user@example.com
ts_dns()   { ts_field dns; }
ts_ready() { [ "$(ts_state)" = Running ] && [ -n "$(ts_login)" ] && [ -n "$(ts_dns)" ]; }

if wants tailscale; then
  banner "Tailscale (required): installed, connected, logged in"
  # 1. Installed?
  if [ ! -x "$TS" ]; then
    warn "Tailscale.app is not installed. DSH's tailnet route, the Dock app and the remotes all depend on it."
    if have_brew && confirm "Install Tailscale now (brew install --cask tailscale-app)?" y; then
      run brew install --cask tailscale-app || die "Tailscale install failed — install it from https://tailscale.com/download/mac, log in, then re-run"
    else
      die "Install Tailscale (https://tailscale.com/download/mac or: brew install --cask tailscale-app), log in as the same tailnet user as your other DSH Macs, then re-run this script."
    fi
    [ -x "$TS" ] || [ "$DRY" = 1 ] || die "Tailscale.app still missing after the install"
  fi
  if [ "$DRY" = 1 ] && [ ! -x "$TS" ]; then log "would connect/log in Tailscale and require a tailnet login"
  else
    # 2. The GUI app must be running for its CLI to talk to the backend (it is a network extension owned by the app).
    pgrep -xq Tailscale || { [ "$DRY" = 1 ] || { open -ga Tailscale 2>/dev/null || true; sleep 4; }; }
    state="$(ts_state)"
    log "backend state: ${state:-unknown} $( [ -n "$(ts_login)" ] && echo "(login $(ts_login))" )"
    if [ "$DRY" = 0 ] && ! ts_ready; then
      case "$state" in
        Stopped)
          # Logged in but disconnected: reconnect on the command line.
          log "Tailscale is logged in but disconnected — connecting (tailscale up)"
          "$TS" up --timeout 60s 2>&1 | sed 's/^/    │ /' || true ;;
        NeedsLogin|NoState|""|*)
          warn "Tailscale is not logged in. Log in as the SAME tailnet user as your other DSH Macs (the ACL only lets a user reach their own devices)."
          # `tailscale up` prints the auth URL and blocks until the browser login completes; run it in the
          # background, surface (and open) the URL, and poll the backend state.
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
      # NeedsMachineAuth: the tailnet admin must approve this device first.
      [ "$(ts_state)" = NeedsMachineAuth ] && warn "this device needs approval by the tailnet admin (Machines → Approve) before it is usable"
    fi
    if ts_ready; then ok "Tailscale connected: $(ts_dns) as $(ts_login)"
    elif [ "$DRY" = 1 ]; then warn "a real run would ABORT here: Tailscale is not connected with a tailnet login (state: ${state:-unknown})"
    else die "Tailscale is not connected with a tailnet login (state: $(ts_state), login: '$(ts_login)'). Open Tailscale.app, log in as the same user as your other DSH Macs, wait until it shows Connected, then re-run this script."; fi
  fi
fi

# ===========================================================================
if wants clone; then
  banner "Clone tali-dash-plugins (fork inside as the submodule deepseek-harness/)"
  [ -n "$DIR" ] || ask DIR "Directory for the checkout" "$HOME/github/tali-dash-plugins"
  DIR="${DIR/#\~/$HOME}"
  if [ -d "$DIR/.git" ] || [ -f "$DIR/.git" ]; then
    ok "existing clone at $DIR — adopting it"
    # A redeploy means "the current main": fast-forward when that is possible, leave local work alone otherwise.
    # (Local modifications such as the re-pointed cordis.dev.yml do not block a fast-forward; a real
    # divergence or a conflicting local edit does, and then we keep what is checked out.)
    if [ "$DRY" = 0 ]; then
      if ! git -C "$DIR" pull --ff-only -q 2>>"$LOG"; then warn "could not fast-forward $DIR (diverged from origin, or local edits conflict) — continuing with what is checked out"; fi
      ok "$DIR at $(git -C "$DIR" log -1 --format='%h %s' 2>/dev/null)"
    fi
  else
    log "cloning $REPO → $DIR (a few minutes; the fork comes next as a submodule)"
    [ "$DRY" = 1 ] || mkdir -p "$(dirname "$DIR")"
    run git clone "$REPO" "$DIR" || die "clone failed"
  fi
  # .gitmodules points at the fork over ssh (git@github.com:…), which needs a GitHub key on this Mac —
  # a fresh machine has none (<remote>: "Host key verification failed"). The fork is public, so fetch the
  # submodule over https by overriding the URL in this clone's config only; .gitmodules stays as is.
  if [ "$DRY" = 0 ] || [ -d "$DIR/.git" ]; then
    [ "$DRY" = 1 ] || git -C "$DIR" submodule init >/dev/null 2>&1 || true
    for name in $(git -C "$DIR" config -f .gitmodules --name-only --get-regexp 'submodule\..*\.url' 2>/dev/null | sed -E 's/^submodule\.(.*)\.url$/\1/'); do
      sshurl="$(git -C "$DIR" config -f .gitmodules --get "submodule.$name.url" || true)"
      case "$sshurl" in
        git@github.com:*)
          https="https://github.com/${sshurl#git@github.com:}"
          log "submodule $name: fetching over https ($https) instead of ssh"
          [ "$DRY" = 1 ] || git -C "$DIR" config "submodule.$name.url" "$https" ;;
      esac
    done
  fi
  run git -C "$DIR" submodule update --init || die "submodule checkout failed"
  # A freshly cloned submodule keeps `core.worktree` in its common config (.git/modules/<name>/config).
  # The fork's pnpm postinstall (scripts/install-lefthook.mjs) refuses that layout — and pnpm re-runs the
  # postinstall before EVERY `pnpm dsh …` (verify-deps-before-run), so nothing in the fork would work.
  # Do the migration its error message asks for: repository format 1, extensions.worktreeConfig, and
  # core.worktree moved into config.worktree. (the maintainer's own submodule has an embedded .git dir and no
  # core.worktree, which is why this never showed up there.)
  if [ "$DRY" = 0 ]; then
    for sub in $(git -C "$DIR" submodule --quiet foreach 'echo $sm_path' 2>/dev/null); do
      gd="$(git -C "$DIR/$sub" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
      [ -n "$gd" ] || continue
      wt="$(git config --file "$gd/config" core.worktree 2>/dev/null || true)"
      if [ -n "$wt" ]; then
        git config --file "$gd/config" core.repositoryFormatVersion 1
        git config --file "$gd/config" extensions.worktreeConfig true
        git config --file "$gd/config" --unset core.worktree
        git config --file "$gd/config.worktree" core.worktree "$wt"
        ok "submodule $sub: core.worktree moved to config.worktree (repository format 1, extensions.worktreeConfig)"
      fi
    done
  fi
else
  [ -n "$DIR" ] || DIR="$HOME/github/tali-dash-plugins"; DIR="${DIR/#\~/$HOME}"
fi
CK="$DIR/deepseek-harness"
[ "$DRY" = 1 ] || [ -f "$CK/package.json" ] || die "fork submodule not present at $CK (run the clone step)"

# ===========================================================================
if wants fork; then
  banner "Build the DSH fork ($CK)"
  if [ "$REBUILD" = 0 ] && [ -f "$CK/apps/cli/lib/bin.js" ] && [ -d "$CK/node_modules" ]; then
    ok "already built (apps/cli/lib/bin.js exists; --rebuild to force)"
  else
    log "pnpm install (the fork pins pnpm via packageManager; pnpm fetches that version itself)"
    if [ "$DRY" = 1 ] && [ ! -d "$CK" ]; then log "would run pnpm install && pnpm run build in $CK"; else
    (cd "$CK" && runq pnpm install) || die "pnpm install failed in $CK"
    log "pnpm run build (~2 minutes)"
    (cd "$CK" && runq pnpm run build) || die "fork build failed"
    [ -f "$CK/apps/cli/lib/bin.js" ] || die "build reported success but $CK/apps/cli/lib/bin.js is missing"
    fi
    ok "built"
  fi
fi

# ===========================================================================
if wants plugins; then
  banner "Install + build the plugins ($DIR/plugins)"
  # The dev overlay is the one file with absolute paths; harmless to fix even if unused.
  if [ -f "$DIR/cordis.dev.yml" ] && grep -q '/Users/USER/github/tali-dash-plugins' "$DIR/cordis.dev.yml" && [ "$DIR" != /Users/USER/github/tali-dash-plugins ]; then
    [ "$DRY" = 1 ] || sed -i '' "s#/Users/USER/github/tali-dash-plugins#$DIR#g" "$DIR/cordis.dev.yml"
    ok "cordis.dev.yml re-pointed at $DIR"
  fi
  for pdir in "$DIR"/plugins/*/; do
    p="$(basename "$pdir")"; [ -f "$pdir/package.json" ] || continue
    if excluded "$p"; then
      case "$p" in
        dash-docsets) warn "$p skipped — Dash.app (paid) is not installed" ;;
        <private-plugin>) warn "$p skipped — <private>.app / <private>.app (paid) is not installed" ;;
        *) log "$p skipped (not a live-profile plugin)" ;;
      esac
      continue
    fi
    ndeps="$(pkg_field "$pdir" 'Object.keys({...(p.dependencies??{}),...(p.devDependencies??{})}).length' || echo 0)"
    isclient="$(pkg_field "$pdir" 'p.dsh?.client ? "yes" : ""' || true)"
    hasbuild="$(pkg_field "$pdir" 'p.scripts?.build ? "yes" : ""' || true)"
    if [ "$ndeps" != 0 ] && { [ ! -d "$pdir/node_modules" ] || [ "$REBUILD" = 1 ]; }; then
      # pnpm ≥ 12 makes ignored dependency build scripts (esbuild, sharp) a hard error instead of a warning;
      # the plugins pin no pnpm, so brew's latest runs here. Allow builds for these small trees.
      (cd "$pdir" && runq pnpm install --config.dangerouslyAllowAllBuilds=true) || die "pnpm install failed in plugins/$p"
    fi
    if [ -n "$hasbuild" ] && { [ ! -f "$pdir/lib/client.js" ] || [ "$REBUILD" = 1 ]; }; then
      (cd "$pdir" && runq pnpm build) || die "build failed in plugins/$p"
    fi
    if [ -n "$isclient" ] && [ ! -f "$pdir/lib/client.js" ] && [ "$DRY" = 0 ]; then die "plugins/$p is a client plugin without lib/client.js"; fi
    ok "$p"
  done
fi

# ===========================================================================
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
if wants home; then
  banner "Initialise the DSH home ($DSH_HOME_DIR)"
  if [ -f "$DSH_HOME_DIR/profiles/web/cordis.patch.yml" ]; then ok "web profile exists"
  elif [ "$DRY" = 1 ]; then log "would launch dsh web once to create $DSH_HOME_DIR/profiles/web"
  else
    if curl -s -o /dev/null --max-time 2 http://127.0.0.1:3080/; then die "something already listens on :3080 — stop it, then re-run (--only home)"; fi
    log "first launch of dsh web (creates profiles/web/cordis.patch.yml and .credentials.yaml), then stopping it"
    (cd "$CK" && pnpm dsh web --no-open --port 3080 >>"$LOG" 2>&1 &)
    wait_http http://127.0.0.1:3080/ 401 90 || die "dsh web did not come up within 90 s (see $LOG)"
    # Stop exactly the process listening on :3080 (never a pkill by name — another DSH may be running).
    lsof -ti tcp:3080 -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
    sleep 2
    [ -f "$DSH_HOME_DIR/profiles/web/cordis.patch.yml" ] || die "profile not created"
    ok "home initialised"
  fi
  # A fresh home has an empty .credentials.yaml (a comment header only); a --replace host keeps its keys.
  if ! grep -qsE '^[^#[:space:]]' "$DSH_HOME_DIR/.credentials.yaml" 2>/dev/null; then
    todo "add at least one cloud provider + key in the GUI (Settings → Providers); keys go to $DSH_HOME_DIR/.credentials.yaml"
  else ok "credentials present in $DSH_HOME_DIR/.credentials.yaml"; fi
fi

# ===========================================================================
if wants install-plugins; then
  banner "Install the plugins into the web profile as bundles"
  [ -x "$DIR/tools/install-plugins.sh" ] || [ "$DRY" = 1 ] || die "tools/install-plugins.sh missing in $DIR"
  WITHOUT=""
  for p in "${EXCLUDED[@]}"; do [ "$p" = preview-identity ] || WITHOUT="$WITHOUT,$p"; done
  WITHOUT="${WITHOUT#,}"
  IP_ARGS=(--checkout "$CK"); [ -z "$WITHOUT" ] || IP_ARGS+=(--without "$WITHOUT")
  if [ "$DRY" = 1 ] && [ ! -d "$DIR" ]; then log "would run tools/install-plugins.sh ${IP_ARGS[*]}"
  else (cd "$DIR" && run tools/install-plugins.sh "${IP_ARGS[@]}") || die "install-plugins failed"; fi
  has_dash    || todo "if you buy Dash later: install it, then re-run: pnpm install-plugins (adds the dash_* tools)"
  has_<private> || todo "if you install <private>/<private> later: re-run pnpm install-plugins (adds the <private>_* tools)"
fi

# ===========================================================================
if wants preset; then
  banner "User preset minimal-no-tools (used by the Apple rule; harmless otherwise)"
  PRESET="$DSH_HOME_DIR/.agent-presets/minimal-no-tools"
  if [ -f "$PRESET/agent.cordis.yml" ]; then ok "present"
  elif [ "$DRY" = 1 ]; then log "would write $PRESET/{preset.yml,agent.cordis.yml}"
  else
    mkdir -p "$PRESET"
    cat >"$PRESET/preset.yml" <<'EOF'
name: Minimal (no tools)
description: Chat-only composition for tiny local models — a one-line persona, no tools, no runtime context. Pairs with small context windows (e.g. Apple Foundation on-device).
order: 4
EOF
    cat >"$PRESET/agent.cordis.yml" <<'EOF'
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: You are a helpful, concise assistant.
    complete: true
    includeRuntimeContext: false
EOF
    ok "written"
  fi
fi

# ===========================================================================
if wants apple && [ "$APPLE" = 1 ]; then
  banner "Apple on-device model: afm + the apple provider"
  MAJOR="$(macos_major)"
  if [ "$MAJOR" -lt 26 ]; then warn "macOS < 26: no FoundationModels — skipped"
  else
    have_brew || die "Homebrew missing"
    if command -v afm >/dev/null 2>&1; then ok "afm present: $(afm --version 2>/dev/null | head -1)"
    else
      # Homebrew ≥ 6 refuses untrusted third-party taps.
      brew trust scouzi1966/afm >/dev/null 2>&1 || true
      if [ "$MAJOR" -ge 27 ]; then
        run brew install scouzi1966/afm/afm || warn "afm install failed"
      else
        # macOS 26.x: stable ≥ 0.9.17 needs the Swift 6.4 runtime → pin 0.9.10 and fix its metallib packaging bug.
        run brew install scouzi1966/afm/afm@0.9.10 || warn "afm@0.9.10 install failed"
        if [ "$DRY" = 0 ] && [ -d /opt/homebrew/Cellar/afm@0.9.10/0.9.10 ]; then
          brew link afm@0.9.10 >/dev/null 2>&1 || true
          KEG=/opt/homebrew/Cellar/afm@0.9.10/0.9.10
          ln -sfn "$KEG/libexec/MacLocalAPI_MacLocalAPI.bundle" /opt/homebrew/bin/mlx-swift_Cmlx.bundle
          ln -sfn ../libexec/MacLocalAPI_MacLocalAPI.bundle "$KEG/bin/mlx-swift_Cmlx.bundle"
        fi
      fi
    fi
    # settings.yaml: add the apple provider under llm-pi-ai.providers (merge, never overwrite other keys).
    SETTINGS="$DSH_HOME_DIR/settings.yaml"
    YAMLPKG="$(ls -d "$CK"/node_modules/.pnpm/yaml@*/node_modules/yaml 2>/dev/null | sort -V | tail -1 || true)"   # `|| true`: under set -e a failing substitution in an assignment exits silently
    if [ "$DRY" = 1 ]; then log "would merge the apple provider into $SETTINGS"
    elif [ -z "$YAMLPKG" ]; then warn "no yaml package in the checkout; add the apple provider to $SETTINGS by hand (INSTALLING.md C3)"
    else
      node - "$SETTINGS" "$YAMLPKG" <<'JS'
const fs = require('fs'); const [file, yamlPath] = process.argv.slice(2);
const YAML = require(yamlPath);
const doc = fs.existsSync(file) ? (YAML.parse(fs.readFileSync(file, 'utf8')) ?? {}) : {};
doc['llm-pi-ai'] ??= {}; doc['llm-pi-ai'].providers ??= {};
if (doc['llm-pi-ai'].providers.apple) { console.log('    apple provider already configured'); process.exit(0); }
doc['llm-pi-ai'].providers.apple = {
  displayName: 'Apple Foundation', api: 'openai-completions', baseURL: 'http://127.0.0.1:9997/v1',
  headers: { Authorization: 'Bearer x' },
  compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
  models: [{ id: 'foundation', name: 'Apple Foundation (on-device)', contextWindow: 16384, maxTokens: 1024 }],
};
fs.writeFileSync(file, YAML.stringify(doc)); console.log('    apple provider written to ' + file);
JS
    fi
    if command -v afm >/dev/null 2>&1 && [ "$DRY" = 0 ]; then
      log "smoke test: afm --port 9997"
      (afm --port 9997 >"$LOGDIR/afm-smoke.log" 2>&1 &)
      sleep 4
      if curl -s --max-time 5 http://127.0.0.1:9997/v1/models >/dev/null; then
        R="$(curl -s --max-time 30 http://127.0.0.1:9997/v1/chat/completions -H 'content-type: application/json' -H 'authorization: Bearer x' \
          -d '{"model":"foundation","messages":[{"role":"user","content":"Reply with exactly: ok"}],"max_tokens":20}' || true)"
        case "$R" in
          *"not enabled"*) todo "System Settings → Apple Intelligence & Siri → enable, and wait for the model download (afm says: Apple Intelligence is not enabled)" ;;
          *'"content"'*) ok "afm answers" ;;
          *) warn "afm answered unexpectedly: ${R:0:200}" ;;
        esac
      else warn "afm did not start (see $LOGDIR/afm-smoke.log)"; fi
      pkill -f 'afm --port 9997' 2>/dev/null || true
    fi
  fi
fi

# ===========================================================================
RELAY_LABEL=io.github.taliesinb.dsh-web-relay
if wants tailnet && [ "$TAILNET" = 1 ]; then
  banner "Tailnet layer: relay LaunchAgent, tailscale serve route, Dock app"
  if [ "$DRY" = 0 ] && ! ts_ready; then
    die "Tailscale is no longer connected (state: $(ts_state)) — reconnect, then re-run: $0 --dir $DIR --only tailnet"
  fi
  if [ "$DRY" = 1 ]; then log "would install the relay, enable the route, build the Dock app"; fi
  {
      PLUG="$DIR/plugins/dsh-tailscale-remote"
      # 2. Relay LaunchAgent (:3083 → :3084; starts `dsh web` on demand).
      if launchctl print "gui/$(id -u)/$RELAY_LABEL" >/dev/null 2>&1; then ok "relay LaunchAgent present"
      else run_in "$PLUG" pnpm relay:install --cwd "$CK" --start "pnpm dsh web --no-open" || die "relay:install failed"; fi
      # 3. Enable the route: the plugin republishes `tailscale serve … --set-path /dsh` on every boot from this state file.
      STATE="$DSH_HOME_DIR/tailscale-remote.json"
      if [ "$DRY" = 1 ]; then log "would write $STATE (enabled: true) and start the relay"
      else
        SELF_LOGIN="$(ts_login)"
        node - "$STATE" "$SELF_LOGIN" <<'JS'
const fs = require('fs'); const [file, login] = process.argv.slice(2);
let s = {}; try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
s.version = 1; s.enabled = true;
s.allowedUsers = [...new Set([...(s.allowedUsers ?? []), ...(login ? [login.toLowerCase()] : [])])];
if (!/^[A-Za-z0-9_-]{16,}$/.test(s.token ?? '')) s.token = require('crypto').randomBytes(24).toString('base64url');
fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 }); fs.chmodSync(file, 0o600);
console.log('    tailscale-remote.json: enabled, allowed users ' + JSON.stringify(s.allowedUsers));
JS
        launchctl kickstart -k "gui/$(id -u)/$RELAY_LABEL" 2>/dev/null || true
        log "poking the relay (starts dsh web; ~10 s on a cold start)"
        curl -s -o /dev/null --max-time 5 http://127.0.0.1:3083/ || true
        wait_http http://127.0.0.1:3083/ 401 120 || die "DSH did not come up behind the relay (logs: $DSH_HOME_DIR/logs/{relay,dsh-web}.log)"
        ok "dsh web is up behind the relay (:3083 → :3084 → :3080)"
        for _ in $(seq 1 30); do "$TS" serve status 2>/dev/null | grep -q '/dsh' && break; sleep 1; done
        "$TS" serve status 2>/dev/null | grep -q '/dsh' && ok "tailscale serve publishes /dsh" || warn "no /dsh in tailscale serve status yet (MagicDNS + HTTPS certs must be enabled on the tailnet; see Settings → Tailscale remote)"
      fi
      # 4. Dock app (needs swiftc). Rebuilt on --replace: a deploy-remote.sh app points its fallback at :3084, ours at the relay (:3083).
      if [ -d "$HOME/Applications/DSH.app" ] && [ "$REPLACE" = 0 ]; then ok "Dock app present: ~/Applications/DSH.app"
      elif xcrun --find swiftc >/dev/null 2>&1; then
        run_in "$PLUG" pnpm dock-app:install --name DSH --fallback http://127.0.0.1:3083/ || warn "Dock app install failed (Settings → Tailscale remote → Install Dock app works too)"
      else todo "install the Command Line Tools, then: cd $PLUG && pnpm dock-app:install --name DSH --fallback http://127.0.0.1:3083/"; fi
  }
fi

# ===========================================================================
if wants verify; then
  banner "Verification"
  if [ "$DRY" = 0 ]; then
    for u in http://127.0.0.1:3080/ http://127.0.0.1:3083/; do
      code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$u" || true)"
      case "$code" in 401) ok "$u → 401 (alive, auth wall)" ;; 000) warn "$u → nothing listening" ;; *) warn "$u → HTTP $code" ;; esac
    done
    n="$(cd "$CK" && pnpm dsh --profile web --dump-config 2>/dev/null | grep -cE '^- id: tali-' || true)"
    # Every live bundle inserts one `tali-` row: count the plugins that have a bundle patch, minus the app-gated ones.
    expected=0
    for pdir in "$DIR"/plugins/*/; do
      p="$(basename "$pdir")"; excluded "$p" && continue
      [ -n "$(pkg_field "$pdir" 'p.dsh?.bundle?.patch ?? ""' || true)" ] && expected=$((expected+1))
    done
    [ "${n:-0}" -ge "$expected" ] && ok "$n tali- rows composed in the web profile" || warn "only ${n:-0} tali- rows composed (expected ≥ $expected)"
    if [ -x "$TS" ]; then
      DNS="$("$TS" status --self --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).Self.DNSName.replace(/\.$/,""))}catch{}})' 2>/dev/null || true)"
      if [ -n "$DNS" ]; then
        code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$DNS/dsh/" || true)"
        case "$code" in 200|303) ok "https://$DNS/dsh/ → $code (admitted by identity)" ;; 401) ok "https://$DNS/dsh/ → 401 (route live; you are not on the allowlist from here)" ;; *) warn "https://$DNS/dsh/ → ${code:-000} (cert issuance can take a few seconds on the first hit)" ;; esac
      fi
    fi
    TOKEN_URL="$(grep -o 'http://127.0.0.1:3080/?token=[^ ]*' "$DSH_HOME_DIR/logs/dsh-web.log" 2>/dev/null | tail -1 || true)"
    [ -n "$TOKEN_URL" ] && log "GUI (local, tokened): $TOKEN_URL"
    [ -n "${DNS:-}" ] && log "GUI (tailnet): https://$DNS/dsh/"
  fi
  echo
  if [ ${#TODO[@]} -gt 0 ]; then
    printf '%sStill to do by hand:%s\n' "$BOLD" "$NC"
    for t in "${TODO[@]}"; do printf '  • %s\n' "$t"; done
  fi
  printf '\n%sDone.%s checkout: %s · home: %s · log: %s\n' "$GREEN" "$NC" "$DIR" "$DSH_HOME_DIR" "$LOG"
  echo "Day-to-day: cd $CK && pnpm dsh web   (or just open the DSH Dock app / the relay: http://127.0.0.1:3083/)"
fi
