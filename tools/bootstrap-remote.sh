#!/usr/bin/env bash
#
# bootstrap-remote.sh — run tools/bootstrap-mac.sh on another Mac over ssh.
#
#   pnpm bootstrap-remote user@host [bootstrap flags…]
#   pnpm bootstrap-remote user@host --replace            # redeploy a deploy-remote.sh host: stop its
#                                                        # install, keep ~/.dsh, install Path C from scratch
#   pnpm bootstrap-remote user@host --dry-run --replace
#
# How: scp the script to /tmp on the host, then run it there. With a local
# terminal the ssh session gets a tty (-t) so the script can prompt, ask for
# sudo, and print/open the Tailscale login URL; without one (an agent, cron)
# it runs non-interactively with --yes. The script is copied rather than piped
# on stdin on purpose: `bash -s < script` lets any child that reads stdin
# (pnpm, brew, sudo) swallow the rest of the script.
#
# Requirements on the host: key-based ssh (INSTALLING.md A3), the user logged
# in to the GUI (launchctl gui/ domain, the Dock app), Tailscale.app logged in
# as that machine's own user — the script refuses to proceed otherwise.
set -euo pipefail

TARGET="${1:-}"
case "$TARGET" in ""|-h|--help) sed -n '2,20p' "$0"; exit 0 ;; esac
shift
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$HERE/tools/bootstrap-mac.sh"
[ -f "$SCRIPT" ] || { echo "missing $SCRIPT" >&2; exit 1; }

SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10)
"${SSH[@]}" "$TARGET" 'true' || { echo "cannot ssh to $TARGET (key auth required; see INSTALLING.md A3)" >&2; exit 1; }
REMOTE_OS="$("${SSH[@]}" "$TARGET" 'uname -sm')"
[ "$REMOTE_OS" = "Darwin arm64" ] || { echo "$TARGET is $REMOTE_OS; bootstrap-mac.sh needs Darwin arm64" >&2; exit 1; }

scp -q "$SCRIPT" "$TARGET:/tmp/bootstrap-mac.sh"
ARGS=""; for a in "$@"; do ARGS="$ARGS $(printf '%q' "$a")"; done

if [ -t 0 ] && [ -t 1 ]; then
  exec ssh -t "$TARGET" "bash /tmp/bootstrap-mac.sh$ARGS"
else
  case " $* " in *" --yes "*|*" -y "*) ;; *) ARGS=" --yes$ARGS" ;; esac
  exec "${SSH[@]}" "$TARGET" "bash /tmp/bootstrap-mac.sh$ARGS"
fi
