# Quickstart for colleagues

You were given two names: `<host>`, the tailnet name of the shared machine that runs
DSH, and `<user>`, your instance on it (usually your first name). Everything
below runs in Terminal on your own Mac and needs **Tailscale installed and
logged in as your tailnet user** — the shared machine admits you by that identity,
nothing else. Every command is safe to re-run; each asks before doing anything
destructive and prints what it left on the Mac.

## Which one am I?

| I want… | Do |
|---|---|
| **just to use DSH on the shared machine** — a Dock app, nothing local (a few minutes) | [thin client](#a-thin-client) |
| **a full DSH on my own Mac** too (fork, plugins, the local Dock app; ~30–60 min) | [full install](#b-full-install) |
| **my own instance on the shared machine** | ask its admin ([C](#c-an-instance-on-the-shared-mac)), then A |
| **to update / switch version / remove** | [D](#d-update-switch-version-remove) |

## A. Thin client

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/taliesinb/dsh-plugins/main/tools/bootstrap-mac-thin-client.sh)" <host>
```

Asks for `<user>` (default: the local part of your tailnet login), installs the
Xcode Command Line Tools if missing (~500 MB, your password once), checks the
Tailscale login, and builds **`DSH <Host>.app`** in `~/Applications` (blue
whale) that opens `https://<host>.<tailnet>.ts.net/dsh/<user>/`. Nothing else
is installed: no Homebrew, no DSH server. It ends by fetching that URL — `200`
means you are in; `401` means `<user>`'s instance does not admit your login yet
(ask its owner to add you). Re-run the same command for another host or after a
Dock-app update.

Both names on the command line: `… thin-client.sh)" thin-client <host> <user>`
(the word `thin-client` is needed there — see the note at the end).

## B. Full install

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/taliesinb/dsh-plugins/main/tools/bootstrap-mac.sh)"
```

Asks where your git checkouts live (default `~/github`; the clone is
`tali-dash-plugins` inside it), then does everything: Command Line Tools,
Homebrew, node/pnpm, optional Safari Technology Preview + Chrome, Tailscale
(required), clone, fork build, plugins, `~/.dsh`, the relay that starts DSH
at login, the tailnet route, the black **`DSH.app`**, and — last — offers the
thin client of step A as well (enter `<host>`, or nothing to skip). If a DSH is
already on the Mac (the stock Desktop app, an earlier run) it **takes it over**
after one confirmation and keeps `~/.dsh` (sessions, settings, keys). Flags
you may want, after the word `bootstrap`:

```sh
bash -c "$(curl -fsSL …/bootstrap-mac.sh)" bootstrap --checkout-parent ~/code --thin-client <host>
```

`--no-replace` refuses to touch an existing DSH; `--dry-run` shows the plan;
`--yes` takes every default. The full list: [INSTALLING.md](INSTALLING.md)
and the script's `--help`. Afterwards: the Dock app, or `cd
<clone>/deepseek-harness && pnpm dsh web`. Provider keys go in Settings →
Providers in the GUI.

## C. An instance on the shared machine

Only its admin can do this (they need `sudo` there): a macOS account for you,
logged in once, then the full installer run *as that account* with
`--instance <user> --port-base <free decade> --mount /dsh/<user> --allow <your
tailnet login>` (plus that host's `--without …` policy). Once it exists, step A
on your Mac is all you need. The admin-side procedure lives with the host
inventory, not in this public repo.

## D. Update, switch version, remove

- **Update the thin client**: re-run A.
- **Update a full install to current main**: re-run B (same command). The
  take-over stops the running DSH, pulls, and rebuilds only what the pull
  changed (the fork if its pin moved, the plugins if their sources did).
- **A specific branch / tag / commit** (a dev branch, a known-good version):
  `… bootstrap --ref my-branch`. A branch stays checked out as a tracking
  branch, so later updates follow *it*; re-running without `--ref` returns the
  clone to main. The fork is always the version that commit pins.
- **Remove DSH from this Mac** (the way back; keeps `~/.dsh` and the clone,
  asks before each step — `--force` to skip the questions):

  ```sh
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/taliesinb/dsh-plugins/main/tools/uninstall-mac.sh)" uninstall
  ```

  Stops every DSH process, unloads the launch-at-login relay, removes your
  tailnet route, moves the DSH apps (incl. thin clients) to the Trash with
  their Dock tiles, removes a global `dsh` CLI. Not touched: `~/.dsh`, the
  checkouts, Homebrew and its packages, Tailscale.

## If something goes wrong

Every script writes a log (path printed at the end) under
`$TMPDIR/dsh-bootstrap/`. Common cases:

| You see | Meaning |
|---|---|
| `Tailscale is not connected with a tailnet login` | open Tailscale.app, log in as your tailnet user, wait for *Connected*, re-run |
| thin client: `→ 401` | the instance does not admit your login: its owner adds you (Settings → Tailscale remote → allowed users) |
| thin client: `→ no answer` | the shared machine is off or not serving `/dsh/<user>` |
| full install: `DSH already appears to be installed … and --no-replace was given` | drop `--no-replace` to take it over |
| the flags after the command seem ignored | `bash -c "$(curl …)" WORD --flag …`: bash makes the first word after the script its `$0`, not `$1`, so a placeholder word (`bootstrap`, `uninstall`, `thin-client`) must come before the flags — the thin-client script takes a bare `<host>` in that slot on purpose |

More: [INSTALLING.md](INSTALLING.md) (the manual the scripts automate, with
a troubleshooting table) and `recipes/bootstrap-mac-installer.md` (how the
scripts work and what was verified).
