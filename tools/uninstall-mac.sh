#!/usr/bin/env bash
#
# uninstall-mac.sh — take DSH off this Mac: everything tools/bootstrap-mac.sh
# (or a deploy-remote.sh / stock install) started, launches at login, published
# on the tailnet or put in ~/Applications — while KEEPING ~/.dsh (sessions,
# settings, credentials, tailscale-remote.json) and every git checkout
# (~/github/tali-dash-plugins, ~/.dsh-thin-client). Needs no checkout itself:
# plain shell + launchctl + lsof + the Tailscale CLI + `defaults`.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/taliesinb/dsh-plugins/main/tools/uninstall-mac.sh)" uninstall [--force]
#   # from a clone:  tools/uninstall-mac.sh [--force] [--dry-run]     (pnpm uninstall-dsh)
#
# Flags
#   --force, -f, --yes    no questions: terminate, unload and trash everything found
#   --dry-run             list what would be done, change nothing
#
# Without --force every group of actions is a question ("… is running,
# terminate?", "… move to Trash?", default yes). The word `uninstall` after the
# curl'ed string is bash's $0 placeholder so the flags land in $1…; a lone flag
# there (`… uninstall-mac.sh)" --force`) is understood as well.
#
# What goes (in this order, each group only if present):
#   1. LaunchAgents: io.github.taliesinb.dsh-web-relay[.<instance>] (the relay that starts dsh web at login),
#      ai.symbolica.dsh-remote (deploy-remote.sh), anything else *dsh* / *deepseek* in ~/Library/LaunchAgents —
#      bootout + plist removed.
#   2. Processes of THIS user: the relays, every dsh web/serve (built checkout, stock CLI, Desktop app),
#      the Dock apps, and any remaining listener on 127.0.0.1:3080–3099. Never another account's.
#   3. Tailscale Serve paths this user published (/dsh, /dsh-<instance>, /dsh-preview: the ones whose target
#      port a process of this user was listening on, or that a relay plist of this user names). Never
#      `serve reset`: on a shared machine that would take every other account's route down.
#   4. Apps → Trash (Finder; ~/.Trash as the fallback): ~/Applications/*.app with bundle id
#      io.github.taliesinb.dsh-dock-app* (DSH, DSH Preview, DSH-<instance>, the blue thin clients DSH <Host>),
#      Safari "Add to Dock" web apps named DSH*, the stock Desktop app (/Applications/DSH.app, *deepseek*
#      bundle ids); their Dock tiles are dropped; Launch Services unregistered.
#   5. A global `dsh` CLI (npm / pnpm / bun / Homebrew), the relay symlinks in
#      ~/Library/Application Support/dsh-tailscale-remote, and — asked separately, it is 1.7 GB and not a
#      git clone — the deploy-remote.sh tree ~/dsh.
# What stays, on purpose: ~/.dsh (incl. bootstrap-mac.json, logs/, deploy/), ~/.dsh-preview, the checkouts,
# ~/.dsh-thin-client, Homebrew and its formulae/casks (node, pnpm, afm, Tailscale, Safari Technology Preview,
# Chrome), ~/.zprofile, the Command Line Tools, ~/Library/Logs/DSH Dock. Reinstall any time with the bootstrap.
set -euo pipefail

FORCE=0
DRY=0
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
case "$0" in --*) set -- "$0" "$@" ;; esac   # `bash -c "$(curl …)" --force`: the flag landed in $0
while [ $# -gt 0 ]; do
  case "$1" in
    --force|-f|--yes|-y) FORCE=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) [ -f "$0" ] && sed -n "2,40p" "$0" || echo "usage: uninstall-mac.sh [--force] [--dry-run]"; exit 0 ;;
    *) echo "unknown argument: $1 (try --help)" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
