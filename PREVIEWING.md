# PREVIEWING.md — trialing plugins safely

> **VERY IMPORTANT: do not modify the user's live DSH configuration without
> explicit confirmation.** The user's live DSH home is `~/.dsh` (profiles under
> `~/.dsh/profiles/<name>/`, home-level `~/.dsh/cordis.patch.yml`). If you
> apply patches there, or `dsh plugin add` into their profile, DSH hot-reloads
> the affected plugins — **including the very client/server session YOU are
> likely being run in**, which can render this session inoperative. Therefore
> do not patch the default config unless explicitly asked to. If the user only
> *implies* it — e.g. asks you to "install" a plugin or fix a DSH bug — check
> first that they want the change applied to the live DSH they are using. The
> safe way to trial a plugin is the isolated preview server below; that
> requires no confirmation.

## The preview server (isolated sandbox)

Run a second `dsh web` against a throwaway home, so the user's real GUI
(usually on :3080) and their `~/.dsh` stay untouched:

```sh
cd ~/github/deepseek-harness
DSH_HOME=/tmp/tali-dash-plugins-home \
  pnpm dsh web --patch /Users/USER/github/tali-dash-plugins/cordis.dev.yml \
  --port 3081 --no-open
```

Run it as a managed background job and capture stdout.

## Details and gotchas

- **The URL is tokened.** stdout prints
  `dsh web: http://127.0.0.1:3081/?token=...` — open THAT link (or hand it to
  the user); a bare `http://127.0.0.1:3081/` answers 401.
- **What isolation covers.** Sessions, workspace registrations, and profile
  state live per-home — but NOT the filesystem: agents run in the preview do
  real work in whatever workspace is opened there. Use a scratch directory.
- **Credentials.** A fresh home has no API keys or providers. Forward the
  user's by copying `~/.dsh/.credentials.yaml` (file-backed key store) and
  `~/.dsh/settings.yaml` (providers/models) into the throwaway home. They are
  snapshots, not links — edits on either side do not propagate.
- **Headless verification.** Fetch the tokened URL with a cookie jar and grep
  the `window.__DSH_BOOT__` graph for the plugin package name; the bundle is
  served at `/plugins/??<package>/client.js&rev=...` (expect HTTP 200).
- **HMR.** The server stat-polls every plugin bundle: a `pnpm watch` rebuild
  hot-swaps the browser without a refresh, and the graph row's `rev` flips
  from a process nonce to a content hash once a rebuild was observed.
- **Disposable.** The `/tmp` home evaporates on reboot; treat everything in it
  (sessions, keys copied there) as throwaway state.
