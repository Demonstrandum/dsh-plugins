/**
 * tali-reload-on-restart — browser half.
 *
 * THE BUG THIS WORKS AROUND (diagnosed 2026-09-22 on the DSH Remote Dock app):
 * when the DSH server restarts and the page's WebSocket later reconnects, the
 * client-hmr plugin's `/plugins/events` EventSource reconnects too and gets
 * the new process's graph. Row revisions are minted per host process
 * (`<nonce>-<n>`), so every rev differs although the bundles are byte-identical,
 * and `ctx.modules.entries.sync(graph)` hot-swaps EVERY client plugin in place.
 * React components render in the gap ("conversation.input: sessions service
 * unavailable", "scope 'session-maybe' rendered without an installed adapter"),
 * the uncaught render error unmounts the React root, and the window is a bare
 * dark <body>: the "black screen". No navigation happens, so neither the
 * relay's "Starting DSH…" splash nor the Dock wrapper's offline page can show.
 *
 * THE FIX: wrap `entries.sync` (the exact call client-hmr makes for a graph
 * frame). When every row the page knows changed rev at once, the page is
 * talking to a new server process: `location.reload()` instead of swapping.
 * A reload boots cleanly against the new process — or, if that process is
 * still coming up, lands on the relay's self-reloading 503 splash. Partial
 * changes (a rebuilt bundle during development) still go through the normal
 * hot-swap; `entries.reload` (rebuilt frames) keeps our revision table current.
 *
 * Why not a fork patch: this is a policy on top of an upstream mechanism
 * (in-place swap) that upstream considers correct; a plugin survives rebases.
 */
import type { Context } from '@deepseek-ai/cordis'
import { classify, graphRows } from './detect.ts'

/** The slice of `ctx.modules` (dsh-client-modules' ClientModuleLoader) this plugin touches. */
interface EntriesLike {
  sync(graph: unknown): Promise<void>
  reload(id: string, rev: string): Promise<void>
}
interface ModulesLike {
  manifest: { modules: readonly { id: string; rev: string }[] }
  entries: EntriesLike
}

export const name = 'reload-on-restart-client'
export const inject = ['modules']

/** Where the reload decision is exposed for tests and the console. */
export interface Installed {
  /** Row id → rev as currently applied in this page. */
  readonly known: Map<string, string>
  /** Undo the wrapping. */
  dispose(): void
}

/**
 * Wrap the entry controller. Exported so a harness can drive it without Cordis.
 * @param modules - the `ctx.modules` service.
 * @param reloadPage - what to do on a detected restart (default `location.reload()`).
 */
export function install(modules: ModulesLike, reloadPage: () => void = () => { location.reload() }): Installed {
  const entries = modules.entries
  const known = new Map<string, string>()
  for (const row of modules.manifest.modules) known.set(row.id, row.rev)

  const originalSync = entries.sync
  const originalReload = entries.reload
  let reloading = false

  const wrappedSync = function sync(this: EntriesLike, graph: unknown): Promise<void> {
    const rows = graphRows(graph)
    const verdict = classify(known, rows)
    if (verdict.kind === 'restart') {
      if (!reloading) {
        reloading = true
        console.warn(`[reload-on-restart] the server restarted (all ${String(verdict.changed)} client bundle revisions re-minted); reloading the page instead of hot-swapping every plugin`)
        reloadPage()
      }
      // Never let the swap start: the page is going away.
      return Promise.resolve()
    }
    if (verdict.kind === 'partial') {
      console.info(`[reload-on-restart] ${String(verdict.changed)}/${String(verdict.common)} bundles changed; letting client-hmr hot-swap them`)
    }
    for (const row of rows) known.set(row.id, row.rev)
    return originalSync.call(this, graph)
  }

  const wrappedReload = function reload(this: EntriesLike, id: string, rev: string): Promise<void> {
    known.set(id, rev)
    return originalReload.call(this, id, rev)
  }

  entries.sync = wrappedSync
  entries.reload = wrappedReload

  return {
    known,
    dispose() {
      // Only undo our own layer; a later wrapper stacked on top stays.
      if (entries.sync === wrappedSync) entries.sync = originalSync
      if (entries.reload === wrappedReload) entries.reload = originalReload
    },
  }
}

export function apply(ctx: Context): void {
  const modules = (ctx as unknown as { modules?: ModulesLike }).modules
  if (modules === undefined || typeof modules.entries?.sync !== 'function') {
    console.warn('[reload-on-restart] ctx.modules.entries.sync not found — the client module system changed shape; plugin inactive')
    return
  }
  ctx.effect(() => {
    const installed = install(modules)
    console.info(`[reload-on-restart] watching ${String(installed.known.size)} client bundle revisions; a server restart reloads the page`)
    return () => { installed.dispose() }
  }, 'reload-on-restart: entries.sync wrapper')
}
