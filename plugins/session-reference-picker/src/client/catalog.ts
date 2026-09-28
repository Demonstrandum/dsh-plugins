import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'

export interface SessionPickerItem {
  readonly sessionId: string
  readonly workspaceName: string
  readonly sessionName: string
  readonly qualifiedName: string
  readonly updatedAt: number
}

/** Build the recent-first ordinary-session catalog rendered by the percent picker. */
export function sessionPickerItems(
  sessions: SessionListState,
  workspaces: WorkspaceSnapshot,
  currentSessionId: string,
): SessionPickerItem[] {
  const workspaceBySession = new Map<string, string>()
  for (const workspace of workspaces.items) {
    for (const sessionId of workspace.sessionIds) workspaceBySession.set(sessionId, workspace.title)
  }
  const archived = new Set<string>(workspaces.archivedSessionIds)
  const items: SessionPickerItem[] = []
  for (const sessionId of sessions.ids) {
    const session = sessions.byId[sessionId]
    if (session === undefined || session.id === currentSessionId || session.origin === 'subagent'
      || session.blank || archived.has(session.id)) continue
    const workspaceName = workspaceBySession.get(session.id) ?? fallbackWorkspaceName(session.cwd)
    items.push({
      sessionId: session.id,
      workspaceName,
      sessionName: session.displayTitle,
      qualifiedName: `${workspaceName}/${session.displayTitle}`,
      updatedAt: session.updatedAt,
    })
  }
  return items.sort((left, right) => right.updatedAt - left.updatedAt
    || left.qualifiedName.localeCompare(right.qualifiedName))
}

/** Apply `%foo` full-name or `%foo/bar` component-aware matching. */
export function filterSessionPickerItems(items: readonly SessionPickerItem[], query: string): SessionPickerItem[] {
  const normalized = query.toLocaleLowerCase()
  const slash = normalized.indexOf('/')
  if (slash < 0) {
    return items.filter(item => item.qualifiedName.toLocaleLowerCase().includes(normalized))
  }
  const workspaceNeedle = normalized.slice(0, slash)
  const sessionNeedle = normalized.slice(slash + 1)
  return items.filter(item => item.workspaceName.toLocaleLowerCase().includes(workspaceNeedle)
    && item.sessionName.toLocaleLowerCase().includes(sessionNeedle))
}

function fallbackWorkspaceName(cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return '(unregistered)'
  const normalized = cwd.replaceAll('\\', '/').replace(/\/+$/u, '')
  return normalized.slice(normalized.lastIndexOf('/') + 1) || '(unregistered)'
}

/** Structured display pieces for `workspace / session`; identity remains the unspaced qualified name. */
export function sessionLabelSegments(workspace: string, title: string) {
  return [
    { text: workspace },
    { text: ' / ', dim: true },
    { text: title },
  ] as const
}

/** Compact relative activity age matching the existing session-reference picker style. */
export function relativeSessionAge(updatedAt: number, now: number = Date.now()): string {
  const elapsed = Math.max(0, now - updatedAt)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (elapsed < minute) return 'now'
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}min`
  if (elapsed < day) return `${Math.floor(elapsed / hour)}h`
  return `${Math.floor(elapsed / day)}d`
}
