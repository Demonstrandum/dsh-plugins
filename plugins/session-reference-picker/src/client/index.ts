/** `%` session-only reference picker. */
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {
  ClientSessionContext, InputTriggerServiceContract, InputTriggerSource,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { filterSessionPickerItems, relativeSessionAge, sessionLabelSegments, sessionPickerItems } from './catalog.ts'
import { formatSessionReferenceMention } from './mention.ts'

export const name = 'session-reference-picker-client'
export const inject = ['inputTriggers', 'sessions', 'workspaces']

export function apply(ctx: Context): void {
  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  const sessions = ctx.get('sessions') as ISessions
  const workspaces = ctx.get('workspaces') as IWorkspaces
  const source: InputTriggerSource = {
    trigger: '%',
    name: 'session-reference',
    showGroupTitle: false,
    candidates(session: ClientSessionContext, { query, signal }) {
      if (signal.aborted) return Promise.resolve([])
      const catalog = sessionPickerItems(
        sessions.list.getSnapshot(),
        workspaces.list.getSnapshot(),
        session.sessionId,
      )
      const now = Date.now()
      return Promise.resolve(filterSessionPickerItems(catalog, query).map(item => ({
        name: item.qualifiedName,
        labelSegments: sessionLabelSegments(item.workspaceName, item.sessionName),
        description: relativeSessionAge(item.updatedAt, now),
        icon: 'session' as const,
        value: JSON.stringify({ sessionId: item.sessionId, label: item.qualifiedName }),
      })))
    },
    onPick({ candidate }) {
      const value = parseValue(candidate.value)
      if (value === undefined) return undefined
      const mention = formatSessionReferenceMention(value.sessionId, value.label)
      return {
        insert: {
          source: 'session-reference',
          ref: mention,
          label: value.label,
          appearance: 'session',
          clipboardText: mention,
        },
      }
    },
    codec: {
      clipboardText: ref => ref,
      serialize: ref => Promise.resolve(ref),
    },
  }
  ctx.effect(() => inputTriggers.registerSource(source), 'session-reference-picker: % source')
}

function parseValue(value: string | undefined): { sessionId: string; label: string } | undefined {
  if (value === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    return typeof record.sessionId === 'string' && typeof record.label === 'string'
      ? { sessionId: record.sessionId, label: record.label }
      : undefined
  } catch {
    return undefined
  }
}
