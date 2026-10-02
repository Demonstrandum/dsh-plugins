# macOS privacy prompts for agent commands (the server host)

**Problem (2026-10-02).** An agent extracting the maintainer's own listening
history got `Operation not permitted` on
`~/Library/Containers/com.apple.Music.MusicCacheExtension/…/Caches`,
`~/Library/Application Support/Knowledge` and `~/Library/Biome/streams/restricted`,
and macOS never asked. The wish: requests made by agents should produce the
ordinary macOS consent prompts ("… would like to access …"), and Full Disk Access
should be grantable to "DSH", as for any app.

**Fix.** The relay LaunchAgent's program is now a tiny background-only app
bundle, `DSH <Instance> Server.app`, that spawns the Node relay and stays its
parent. Code: `plugins/dsh-tailscale-remote/relay/server-host.mjs` (build,
Info.plist, change-only re-sign), `dock-app/ServerHost/main.swift` (the host),
`relay/launch-agent.mjs` (prepends it to ProgramArguments; `specFromPlist` for
`relay:reinstall`). Plugin README, "Server host (macOS privacy)".

## Why the Dock app is the wrong thing to rebuild

The Dock app (`~/Applications/DSH <Instance>.app`) is only a WKWebView onto the
relay's URL. The DSH server is **not its child**: launchd starts
`~/Library/Application Support/dsh-tailscale-remote/dsh-web-relay-<instance>`
(a symlink to Homebrew's `node`), the relay spawns `/bin/zsh -lc 'pnpm dsh web …'`,
and agent tools are descendants of that. Quitting the Dock app does not stop DSH.

## How macOS decides who is asking

TCC charges every protected access to the accessing process's **responsible
process**. For a launchd job that is the job's own executable; `posix_spawn`
children inherit it (Node/libuv and zsh do not disclaim). Read it with the
private `responsibility_get_pid_responsible_for_pid(pid)` (dlsym from a 5-line
Swift tool), or in the log:

```sh
log show --last 10m --style compact --predicate 'subsystem == "com.apple.TCC"' \
  | grep -E 'AUTHREQ_(CTX|ATTRIBUTION|SUBJECT|RESULT)'
```

`AUTHREQ_ATTRIBUTION … responsible={identifier=…, responsible_path=…}`,
`AUTHREQ_SUBJECT subject=<bundle id or path>`, `AUTHREQ_RESULT authValue=
(0 denied, 1 unknown, 2 allowed) authReason=` (2 user consent, 5 service policy,
8 missing usage string, 11 entitled). Before the fix every agent request read
`responsible_path=/opt/homebrew/Cellar/node/<v>/bin/node`,
`identifier=node-<hash>` (ad-hoc, no bundle, no usage strings).

## Measurements (macOS 27.0.1)

| Probe (from a launchd job) | Responsible | Service | Outcome |
|---|---|---|---|
| `ls` another app's sandbox container (Music cache extension) | bare node | AllFiles (preflight) | denied, reason 5, no prompt |
| same | test bundle | `kTCCServiceSystemPolicyAllFiles` | denied, reason 5, no prompt — **FDA only** |
| `ls ~/Documents` | test bundle | none requested | allowed (not protected on this Mac) |
| `osascript -e 'tell application "Music" to get name'` | test bundle | none (answered locally) | allowed |
| `osascript … count of tracks of library playlist 1` | test bundle | AppleEvents (Music → `TCCAccessRequestIndirect`) | **UserNotificationCenter dialog shown**, user allowed |
| relay install, `zsh -lc` command | `DSH Hosttest Server.app` | — | host pid responsible for relay, zsh, children |

So: a background-only bundle (`LSBackgroundOnly`) started by launchd **does**
get consent dialogs, and it becomes the name in System Settings. Full Disk Access
never prompts for anyone: add the bundle by hand (System Settings ▸ Privacy &
Security ▸ Full Disk Access ▸ +, ⌘⇧G
`~/Library/Application Support/dsh-tailscale-remote/DSH <Instance> Server.app`),
then restart the relay (`launchctl kickstart -k gui/$UID/io.github.taliesinb.dsh-web-relay.<instance>`)
so new processes pick it up. Knowledge/Biome, other apps' containers, Mail,
Messages, Safari data all fall under FDA.

## Design choices

- **Spawn, never exec.** If the host exec'd Node the responsible pid would stay
  but its code identity would become `node` again. The host `posix_spawnp`s
  its arguments with `POSIX_SPAWN_SETSIGDEF` + empty mask (the child must not
  inherit the host's ignored signals), then ignores TERM/INT/HUP/QUIT/USR1/USR2
  itself and forwards them through dispatch sources; exits with the child's
  status (128+signal when killed). launchd's `kickstart -k`/`bootout` SIGTERM
  reaches the relay, which stops its DSH as before.
- **A separate bundle, not the Dock app's executable with a flag.** The Dock
  app is ad-hoc signed and rebuilt often; TCC pins an ad-hoc app's grants to its
  cdhash, so every rebuild would silently void Full Disk Access. The host is
  rewritten (and re-signed) only when its executable, Info.plist or icon bytes
  differ, so `relay:reinstall` keeps grants. Changing the Dock app's icon or the
  usage strings *does* change the bundle — re-grant after that (the installer
  logs "rewritten (privacy grants for it must be given again)").
- **Name** `DSH <Instance> Server` so System Settings distinguishes it from the
  Dock app; icon copied from the instance's Dock app if installed; bundle id
  `io.github.taliesinb.dsh-server-host[.<instance>]`; one purpose string ("An
  agent running in DSH is asking for this.") on every `NS…UsageDescription` key
  macOS may need before it will prompt.
- **Opt-out / fallback.** No swiftc (no CLT) or a build error → the old bare
  Node form with a log line. `--no-server-host` forces it.

## Switching an installed instance

`pnpm relay:reinstall --instance <name>` (plugin dir) re-reads the installed
plist (`specFromPlist`: everything after `relay.mjs`, `DSH_HOME`, `PATH`, log
dir) and reinstalls with the host. It **boots out the relay and the DSH it
started** — every running turn on that instance dies, including the session that
runs the command. Run it from outside the instance's process tree and after a
delay, e.g. a one-shot LaunchAgent (RunAtLoad, *no* KeepAlive — `launchctl
submit` is keepalive by default, see `promotion-loop-and-duplicate-dsh-tools.md`)
whose script sleeps, runs the reinstall with `/opt/homebrew/bin/node`, then boots
itself out.

## Traps

| Symptom | Cause |
|---|---|
| Still "Operation not permitted", no dialog | That path is FDA-class (no prompt exists): add the bundle to Full Disk Access, then kickstart the relay |
| Grant vanished after an update | Host bundle bytes changed → new cdhash; re-grant |
| `tccutil reset All <id>` → `-10814` | Launch Services no longer knows the bundle id (bundle deleted or never registered); delete the row in System Settings instead |
| Automation dialog never appears for `get name` | osascript answers some properties locally; a real event (`count of tracks …`) is needed |
| `/usr/bin/timeout: No such file` in a probe | macOS has no `timeout`; Homebrew's is `gtimeout` |
