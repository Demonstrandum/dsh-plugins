# AGENTS.md — tali-dash-plugins

Out-of-tree work on DeepSeek Harness (DSH): **plugin code** under
`plugins/`, **recipes** (one Markdown file per completed setup/change) under
`recipes/`, helper scripts under `tools/`, and the DSH fork itself as the
submodule `deepseek-harness/`. Setting up a fresh machine: [INSTALLING.md](INSTALLING.md). This file is the onboarding
guide for agents working here: how DSH plugins work, how this repo is laid
out, where the authoritative docs live, and how to record what you did.

> **VERY IMPORTANT: changes under the user's live DSH home (`$DSH_HOME`,
> default `~/.dsh`) can hot-reload the very client/server session YOU are
> likely being run in, making it inoperative.** The `web` profile ships
> `patchReload: 'live'`, so edits to `$DSH_HOME/cordis.patch.yml` or
> `$DSH_HOME/profiles/<name>/cordis.patch.yml` apply to the running server
> THE MOMENT you save. Rebuilding a plugin bundle that is installed in the
> live profile hot-swaps the live browser too. Even boot-time changes
> (`dsh plugin add`/`remove`) alter what the user's next launch runs. Make
> none of these changes unless explicitly asked; if the user only implies it
> (e.g. "install this plugin", "fix this DSH bug"), confirm first that they
> mean their live DSH. The safe, no-confirmation way to trial a plugin is the
> isolated preview server — see [PREVIEWING.md](PREVIEWING.md).

## Locations (symbolic — resolve them on the machine you are on)

| Symbol | Meaning | What belongs there |
|---|---|---|
| `<plugins>` | **this repo** | All plugin code (`plugins/<name>/`), recipes (`recipes/`), helper tools (`tools/`), the dev overlay `cordis.dev.yml` |
| `<dsh-src>` | the DSH **source checkout** — the custom fork (`taliesinb/deepseek-harness`, branch `feat/embed-session`) as this repo's git **submodule `deepseek-harness/`**; the clone that `pnpm dsh web` runs from | Reference for APIs, docs (`docs/`), shipped presets. Fork commits live there (Remotes/embed/tailscale-mounting); ordinary features are plugins, not fork patches. Bump the submodule pin (`git add deepseek-harness`) when the fork moves |
| `$DSH_HOME` | the DSH home, default `~/.dsh` | Configuration, not code: `settings.yaml` (providers, models), `.agent-presets/`, `profiles/web/cordis.patch.yml` (which plugins the live web GUI runs), `sessions/`, `attachments/` |
| `<recipes-ws>` | the maintainer's **recipes workspace** — a code-free directory used as a session cwd whose `AGENTS.md` just points here | Nothing; recipes live in `<plugins>/recipes/` |

All doc paths below are relative to `<dsh-src>`. **Verify APIs against the
checkout** before relying on this file — it is a summary, the checkout is the
truth. Recipes spell out the concrete `~`-relative paths of the machine they
were written on; map them onto the symbols above when you are elsewhere.

