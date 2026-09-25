# Private plugins in the `extras/` layer

How a DSH plugin lives outside this public repo yet installs, builds and
deploys exactly like the public ones — and how one was moved there
(2026-09-25) so that the public history no longer contains it.

## The mechanism

The optional private submodule `extras/` (symbolica-ai/dsh-extras; absent
without org access, and every script here continues without it) carries a
manifest, `extras/dsh-extras.yml`, read by `tools/extras-manifest.mjs`:

```yaml
plugins:
  - id: <name>
    path: plugins/<dir>              # relative to the manifest; vendored dir or nested pin
    bundle: <package name>           # for `dsh plugin --profile web add`
    install: true                    # false = buildable, not in the default bundle set
    requires:                        # optional gate: ANY listed item present → installed
      app: [/Applications/X.app, com.example.x]   # paths, or macOS bundle ids (LaunchServices)
      command: x                     # on PATH
    check: bin/check-x               # optional: run after the build; each stdout line → a to-do item
```

The reader prints one tab-separated row per plugin — `path`, `bundle`,
`install`, **status**, `check` — where status is the *evaluated* gate: `-`
(none), `ok`, or `missing:<what it looked for>` (`X.app / com.example.x /
\`x\``). Three consumers read only that column:

- `tools/install-plugins.sh` — rows with `install: yes` and a passing gate join
  the `dsh plugin add` set; `missing:*` prints `skipped (requires …)`;
  `--without <dir|bundle>` applies to extras rows too.
- `tools/bootstrap-mac.sh` step `plugins` — same skip, labels the row
  `extras:plugins/<dir>`, and after the build runs every `check` hook, turning
  each printed line into a to-do item (the place for "only a human can finish
  this": a per-user licence, a login).
- `extras/bin/sync-host` — builds every manifest path, then calls
  `install-plugins.sh`, so the gate is evaluated on each instance.

So nothing about a private plugin is hardcoded in a public script: not its
name, not what it needs. The public side of the paid-app rule that remains is
`dash-docsets` (bundle-id detection, `recipes/bootstrap-mac-installer.md`).

A vendored extras plugin links into the fork one level deeper than a public
one — `link:../../../deepseek-harness/…` — which is why `extras/` must be
checked out at `<plugins>/extras` and nowhere else. `pnpm install && pnpm
build` inside the plugin directory as usual; `pnpm typecheck` sees the same
d.ts files.

## Moving a plugin out of this repo (as done 2026-09-25)

1. **Extract with history** into a temp clone:
   `git clone --no-local --single-branch <repo> /tmp/x && cd /tmp/x &&
   git filter-repo --force --path plugins/<dir> --path recipes/<its-recipes>.md`
   (paths keep their names, which is the layout extras wants), then in
   `extras/`: `git fetch /tmp/x main && git merge --allow-unrelated-histories
   FETCH_HEAD`. Its commits now live privately; the trees were byte-identical.
2. **Make it build there**: `link:` paths one `../` deeper, `pnpm install &&
   pnpm build && pnpm typecheck`, its own `check` script and `.gitignore`
   (`node_modules/`, `lib/`), the manifest entry with the `requires` gate that
   used to be a hardcoded `has_<app>` in the bootstrap.
3. **Public tree**: `git rm -r` the directory and recipes; replace every
   mention (README blurb and counts, AGENTS recipe index and the
   bundle-template pointer, INSTALLING tables, recipes' passing mentions,
   comments in sibling plugins, `deploy-remote.sh`, `migrate-to-submodule.sh`)
   by hand — `grep -rni <name> --exclude-dir=extras --exclude-dir=deepseek-harness`
   until clean. One commit whose message does not name it either.
4. **Rewrite**: rehearse on a `--mirror` clone, then in place:
   `git filter-repo --force --invert-paths --path … --replace-text T
   --replace-message T` with a **targeted** table — literal rules for the
   plugin/recipe names first, then a case-insensitive rule for the vendor word
   with negative lookaheads for every legitimate use found by grepping all
   historical blobs first (here: icon-set file names in a deleted demo plugin
   and an ordinary English word sharing the prefix). Verify by grepping *every blob and
   every message* of the result, and by diffing the protected blobs.
   filter-repo asks to continue when `.git/filter-repo/already_ran` exists
   from an earlier rewrite (pipe `echo y`), removes `origin` (re-add it) and
   turns remote-tracking branches into local ones (delete the merged ones on
   both sides). Force-push with `--force-with-lease=main`.
5. **Clones**: a rewritten upstream is not fast-forwardable — `sync-host`
   now fetches and `reset --hard origin/<branch>` when `HEAD` is not an
   ancestor, then removes plugin directories the reset emptied (the untracked
   `node_modules/` and `lib/` of the removed plugin would otherwise stay as an
   orphan). GitHub forks keep the old objects; only their owners can reset or
   delete them, and GitHub Support purges cached SHAs on request.
6. **Live profiles** link plugins by **absolute path**
   (`~/.dsh/profiles/web/package.json`); after the move the symlink dangles
   and the next boot fails loudly for a `dsh.client` package. Re-link with
   `dsh plugin --profile web add <new path>` — using the pnpm the profile was
   installed with (`ERR_PNPM_UNEXPECTED_STORE` when brew's pnpm 10 meets a
   profile installed by the fork's pinned pnpm 11 — run the pinned one from
   `~/Library/pnpm/.tools/pnpm/<ver>/bin/pnpm`). The running server keeps
   the old module until its restart.

Traps met: a backtick inside `sync-host`'s *unquoted* heredoc is executed by
the local shell (`requires:: command not found`) — its comments must not use
them; the recipe's own history entry and tables live in `extras/history/`.
