# AGENTS.md — tali-dash-plugins

Local-only plugins for DeepSeek Harness (DSH). This file is the onboarding
guide for agents working in this repo: how DSH plugins work, how this repo is
laid out, and where the authoritative docs live.

## Ground rules

- The DSH source checkout is at `~/github/deepseek-harness`. All doc paths
  below are relative to that checkout. **Verify APIs against the checkout**
  before relying on this file — it is a summary, the checkout is the truth.
- Plugins are developed **out-of-tree** (this repo). Never fork/patch DSH to
  add a feature: "There is no privileged core to patch: you extend dsh by
  mounting a plugin beside the others" (`docs/architecture.md`).
- Layout: one plugin = one directory under `plugins/`, each an installable npm
  package. `cordis.dev.yml` at the repo root is the dev overlay that loads all
  of them by absolute path (machine-specific, that is fine — local-only repo).

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
   cd ~/github/deepseek-harness
   pnpm dsh web --patch /Users/USER/github/tali-dash-plugins/cordis.dev.yml
   ```

   The overlay `insert`s rows whose `name` is an **absolute path** to the
   plugin entry module. Tutorial: `docs/user/develop/basic/index.md`.
   Verify composition without booting: `pnpm dsh web --dump-config --patch ...`.

2. **Installed bundle** (stable plugins): the package declares
   `dsh.bundle.patch` in package.json (see any `plugins/*/cordis.patch.yml`)
   and is installed into a profile with
   `dsh plugin --profile <name> add ./plugins/<dir>` (pnpm-links the local
   directory; `remove` undoes it). Layer order, git installs, and the pnpm
   `allowBuilds` catch: `docs/user/develop/basic/publish.md`.

## Host plugins (Node side)

Register tools, listen to agent events, provide services. Start points:

- `docs/user/develop/basic/tool.md` — the tool-definition DSL (`ctx.tools`).
- `docs/user/develop/framework/` — services, events.
- `docs/user/develop/practice/` — LLM adapters, dynamic composition.
- `docs/agent-lifecycle.md`, `docs/tool-execution-pipeline.md` — agent-loop
  events a host plugin can hook.
- Running from the source checkout, a row may point straight at a `.ts` file
  (the host runs through tsx). Built JS always works.

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
out-of-tree equivalent is `plugins/agent-status-indicator/build.mjs` (esbuild).
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
cd plugins/<plugin> && pnpm watch        # rebuilds lib/client.js on save
cd ~/github/deepseek-harness && pnpm dsh web --patch .../cordis.dev.yml
```

The server's HMR node half stat-polls every graph row's bundle and pushes
changed bundles to the browser without a manual refresh (dev boots only; see
`docs/subsystems/client-modules.md`). If nothing loads: check the terminal for
the activation `AggregateError`, then `--dump-config`, then fiber state
(PENDING = missing service, `docs/cordis-tutorial/06-composition-and-hmr.md`).

### Type-checking against the checkout

Each plugin declares `link:` devDependencies pointing into the checkout
(`vendor/cordis`, `packages/client/ui-slots`, ...) so `pnpm typecheck` sees
the real d.ts files. Links are absolute paths — regenerate if the checkout
moves. esbuild does not type-check; the build works even if types drift.

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
