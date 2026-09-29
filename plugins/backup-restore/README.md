# tali-backup-restore

Bare `/backup` opens a confirmation dialog and then displays the workspace/session counts, readable ZIP path, size and a copy-path icon. The host command also works without the Web GUI. It packages the complete `$DSH_HOME` directory (default `~/.dsh`) into a private ZIP under the corresponding backups directory. SQLite databases are snapshotted through Node's online SQLite backup API: committed WAL transactions are included in a standalone database file; WAL/SHM/journal sidecars are deliberately omitted. This includes sessions, attachments, settings, credentials, profiles and plugin configuration stored inside that home. It does **not** include external workspace directories, plugin source checkouts, `~/.dsh-backups`, process environment variables, or data explicitly configured outside `$DSH_HOME`.

`/restore` in the Web GUI opens a chooser listing backups in that directory. Select a ZIP and confirm; `/restore <filename>` works headlessly (filename only, never an arbitrary path). Restore first writes and verifies a fresh `.rollback.dsh.zip` of the current home. If that fails, it aborts without stopping DSH. After the server restarts, the dialog shows the verified result: selected archive and rollback archive with counts, paths, sizes and separate copy buttons; on failure it distinguishes a successful rollback from a failed rollback. It then sends DSH a graceful SIGTERM, waits for the process to exit, extracts the chosen ZIP into a staging directory and swaps the home directory. On failure it restores the rollback ZIP and records outcomes in `~/.dsh-backups/restore.log`. If the old process fails to exit within 60 seconds, it leaves the home untouched.

A relay (as used by `dsh-tailscale-remote`) starts DSH again on the next connection; without one, start the server manually. The chooser probes for its return and reloads the page. An interrupted running turn will not resume automatically. Restore is a **whole-home replacement**: files created after the selected backup disappear, and installed plugin symlinks retain their original targets. Restore onto a different machine requires those external targets and a compatible DSH fork to be installed there.

Backup names encode a local timestamp, short host, custom fork SHA and counts (`p`, `w`, `s`). Rollbacks have a separate `h<host>--...--c<sha>-...rollback.dsh.zip` name. The manifest and archive CRC are checked before replacement, archive entries are restricted to `dsh/` and `dsh-backup.json`, and source symlinks are archived as links rather than traversed. The backup directory is created private (`0700`) and ZIPs are mode `0600`: the archive contains secrets; do not publish it.

## Build and install

```sh
cd plugins/backup-restore
pnpm install && pnpm test && pnpm typecheck && pnpm build
cd ../../deepseek-harness
pnpm dsh plugin --profile web add ../plugins/backup-restore
```

Install changes the live profile only when explicitly requested. After installation restart the server to load the host half. For the default `~/.dsh` home the backup directory is `~/.dsh-backups`; for a custom `$DSH_HOME`, including preview `~/.dsh-preview`, it defaults to the sibling `<DSH_HOME>-backups` (`~/.dsh-preview-backups`). `DSH_BACKUPS_HOME` optionally overrides this. Keep backups outside `$DSH_HOME`.

## Limitations

Each SQLite database is internally consistent, including its committed WAL transactions, and checked with `PRAGMA integrity_check` before packaging and again before restore. SQLite consistency is **per database**, not a transaction across multiple databases or the JSON/session files. Non-SQLite files are copied while DSH is running: changing-size writes are rejected, but concurrent same-size rewrites or multi-file updates can still produce an inconsistent overall snapshot. For a strict whole-home snapshot, stop DSH and archive `$DSH_HOME` while it is offline. Rollback is also taken while DSH is still running. A file named `.db`/`.sqlite` with no SQLite header or an orphan SQLite sidecar aborts the backup rather than producing a misleading ZIP. Check `restore.log` if the server does not return; a failed rollback may need manual recovery using the retained ZIP.
