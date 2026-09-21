# One-command fresh-machine installer: `tools/bootstrap-mac.sh`

Written 2026-09-21. Turns [INSTALLING.md](../INSTALLING.md) Part A + Path C
(A1 CLT, A2 Tailscale install + login wait, A4 afm, A6 apps, C1–C5) into a
single interactive, idempotent Terminal script:

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/taliesinb/dsh-plugins/main/tools/bootstrap-mac.sh)"
# from a clone: pnpm bootstrap  /  tools/bootstrap-mac.sh [--dir DIR] [--yes] [--dry-run] [--skip STEP,…] [--only STEP,…]
#               [--no-apps] [--no-tailnet] [--no-apple] [--rebuild] [--force] [--replace]
#               [--tailscale-timeout S] [--repo URL] [--list]
# on another Mac over ssh (copies the script, runs it with a tty when you have one, --yes otherwise):
pnpm bootstrap-remote user@host [same flags]
pnpm bootstrap-remote user@host --replace          # redeploy a Path B host (see § Redeploying a deploy-remote host)
```

`bash -c "$(curl …)"` rather than `curl | bash`: when bash reads the script from
stdin, any child that reads stdin (pnpm, brew, sudo, `read`) swallows the rest
of the script. Same reason `bootstrap-remote.sh` scp's the file instead of
`ssh host bash -s < script`.

Sixteen steps, each guarded by its own postcondition so a re-run resumes
where it stopped: `preflight clt brew tools apps tailscale clone fork plugins
home install-plugins preset apple tailnet verify`. The things only a human can do
are collected into a "Still to do by hand" list printed at the end: the Apple
Intelligence toggle, STP's first-launch licence, provider keys in the GUI,
and — if the wait timed out — the Tailscale login.

## The two hard gates

**1. Fresh machine only.** Preflight aborts (exit 1, nothing written) when DSH
already appears to be installed or running: a listener on `:3080`/`:3083`/
`:3084` (`lsof -ti tcp:PORT -sTCP:LISTEN`), a `dsh` process
(`pgrep -f 'apps/cli/(lib/bin\.js|src/bin\.ts)'`), `$DSH_HOME/profiles`, the
`io.github.taliesinb.dsh-web-relay` / `ai.symbolica.dsh-remote` LaunchAgent
plists, `~/Applications/DSH.app`, a `dsh` on PATH, or a built checkout at the
target directory. Two exemptions: `--force` (documented as "layer on top";
every step still skips what exists), and a **resume marker**
`$DSH_HOME/bootstrap-mac.json` (`{tool, started, dir}`) that preflight writes
once the gate has passed — without it a re-run after a mid-way failure would
trip its own footprint (the `home` step creates `profiles/`, the `tailnet`
step starts a server). Verified on the development laptop: the real run reports all eight
findings and aborts before touching `~/.dsh`; `--dry-run` reports them and
continues.

**2. Tailscale before anything is cloned.** The `tailscale` step (right after
the casks) requires Tailscale.app installed, `BackendState == Running` and a
non-empty login (`status --self --json` → `User[Self.UserID].LoginName`; on
the Air `user@example.com`). Missing app → offers `brew install --cask
tailscale-app`, otherwise dies with the download URL. `Stopped` (logged in,
disconnected) → `tailscale up --timeout 60s` reconnects on the command line.
`NeedsLogin` → runs `tailscale up` in the background (the GUI variant's CLI
supports both `up` and `login`, checked against 1.102.4: `up` = "connect,
logging in if needed"; it prints the `https://login.tailscale.com/...` URL and
blocks until the browser login completes), surfaces the URL, `open`s it when
there is a terminal, and polls until Running — for **10 s by default**
(`--tailscale-timeout`): the login is a precondition the script checks and
explains, not something it waits around for. `NeedsMachineAuth` gets a "tailnet admin must approve
this device" warning. Anything short of connected-with-login dies with
instructions. The late `tailnet` step therefore only re-checks and dies if the
connection dropped. Why Tailscale is not optional: the relay, the route, the
Dock app and the Remotes feature all hang off it, and installing a Mac
without it produces exactly the half-working state INSTALLING.md's
troubleshooting table is full of.

