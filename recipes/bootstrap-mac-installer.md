# One-command fresh-machine installer: `tools/bootstrap-mac.sh`

Written 2026-09-21. Turns [INSTALLING.md](../INSTALLING.md) Part A + Path C
(A1 CLT, A2 Tailscale install + login wait, A4 afm, A6 apps, C1–C5) into a
single interactive, idempotent Terminal script:

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/taliesinb/dsh-plugins/main/tools/bootstrap-mac.sh)"
bash -c "$(curl -fsSL https://raw.githubusercontent.com/taliesinb/dsh-plugins/main/tools/bootstrap-mac.sh)" bootstrap --thin-client <host>
# from a clone: pnpm bootstrap  /  tools/bootstrap-mac.sh [--checkout-parent DIR | --dir DIR] [--yes] [--dry-run] [--skip STEP,…] [--only STEP,…]
#               [--no-apps] [--no-tailnet] [--no-apple] [--rebuild] [--no-replace] [--force]
#               [--thin-client HOST] [--thin-client-user U] [--tailscale-timeout S] [--repo URL] [--list]
# on another Mac over ssh (copies the script, runs it with a tty when you have one, --yes otherwise):
pnpm bootstrap-remote user@host [same flags]       # an existing DSH there is taken over (see § Redeploying a deploy-remote host)
# the thin client alone — a Dock app for a DSH on ANOTHER Mac, nothing built locally (see § The thin client):
bash -c "$(curl -fsSL https://raw.githubusercontent.com/taliesinb/dsh-plugins/main/tools/bootstrap-mac-thin-client.sh)" <host>
```

`bash -c "$(curl …)"` rather than `curl | bash`: when bash reads the script from
stdin, any child that reads stdin (pnpm, brew, sudo, `read`) swallows the rest
of the script. Same reason `bootstrap-remote.sh` scp's the file instead of
`ssh host bash -s < script`.

**Why the word `bootstrap` before the flags.** `bash -c STRING ARG0 ARG1…`
binds the first word after the string to `$0` (the "script name"), and only the
rest to `$1…`. So `bash -c "$(curl …)" --no-replace` silently makes
`--no-replace` the program name and the script sees no flags at all; the
placeholder `bootstrap` soaks up `$0` so the real flags land in `$1…` (`--`
does not help: it becomes `$0` too). Any word works; `bootstrap` also makes the
`--help`/`re-run: $0 …` messages read sensibly. The thin-client script turns
this around: a bare word in `$0` that is not a shell or a path is taken as
HOST, so `… thin-client.sh)" hub` works as written.

Seventeen steps, each guarded by its own postcondition so a re-run resumes
where it stopped: `preflight clt brew tools apps tailscale clone fork plugins
home install-plugins preset apple tailnet thin-client verify`. The things only a human can do
are collected into a "Still to do by hand" list printed at the end: the Apple
Intelligence toggle, STP's first-launch licence, provider keys in the GUI,
and — if the wait timed out — the Tailscale login.

## The two hard gates