BOLD=$'\033[1m'; BLUE=$'\033[1;34m'; GREEN=$'\033[1;32m'; YELLOW=$'\033[1;33m'; RED=$'\033[1;31m'; DIM=$'\033[2m'; NC=$'\033[0m'
LOGDIR="${TMPDIR:-/tmp}/dsh-bootstrap"; mkdir -p "$LOGDIR"
LOG="$LOGDIR/uninstall-$(date +%Y%m%d-%H%M%S).log"
UID_="$(id -u)"
log()  { printf '%s▸%s %s\n' "$BLUE" "$NC" "$*" | tee -a "$LOG"; }
ok()   { printf '%s✓%s %s\n' "$GREEN" "$NC" "$*" | tee -a "$LOG"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$NC" "$*" | tee -a "$LOG"; }
die()  { printf '%s✖%s %s\n' "$RED" "$NC" "$*" | tee -a "$LOG" >&2; echo "   log: $LOG" >&2; exit 1; }
banner() { printf '\n%s━━ %s ━━%s\n' "$BOLD" "$*" "$NC" | tee -a "$LOG"; }
has_tty() { { : </dev/tty; } 2>/dev/null; }
# confirm "question" → 0 = yes. --force (or no terminal) answers yes; --dry-run only prints the question.
confirm() {
  if [ "$DRY" = 1 ]; then printf '  %s? %s(would ask; assuming yes for the plan)%s\n' "$1" "$DIM" "$NC" | tee -a "$LOG"; return 0; fi
  if [ "$FORCE" = 1 ] || ! has_tty; then printf '  %s? [y] %s(--force)%s\n' "$1" "$DIM" "$NC" | tee -a "$LOG"; return 0; fi
  local a; read -r -p "  $1? [y/n] (y) " a </dev/tty; case "${a:-y}" in y|Y|yes) return 0 ;; *) return 1 ;; esac
}
act() { # act CMD... — run unless --dry-run (then print)
  if [ "$DRY" = 1 ]; then printf '  %swould run:%s %s\n' "$DIM" "$NC" "$*" | tee -a "$LOG"; return 0; fi
  printf '  $ %s\n' "$*" >>"$LOG"; "$@" >>"$LOG" 2>&1
}
my_pids_on_port() { lsof -u "$UID_" -a -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null || true; }
# dsh_pids: this user's processes matching PROC_RE, minus this script's own shells (the script text names
# every pattern; under `bash -c "$(curl …)"` it IS the argv — macOS ps/pgrep hide such long argvs, but do not rely on it).
dsh_pids() {
  local pid
  for pid in $(pgrep -a -u "$UID_" -f "$PROC_RE" 2>/dev/null || true); do   # -a: ancestors too (a DSH agent running this)
    [ "$pid" = "$$" ] && continue
    cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
    case "$cmd" in ""|*uninstall-mac*) continue ;; esac   # "": an argv too long for ps = a `bash -c "<script>"` shell, never a DSH process
    echo "$pid"
  done
}
bundle_id() { defaults read "$1/Contents/Info.plist" CFBundleIdentifier 2>/dev/null || true; }
# trash PATH: Finder "move to Trash" (Put Back works), else mv into ~/.Trash (deduplicated name).
trash() {
  local p="$1" base dest n=1
  [ -e "$p" ] || return 0
  if osascript -e "tell application \"Finder\" to delete (POSIX file \"$p\" as alias)" >>"$LOG" 2>&1; then return 0; fi
  base="$(basename "$p")"; dest="$HOME/.Trash/$base"
  while [ -e "$dest" ]; do dest="$HOME/.Trash/${base%.*} $n.${base##*.}"; n=$((n+1)); done
  mv "$p" "$dest" 2>>"$LOG" || { warn "could not move $p to the Trash — remove it by hand"; return 1; }
}

echo "${BOLD}DSH uninstall${NC} — log: $LOG"
[ "$(uname -s)" = Darwin ] || die "macOS only"
[ "$UID_" != 0 ] || die "run as the user whose DSH this is, not root"
[ "$DRY" = 1 ] && warn "dry run: nothing will be changed"
[ "$FORCE" = 1 ] && [ "$DRY" = 0 ] && warn "--force: no questions asked"
REMOVED=0

