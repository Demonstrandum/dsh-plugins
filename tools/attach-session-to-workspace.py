#!/usr/bin/env python3
"""Attach one existing DSH session to a workspace, in the durable registry.

Why this exists: DSH attaches a session to a workspace only when the session is
*created* (`session-controller` calls `workspace.attachSession` on create/fork),
and no RPC exposes attach for an existing session. The installed
`dsh-import-agents` plugin is the only supported route, via `/attach-workspaces`
— but that command is global: it walks every imported session (id prefixes
`pi-` / `oc-` / `codex-` / `claude-`), creates a workspace per distinct cwd, and
normalizes default-named workspace titles to `name (~/path)`. When you want to
attach exactly one session and leave the rest of the sidebar alone, edit the
registry instead.

IMPORTANT — the running server owns this file. It keeps the document in memory
and rewrites it from that state on any workspace mutation (create, rename,
archive, and every session creation, which attaches). So:

  1. run this while the `dsh web` server is STOPPED, or
  2. run it, then restart the server promptly, and re-run if it got clobbered.

The edit is validated the way the registry validates at startup: written
atomically, no duplicate session account, no duplicate path, order preserved.

Usage:
  python3 attach-session-to-workspace.py --session <sessionId> --workspace <title> [--root ~/.dsh/storages]
  python3 attach-session-to-workspace.py --session claude-4d6f2b87-... --workspace ncatlab
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import shutil
import sys
import tempfile
from datetime import datetime, timezone


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--session', required=True, help='session id to attach')
    ap.add_argument('--workspace', required=True, help='workspace title (exact match)')
    ap.add_argument('--root', default=os.path.expanduser('~/.dsh/storages'))
    ap.add_argument('--no-backup', action='store_true')
    args = ap.parse_args()

    path = os.path.join(args.root, 'workspace.json')
    if not os.path.exists(path):
        fail(f'no registry at {path}')

    doc = json.load(open(path, encoding='utf-8'))
    workspaces = doc['tables']['workspaces']

    matches = [(wid, rec) for wid, rec in workspaces.items() if rec['title'] == args.workspace]
    if len(matches) != 1:
        fail(f'workspace title {args.workspace!r} matched {len(matches)} workspaces; refine it')
    wid, record = matches[0]

    if record['sessionIds'] and record['sessionIds'][0] == args.session:
        if args.session in record['sessionIds']:
            print(f'already attached: {args.session} -> {record["title"]} ({record["path"]})')
            return

    # The registry refuses duplicate session accounts and duplicate paths at
    # startup, and a bad edit breaks the whole sidebar rather than one row.
    owners = [w['title'] for w in workspaces.values() if args.session in w['sessionIds']]
    if owners:
        fail(f'{args.session} is already accounted by workspace(s): {owners}')
    paths = collections.Counter(w['path'] for w in workspaces.values())
    dupes = [p for p, c in paths.items() if c > 1]
    if dupes:
        fail(f'registry already has duplicate workspace paths: {dupes}')
    if set(doc['global']['workspaceIds']) != set(workspaces):
        fail('registry order does not match its table; fix that before editing')

    header = os.path.join(args.root, '..', 'sessions')
    header_file = None
    for project in os.listdir(header):
        candidate = os.path.join(header, project, args.session, 'session.jsonl.zstd')
        if os.path.exists(candidate):
            header_file = candidate
            break
    if header_file is None:
        fail(f'no stored session log for {args.session} under {header}; attach would fail validation')

    if not args.no_backup:
        shutil.copy2(path, f'{path}.bak')
    record['sessionIds'] = [args.session, *record['sessionIds']]
    record['updatedAt'] = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')

    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
    with os.fdopen(fd, 'w', encoding='utf-8') as handle:
        json.dump(doc, handle, indent=2)
        handle.write('\n')
    os.replace(tmp, path)

    print(f'attached {args.session} -> {record["title"]} ({record["path"]})')
    print(f'log         {header_file}')
    print('restart the dsh web server so the registry loads this document')


if __name__ == '__main__':
    main()