**1. An existing DSH is taken over (default since 2026-09-23; before that:
fresh machine only).** Preflight always looks for one: a listener on `:3080`/`:3083`/
`:3084` (`lsof -ti tcp:PORT -sTCP:LISTEN`), a `dsh` process
(`pgrep -f 'apps/cli/(lib/bin\.js|src/bin\.ts)'`) or a stock `dsh web` /
`DSH.app` process, `$DSH_HOME/profiles`, the
`io.github.taliesinb.dsh-web-relay` / `ai.symbolica.dsh-remote` LaunchAgent
plists, `~/Applications/DSH.app`, `/Applications/DSH.app`, a deploy-remote
`~/dsh`, a `dsh` on PATH, or a built checkout at the target directory. Every
finding is printed. Nothing found → plain install. Something found → by default
(`--replace`) the **take-over** described in § Redeploying runs after one
confirmation (auto-yes with `--yes`); with `--no-replace` the script aborts
instead (exit 1, nothing written), with two exemptions: `--force` ("layer on
top"; every step still skips what exists) and the **resume marker**
`$DSH_HOME/bootstrap-mac.json` (`{tool, started, dir, instance, portBase}`)
that preflight writes once the gate has passed — without it a `--no-replace`
re-run after a mid-way failure would trip its own footprint (the `home` step
creates `profiles/`, the `tailnet` step starts a server). With the default
take-over the marker only lends its `dir` as the `--dir` default and is then
removed. Why the flip: the colleagues' Macs all had *something* (the stock
Desktop app, an earlier run) and the fresh-machine abort was the first thing every
one of them hit; the take-over keeps `~/.dsh` so nothing is lost. Thin-client
apps (`…dsh-dock-app.remote-*`, § The thin client) are never removed by the
take-over — they open other Macs' DSH and hold no local state. Verified on
the development laptop 2026-09-23 (`--dry-run`): nine findings, the take-over plan lists
the relay, the three listeners, the Dock apps and keeps `DSH Hub.app`;
`--no-replace --dry-run` reports the would-be abort and continues.

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

## Re-running on an existing clone (stale, diverged, dirty, half-dead)

The `clone` step adopts whatever is at `--dir` (default
`~/github/tali-dash-plugins`) and brings it to *current main*; nothing there is
assumed fresh. Checked 2026-09-23 against a throwaway clone with the fork
submodule pointed at a local path (`git -c protocol.file.allow=always`), in each
of these states:

- **Parent repo behind or diverged** (a local commit, or a clone from before one
  of the history rewrites): `git pull --ff-only`; when that fails, the dirty
  files are listed and stashed (`stash push -u -m "bootstrap-mac <date>"`) and
  the clone is `reset --hard origin/main`. An installer, not a dev checkout.
- **Fork submodule stale / rebased upstream**: irrelevant to `git submodule
  update --init deepseek-harness` — it fetches what is missing and checks out
  the parent's *pinned SHA* (detached), so a force-pushed `feat/embed-session`
  is never a non-fast-forward problem; there is no branch to fast-forward.
  Verified: `checkout HEAD~3` in the submodule → back at the pin.
- **Fork submodule dirty**: git keeps edits that do not collide with the
  checkout, but a local edit to a file that changed between the two commits
  fails with `Your local changes to the following files would be overwritten by
  checkout`. The step now lists the edits, stashes them in the submodule
  (tracked first, `-u` on a second failure) and retries; the run ends with
  `your edits: git -C …/deepseek-harness stash list`.
- **Half-dead `deepseek-harness/`** (a clone that died with the directory
  populated but `.git/modules/deepseek-harness` missing — exactly what a first
  run over a bad network leaves): `fatal: destination path … already exists and
  is not an empty directory`, twice, abort. Detected as "its git toplevel is not
  itself" (a bare subdirectory of the parent reports the parent — plain
  `rev-parse --is-inside-work-tree` is true there, the first attempt at this
  check), moved to `deepseek-harness.broken-<timestamp>`, re-cloned.
- **Submodule URL**: only an effective `git@github.com:` URL is rewritten to
  https; an override already in the clone's config (a mirror, a local path) is
  respected. Before, the rewrite was unconditional.