## Redeploying a deploy-remote host (`--replace`)

The first remote Mac was set up by `tools/deploy-remote.sh` (INSTALLING.md
Path B; sessions `deepseek-harness/hybrid-local-remote` T15–T17/T39–T43 and
the remote-setup sessions): rsynced checkout at `~/dsh/checkout`,
plugins at `~/dsh/plugins`, Node at `~/.local/node`, LaunchAgent
`ai.symbolica.dsh-remote` (KeepAlive, `zsh -lc`), `~/.dsh/deploy/remote.cordis.yml`
inserting the plugins by absolute path, listeners on `:3080`/`:3084`
(`publishPort: 0`), `~/Applications/DSH.app` with fallback `:3084`, and a
`~/.dsh` with settings, credentials, sessions and `tailscale-remote.json`
(standing token + the deployer's login allowlisted — the deploying Mac's
Remotes registry stores that token). `--replace` turns such a host into a Path C install:

1. confirms (auto with `--yes`), then `launchctl bootout` + removes both
   LaunchAgent plists (`ai.symbolica.dsh-remote`, `io.github.taliesinb.dsh-web-relay`),
   kills the `:3080/:3083/:3084` listeners and any surviving `dsh` process,
   deletes `~/dsh` and `~/.dsh/deploy` **only if** `~/dsh/checkout/apps/cli/lib/bin.js`
   exists (the Path B signature); dies if anything still listens;
2. **keeps `~/.dsh`** entirely — so the `home` step skips (profile exists),
   the credentials to-do is suppressed (the file has real records), the
   `tailnet` step re-uses the token/allowlist and just sets `enabled: true` and
   adds the node's own login; the Remotes entry on the deploying Mac keeps
   working because the URL (`https://<remote>.<tailnet>.ts.net/dsh/`) and token
   are unchanged;
3. runs the normal steps (brew node/pnpm were missing on the remote — Path B
   never needed them; CLT, Homebrew, STP, Chrome, afm 0.9.19 were present);
4. **rebuilds the Dock app** even though `DSH.app` exists (its fallback moves
   from `:3084` to the relay `:3083`).

Why the old absolute-path overlay must go: `install-plugins` adds the same
plugins as bundles, and duplicate `tali-*` row ids fail the boot. Why the
Path B checkout must go: nothing else references it, and 1.7 GB.

