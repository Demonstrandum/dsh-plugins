/**
 * Browser half of dsh-remote-workspaces. Registers:
 *   - `sidebar.workspaces.extra`         the "Remotes" section (fork seat)
 *   - `main` key `remote-session`        the host box the visible frame covers
 *   - `shell.overlay`                    the iframe pool + the add-remote modal
 *
 * Selecting a remote session selects our main panel; the local shell's own
 * `openSession` resets the panel to the Conversation, which hides the pool
 * without destroying it (frames die after 10 minutes hidden, see store.ts).
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only merges: ctx.slots / ctx.layout / the fork's ui-workspace seats.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { createApi, RemoteApiError, type StatusSnapshot } from './api.ts'
import { PANEL_ID, RemoteWorkspacesModel, type RemoteSelection } from './store.ts'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { DestinationEntry, DestinationGroup, DestinationRunResult } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { AddRemoteModal, FramePool, MoveRemoteDialog, RemoteSessionPanel, RemotesSection, type RemoteInjected } from './ui.tsx'

/**
 * The face other browser plugins see as `ctx.remoteWorkspaces` (provided
 * below; consumers `ctx.inject(['remoteWorkspaces'], …)` so they run only
 * while this plugin is loaded and unwind when it goes). First consumer:
 * `numbered-switching`, which numbers remote sessions alongside local ones.
 * Row identity for DOM patchers: every remote session row carries
 * `data-remote-session="<workspaceId>:<sessionId>"` (the frame key).
 */
export interface RemoteWorkspacesFace {
  /** The remote session on screen, or undefined while a local Conversation or another panel shows. */
  getSelection(): RemoteSelection | undefined
  /**
   * Whether the session may still exist. False only on positive evidence —
   * the workspace is no longer mirrored / gone on the remote, or it has been
   * fetched and neither lists the session nor knows it as a blank. Before the
   * first host snapshot, or for a workspace never polled (collapsed group),
   * the answer is true: unknown is not gone.
   */
  has(selection: RemoteSelection): boolean
  /** Select the session and show the remote panel (what a row click does). */
  open(selection: RemoteSelection): void
  /** Fires on any change of the selection, the on-screen state, or the mirrored catalogue. */
  subscribe(listener: () => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    remoteWorkspaces: RemoteWorkspacesFace
  }
}

export const inject = ['slots', 'connection', 'layout']