- **Stale builds — the real gap.** After any of the above the pin has moved,
  yet `apps/cli/lib/bin.js` and every `lib/client.js` still exist, and the
  `fork`/`plugins` steps used to say "already built" and ship the old code.
  Now `$DSH_HOME/bootstrap-built.json` records `{fork, plugins}` = the commits
  each build came from; the fork rebuilds when its SHA differs (`fork checkout
  moved 9384b80976 → 5029131621 since the last build — rebuilding`), all
  plugins rebuild (`pnpm install` + `pnpm build`) when the plugins repo's SHA
  differs, and an existing build with no record rebuilds once ("unknown
  provenance"). The file lives in `~/.dsh` so the take-over and the uninstaller
  leave it alone; `--rebuild` still forces everything.
- **Clean and current**: a no-op ("adopting it", pin unchanged, nothing
  rebuilt).

The thin-client script's clone is shallow and single-branch; its re-run is
`fetch --depth 1 origin main` + `reset --hard origin/main` (non-FF-proof by
construction), and a `--dir` that exists without being a clone dies with a
clear message instead of git's.

## Redeploying a deploy-remote host (`--replace`, the default)

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
- **pnpm build scripts**: declared per plugin in `pnpm-workspace.yaml` `allowBuilds` (esbuild, sharp, ripgrep, chrome-devtools-mcp); no CLI flag — `--dangerously-allow-all-builds` conflicts with `allowBuilds` on pnpm 10.32 (`CONFLICT_BUILT_DEPENDENCIES`, found on the first colleague install). Verified pnpm 10.32 / 11.7 / 12.5.
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

### Creating the extra macOS accounts hands-free

Done 2026-09-21 for five colleagues on the shared machine with a root-owned script
kept **on that Mac** (`/usr/local/bin/dsh-add-user NAME…`, not in this repo:
it carries site-specific defaults). What it does per account, and why:

- `sysadminctl -addUser NAME -fullName NAME -password … -admin`, then
  `createhomedir -c -u NAME`; the password is set with `dscl . -passwd` because
  `sysadminctl -resetPasswordFor` refuses without a Secure-Token holder
  (accounts created from a root shell get **no Secure Token** — irrelevant
  unless FileVault is on). `authorized_keys` copied from the caller.
- **The first-login panes are not Setup Assistant's own `DidSee*` panes.**
  Seeding `com.apple.SetupAssistant` (the `DidSee*`/`LastSeen*` set copied from
  an account that had clicked through) removed Siri, Screen Time, Touch ID,
  privacy, appearance, accessibility — but three screens survived every seed:
  *Sign in to your Apple Account*, an Apple Intelligence feature offer (Image
  Playground / notification summaries) and *Your Mac is ready for FileVault*.
  Traced in the unified log (`log show --predicate 'process == "loginwindow"'`
  etc.): loginwindow reads a per-user OS stamp from
  **`~/Library/Preferences/loginwindow.plist`** (no `com.apple.` prefix:
  `SystemVersionStampAsNumber/AsString`, `BuildVersionStampAsNumber/AsString`).
  A new account has none → `lastUpdatedSystemVersion = 0` → it launches
  **UserAccountUpdater** → its `MiniLauncherPlugin` runs
  `prepareLaunchDecisionForNewUser` ("required = 1, launch reason = New User
  (13)") and arms `MiniBuddyLaunch` in the user's `com.apple.loginwindow` →
  loginwindow starts **Setup Assistant as MiniBuddy**, which for reason 13 runs
  the iCloud flow (first pane `iCloudLogin`, then the Intelligence offer, then
  `MBTargetUserGetsFDEUpsell YES` — "FDE volume check: is in major OS upgrade
  flow"). **Fix: copy the caller's `loginwindow.plist` stamp into the new
  home** (same OS/build) and write `MiniBuddyLaunch = false`. Verified: the
  next account's log read `shouldLaunchUpdate = NO … MiniBuddyLaunch pref is
  NOT set` and the login went straight to the desktop.
- Dead ends, recorded so nobody repeats them: `FDEUpsellStorageLogicalVolumeUUIDs`
  / `com.apple.siri.setup` / `com.apple.setupassistant.privacypane` seeds (the
  right domains, but downstream of the launch decision); `com.apple.NewDeviceOutreach`
  (`ndoagent` — its check-in is disabled while the account is signed out, so it
  never produced the cards); pre-writing launchd's
  `/var/db/com.apple.xpc.launchd/disabled.<uid>.plist` (overwritten at the
  account's first login); the MDM `SkipKeys` (`AppleID`, `FileVault`,
  `Intelligence`) only act through a DEP cloud configuration; enabling
  FileVault would remove the upsell but makes every unattended reboot stop at
  the pre-boot unlock screen — wrong for a headless server.
- Still manual, by design: one login per account via Fast User Switching (a
  `gui/<uid>` launchd domain exists only for a GUI session; no CLI creates an
  Aqua session). With the seeds it is just the password prompt. Then
  `pnpm bootstrap-remote <name>@<mac> --instance <name> --mount /dsh/<name>
  --allow <their tailnet login>`.

### The on-device model answered one token (`Output token limit reached`)

First real use of the Apple model on a fresh instance: `enforce-model-preset`
did switch the blank session to `minimal-no-tools`, yet the request carried
**62 tool schemas (62 KB)** — every tool of the out-of-tree plugins — into a
4K-window model, which answered one token with `stopReason: length`. The
preset only omits the in-tree tool groups; plugin tools bypass it two ways:
global registrations (`fs-tools`, `session-introspect`) and per-agent scoped
registrations on `agent/created` (`browser-automation`,
`<private-plugin>`). Fix, verified 0 tools on the wire afterwards:
`plugins/no-global-tools` (a preset row calling `ctx.tools.restrict({ allow:
[] })`, written into the preset by the bootstrap's `preset` step) for the
former, and a `skipPresets` gate in the two per-agent plugins for the latter
(scoped registrations are exempt from `restrict`; and `agentPresets.select`
*recomposes the same Agent*, so the plugins also detach/attach on
`agent-preset/selected`). Diagnosed by decoding the session log
(`zstd -dc session.v3.jsonl.zstd`, `request/header` → `tools.length`).

### Read-only "Tailscale remote"/"Server" panes and no <private> card for the owner

Seen from the direct-remote Dock app: *"The Tailscale remote is controlled from
the DSH host only"* and no host-settings cards. Not the relay — that only
autostarts and forwards; the proxy already admits identity users and hands DSH
a loopback connection. It was the proxy's **operator** fence: the control
channel (`/tailscale-remote/*`) and the `ownsHost` script (which makes
Settings persist on the host and reveals host-settings panes) were granted
only to requests from the node's own tailnet address. Right for one Mac with
one owner; on a shared machine the owner of an instance is never "the node". Fix
(`dsh-tailscale-remote` `identityOperators`, default `true`): **identity-
admitted ⇒ operator** — the same Serve-injected login the allowlist trusts;
token/QR holders stay non-operators; `false` restores the old policy.
Separately, the <private> card lives on the bundle's page in the **sidebar ▸
Plugins** panel since the 0.1.6-alpha.2 rebase (not Settings), and an instance
whose plugin client bundle was built before that fix registers into a slot
that no longer exists — rebuild `lib/client.js` after pulling.

### The optional `extras/` layer

Anything deployment-specific — host inventories, account scripts, pins of
private plugins — lives in a **private** repo checked out as the `extras/`
submodule. Its existence is public (this paragraph, `.gitmodules`); its
contents need GitHub org access over ssh. The bootstrap inits `deepseek-harness`
explicitly, then tries `extras` and, on success, its nested pins
(`--recursive`); on failure it warns *"extras layer not reachable … continuing
with the public plugin set only"* and deinits the pin, so a colleague without
access gets a complete public install (verified with `GIT_SSH_COMMAND=false`).
The https-override for the fork skips `extras` (a private https fetch would
prompt). What extras contributes is declared in `extras/dsh-extras.yml`
(`plugins[]`: path, bundle name, `install`, optional `requires.command`),
read by `tools/extras-manifest.mjs`; the build loop and
`install-plugins.sh` layer those plugins on. Private plugins that
self-detect their tool should not use `requires` — the plugin's own remedy
card is the better message. Moving a pin is a commit in extras, then a
submodule bump here.

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

## The thin client (`--thin-client HOST`, `tools/bootstrap-mac-thin-client.sh`)

Added 2026-09-23 for the colleagues whose DSH runs on the shared server: what
they need on their own Mac is only the blue Dock app `DSH <Host>` that opens
`https://<host>.<tailnet>.ts.net/dsh/<user>/` by tailnet identity
(`pnpm remote-app <host>/dsh/<user>`, i.e. `dsh-tailscale-remote`'s
`dock-app:remote`; `recipes/dock-app-via-tailnet.md`). Two entry points:

- **In the full installer**: the `thin-client` step (after `tailnet`, before
  `verify`) asks *"Tailnet host name of a Mac whose DSH you also want a Dock app
  for (empty = skip)"*, then *"Your instance on HOST"* with the local part of
  the tailnet login as default (`jo@example.com` → `jo`; `$USER` if
  there is none), and runs `pnpm remote-app HOST/dsh/USER` in the clone.
  `--thin-client HOST [--thin-client-user U]` pre-answers; `--yes` without the
  flag skips (empty default). Needs nothing the earlier steps have not
  guaranteed (node, swiftc, a connected Tailscale, the clone).
- **Alone**: `tools/bootstrap-mac-thin-client.sh [HOST [USER]]` (`pnpm
  bootstrap-thin-client` from a clone). Seven steps, no Homebrew, no pnpm, no
  fork, no plugin builds, no `~/.dsh`: preflight (asks HOST if missing; empty
  = exit 0) → Command Line Tools (same headless `softwareupdate` path; `swiftc`
  compiles the wrapper) → Tailscale (same gate as the full script, but the
  login wait defaults to 180 s since it is the one real dependency; a missing
  app is offered as a brew cask when brew exists, otherwise the download page
  is opened and the script waits for `/Applications/Tailscale.app`) → node (an
  existing node ≥ 20 on PATH / `/opt/homebrew/bin` / `/usr/local/bin`, else the
  official `latest-v24.x` darwin tarball is extracted to
  `~/.dsh-thin-client/node` — no sudo, ~50 MB; `dock-app:remote` needs only
  node built-ins, so no `pnpm install` anywhere) → sources (`git clone --depth 1
  --single-branch` of this repo into `~/.dsh-thin-client/dsh-plugins`, 3 MB;
  a re-run `fetch --depth 1` + `reset --hard origin/main`; no submodule) →
  `node plugins/dsh-tailscale-remote/scripts/cli.mjs dock-app:remote HOST/dsh/USER
  --name "DSH <Host>"` → verification (the app exists; its URL, read from
  `Contents/Resources/dsh-dock-app.json`, is curled: 200/303 admitted, 401 =
  route live but not on that instance's allowlist, 000 = host down or no
  route). Everything it leaves behind: `~/.dsh-thin-client/`, the CLT,
  Tailscale, `~/Applications/DSH <Host>.app` + Dock tile. `--name`, `--dir`,
  `--no-launch`, `--yes`, `--dry-run`, `--tailscale-timeout`, `--repo`.

Verified 2026-09-23 on the development laptop: `tools/bootstrap-mac-thin-client.sh hub
<user> --name "DSH Hub Test" --no-launch --yes` — clone, wrapper + icon
compile (~20 s cold), install, pin, `→ 200 (the server admits you by
identity)`; the re-run took the update path and replaced the wrapper; the node
tarball path tested in isolation (24.21.0 runs `cli.mjs dock-app:status`);
`bash -c "$(cat script)" hub --dry-run` takes `hub` from `$0` (see "Why
the word `bootstrap`" above), `… thin-client hub jo` from `$1 $2`, and a
bare `--yes` with no host prints "nothing to build" and exits 0. Test app
removed with `cli.mjs dock-app:uninstall --name`.

The default app name is `dock-app.mjs`'s `remoteAppName`: `DSH ` + the host's
first label title-cased on `-`/`_` (`hub` → `DSH Hub`, `my-mac` → `DSH My
Mac`); both scripts recompute it in awk to find the bundle afterwards. The
bundle id is `io.github.taliesinb.dsh-dock-app.remote-<host>-dsh-<user>` — one
WebKit data store per remote, and the prefix the full installer's take-over
uses to leave these apps alone.

## Uninstalling (`tools/uninstall-mac.sh`)

Added 2026-09-23: the take-over's teardown as a standalone, checkout-free
script (`bash -c "$(curl …/uninstall-mac.sh)" uninstall [--force]`, or
`pnpm uninstall-dsh` from a clone). Plain shell + `launchctl` + `lsof` + the
Tailscale CLI + `defaults`/`python3` (plistlib, from the CLT) — nothing is
cloned or built. It inventories first and then, **asking before each group**
(default yes; `--force` asks nothing; `--dry-run` prints the plan):

1. LaunchAgents `io.github.taliesinb.dsh-web-relay[.<instance>]`,
   `ai.symbolica.dsh-remote`, anything `*dsh*`/`*deepseek*` in
   `~/Library/LaunchAgents` — `launchctl bootout` + plist removed (first, so a
   KeepAlive relay cannot respawn what is stopped next).
2. This user's processes: the relays, every `dsh web`/`serve` (built checkout,
   stock CLI, Desktop app), the Dock apps, then any remaining listener on
   `127.0.0.1:3080–3099` (SIGTERM, 20 s, SIGKILL); dies if a listener of yours
   survives. Never another account's processes (`pgrep -u`, `lsof -u`).
3. Tailscale Serve paths `/dsh*` that are **yours**: decided *before* anything
   is stopped, by whether a process of this user listens on the path's target
   port or a relay plist of this user names that port (`--listen
   127.0.0.1:PORT`). Others' paths on a shared machine are listed and left alone;
   never `serve reset` (see the 2026-09-22 incident in § Redeploying).
4. Apps → Trash: `~/Applications/*.app` with bundle id
   `io.github.taliesinb.dsh-dock-app*` (DSH, DSH Preview, DSH-<instance>, the
   thin clients), Safari web apps named `DSH*`, `/Applications/DSH.app` and
   `*deepseek*` ids. Quit, `lsregister -u`, then Finder's *delete* (Put Back
   works; the first time Terminal may ask for Finder automation) with a `mv`
   into `~/.Trash` as the fallback. Their Dock tiles are dropped by editing
   `persistent-apps` (`defaults export com.apple.dock -` → plistlib →
   `defaults import` → `killall Dock`), the shell equivalent of
   `dock-app.mjs`'s `removeDockTile`.
5. A global `dsh` CLI (npm/pnpm/bun/brew), the relay symlinks in
   `~/Library/Application Support/dsh-tailscale-remote`, and — its own
   question, 1.7 GB and not a git clone — a deploy-remote.sh `~/dsh`.

Kept on purpose and said so at the end: `~/.dsh` (incl. `bootstrap-mac.json`,
`logs/`, `deploy/`), `~/.dsh-preview`, the checkouts (`~/github/tali-dash-plugins`,
`~/.dsh-thin-client`), Homebrew and its formulae/casks (node, pnpm, afm,
Tailscale, STP, Chrome), `~/.zprofile`, the CLT, `~/Library/Logs/DSH Dock`.
A re-bootstrap afterwards finds `~/.dsh/profiles` and takes over as usual.

Two `pgrep` facts learnt writing it, both now handled in the bootstrap too
(`my_dsh_pids` / `dsh_pids` helpers): **(a)** BSD `pgrep` excludes its own
*ancestors* by default, so a DSH agent running the script never saw the very
server it runs under (this Mac's live `dsh web` tree was invisible while the
preview tree showed) — `pgrep -a` includes them; **(b)** under `bash -c
"$(curl …)"` the whole script is the shell's argv and contains every pattern
(`dsh web`, `apps/cli/lib/bin.js`…) — macOS `ps`/`pgrep` happen to hide argvs
that long (they show an empty command), but the helpers also skip `$$`, any
process whose command mentions the script's name, and any process whose
command `ps` cannot show. Related: never `my_dsh_pids … | head -1` inside an
assignment — `head` closes the pipe, the loop's next `echo` gets SIGPIPE, and
with `pipefail` the assignment fails, which under `set -e` exits the script
silently (found in the dry run; `| tr '\n' ' '` + `${x%% *}` instead).

Verified 2026-09-23 on the development laptop: `--dry-run` inventories the two relays
(live + preview), 9 processes, 6 listeners, both Serve paths as "yours",
three Dock apps, the support dir; the `$0`-flag form (`… uninstall-mac.sh)"
--dry-run`) works. `trash()` and the tile surgery were unit-tested on a fake
`DSH Fake Test.app` (bundle id `…dsh-dock-app.faketest`, tile pinned the
`ensureDockTile` way): Finder moved it to the Trash, exactly its tile went,
the other 20 tiles stayed; a first attempt failed with `plistlib.load` on a
non-seekable stdin → `plistlib.loads(sys.stdin.buffer.read())`. A full real run
has not been done on this Mac (it would take down the session that wrote it).

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
| `DSH already appears to be installed or running on this Mac and --no-replace was given` | the gate with `--no-replace`; it lists what it found. Drop `--no-replace` to take it over (keeps `~/.dsh`), use the existing install, or add `--force` |
| the flags after `bash -c "$(curl …)"` are ignored | the first word after the string is `$0`, not `$1`: write `bash -c "$(curl …)" bootstrap --flag …` (any word); the thin-client script takes a bare `$0` as HOST on purpose |
| thin client: `→ 401: the route is live but <host> does not admit <login>` | your tailnet login is not on that instance's allowlist: its owner adds it (Settings → Tailscale remote → allowed users, or `--allow` when they bootstrap the instance) |
| thin client: `→ no answer` | the host is offline, not serving `/dsh/<user>`, or MagicDNS/HTTPS certs are off on the tailnet; the app itself still installs |
| thin client: `Tailscale.app did not appear within 15 minutes` | no brew and the manual install was not done: install from tailscale.com (or the App Store), log in, re-run |
| `Tailscale is not connected with a tailnet login (state: NeedsLogin)` | the login was not completed within the timeout: open Tailscale.app, log in as the same tailnet user as your other DSH Macs, re-run |
| `state: NeedsMachineAuth` | device approval is on for the tailnet: approve the new machine in the admin console, re-run |
| `sudo needs a password but there is no terminal` | headless run: `sudo -v` (or `echo pw \| sudo -S -v`) first, then re-run |
| `--yes` picked defaults you didn't want | drop `--yes`; prompts read `/dev/tty`, so they work under `curl \| bash` too |
| STP cask "skipped (needs macOS ≥ 26)" | Apple only ships STP for current macOS; install stable Safari has no `--mcp`, so `safari_*` tools stay unavailable |
| `something already listens on :3080` in the `home` step | another DSH instance; stop it or run `--skip home` if `~/.dsh/profiles/web` already exists |
| `still waiting for the Tailscale login…` | complete the browser login at the printed `log in here:` URL (same user as your other DSH Macs); `--tailscale-timeout 600` bounds the wait |
| `no /dsh in tailscale serve status` | MagicDNS + HTTPS certs off on the tailnet, or Tailscale run from bare launchd (the relay plist uses `zsh -lc`; see INSTALLING.md A2) |
| `Your local changes to the following files would be overwritten by checkout` under the submodule step | a local edit in `deepseek-harness/` collides with the pinned commit; since 2026-09-23 the step stashes and retries by itself (`git -C deepseek-harness stash list` has it) — on an older script: stash by hand, re-run `--only clone` |
| `destination path '…/deepseek-harness' already exists and is not an empty directory` | a half-dead earlier clone (directory populated, gitdir missing); since 2026-09-23 moved aside to `deepseek-harness.broken-<ts>` automatically — on an older script: `rm -rf deepseek-harness`, re-run `--only clone` |
| the GUI runs old code after a re-run that moved the pin | pre-2026-09-23 scripts skipped the build when `bin.js` existed; now `~/.dsh/bootstrap-built.json` tracks the built SHAs — or `--rebuild` |
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