**Done for real on 2026-09-21** (`pnpm bootstrap-remote <user>@<remote> --replace`,
no local tty → `--yes`; the host needed no sudo since brew and the CLT were
there). Result: relay LaunchAgent `io.github.taliesinb.dsh-web-relay` running
`pnpm dsh web` from `~/github/tali-dash-plugins/deepseek-harness` (2.7 GB),
Serve `/dsh` → `:3083`, 12 `tali-` rows, afm answering, Dock app rebuilt
(`fallbackUrl` now `:3083`, still pinned), `~/dsh` and `~/.dsh/deploy` gone,
`~/.dsh` intact (token + 3 allowlisted users), `https://<remote>.<tailnet>.ts.net/dsh/`
→ 200 from the deploying Mac by identity. Over ssh the GUI-dependent parts
worked as expected because the user is logged into the remote's GUI session (`launchctl
bootstrap gui/$UID`, the Tailscale CLI, `xcrun swiftc`, launching the app).

It took **five runs**; each failure resumed via the marker, and each found a
bug that a dry run cannot (all fixed in `638c95a`…`49d8689`):

| Run | Failure | Root cause → fix |
|---|---|---|
| 1 | `git clone --recurse-submodules`: *Host key verification failed* | `.gitmodules` uses `git@github.com:` for the fork; a fresh machine has no GitHub key. The fork is public → clone the superproject alone, then override `submodule.<name>.url` to https **in the clone's config** (`.gitmodules` untouched, so the maintainer's ssh workflow is unaffected) before `submodule update --init` |
| 2 | fork "built" ✓ but `apps/cli/lib/bin.js` missing; plugins ✓ with `ERR_PNPM_IGNORED_BUILDS`; `--without` unknown | (a) `runq` read `$?` *after* an `if` → always 0, masking every failure; (b) the fork's postinstall `install-lefthook.mjs` refused the submodule layout; (c) pnpm 12 (brew's latest; plugins pin no pnpm) makes ignored build scripts an error → `--dangerously-allow-all-builds`; (d) the remote's clone was `main` *before* the push — the remote flow only works once `main` carries the tooling |
| 3 | `--without` still unknown | the adopt path didn't `pull`; my "clean tree" precondition was defeated by our own `cordis.dev.yml` re-point → always `pull --ff-only`, warn on failure |
| 4 | `install-plugins` → `pnpm dsh plugin add` fails in the lefthook postinstall | pnpm's verify-deps-before-run re-runs `pnpm install` before **every** `pnpm dsh …`, so `CI=true` on two commands was not enough. Real fix = the migration the error asks for, on the submodule's common config: `core.repositoryFormatVersion 1`, `extensions.worktreeConfig true`, move `core.worktree` into `config.worktree`. (the maintainer's own submodule has an *embedded* `.git` dir and no `core.worktree`, which is why it never showed up locally.) |
| 5 | — | success |

## One DSH per macOS user on a shared machine (`--instance`)

Tried 2026-09-21 on the remote Mac: a second **Administrator** account, logged
in once via **Fast User Switching** and left in the background, then
`pnpm bootstrap-remote <user>@<remote> --instance <name> --allow <login>`.
Result: a second, fully independent DSH beside the first — own `~/.dsh`
(sessions, credentials, settings, token), own relay LaunchAgent, own Dock app
`DSH-<name>`, reachable at `https://<remote>.<tailnet>.ts.net/dsh-<name>/`
while the first stays at `/dsh`. Facts that make it work:

- **Tailscale (Standalone variant) is one node for the whole Mac.** The tunnel
  is a system extension running as root with a single machine-wide VPN
  configuration; the GUI app runs per user and the CLI talks to the backend
  through it. Measured: a second user's `tailscale status/serve` work from a
  plain ssh session with **no GUI app of its own** (the console user's app
  serves it; still exactly one `Tailscale` process). So the gate passes for
  every account, the node identity/login is shared, and identity admission for
  the second person is an allowlist entry (`--allow`), not a second login.
- **Serve config is node-wide but path-additive**: `tailscale serve --set-path
  /dsh-<name>` adds a handler; the first user's `/dsh` handler survives, and
  each user's plugin only ever re-publishes its own path on boot.
- **What must differ per user is only TCP ports, the Serve path and the Dock
  app name.** `--instance` picks the first free decade ≥ 3090 (web/relay/proxy
  = base/+3/+4; `--port-base` to choose; recorded in the resume marker),
  and writes a `tali-tailscale-remote` row override (`listenPort`,
  `publishPort`, `mountPath`, `dockAppName`, `relayStart … --port N`) into the
  user's `~/.dsh/profiles/web/cordis.patch.yml` — a patch row replaces the
  whole config, unset keys fall back to the plugin's defaults. The plugin's
  own `instance` setting is for two instances in *one* home (live+preview) and
  is not needed here. `port_busy` uses `nc -z` because `lsof` only shows the
  caller's own processes: the other user's listeners are invisible but very
  much there.
- **The account must be an Administrator** on that Mac: Remote Login was
  restricted to admins (`com.apple.access_ssh` nests the `admin` group), and
  Homebrew's prefix is `admin`-group-writable, so admins can `brew install`
  with no extra group. A dedicated group only earns its keep for Standard
  users (`chgrp` the brew prefix + add them to `com.apple.access_ssh`).
- **A LaunchAgent runs only while its user has a GUI session** (`gui/<uid>`
  domain): enable Fast User Switching, log the account in once, switch back.
  `launchctl bootstrap`, the Dock-app build and launch all worked over ssh into
  that background session.
- **`/tmp` is shared**: the remote runner stages the script in the target
  user's home (`~/.bootstrap-mac.sh`) — the first user's copy in `/tmp` was not
  writable by the second (found the hard way).