Absolute paths are unavoidable in one place and are tolerated there:
`cordis.dev.yml` rows (`name:` must be an absolute module path; the loader's
`!!js` interpolation covers `config` only) — regenerate it if the checkout or
this repo moves. The plugins' `link:` dependencies are **relative**
(`link:../../deepseek-harness/...`, i.e. the submodule), so the fork must be
checked out there (`git submodule update --init`). The repo is **not** local-only: it is pushed
to `origin` (https://github.com/taliesinb/dsh-plugins), so commit finished
work and `git push`; anything machine-specific (those absolute paths, `~`
paths in recipes) is documented as such rather than assumed.

## Permissions (deliberate — do not "fix")

Sessions started from `<recipes-ws>` have `workspace-write` over that
directory only. Writing plugin code or recipes into `<plugins>` (or config
into `$DSH_HOME`) triggers one approval escalation per operation — **that is
the maintainer's chosen setup** (decided 2026-09-05). Do not try to widen the sandbox:
the DSH file policy is single-root by design (`workspaceRoot` = session cwd;
enforcement is canonicalize-then-contain, so symlinks don't help; no plugin
seam exists, and shell writes enforce the same roots at the OS level). Just
attempt the write and let the approval prompt do its job. If approvals are
disabled in a session, a denial is final.

## Ground rules

- **This repo is public.** Nothing that identifies a real deployment goes into
  it — no host names, macOS account names, tailnet/MagicDNS names, tailnet
  logins, LAN IPs, or internal repo names — not in code, comments, recipes,
  this file, or commit messages. Write `<remote>`, `<user>`,
  `<host>.example.ts.net`, "the shared remote machine", "DSH Remote" instead, and
  put the concrete facts in the private `extras/` submodule (its `AGENTS.md`
  has the full rule, the grep to run on every staged diff, and the history
  rewrite procedure). Before committing: `git diff --cached -- . ':!extras' |
  grep -i` for the identifiers listed there. Two history rewrites already
  (2026-09-21, 2026-09-22); there must not be a third.
- Plugins are developed **out-of-tree** (this repo). Never fork/patch DSH to
  add a feature: "There is no privileged core to patch: you extend dsh by
  mounting a plugin beside the others" (`docs/architecture.md`).
- Layout: one plugin = one directory under `plugins/`, each an installable npm
  package. `cordis.dev.yml` at the repo root is the dev overlay that loads all
  of them by absolute path.
- The recipe owns the system-level story; the plugin README owns the plugin.
  Cross-reference rather than duplicate.

## The plugin model (Cordis)

DSH is composed entirely of Cordis plugins mounted into a shared context. A
plugin is a module exporting `apply(ctx, config)` (function form), or an
object `{ name, inject, apply }`, or a `Service` subclass (class form, used
when the plugin *provides* a service to others).

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-plugin'
export const inject = ['tools']        // required services; apply waits for them

export function apply(ctx: Context) {
  ctx.tools.register(/* ... */)        // registrations are effects
}
```

Key mechanics (details: `docs/cordis-tutorial/`, `docs/cordis-primer.md`,
generated API in `docs/cordis-api/`):

- **Effects**: everything registered through `ctx` (listeners, tools, slots,
  timers) is undone automatically when the plugin unloads. Wrap any resource
  managed outside Cordis in `ctx.effect(() => { ...; return disposer })`.
- **inject / PENDING**: a plugin whose `inject` names an unavailable service
  waits silently in PENDING — the #1 "my plugin prints nothing" cause
  (`docs/cordis-tutorial/06-composition-and-hmr.md`).
- **Config**: export a `Config` schema; invalid YAML config fails the load
  loudly before `apply` runs (`docs/user/develop/basic/config.md`).
- A row's `config` in a later patch layer **replaces** the whole value, no
  deep-merge.

## Loading a plugin: two ways

1. **Dev overlay** (what this repo uses day-to-day):

   ```sh
   cd <dsh-src>
   DSH_HOME=~/.dsh-preview pnpm dsh --profile web --patch <plugins>/cordis.dev.yml --port 3088 --no-open
   # (what the preview relay runs for you; see PREVIEWING.md)
   ```

   The overlay `insert`s rows whose `name` is an **absolute path** to the
   plugin entry module. Tutorial: `docs/user/develop/basic/index.md`.
   Verify composition without booting:
   `DSH_HOME=~/.dsh-preview pnpm dsh --profile web --patch ... --dump-config`
   (global options before the profile's own; `dsh web --patch` is rejected).

2. **Installed bundle** (stable plugins): the package declares
   `dsh.bundle.patch` in package.json (see any `plugins/*/cordis.patch.yml`)
   and is installed into a profile with
   `dsh plugin --profile <name> add ./plugins/<dir>` (pnpm-links the local
   directory; `remove` undoes it). Layer order, git installs, and the pnpm
   `allowBuilds` catch: `docs/user/develop/basic/publish.md`.
   **All eighteen live plugins at once:** `pnpm install-plugins [--profile web]`
   (`tools/install-plugins.sh`; `pnpm remove-plugins` undoes it). Rows then
   resolve by package name from the profile's hoisted `node_modules`, so no
   patch carries an absolute path. A "superplugin" package that merely lists
   the plugins as dependencies does **not** work: pnpm never installs a
   `link:`ed package's dependencies into the profile, and the loader resolves
   rows from the profile directory (measured 2026-09-18). Never combine the
   bundle install with absolute-path `insert` rows for the same plugins —
   duplicate ids fail the boot.

## Host plugins (Node side)

Register tools, listen to agent events, provide services. Start points:

- `docs/user/develop/basic/tool.md` — the tool-definition DSL (`ctx.tools`).
- `docs/user/develop/framework/` — services, events.
- `docs/user/develop/practice/` — LLM adapters, dynamic composition.
- `docs/agent-lifecycle.md`, `docs/tool-execution-pipeline.md` — agent-loop
  events a host plugin can hook.
- Running from the source checkout, a row may point straight at a `.ts` file
  (the host runs through tsx). Built JS always works.
- Host module edits need a `dsh web` restart — a live patch-row reload re-runs
  `apply` from Node's module cache (module-source HMR is off). Client bundle
  rebuilds hot-swap on their own.

## Client plugins (Web GUI side)

The web GUI is also a Cordis tree, running in the browser. A *client plugin*
is one package with two halves:

- **Node half** (`main` / exports `"."`): loaded by the host Loader; may be an
  empty `apply` for browser-only plugins.
- **Browser half** (exports `"./client"` → `lib/client.js`): a built bundle
  the web shell fetches and mounts as a browser-side Cordis plugin.

The host scans Loader rows for packages declaring `dsh.client` in
package.json (`{ "dsh": { "client": { "platform": "web" } } }`, requires the
`./client` export) and serves their bundles under `/plugins`; the browser
boots from the injected `window.__DSH_BOOT__` graph. Subsystem doc:
`docs/subsystems/client-modules.md`.

### Client bundle format

Source of truth: `packages/client/tsdown.client.ts` (in-tree preset). Our
out-of-tree equivalent is `plugins/<private-plugin>/build.mjs` (esbuild).
The artifact is a CJS bundle wrapped in a factory registration:

```js
window.__ModuleLoader__.load({ id: '<package name>', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
/* ...bundled CJS... */
return module.exports; } });
```

- `id` must equal the package.json `name`.
- Only the shell's **platform modules** may remain `require()`d (externals);
  everything else must be inlined. Mirror of
  `packages/client/web/src/platform.ts`:
  `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`,
  `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-store`,
  `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`.
- Cross-plugin **runtime** imports of other `@deepseek-ai/*` client packages
  are forbidden; `import type {}` is fine (erased) and is how you pull in
  SlotMap/standard-prop declaration merges.
- The bundle must exist when the server boots — a `dsh.client` package with a
  missing `lib/client.js` fails activation loudly.

### Slots: contributing UI

All client UI composes through the typed slot system — `ctx.slots` in the
browser `apply`. Authoritative doc (incl. the full slot tree):
`docs/subsystems/slots.md`; house rules: `packages/client/AGENTS.md`.

```ts
export const inject = ['slots']
export function apply(ctx: Context) {
  // inject(name, cb): waits until the slot's owner declares it, re-runs on
  // redeclaration, unwinds with your plugin.
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      { name: 'conversation.input.dock', id: 'my-entry', order: 100 },
      MyComponent,
    ))
}
```

- Cardinality `list` needs a unique `id` (+ `order`); `single`/`keyed` cells
  are replacement points; `chain` elects by `select()`.
- Scope `session` gives components `sessionId`, `useSession`, `useProjection`;
  every scope gets `useSessions`, `useWorkspaces`,
  `useSessionPendingInteraction`. Conversation slots add `useConversation`,
  `useChat`, etc.
- Components never see `ctx`; type props as
  `PropsRuntime<'slot.name'>` (& store/inject/renderSlots shares as needed)
  from `@deepseek-ai/dsh-client-ui-slots`.
- Useful session state (`SessionSnapshot`, in
  `packages/api/session-controller/src/client/contract/snapshot.ts`):
  `running`, `lastAgentError`, `queue`, `blank`, `openState`.
  Pending approvals/questions: `useSessionPendingInteraction` map keyed by
  session id. Host-computed per-session values: `useProjection('<key>')`
  (`docs/subsystems/session-projection.md`).
- Live introspection: ask a running agent to call
  `cordis_inspect what:"client"` for the live slot catalog.

### Dev loop for client plugins

```sh
cd <plugins>/plugins/<plugin> && pnpm watch   # rebuilds lib/client.js on save (hot-swaps the preview GUI)
# row in <plugins>/cordis.dev.yml, then (re)start the standing preview:
launchctl kickstart -k gui/$UID/io.github.taliesinb.dsh-web-relay.preview
```

### The preview server

Trial plugins in the **standing preview instance** — `DSH_HOME=~/.dsh-preview`,
port 3088, composed from that home's profile patch plus `cordis.dev.yml`,
started on demand by the relay LaunchAgent
`io.github.taliesinb.dsh-web-relay.preview`, reachable token-free from any
browser on this Mac at `https://laptop.example.ts.net/dsh-preview/`
and by the user as **DSH Preview** in the Dock — never by patching the live
config. Add rows to `cordis.dev.yml`, then
`launchctl kickstart -k gui/$UID/io.github.taliesinb.dsh-web-relay.preview`.
**Its default model is local and dumb on purpose**: `apple/foundation` (Apple
Foundation on-device, 4K window) on the `minimal-no-tools` preset — basic text
replies only, **no tools**; LM Studio models (`minimal` preset, tools) are
the other local option. There are no cloud providers/keys in the preview home
and none should be added, so a preview session can smoke-test UI/plugin
behaviour but cannot run a real agent turn; test tool-using plugins headlessly
or in a throwaway home with forwarded credentials (PREVIEWING.md).
Full procedure, the ad-hoc `/tmp`-home alternative, credential forwarding and
HMR gotchas: [PREVIEWING.md](PREVIEWING.md).

### Verifying a client change without a GUI login

`dsh web` authenticates the browser with a per-process launch token printed
only in its terminal, so an agent's own browser usually cannot open the live
GUI. **On the development Mac this no longer holds**: with `dsh-tailscale-remote`
installed, any browser on the machine (incl. the `browser-automation` STP
windows) is admitted by the node's own Tailscale identity at
`https://laptop.example.ts.net/dsh/` (live) and `/dsh-preview/`
(preview server on its own home `~/.dsh-preview`, started on demand by its
relay; its `?token=` URL is in `~/.dsh-preview/logs/dsh-web-preview.log`) — see `recipes/dock-app-via-tailnet.md`.
Elsewhere, the fallback below still applies. Alternative used in `recipes/<private-plugin>.md`: load
`lib/client.js` in Node under a fake `window.__ModuleLoader__` with stub
platform modules, capture what `apply(ctx)` registers, and replay a real
session log (`zstd -dc $DSH_HOME/sessions/<ws>/<session>/session.jsonl.zstd`)
through it.

### Type-checking against the checkout

Each plugin declares `link:` devDependencies pointing into the checkout
(`vendor/cordis`, `packages/client/ui-slots`, ...) so `pnpm typecheck` sees
the real d.ts files. Links are relative to the submodule
(`link:../../deepseek-harness/...`). `@modelcontextprotocol/sdk` and `sharp`
are ordinary npm dependencies pinned to the checkout's versions, not links into
its `.pnpm` store (since `5785d17`). esbuild does not type-check; the build
works even if types drift.

## Recipes (`recipes/`)

After completing any non-trivial DSH task — adding a provider, authoring a
plugin or preset, installing/configuring third-party plugins, infrastructure
like local model servers, diagnosing a bug — write (or update) a recipe in
`recipes/`, written so a future agent (or human) with zero session context
can reproduce or maintain it:

- One topic per file, kebab-case name (`apple-foundation-model-provider.md`,
  `cloudflare-remote-control.md`, `install-rewind-plugin.md` are examples).
- Exact paths, exact config blocks, exact commands, and the *why* behind
  non-obvious choices.
- Record what **failed** and why, not just the happy path — failed attempts
  are what save the next agent hours.
- Include a troubleshooting table when the task had failure modes.
- Cross-reference plugin READMEs rather than duplicating them.
- No real host / account / tailnet names (Ground rules): `<remote>`,
  `<user>`, `<host>.example.ts.net`; the concrete inventory and any
  per-account rollout log go into the private `extras/AGENTS.md`.
- Add the new recipe to the index below.

### Recipe index

- `anthropic-many-image-2000px-limit.md` — "many-image requests: 2000 pixels"
  400 after the 21st image of a session: Anthropic's >20-image per-dimension
  cap vs DSH's pixel-count-only `requestImagePixelBudget`, diagnosing from
  attachment metadata in the session log, the 1.15 MP per-provider setting
  in `$DSH_HOME/settings.yaml`, and why downscaling beats offloading for the
  prompt cache.
- `anthropic-new-model-before-catalog.md` — using a model newer than the
  installed catalog.
- `apple-foundation-model-provider.md` — local models as DSH providers
  (LM Studio + Apple Foundation via AFM), the pi-ai token-budget trap,
  minimal presets, and the `enforce-model-preset` plugin.
- `black-screen-after-server-restart.md` — a bare dark window in the Dock
  apps (any browser) after the DSH server restarted: not the wrapper — the
  client's `/plugins/events` reconnect gets per-process `<nonce>-<n>` bundle
  revs, `entries.sync` hot-swaps every plugin in place and the React root
  crashes; the `reload-on-restart` client plugin (wraps
  `ctx.modules.entries.sync`, reloads the page when *all* known revs changed,
  passes single-bundle HMR through), the Dock-log/relay-log (local vs UTC)
  diagnosis trail, the preview-server reproduction, and per-instance
  deployment with its one-time ⌘R caveat.
- `bootstrap-mac-installer.md` — `tools/bootstrap-mac.sh`, the one-command
  fresh-machine installer (INSTALLING.md Part A + C1–C5 as sixteen idempotent
  steps: CLT, Homebrew, node/pnpm/git, STP/Chrome casks, the mandatory
  Tailscale gate (install → `tailscale up` reconnect → driven browser login),
  clone, fork + plugin builds, `~/.dsh`, bundles, afm + Apple provider, relay
  → route → Dock app); the fresh-machine abort gate and its resume marker, the
  paid-app rule (Dash/<private> never installed, their plugins gated on
  bundle-id detection — the Setapp-Dash trap), why a `.pkg` is the wrong
  container, the headless facts it relies on, the macOS-VM landscape
  (Virtualization.framework vs UTM / Tart / VirtualBuddy) and the pending
  clean-VM test plan; `pnpm bootstrap-remote user@host` (ssh runner) and
  `--replace`, which turned the remote Mac from a deploy-remote (Path B) host into a
  standalone install while keeping `~/.dsh` — the default since 2026-09-23
  (`--no-replace` restores the fresh-machine abort), and `--instance`/`--allow` for one
  DSH per macOS user on a shared machine (Tailscale is one node per Mac, Serve
  paths are additive; 2026-09-21; the five-run log of
  what only a real run finds: ssh submodule URL, masked `runq` failures,
  lefthook vs a fresh submodule's `core.worktree`, pnpm 12 build scripts).
  Also the **thin client** (2026-09-23): the `thin-client` step /
  `--thin-client HOST` (a blue `DSH <Host>` Dock app to another Mac's
  `/dsh/<user>` via `pnpm remote-app`) and the standalone
  `tools/bootstrap-mac-thin-client.sh [HOST [USER]]` (CLT, Tailscale, node
  tarball, shallow clone, `dock-app:remote`; nothing built locally), plus why
  `bash -c "$(curl …)"` needs a `$0` placeholder word before any flags. And
  the checkout-free **uninstaller** `tools/uninstall-mac.sh [--force]`
  (LaunchAgents, this user's processes and Serve paths, apps → Trash + Dock
  tiles, global CLI; keeps `~/.dsh` and the checkouts) with the two `pgrep`
  facts it surfaced (ancestor exclusion → `-a`; the script text as argv).
- `browser-automation-plugin.md` — per-chat Safari Technology Preview /
  Chrome windows and the isolated page reader (`browser-automation` plugin):
  why a plugin and not MCP config, the STP `--mcp` facts that shape it, the
  live profile row, the attempts that failed (incl. chrome-devtools-mcp's
  silent ≥ 2 MB screenshot spill-to-disk), and the failure-reporting layer
  (`explainFailure` / `FAILURE_HINTS`) every `safari_*`/`chrome_*` error
  passes through.
- `client-bundle-rebuild-kills-pending-prompts.md` — `ask_user_question`
  fails with `NO_PROVIDER` ("no user-questions answerer accepted the
  request") seconds after a live-profile client bundle is rebuilt: the HMR
  swap tears down every plugin injecting `sessions`, `ui-user-questions`
  delegates the pending prompt, and the gateway reads a last-client `next`
  as "nobody can answer". Same for approvals. Not a rebase regression; no
  fork fix by decision (drafted handover-across-reload approach recorded);
  just re-ask, and rebuild in the preview server instead.
- `cloudflare-remote-control.md` — phone remote control via dsh-full-remote
  behind cloudflared: install + profile patch, the 反向代理 locale bug and its
  root cause, the `taliesinb/dsh-full-remote` fork (`~/github/dsh-full-remote`,
  branch `tali/main`) with the reactive-locale fix and the **Tailscale route**
  feature (why port-based not `/dsh`, the tagged-node login-allowlist facts,
  the identity-header trust conditions vs cloudflared spoofing, `tailscale
  serve` CLI syntax), plus Phase 2 (named tunnel + Cloudflare Access).
- `dash-docsets-plugin.md` — Dash 8 docsets as native tools (`dash-docsets`
  plugin): the Dash HTTP API facts (port file, endpoints, anchors, FTS
  quirks), why native tools instead of Kapeli's MCP server, the in-process
  HTML→Markdown decision, install/test commands, and the failure table.
- `foreign-link-opener-plugin.md` — Dock-installed (Safari "Add to Dock") DSH
  web app opening other-port/other-host links in a new DSH window: why the
  manifest cannot fix it (web-app scope is host-only, `window.open` never
  leaves the app) and the `foreign-link-opener` plugin that hands such links
  to real Safari via `open -a`.
- `dock-app-via-tailnet.md` — the DSH Dock app as a native WKWebView wrapper
  (`dsh-tailscale-remote/dock-app`) admitted by this Mac's own Tailscale
  identity, plus the always-on relay LaunchAgent that starts `dsh web` on a
  cold open: why the Safari web app broke (30-day cookie, no URL bar), why a
  web-app bundle cannot be fabricated (LS template-app data vault), why not
  GUI-scripting Safari (TCC/cdhash), the relay's "answer first, start DSH,
  self-reloading splash" trick, the proxy's Host/Origin fence and
  `ownsHost` injection, the live rollout order while the old host code still
  ran, and the Dock-plist `<data>` trap. The wrapper's menu bar also carries
  **Settings… (⌘,)**, impossible in Safari — see
  `settings-keyboard-shortcut-plugin.md`.
- `fs-tools-plugin.md` — batch filesystem tools beside the built-ins
  (`fs-tools` plugin: `list_dir` with directories, `read_many` that emits
  `fs/observed`, `edit_many` validated-before-write across files, `search` =
  ripgrep with context/files/count/include/exclude): the corpus evidence from
  `rsi/tool-analysis-02-validation.md` (bash mutates files 1.5× more than
  edit+write; `edit` 19 % error rate), how the read-guard integration works
  (`fs/edit-intent` waterfall + `fs/observed`), the headless e2e method, and
  the Cordis `inject`/HarnessError/`oneOf`/glob-anchoring traps.
- `import-claude-code-sessions.md` — migrating Supacode/Claude Code transcripts
  (and their project memory) into DSH sessions: why Supacode keeps no
  transcripts, the session-log frame contract, the converter tool in
  `tools/`, and the installed `dsh-import-agents` plugin alternative.
- `inline-links-remote-audit.md` — audit (no code) of what the client
  auto-links in agent output (GFM allowlist, inline-code URLs, `#L` file
  links, produced-file mentions, `WebBlock`) and what a click does, then what
  becomes of `127.0.0.1`/`localhost` links from a DSH Remote session viewed in
  the Dock app and from a `dsh-remote-workspaces` hybrid frame: loopback is
  always the *client's*, `localWebUrl` hard-codes the server's, the Browser's
  `application-origin` check is against the local origin inside the frame,
  file links stay correct via the document-relative API; the seams a fix
  would use — and the fix built on them (2026-09-23): transparent loopback
  port forwarding in the DSH Remote Dock app (`forward.mjs` upgrade route
  with the `lsof` uid guard + `PortForward.swift`; the `NWListener` EINVAL
  and multi-file `swiftc` traps; what is still unmeasured).
- `install-rewind-plugin.md` — session rewind plugin install.
- `model-titles-not-slugs-on-new-instance.md` — model-generated session
  titles come out as natural phrases instead of `foo-bar-baz` on a freshly
  bootstrapped instance (DSH Remote, 2026-09-22): the slug shape is the fork's
  `style: slug` on the in-tree `session-title-llm` row, set only in this Mac's
  `~/.dsh/profiles/web/cordis.patch.yml` and never by `bootstrap-mac.sh`; how
  to read `source.kind` from `session/title` events, the preview
  reproduction + fix, and the per-account rollout on the shared remote machine
  (live patch reload, no restart; host details stay in `extras/`).
- `notion-mcp.md` — Notion's hosted MCP server in the web profile: why DSH's
  mcp-client can't do OAuth, the `mcp-remote` stdio bridge, the one-time
  terminal login into `~/.mcp-auth`, and the sandbox/`npx` EPERM trap.
- `numbered-session-switching-plugin.md` — ⌘1…⌘5 between the five most
  recently viewed sessions, numbers in the sidebar gutter
  (`numbered-switching` plugin): the post-rebase selection facts (no
  `list.current`; current = `retainedBy.mainView`, open =
  `ctx.uiWorkspace.openSession`), row→session identity through React's
  fiber expando (rows carry no id), the badge-in-the-padding-box geometry,
  why only the WKWebView Dock app receives ⌘digit, the PID-keyed
  AX/`CGEvent.postToPid` method for testing real chords — because System
  Events resolves both same-named "DSH" apps to the LIVE one — and the
  optional coupling to `dsh-remote-workspaces` (`ctx.provide` +
  `ctx.inject` for a sibling plugin; "absent is not gone"; the same-origin
  embed frame shares `sessionStorage` and must opt out).
- `plugin-inject-string-content-bug.md` — "This turn failed: content.some is
  not a function": a host plugin passed a bare string as `agent.inject`
  `content`, poisoning the session log; the `UserMessage` shape rule, the fix
  in `browser-automation`/`<private-plugin>`, and the
  `repair-session-string-content.mjs` log-repair tool (zstd multi-frame and
  packed-chunk-row traps).
- `instance-identity.md` — telling the DSH / DSH Preview / DSH Remote windows
  apart (`instance-identity` plugin, host-only, plus the Dock-app wrapper):
  a `webserver/index-inject` `<style>` row renames the wordmark via
  `::before{content}` on the existing span (`display:flex;font-size:0` — the
  17.5px-strut trap), colours the whale (`fill="currentColor"`;
  `_brandMark` + the rail's `_railMark`) and dims the baked-in version chip; a
  body-placed script row rewrites `document.title` behind `DocumentTitle`; why
  the `common` locale namespace cannot be overridden; the wrapper's own
  `__DSH_DOCK__` + `!important` copy of the rules so DSH Remote reads right
  with no plugin on its server; rebuilding the three Dock apps from their
  `dsh-dock-app.json` specs.
- `per-session-qr-code.md` — a QR button in the Session header (top right)
  whose code opens *that one Session* chrome-less on a phone: the fork's
  `?embed=<sessionId>` page at the tailnet route, riding the standing token
  (or identity) — a UI feature, deliberately not a security boundary (what
  real per-session scoping of `/api` + the mux would take, and why not); the
  `conversation.session.header.utilities` slot, the proxy exchange now
  keeping the query, the `session-` prefix trap, phone-width facts, the
  `/tmp`-copy trial so the live bundle is not hot-swapped, and the `CI=true
  pnpm install` purge trap.
- `phone-ui.md` — chat-only Session chrome on phone-width viewports
  (`phone-ui` plugin, host-only `<style>` row in a `max-width` media query):
  hides the Session header + Chat/Trajectory tabs, the per-message icon
  rows and the composer stats dock (incl. the context meter) below 640px,
  in the full GUI and the `?embed` page alike, then 8px side margins (text
  and composer card on one edge), no code-block banner rows and half the
  code-block/user-bubble rounding; the `data-slot="…"` outlets as the
  unhashed hooks for chrome without attributes of its own, the DOM facts
  per target (`.md-code-block` + its radius variable, the `.scroll`
  padding formula), the **cascade trap** (client CSS is injected after the
  `index-inject` rows, so a specificity tie loses — and a console-appended
  trial hides it), the STP `safari_set_viewport_size 390×844` trial (no
  device emulation needed), the Dock apps' **View ▸ Desktop / Mobile**
  switch (`<html data-dsh-view="mobile">` from a re-registered document-start
  script + a 390×844 resize; the plugin emits every rule twice so the flag
  alone selects the phone view), the PID-keyed `ax-drive.swift` that tests
  the wrapper's menus where System Events picks the wrong "DSH", the
  **mobile composer** (browser half: bottom tongue + full-screen entry over
  `inputActions.setDraft/submit`, stop via the session's `cancel()`,
  caret memory, sheet sized to `visualViewport` because iOS covers rather
  than shrinks the layout viewport, React ignores synthetic `input`
  events), the iOS "never finishes loading" root cause (client-hmr's
  mid-load `EventSource` — deferred past `load` by a head-script shim), and
  the rest of the phone pass still open (sidebar rail, right dock).
- `preview-identity.md` — superseded stub (2026-09-05 red favicon + "DSH-dev"
  manifest for the Safari Dock preview; the dev-overlay/profile collision rule).
- `promotion-loop-and-duplicate-dsh-tools.md` — the two faults that made the
  live GUI blank and every tool call die after the 2026-09-18 promotion:
  a `launchctl submit` one-shot script is **keepalive by default** (an
  install→build→restart loop rewrote `apps/web/dist` under the live server
  every 25 s for an hour), and `@deepseek-ai/dsh-tools` loaded twice (src via
  tsconfig paths, lib via one row resolved through `node_modules`) so the
  module-local `TOOL_RUNTIME_SCHEDULER` symbol never matched — fixed with
  `Symbol.for` (fork commit `9384b80976`; re-apply on every rebase).
- `rebase-fork-on-upstream.md` — trialing a rebase of the `feat/embed-session`
  fork onto `upstream/master` in a separate worktree: the six conflicts and
  their resolutions (selection moved out of the Session Controller into
  ui-workspace, nested-group `renderGroup`, the transport `streamBaseUrl`
  override), the two fix-ups the new upstream gates demand (client-typecheck
  of test doubles, `gen-cordis-catalog` type/event classification), the
  throwaway-home + prefix-stripping-proxy verification of every fork feature,
  the plugin breakages it exposed (turnTail chain→list, `requestBody` on
  Fetch routes), and how to promote the trial branch.
- `session-introspect-plugin.md` — model-facing `transcript_*` tools for
  reading *other* agents' transcripts (`session-introspect` plugin: find by
  `workspace/title`, per-turn outline, timeline render, per-tool error/latency
  stats with what-happened-next, grep, raw event; `fmt` text/json/jsonl and
  `out_file` via `ctx.fs` on every tool) over `ctx.sessionQuery`; the survey
  (in-tree `tool-session-query` is unmounted and same-cwd-only; the `@session`
  mention drops tool events), the five-session evidence of agents hand-decoding
  `~/.dsh/sessions/*/session*.jsonl.zstd`, the on-disk format census and the
  `session.v3.jsonl.zstd` stale-copy trap, the headless end-to-end test method
  against a copied home, and the first corpus-wide findings (incl. 11 sessions
  the current reader refuses).
- `session-title-slug-plugin.md` — name a New Session at creation by starting
  its first prompt with `some-slug: ` (`session-title-slug` plugin): the
  survey of why the blank row's label is unreachable through data (blank
  until `turn/start`, `single` browser slot, one-owner locale namespaces) and
  hence a DOM preview; why the rename waits for the local `blank` flip and
  reads the submission echo, not the draft or input phase; the
  `SSH_TTY` trick that keeps the preview's directory picker in the browser.
- `settings-keyboard-shortcut-plugin.md` — ⌘. toggles the web GUI Settings
  panel (`settings-shortcut` plugin): why ⌘, is impossible in Safari (the
  app consumes it before the page), the component-local open state that
  forces DOM clicks on `[hash]_[local]` class selectors, and how to test a
  chord with a real System Events keystroke instead of a synthetic one —
  plus (2026-09-22) ⌘, in the WKWebView Dock apps: a real Settings… menu
  item whose action feeds the plugin its ⌘. chord synthetically, with the
  DOM-click fallback for servers without the plugin, tested by PID-posted
  `CGEvent`s.
- `stuck-loading-history-on-session-switch.md` — "Loading history…" forever
  when switching to a mid-turn session in the Dock app: root cause is
  `dsh-util-values` comparing `Function.prototype.toString(Object)` to V8's
  one-line `[native code]` literal, which JavaScriptCore renders multi-line,
  so every object failed the lossless-JSON test and the mid-turn
  assistant-stream baseline threw (fork `319dcb8a56`); plus fork
  `1ab8de08d2` so `doOpen` never leaves `openState='loading'` (local faults
  → `'error'` + `console.error`, 15 s/30 s opening watchdog). The
  `openState` state machine down to the multiplexed socket, why Chrome
  could not reproduce it, the util-values `lib/index.js` host-face
  rebuild trap, and the hot-swap caveat when rebuilding
  `session-controller/lib/client.js`.
- `tailscale-remote-plugin.md` — the DSH GUI at `https://<node>/dsh/` over the
  tailnet: the from-scratch `dsh-tailscale-remote` plugin (loopback proxy +
  `tailscale serve --set-path /dsh` + "Tailscale remote" settings section with
  Enable/Disable, URL, allowed-user list, tokened QR), the DSH branch
  `fix/tailscale-mounting` (document-relative Host URLs; why a worktree), the
  measured Tailscale path-strip facts, and the trailing-slash trap. Ports and
  the Dock app / relay moved on in `dock-app-via-tailnet.md`.
