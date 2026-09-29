# Full-home backup and restore plugin

The `tali-backup-restore` bundle lives in `plugins/backup-restore/` and provides `/backup` and `/restore` (see its README for behavior and limitations). Bare `/backup` confirms before running, then shows counts, ZIP size, the actual instance-specific destination, and a copy-path control. Its host half archives `$DSH_HOME` and provides a gated RPC channel; its browser half decorates bare `/restore` with a selector. A detached worker waits until the old DSH process exits before replacing the home, then the existing relay starts the server when a client reconnects.

Build and test from the plugin directory with `pnpm install && pnpm test && pnpm typecheck && pnpm build`. Add the bundle to a profile with `pnpm dsh plugin --profile web add ../plugins/backup-restore` from the fork checkout; restart that DSH process. The plugin is included in `tools/install-plugins.sh` and in the preview overlay template `cordis.dev.yml`. Generate the preview overlay with `pnpm dev-overlay` from the plugin repository; do not install into the live profile merely to test it.

Archives live outside the home (`~/.dsh-backups` for the default home, `~/.dsh-preview-backups` for the preview home, or `$DSH_BACKUPS_HOME` when explicitly set) and contain all regular files and symlinks from `$DSH_HOME`, except live SQLite WAL/SHM/journal sidecars: Node's `node:sqlite` online backup API folds committed WAL transactions into standalone database snapshots, verified by `PRAGMA integrity_check` before archiving and again after extraction. The archive name records local time, machine, fork commit and rough plugin/workspace/session counts. It includes `dsh-backup.json`, a manifest of entries, and a `dsh/` tree. A rollback is made and verified before the server is stopped. Per-operation status (pending/restored/rolled-back/rollback-failed) lives outside the swapped home in `<backups>/.restore-status/`; the browser retains the operation ID across reload and shows verified counts, paths and ZIP sizes for the selected backup and rollback, or explains the failure. The worker stages extraction and swaps the directory; on error, it attempts to restore the rollback. Logs live at `<backups>/restore.log`.

| Symptom | Check |
|---|---|
| Backup fails on a special file | Remove a live socket/FIFO from `$DSH_HOME` or take a cold backup instead. |
| Restore aborts before restart | Check write access and free space for the rollback; current home remains active. |
| Server never returns | Read `<backups>/restore.log`; verify the relay is loaded or restart DSH manually. |
| Session or plugin missing after cross-machine restore | Workspace paths and plugin source checkouts outside `$DSH_HOME` are not included. |
| SQLite snapshot fails | Check for a malformed `.db`/`.sqlite`, an orphan WAL sidecar, or an integrity-check failure; no archive is published. |
| Non-SQLite files differ across a live backup | Stop DSH and take a cold snapshot: SQLite is consistent per database, but the complete home has no cross-file transaction. |
