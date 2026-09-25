# tali-import-sessions — host ⇄ browser protocol

Control channel: `POST /import-sessions/<endpoint>` with the same envelope the
other tali plugins use (`reboot-command`, `import-api-keys`), sent through the
client's `connection.rpc.call('/import-sessions', endpoint, { args })`:

```json
{ "type": "client-request", "rpcId": "…", "method": "<endpoint>", "payload": { "args": { … } } }
→ { "type": "server-response", "rpcId": "…", "result": { "ok": true, "value": … } | { "ok": false, "error": { "code": "import-sessions/…", "message": "…", "details": {} } } }
```

All endpoints are POST. `source` is always `'claude' | 'pi'`.

## `sources` — `{}`

```ts
{
  platform: 'darwin' | 'linux' | 'win32' | string,
  pickerAvailable: boolean,          // a native file-or-folder chooser can be shown on the server machine
  sources: {
    claude: { label: 'Claude Code', root: string, defaultRoot: '~/.claude/projects',   exists: boolean },  // root: expanded server path; exists: the server store holds ≥1 workspace
    pi:     { label: 'pi',          root: string, defaultRoot: '~/.pi/agent/sessions', exists: boolean },
  },
  server: { host?: string },                                          // short host name of the server machine
  client: { sameMachine: boolean, host?: string },                    // is this request from the server machine itself (not via the tailnet proxy)? host = tailnet peer name when known
  workspaces: Array<{ id: string, title: string, path: string }>,      // existing DSH workspaces, for destination overrides
  pickerKind: 'file-or-directory' | 'directory' | 'none',            // Linux choosers are directory-only
  defaults: { keepTurns: number, resultCap: number },                 // configured working-mode defaults
}
```

## `pick` — `{ source }`

Opens the native chooser on the server machine, rooted at the source's root,
allowing ONE file or ONE directory. Long-running (resolves when the dialog
closes). `{ path: string | null }` — `null` = cancelled. Fails with
`import-sessions/picker-unavailable` when no chooser exists (client falls back
to its typed-path input).

## `upload-begin` / `upload-chunk` / `upload-finish` / `upload-discard`

For clients whose transcripts live on THEIR device (a remote Dock app (macOS) or DSH Remote (Linux) on
a laptop talking to a shared host). The browser picks a folder or a transcript
with the standard HTML chooser (`<input type="file" webkitdirectory>` for a
folder, `<input type="file" accept=".jsonl">` for one transcript), keeps only
transcript files (see filter below), and streams each one gzipped in base64
chunks. All chunks of one file go in order; files may be sequential.

```ts
upload-begin   { source }                                   → { uploadId, chunkBytes }     // chunkBytes = max RAW bytes per chunk (4 MiB)
upload-chunk   { uploadId, path, data, encoding, offset }   → { bytes }                    // path: relative posix path (below); data: base64 of the (gzipped) bytes; encoding: 'gzip' | 'identity'; offset: bytes of ENCODED data sent before this chunk
upload-finish  { uploadId }                                 → { path, files, bytes }       // path is a server directory: pass it to `scan` as-is
upload-discard { uploadId }                                 → { discarded }                // on cancel / close before import; after `import` with uploadId the server discards it itself
```