# ===========================================================================
banner "Inventory"
# LaunchAgents (labels from the plist files; a loaded agent without a plist is caught by launchctl below).
AGENTS=()
for pl in "$HOME"/Library/LaunchAgents/*.plist; do
  [ -f "$pl" ] || continue
  case "$(basename "$pl" .plist)" in
    io.github.taliesinb.dsh-*|ai.symbolica.dsh-remote|*deepseek*|*[dD][sS][hH]*) AGENTS+=("$(basename "$pl" .plist)") ;;
  esac
done
for la in io.github.taliesinb.dsh-web-relay ai.symbolica.dsh-remote; do
  case " ${AGENTS[*]-} " in *" $la "*) ;; *) launchctl print "gui/$UID_/$la" >/dev/null 2>&1 && AGENTS+=("$la") ;; esac
done
for la in "${AGENTS[@]-}"; do [ -n "$la" ] && log "LaunchAgent: $la$(launchctl print "gui/$UID_/$la" >/dev/null 2>&1 && echo ' (loaded)')"; done

# Serve paths (read BEFORE anything is stopped: ownership is decided by who listens on the target port).
SERVE_PATHS=()
if [ -x "$TS" ]; then
  RELAY_PORTS="$(grep -ho -- '--listen[^<]*127\.0\.0\.1:[0-9]*' "$HOME"/Library/LaunchAgents/io.github.taliesinb.dsh-*.plist 2>/dev/null | grep -o '[0-9]*$' | tr '\n' ' ' || true)"
  while IFS= read -r line; do
    p="$(printf '%s' "$line" | sed -nE 's#^\|--[[:space:]]+(/dsh[^[:space:]]*)[[:space:]]+proxy[[:space:]]+http://127\.0\.0\.1:([0-9]+).*#\1 \2#p')"
    [ -n "$p" ] || continue
    path="${p% *}"; port="${p#* }"
    if [ -n "$(my_pids_on_port "$port")" ] || case " $RELAY_PORTS " in *" $port "*) true ;; *) false ;; esac; then
      SERVE_PATHS+=("$path"); log "Tailscale Serve path: $path → 127.0.0.1:$port (yours)"
    else log "Tailscale Serve path: $path → 127.0.0.1:$port (not yours — another account's; left alone)"; fi
  done < <("$TS" serve status 2>/dev/null || true)
fi

# Apps.
APPS=()
for app in "$HOME"/Applications/*.app /Applications/DSH.app; do
  [ -d "$app" ] || continue
  bid="$(bundle_id "$app")"
  case "$bid" in
    io.github.taliesinb.dsh-dock-app*|*deepseek*) ;;
    com.apple.Safari.WebApp*) case "$(basename "$app")" in DSH*) ;; *) continue ;; esac ;;
    *) case "$(basename "$app")" in DSH.app) ;; *) continue ;; esac ;;
  esac
  APPS+=("$app"); log "app: $app ($bid)"
done

# Processes and listeners (this user's only).
PROC_RE='dsh-tailscale-remote/dsh-web-relay|apps/cli/(lib/bin\.js|src/bin\.ts)|dsh (web|serve)|@deepseek-ai/dsh|dsh/(lib|src)/bin\.(js|ts)|DSH[^/]*\.app/Contents/MacOS/'
PIDS="$(dsh_pids | tr '\n' ' ')"
for pid in $PIDS; do log "process $pid: $(ps -o command= -p "$pid" 2>/dev/null | cut -c1-90)"; done
LISTEN_PORTS=""
for port in $(seq 3080 3099); do [ -n "$(my_pids_on_port "$port")" ] && LISTEN_PORTS="$LISTEN_PORTS $port"; done
LISTEN_PORTS="${LISTEN_PORTS# }"; [ -z "$LISTEN_PORTS" ] || log "listening on 127.0.0.1:{${LISTEN_PORTS// /,}}"

DSH_BIN="$(command -v dsh 2>/dev/null || true)"; [ -z "$DSH_BIN" ] || log "global dsh CLI: $DSH_BIN"
SUPPORT="$HOME/Library/Application Support/dsh-tailscale-remote"; [ -d "$SUPPORT" ] && log "relay symlinks: $SUPPORT"
DEPLOY=""; [ -f "$HOME/dsh/checkout/apps/cli/lib/bin.js" ] && { DEPLOY="$HOME/dsh"; log "deploy-remote.sh tree: ~/dsh ($(du -sh "$HOME/dsh" 2>/dev/null | cut -f1))"; }

if [ ${#AGENTS[@]} = 0 ] && [ ${#SERVE_PATHS[@]} = 0 ] && [ ${#APPS[@]} = 0 ] && [ -z "$PIDS" ] && [ -z "$LISTEN_PORTS" ] && [ -z "$DSH_BIN" ] && [ ! -d "$SUPPORT" ] && [ -z "$DEPLOY" ]; then
  ok "nothing of DSH is installed or running for $USER on this Mac"; exit 0
fi

# ===========================================================================
if [ ${#AGENTS[@]} -gt 0 ]; then
  banner "Launch-at-login agents"
  if confirm "${#AGENTS[@]} DSH LaunchAgent(s) start DSH at login (${AGENTS[*]}) — unload and remove"; then
    for la in "${AGENTS[@]}"; do
      act launchctl bootout "gui/$UID_/$la" || true
      [ -f "$HOME/Library/LaunchAgents/$la.plist" ] && { act rm -f "$HOME/Library/LaunchAgents/$la.plist" || true; }
      ok "$la unloaded and removed"
    done
    REMOVED=1
  else warn "LaunchAgents kept — DSH will start again at the next login"; fi
fi

# ===========================================================================
if [ -n "$PIDS" ] || [ -n "$LISTEN_PORTS" ]; then
  banner "Running DSH"
  n="$(echo $PIDS | wc -w | tr -d ' ')"
  if confirm "$n DSH process(es) of yours are running${LISTEN_PORTS:+ (listening on $LISTEN_PORTS)} — terminate"; then
    # Dock apps first (a clean quit), then everything else; listeners last in case something re-spawned.
    for app in "${APPS[@]-}"; do
      [ -n "$app" ] || continue
      bid="$(bundle_id "$app")"
      pgrep -u "$UID_" -f "$app/Contents/MacOS/" >/dev/null 2>&1 || continue
      [ "$DRY" = 1 ] || { [ -z "$bid" ] || osascript -e "tell application id \"$bid\" to quit" >/dev/null 2>&1 || true; }
      act pkill -u "$UID_" -f "$app/Contents/MacOS/" || true
    done
    for pid in $PIDS; do kill -0 "$pid" 2>/dev/null && { act kill "$pid" || true; }; done
    if [ "$DRY" = 0 ]; then
      for _ in $(seq 1 20); do [ -n "$(dsh_pids)" ] || break; sleep 1; done
      left="$(dsh_pids)"; [ -z "$left" ] || kill -9 $left 2>/dev/null || true
    fi
    for port in $LISTEN_PORTS; do pids="$(my_pids_on_port "$port")"; [ -z "$pids" ] || { act kill $pids || true; }; done
    if [ "$DRY" = 0 ]; then
      sleep 1
      left=""; for port in $(seq 3080 3099); do [ -n "$(my_pids_on_port "$port")" ] && left="$left $port"; done
      [ -z "$left" ] && ok "all DSH processes stopped" || die "something of yours still listens on$left — stop it by hand and re-run"
    fi
    REMOVED=1
  else warn "processes left running"; fi
fi

# ===========================================================================
if [ ${#SERVE_PATHS[@]} -gt 0 ]; then
  banner "Tailscale Serve routes"
  if confirm "${#SERVE_PATHS[@]} tailnet route(s) of yours are published (${SERVE_PATHS[*]}) — remove"; then
    for path in "${SERVE_PATHS[@]}"; do
      act "$TS" serve --https=443 --set-path="$path" off && ok "$path removed" || warn "tailscale serve … off failed for $path — check 'tailscale serve status'"
    done
    REMOVED=1
  else warn "routes kept (they answer nothing while DSH is stopped)"; fi
fi

# ===========================================================================
if [ ${#APPS[@]} -gt 0 ]; then
  banner "Apps → Trash"
  if confirm "${#APPS[@]} app(s): $(for a in "${APPS[@]}"; do printf '%s ' "$(basename "$a")"; done)— move to the Trash (and drop their Dock tiles)"; then
    LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
    for app in "${APPS[@]}"; do
      bid="$(bundle_id "$app")"
      [ "$DRY" = 1 ] || { [ -z "$bid" ] || osascript -e "tell application id \"$bid\" to quit" >/dev/null 2>&1 || true; pkill -u "$UID_" -f "$app/Contents/MacOS/" 2>/dev/null || true; }
      [ "$DRY" = 1 ] || "$LSREG" -u "$app" >/dev/null 2>&1 || true
      if [ "$DRY" = 1 ]; then log "would move $app to the Trash"; else trash "$app" && ok "$(basename "$app") → Trash"; fi
    done
    # Dock tiles pointing at those paths (they would turn into "?" tiles). python3 comes with the CLT.
    if [ "$DRY" = 1 ]; then log "would drop the Dock tiles of: ${APPS[*]}"
    elif xcode-select -p >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then
      TMPPL="$(mktemp)"
      # exit 3 = no tile matched (nothing to write); any other failure is logged and reported as a warning.
      if defaults export com.apple.dock - 2>/dev/null | OUT="$TMPPL" python3 -c '
import os, plistlib, sys, urllib.parse
targets = {a.rstrip("/") for a in sys.argv[1:]}
d = plistlib.loads(sys.stdin.buffer.read())
apps = d.get("persistent-apps", [])
def path(item):
    u = ((item.get("tile-data") or {}).get("file-data") or {}).get("_CFURLString", "")
    return urllib.parse.unquote(u[len("file://"):] if u.startswith("file://") else u).rstrip("/")
kept = [i for i in apps if path(i) not in targets]
if len(kept) == len(apps): sys.exit(3)
d["persistent-apps"] = kept
with open(os.environ["OUT"], "wb") as f: plistlib.dump(d, f)
print(len(apps) - len(kept))' "${APPS[@]}" >"$TMPPL.n" 2>>"$LOG"; then
        if defaults import com.apple.dock "$TMPPL" 2>>"$LOG"; then killall Dock 2>/dev/null || true; ok "$(cat "$TMPPL.n") Dock tile(s) removed"
        else warn "could not write the Dock preferences — drag the leftover '?' tiles off the Dock"; fi
      elif [ "${PIPESTATUS[1]}" = 3 ]; then log "no Dock tiles pointed at those apps"
      else warn "could not edit the Dock tiles (see $LOG) — drag the leftover '?' tiles off the Dock"; fi
      rm -f "$TMPPL" "$TMPPL.n"
    else warn "python3 not available (no Command Line Tools) — remove the leftover '?' Dock tiles by hand"; fi
    REMOVED=1
  else warn "apps kept"; fi
fi

# ===========================================================================
if [ -n "$DSH_BIN" ]; then
  banner "Global dsh CLI"
  if confirm "a global dsh CLI is installed at $DSH_BIN — uninstall"; then
    act npm uninstall -g @deepseek-ai/dsh || true
    act pnpm remove -g @deepseek-ai/dsh || true
    act bun remove -g @deepseek-ai/dsh || true
    act brew uninstall dsh || true
    if [ "$DRY" = 0 ]; then
      [ ! -e "$DSH_BIN" ] || rm -f "$DSH_BIN" 2>/dev/null || warn "could not remove $DSH_BIN — remove it by hand"
      hash -r; if command -v dsh >/dev/null 2>&1; then warn "a 'dsh' is still on PATH: $(command -v dsh)"; else ok "dsh CLI removed"; fi
    fi
    REMOVED=1
  fi
fi
if [ -d "$SUPPORT" ]; then
  banner "Relay support files"
  if confirm "$SUPPORT (the relay's node symlinks) — remove"; then act rm -rf "$SUPPORT" && ok "removed"; REMOVED=1; fi
fi
if [ -n "$DEPLOY" ]; then
  banner "deploy-remote.sh tree"
  if confirm "~/dsh is a deploy-remote.sh install tree (rsynced checkout + plugins + node, not a git clone) — remove"; then
    act rm -rf "$HOME/dsh" && ok "~/dsh removed"; REMOVED=1
  else warn "~/dsh kept"; fi
fi

# ===========================================================================
banner "Done"
[ "$REMOVED" = 1 ] || warn "nothing was removed"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
echo "Kept on purpose: $DSH_HOME_DIR (sessions, settings, credentials, tailscale-remote.json, logs)$( [ -d "$HOME/.dsh-preview" ] && echo ", ~/.dsh-preview" )"
for d in "$HOME/github/tali-dash-plugins" "$HOME/.dsh-thin-client"; do [ -d "$d" ] && echo "                 $d (checkout; rm -rf it yourself if you want it gone)"; done
echo "                 Homebrew + node/pnpm/afm, Tailscale, Safari Technology Preview, Chrome, the Command Line Tools"
echo "Reinstall: bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/taliesinb/dsh-plugins/main/tools/bootstrap-mac.sh)\""
echo "log: $LOG"