export function apply(ctx: Context): void {
  const rpc = (ctx as unknown as { connection: { rpc: ClientConnectionRpc } }).connection.rpc
  const api = createApi(rpc)
  const model = new RemoteWorkspacesModel(api)

  const openRemoteSession = (selection: RemoteSelection): void => {
    model.select(selection)
    try {
      ctx.layout.selectPanel(PANEL_ID as MainPanelId)
    } catch (error) {
      console.warn('[remote-workspaces] main panel not registered yet', error)
    }
  }

  const face: RemoteWorkspacesFace = {
    getSelection: () => {
      const view = model.view.getSnapshot()
      return view.remoteActive === true ? view.selected : undefined
    },
    has: (selection) => {
      const runtime = model.runtime.getSnapshot()
      if (!runtime.loaded || runtime.snapshot === undefined) return true
      const workspace = model.workspace(selection.workspaceId)
      if (workspace === undefined || workspace.cache.gone === true) return false
      if (workspace.cache.polledAt === undefined && workspace.cache.sessions.length === 0) return true
      if (workspace.cache.sessions.some(session => session.id === selection.sessionId)) return true
      if (workspace.cache.blankIds?.includes(selection.sessionId) === true) return true
      const selected = model.view.getSnapshot().selected
      return selected?.workspaceId === selection.workspaceId && selected.sessionId === selection.sessionId
    },
    open: openRemoteSession,
    subscribe: (listener) => {
      const stopView = model.view.subscribe(listener)
      const stopRuntime = model.runtime.subscribe(listener)
      return () => { stopView(); stopRuntime() }
    },
  }
  ctx.provide('remoteWorkspaces', face)

  const localWorkspaces = (): readonly { workspaceId: string; title: string; path: string }[] => {
    const workspaces = ctx.get('workspaces') as IWorkspaces | undefined
    return workspaces?.list.getSnapshot().items.map(item => ({ workspaceId: item.workspaceId, title: item.title, path: item.path })) ?? []
  }

  const injected = (): RemoteInjected => ({
    model,
    api,
    openRemoteSession,
    localWorkspaces,
    hooks: { view: model.view, runtime: model.runtime },
  })

  // The shell's own Move to… / Copy to… dialogs on local session rows list
  // our remotes as further destination groups (one per server, after "This
  // machine"); a pick of one comes back to `run` as a cross-host transfer /
  // copy. The groups observable follows the runtime snapshot; its value is
  // memoized per snapshot so an unchanged snapshot yields the same reference.
  ctx.inject(['uiWorkspace'], (scoped) => {
    let memo: { snapshot: StatusSnapshot | undefined; groups: readonly DestinationGroup[] } | undefined
    const groupsOf = (): readonly DestinationGroup[] => {
      const snapshot = model.runtime.getSnapshot().snapshot
      if (memo !== undefined && memo.snapshot === snapshot) return memo.groups
      const byServer = new Map<string, DestinationGroup & { entries: DestinationEntry[] }>()
      for (const workspace of snapshot?.workspaces ?? []) {
        const label = workspace.server?.label ?? workspace.serverId
        let group = byServer.get(workspace.serverId)
        if (group === undefined) {
          group = { id: `server:${workspace.serverId}`, label, entries: [] }
          byServer.set(workspace.serverId, group)
        }
        group.entries.push({ key: workspace.id, title: workspace.title, path: workspace.remotePath })
      }
      memo = { snapshot, groups: [...byServer.values()] }
      return memo.groups
    }
    const failure = (error: unknown): DestinationRunResult => error instanceof RemoteApiError
      ? { ok: false, code: error.code, message: error.message, details: error.details }
      : { ok: false, code: 'remote-workspaces/failed', message: error instanceof Error ? error.message : String(error) }
    scoped.effect(() => scoped.uiWorkspace.contributeDestinations({
      id: 'remote-workspaces',
      order: 10,
      groups: { getSnapshot: groupsOf, subscribe: listener => model.runtime.subscribe(listener) },
      run: async (request) => {
        const destination = model.workspace(request.destinationKey)
        if (destination === undefined) return { ok: false, code: 'remote-workspaces/unknown-workspace', message: 'that remote workspace is no longer mirrored' }
        const where = `${destination.title} on ${destination.server?.label ?? destination.serverId}`
        try {
          if (request.action === 'move') {
            const result = await model.transferSession({
              sessionId: request.sessionId, source: { local: true }, destination: { workspaceId: destination.id },
              ...(request.stopLive === undefined ? {} : { stopLive: request.stopLive }), notify: request.notify,
            })
            const renamed = result.sessionId === request.sessionId ? '' : ` It has a new id there (${result.sessionId.slice(0, 16)}…).`
            return { ok: true, summary: `Moved to ${where} (${String(Math.round(result.bytes / 1024))} KB); the original is archived here.${renamed}` }
          }
          const result = await model.copyAcross({
            sessionId: request.sessionId, source: { local: true }, destination: { workspaceId: destination.id },
            ...(request.truncate === undefined ? {} : { truncate: request.truncate }),
            ...(request.title === undefined ? {} : { title: request.title }),
            notify: request.notify,
          })
          return { ok: true, summary: `Copied to ${where} (${String(Math.round(result.bytes / 1024))} KB); the original is untouched.${result.truncated ? ' The turn in progress was left out of the copy.' : ''}` }
        } catch (error) {
          return failure(error)
        }
      },
    }), 'remote-workspaces: dialog destinations')
  })

  // The "Remotes" section (its own header carries add + refresh-all; nothing
  // is added to the Workspaces header).
  ctx.effect(() => ctx.slots.inject('sidebar.workspaces.extra', () => ctx.slots.register({
    name: 'sidebar.workspaces.extra', id: 'remote-workspaces.section', order: 10, inject: injected,
  }, RemotesSection)), 'remote-workspaces: section')

  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: PANEL_ID, inject: injected,
  }, RemoteSessionPanel)), 'remote-workspaces: main panel')

  ctx.effect(() => ctx.slots.inject('shell.overlay', function* () {
    yield ctx.slots.register({ name: 'shell.overlay', id: 'remote-workspaces.frames', order: 5, inject: injected }, FramePool)
    yield ctx.slots.register({ name: 'shell.overlay', id: 'remote-workspaces.add-modal', order: 50, inject: injected }, AddRemoteModal)
    yield ctx.slots.register({ name: 'shell.overlay', id: 'remote-workspaces.move-dialog', order: 51, inject: injected }, MoveRemoteDialog)
  }), 'remote-workspaces: overlay')

  void model.refresh().then(() => {
    // Reload parity with the local shell, which restores its current Session:
    // if the remote panel was what the operator last looked at, bring it back.
    const view = model.view.getSnapshot()
    if (view.remoteActive === true && view.selected !== undefined && model.workspace(view.selected.workspaceId) !== undefined) {
      openRemoteSession(view.selected)
    }
  })
}