Relative `path` rules (the server rejects anything else): keep the chooser's
`webkitRelativePath` MINUS its first segment when the chosen folder is the
store root or a workspace directory… simplest robust rule: send the
`webkitRelativePath` verbatim (it starts with the chosen folder's name); the
server classifies by content, so the wrapper directory is harmless. For a
single transcript send its `name`. Client-side FILTER before uploading:
- claude: `<uuid>.jsonl` at any depth, plus `<uuid>/subagents/agent-*.jsonl`; skip `memory/`, `*.backup`, everything else
- pi: `<ISO-ts>_<uuid>.jsonl`; skip everything else
Show upload progress (files done / total, bytes). `upload-chunk` errors are fatal
for that upload (discard it).

## `scan` — `{ source, path }`

`path` may be the source root, one workspace slug directory, one session
file, or the directory returned by `upload-finish`. The scan READS EVERY
transcript fully (fast: hundreds of MB/s) so counts are exact. Returns a tree:

```ts
{
  source: 'claude' | 'pi',
  path: string,
  kind: 'root' | 'workspace' | 'session',   // what the user selected
  uploaded: boolean,           // the path is an upload: workspace dirs are the CLIENT's, so `new` is rarely offered
  largeTokens: number,         // the configured threshold
  workspaces: Array<{
    key: string,                 // slug directory name (stable row key)
    dir: string,                 // decoded original working directory (from session headers when available)
    dirExists: boolean,
    destination:                 // computed default; the client may override per workspace
      | { kind: 'existing', workspaceId: string, title: string }
      | { kind: 'new', title: string }            // basename(dir); created at import time
      | { kind: 'ungrouped', reason: string },    // e.g. directory no longer exists
    sessions: Array<{
      id: string,                // stable DSH id: `claude-<uuid>` | `pi-<uuid>`
      sourceId: string,          // the source's own id
      file: string,              // absolute path of the transcript
      title: string,             // Claude aiTitle / pi session_info.name / first prompt excerpt / fallback
      startedAt: number,         // epoch ms
      endedAt: number,           // epoch ms (file mtime or last record)
      bytes: number,
      prompts?: number,          // user prompts counted
      turns: number,             // exact turns the import will produce
      toolCalls: number,
      estimatedTokens: number,   // model-visible surface estimate (DSH's token meter)
      large: boolean,            // estimatedTokens > largeTokens → offer the working-session fold
      imported: boolean,         // a DSH session with this id already exists → not selectable
      duplicateOf?: string,      // same sourceId seen earlier in this scan (pi: moved worktrees) → not selectable
      subagents?: number,        // Claude: subagent transcripts that will become child sessions
    }>,
  }>,
}
```

## `import` — `{ source, selections, uploadId? }`

```ts
type Mode =
  | { kind: 'archive' }                                          // full fidelity; a huge one may not be promptable
  | { kind: 'working', keepTurns: number, resultCap: number }    // fold turns before the last keepTurns behind a checkpoint note; cap tool-result text (chars)
selections: Array<{
  file: string,                 // transcript path from `scan`
  destination:                  // final per-session choice (the client resolves the workspace-level select to each session)
    | { kind: 'existing', workspaceId: string }
    | { kind: 'new', dir: string }        // create a workspace at `dir` (`~` ok; mkdir -p if missing) titled basename(dir); the client builds it as `<placement base>/<basename of the original cwd>`
    | { kind: 'ungrouped' }
  mode: Mode,                   // per session: the "large sessions" choice for large ones, {kind:'archive'} for the rest
}>
uploadId?: string               // when the files came from an upload: the server deletes the upload after the job
→ { jobId: string, total: number }
```

## `progress` — `{ jobId }`

```ts
{
  jobId: string,
  total: number,
  done: number,
  current?: { file: string, title: string, phase: 'reading' | 'writing' | 'attaching' },
  finished: boolean,
  results: Array<{
    file: string,
    ok: boolean,
    sessionId?: string,
    title?: string,
    workspace?: { id: string, title: string } | null,   // null = ungrouped
    counts?: {                                         // fidelity report
      turns: number, steps: number, toolCalls: number, toolResults: number,
      images: number, imagesImported: number, truncatedResults: number,
      droppedRecords: number, orphanResults: number, foldedTurns?: number, children?: number,
      surfaceTokens?: number,                          // estimate after any fold
    },
    error?: string,
  }>,
}
```

Jobs live in host memory for 10 minutes after finishing; `progress` for an
unknown job fails with `import-sessions/unknown-job`.

## Client flow

`/import-claude` and `/import-pi` are host slash commands; the browser half
DECORATES the bare command (`commandUi.decorate`, `ui.kind = 'action'`) to open
ONE modal. Stages inside that modal:

1. **pick** — three ways, all visible:
   - **On this device** (primary): two buttons, "Choose a folder…" (folder
     chooser) and "Choose a transcript…" (single `.jsonl`), with a hint line
     naming where the store lives on a Mac/Linux box (`~/.claude/projects`,
     `~/.pi/agent/sessions`; in the macOS panel ⌘⇧G jumps to a typed path).
     Selecting → filter → upload (progress) → `upload-finish` → `scan`.
   - **On the server** (only when `sources.pickerAvailable`): "Browse on the
     server…" → `pick` (native dialog on the server machine, pre-pointed at
     the store) → `scan`. Cancel returns to pick.
   - **Server path**: an `Input` prefilled with the server's store root + Scan.
2. **scanning** — spinner.
3. **decide** — the single decision view. Two shapes:
   - **bulk** (`kind !== 'session'`): the tree table (workspace rows: tri-state
     checkbox, `~`-collapsed dir, ⚠ when `!dirExists`, destination `<select>`
     = every existing DSH workspace + "New workspace: <basename>" (only when
     `dirExists`) + "Ungrouped", defaulting to the scan's `destination`;
     session leaves: checkbox, title, date range, size, `turns`, `~tokens`,
     badges `imported` / `duplicate` / `large` / `N subagents`). Root scans
     start with nothing selected; workspace scans with all selectable selected.
   - **single** (`kind === 'session'`): a card with the session's title, dates,
     size, turns, tokens, badges, and an **"Import to"** `<select>` with the
     same options as a workspace row (default: the scan's destination).
   - Below either, a **"Large sessions"** section appears ONLY when at least
     one SELECTED session is `large`: "N selected session(s) exceed ~X tokens";
     radio cards Working session (default; keepTurns + resultCap inputs, from
     `sources.defaults`) vs Archive, applied to the large ones only (the rest
     import in full).
   - Footer: Cancel · **Import N session(s)** (disabled at 0). No further
     confirmation step.
4. **running** — poll `progress` every 500 ms; progress bar + current title/phase.
5. **summary** — per-session rows (ok/error, title → workspace, counts); Close.

Closing the modal at pick/decide after an upload calls `upload-discard`.