- The fresh-machine gate checks *this instance's* ports and *this user's* `dsh`
  processes (`pgrep -u`), otherwise the first user's servers would trip it.
- **pnpm 12 build scripts**: `--dangerously-allow-all-builds` (kebab-case).
  The camelCase `--config.dangerouslyAllowAllBuilds=true` is silently ignored
  in a plugin directory that has its own `pnpm-workspace.yaml`; it had looked
  fine earlier only because the affected `node_modules` already existed. Both
  kebab spellings verified on pnpm 11.7 and 12.5 in a throwaway package.
- A fresh home's `.credentials.yaml` is not empty: it holds the
  `client-connection/browser-session` grant; the "add a provider" to-do now
  keys on other `records:` entries.

This second account also serves as the near-clean-slate test of the script:
everything under `~` (clone, build, `~/.dsh`, LaunchAgent, Dock app) was
exercised from nothing; only the system-level installs (CLT, Homebrew, casks,
afm) were pre-existing.

**Paid apps are never installed.** Dash (Kapeli's docs browser) and
<private> are not offered; instead `dash-docsets` and
`<private-plugin>` are left out of the build and of the bundle
install (`install-plugins.sh --without …`, a flag added for this) when the
app is absent, with a to-do to re-run `pnpm install-plugins` after buying it.
Detection is by **bundle id through LaunchServices** (`osascript -e 'id of
application id "com.kapeli.dash-setapp"'`, then `com.kapeli.dashdoc`), not by
path: on the development laptop Dash is the Setapp build at `/Applications/Setapp/Dash.app`,
which a `/Applications/Dash.app` check misses (found out in the dry run: the
plugin that works on that Mac would have been excluded there). <private>:
`/Applications/<private>.app`, `<private>.app`, `<private>script` on PATH, or
the `com.<private>.*` bundle ids.

## Why a shell script and not a `.pkg` (the original ask)

The request was "a once-off .pkg that forces you to pick a directory, installs
STP and Chrome if missing, …". A macOS Installer package is the wrong
container for this sequence, measured against what the steps need:

| Need | Installer.app `.pkg` | Terminal script |
|---|---|---|
| Ask where the checkout goes | only the deprecated `<domains enable_anywhere="true"/>` folder chooser, i.e. payload relocation, flaky UI | `read` with a default |
| Run brew / git / pnpm / `launchctl` / write `~/.dsh` **as the user** | `postinstall` runs as root; every command must be demoted (`sudo -u "$(stat -f%Su /dev/console)"`, `launchctl asuser`); Homebrew refuses root outright | native |
| Wait for a Tailscale browser login, a sudo password, the CLT dialog | impossible mid-run; can only `open` the app and hope | poll loops, `/dev/tty` prompts |
| ~10 min of clone + `pnpm install` + build + cask downloads | hidden behind "Running package scripts…"; failure = "The installation failed", dig through Installer Log | streamed, indented, logged to `$TMPDIR/dsh-bootstrap/` |
| Distribution to a new Mac | unsigned `.pkg` → Privacy & Security → "Open Anyway" on every Mac; avoiding it needs a paid Developer ID + notarization | `curl \| bash` sets no quarantine flag |

If a double-clickable artifact is ever wanted, the honest form is a thin
wrapper (`.pkg` or a tiny `.app`) whose only job is `open -a Terminal` on this
script — not logic inside `postinstall`.

## Facts the script relies on (verified 2026-09-21 on macOS 27.0)

- **The free third-party apps are Homebrew casks**: `tailscale-app` (1.102.4;
  the older name `tailscale` still resolves), `safari-technology-preview`
  (247; `depends_on macos >= 26`), `google-chrome`. The script checks
  `/Applications/<App>.app` first and only offers the cask when missing. (A
  `dash` cask exists too, but Dash is paid — deliberately not offered.)
- **Command Line Tools install headlessly**: `touch
  /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress` makes
  `softwareupdate -l` list `Label: Command Line Tools for Xcode 27.0-27.0`
  (~500 MB), which `sudo softwareupdate -i "<label>"` installs; fallback is
  `xcode-select --install` + a wait loop.
- **Homebrew**: the official installer honours `NONINTERACTIVE=1` and only
  needs a cached sudo (`sudo -v` up front). Homebrew ≥ 6 refuses untrusted
  third-party taps, hence `brew trust scouzi1966/afm` before afm.
- **afm by macOS major**: ≥ 27 → `scouzi1966/afm/afm`; 26.x → `afm@0.9.10` +
  the two metallib symlinks (see `apple-foundation-model-provider.md`).
- **Route enablement without the GUI**: `dsh-tailscale-remote` republishes
  `tailscale serve --set-path /dsh` on every boot from
  `~/.dsh/tailscale-remote.json` (`{version:1, enabled:true, allowedUsers,
  token}`, mode 0600; the plugin regenerates an invalid token). Writing that
  file and kickstarting the relay is exactly what Settings → Enable does.
- **Dock app**: `pnpm dock-app:install --name DSH --fallback
  http://127.0.0.1:3083/` in `plugins/dsh-tailscale-remote` (needs `xcrun
  --find swiftc`); the relay comes from `pnpm relay:install --cwd <fork>
  --start "pnpm dsh web --no-open"`.
- **`settings.yaml` merge** uses the fork's own `yaml` package
  (`node_modules/.pnpm/yaml@*/node_modules/yaml`; not hoisted) so the Apple
  provider is added under `llm-pi-ai.providers` without clobbering anything the
  GUI wrote.
- **Tailscale JSON is parsed with python3, not node**: the gate runs before
  brew node exists on a fresh machine (the remote's first dry run reported `state:
  unknown` for exactly that reason). python3 comes with the CLT (step 2).
- **`set -e` + `VAR="$(a | b)"`**: a failing pipeline inside a command
  substitution makes the *assignment* fail, and `set -e` exits silently — the
  remote dry run died after "afm present" because `ls -d …/yaml@*` had no match.
  Every piped substitution now ends in `|| true`; dry-run paths that `cd` into
  directories that do not exist yet go through `run_in`.
- **Homebrew on the login-shell PATH**: the relay LaunchAgent runs `zsh -lc
  "pnpm dsh web"`, so the brew step appends `brew shellenv` to `~/.zprofile`
  even when Homebrew pre-existed (the remote already had it).
- **bash 3.2**: a fresh machine has only `/bin/bash` 3.2.57. The script avoids
  `${arr[@]}` on possibly-empty arrays under `set -u` (guards with `${#arr[@]}`),
  associative arrays, `;;&`, `mapfile`. `bash -n` under `/bin/bash` passes.
- **Stopping the first launch**: kill *the PID listening on :3080* (`lsof -ti
  tcp:3080 -sTCP:LISTEN`), never `pkill -f bin.js` — on a Mac that already runs
  DSH that would take the live server down.

## Verification status

- **Dry run on the development laptop (fully set up)**: all 14 steps skip correctly and
  propose no action (both paid-app plugins correctly detected as installable).
  No real run has been made on that machine on purpose — it would
  re-clone/rebuild the live checkout.
- **Real `--replace` run on the remote Mac, 2026-09-21: success** on the fifth
  attempt (see § Redeploying for the four bugs the first four found). It is
  now a Path C install driven by the relay; `deploy-remote.sh`/`remote-ctl.sh` no
  longer apply to it (`pnpm remote-status` looks for `ai.symbolica.dsh-remote`).
- **Clean-machine run: pending.** Plan: a pristine macOS guest on the remote
  Mac (macOS 27.0, 366 GB free; the Air has 30 GB free, too little for a
  20–25 GB guest image) with **Tart** (`brew install cirruslabs/cli/tart`;
  `tart clone ghcr.io/cirruslabs/macos-tahoe-vanilla:latest dsh-test`,
  `tart run dsh-test --no-graphics`, `tart ssh dsh-test`), driving the script
  over ssh with `--yes --tailscale-timeout 600` after `echo admin | sudo -S -v`.
  Known limits of any VM test: Apple Intelligence is unavailable in VMs (the
  Apple step can only prove afm installs/starts and returns *not enabled*),
  and the guest is a new tailnet node — its login/device approval needs a
  human once; the script prints the login URL and waits.

### The macOS-VM landscape (for whoever tests this)

Apple ships the *engine* — `Virtualization.framework` (`/System/Library/
Frameworks/`, present on macOS 27) runs macOS guests natively on Apple
Silicon from an IPSW — but no end-user VM app, only sample code. Everything
usable is third-party on top of it: **UTM** (GUI; also QEMU emulation for
other architectures), **VirtualBuddy** (GUI, macOS-guest-only), **Tart**
(Cirrus Labs, CLI, CI-oriented; publishes ready vanilla/base images with an
`admin`/`admin` user and ssh on). Tart is the fit for agent-driven testing
because everything is scriptable and a `tart clone` is a free snapshot.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `DSH already appears to be installed or running on this Mac` | the fresh-machine gate; it lists what it found. Use the existing install, remove it, or `--force` |
| `Tailscale is not connected with a tailnet login (state: NeedsLogin)` | the login was not completed within the timeout: open Tailscale.app, log in as the same tailnet user as your other DSH Macs, re-run |
| `state: NeedsMachineAuth` | device approval is on for the tailnet: approve the new machine in the admin console, re-run |
| `sudo needs a password but there is no terminal` | headless run: `sudo -v` (or `echo pw \| sudo -S -v`) first, then re-run |
| `--yes` picked defaults you didn't want | drop `--yes`; prompts read `/dev/tty`, so they work under `curl \| bash` too |
| STP cask "skipped (needs macOS ≥ 26)" | Apple only ships STP for current macOS; install stable Safari has no `--mcp`, so `safari_*` tools stay unavailable |
| `something already listens on :3080` in the `home` step | another DSH instance; stop it or run `--skip home` if `~/.dsh/profiles/web` already exists |
| `still waiting for the Tailscale login…` | complete the browser login at the printed `log in here:` URL (same user as your other DSH Macs); `--tailscale-timeout 600` bounds the wait |
| `no /dsh in tailscale serve status` | MagicDNS + HTTPS certs off on the tailnet, or Tailscale run from bare launchd (the relay plist uses `zsh -lc`; see INSTALLING.md A2) |
| fork `pnpm install`/`pnpm dsh`: `[install-lefthook] cannot enable extensions.worktreeConfig while core.worktree is in the common config` | freshly cloned submodule; the clone step's migration did not run (re-run `--only clone`), or do it by hand: `git config --file .git/modules/deepseek-harness/config core.repositoryFormatVersion 1; … extensions.worktreeConfig true; … --unset core.worktree; git config --file .git/modules/deepseek-harness/config.worktree core.worktree ../../../deepseek-harness` |
| `Host key verification failed` cloning the submodule | the `git@github.com:` URL in `.gitmodules`; the clone step overrides it to https — if it did not, `git config submodule.deepseek-harness.url https://github.com/taliesinb/deepseek-harness.git` then `git submodule update --init` |
| `ERR_PNPM_IGNORED_BUILDS` in a plugin | pnpm ≥ 12 — `pnpm install --dangerously-allow-all-builds` (the script does) |
| remote run: `unknown argument: --without` (or any tool missing on the host) | the host clones `origin/main`: push first |
| `pnpm install` in a plugin fails on `link:` | fork submodule missing: the `clone` step's `git submodule update --init` did not run — re-run `--only clone,plugins` |
| afm smoke test: `Apple Intelligence is not enabled` | expected until System Settings → Apple Intelligence & Siri is on and the model downloaded; also always the case inside a VM |

## Sources

- `tools/bootstrap-mac.sh`, `tools/install-plugins.sh`, `tools/deploy-remote.sh`
  (the headless route/Dock-app procedure), `plugins/dsh-tailscale-remote/scripts/cli.mjs`
- `INSTALLING.md` (the manual it automates), recipes
  `dock-app-via-tailnet.md`, `apple-foundation-model-provider.md`,
  `browser-automation-plugin.md`