- `transcript-grace-margin.md` — visible "end of transcript" space under the
  last row of an active session (`transcript-grace-margin` plugin, host-only):
  why the shipped client leaves only 16px under a 36px composer fade band,
  the two unhashed hooks (`data-conversation-scroll`, `data-chat-flow`) vs
  the `<hash>_<local>` classes, why padding on the column is safe for
  ChatView's auto-follow / back-to-bottom / turn navigation, the
  console-first verification on the preview and the relay's boot-on-demand
  503.
- `wait-tool-plugin.md` — a `wait` tool replacing bash `sleep N`
  (`wait-tool` plugin, both halves): the model states the duration, so the
  chat draws a live progress bar with **Skip** (returns early, worded as the
  timeout having elapsed) and **Abort** (an error, "user aborted sleep", so
  the model stops and asks); the `status`/`control` Fetch routes with
  session-ownership checks and the server-clock offset, the `defineTool`
  output-DSL trap (`required: true` per property, no array), and why a
  cancelled turn must be thrown as a coded `ABORTED` HarnessError (rejecting
  with `signal.reason` logs `Error: [object Object]`); the throwaway-home +
  Chrome trial that exercised all four settlements.
- `<private-plugin>-graphics3d.md` — native three.js `<private>_show` for
  `Graphics3D` (experiment + implementation, 2026-09-21): the ~26-head box IR that
  `ToBoxes` normalizes every 3D primitive/plot into (and the regions that pass
  through unboxed), why glTF export is too lossy to be the IR (triangles only,
  drops lines/points/text, rejects `Plot3D`), the `dsh-graphics3d/0` JSON
  scene + `Scene3D.wl` translator + `viewer.html` under
  `plugins/<private-plugin>/experiments/graphics3d/`, the measured
  three.js↔<private> lighting facts (π intensities, gamma space, Phong vs
  Blinn, `ImageScaled` z from the back for directional but from the front for
  point lights), sizes vs PNG, and the plugin wiring as built (`kernel/Scene3D.wl`
  + `"scene"` in the `DSH-SHOW` report via a temp file, `saveFile` attachment +
  `/api/<private>/scene`, `manipulate?format=scene` geometry swaps under a
  persistent camera, `src/client/scene3d.tsx`; throwaway-home verification and
  the hidden-command-card-before-first-turn trap).
- `<private-plugin>.md` — per-chat <private>/<private> kernels
  (`<private-plugin>` plugin): the Pi `<private>_Show`/rho archaeology,
  why the paclet fork's Show tool is obsolete, `<private>_show`'s user-only image
  path (presentationMeta + pinned turn-tail gallery + plugin fetch route, and
  the gallery's skip rules for error-box renders / duplicate attachments), the
  SIGTERM-immune kernel and its kill ladder, the client-plugin gotchas, and the
  kernel-location setting (Settings ▸ Plugins ▸ "<private> kernel" card over a
  host settings namespace; cross-platform auto-detection that fills the setting
  in; every tool fails with a configure-me message when nothing is found) with
  the probe-then-`<private>script -configure` hand-off and its `15.` regex trap.

## Doc map (checkout-relative)

| Topic | Path |
|---|---|
| First plugin, tools, config, packaging | `docs/user/develop/basic/` |
| Services & events | `docs/user/develop/framework/` |
| Cordis hands-on tutorial | `docs/cordis-tutorial/` |
| Cordis API reference (generated) | `docs/cordis-api/` |
| Architecture & profile/bundle layering | `docs/architecture.md` |
| Config schema catalog (all shipped plugins) | `docs/config-catalog.md` |
| Tool catalog | `docs/tool-catalog.md` |
| Web client architecture | `docs/subsystems/web-client.md` |
| Slots (full tree + rules) | `docs/subsystems/slots.md` |
| Client module system / dsh.client | `docs/subsystems/client-modules.md` |
| Conversation nodes (chat rendering) | `docs/subsystems/conversation.md` |
| In-tree client house rules | `packages/client/AGENTS.md` |
| Client bundle preset (format truth) | `packages/client/tsdown.client.ts` |
| CLI flags, profiles, layer precedence | `apps/cli/reference/README.md` |

## The optional `extras/` submodule

symbolica-ai/dsh-extras (private): deployment inventory, host scripts, pins of private plugins. Everything that names a host, tailnet, login or internal repo goes there, never here. Missing = fine (no org access); the tooling continues without it. Manifest `extras/dsh-extras.yml`, read by `tools/extras-manifest.mjs`; see recipes/bootstrap-mac-installer.md.
