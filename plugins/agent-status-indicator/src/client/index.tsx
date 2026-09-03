/**
 * Agent status indicator, browser half. Registers a large floating emoji into
 * the conversation input dock (session scope) that reflects the current
 * session's agent state:
 *
 *   🙂 waiting   — no turn running
 *   😕 thinking  — a turn is running
 *   🔧 blocked   — a pending interaction (tool approval / user question) waits on you
 *   😶 error     — the last agent turn reported an error
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only imports (erased at build time): they declaration-merge the slots
// service onto ctx, the 'conversation.input.dock' SlotMap key, and the
// session-scope standard props (useSession, useSessionPendingInteraction).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CSSProperties } from 'react'

type Props = PropsRuntime<'conversation.input.dock'>

type Mood = 'waiting' | 'thinking' | 'blocked' | 'error'

const FACE: Record<Mood, string> = {
  waiting: '\u{1F642}', // 🙂
  thinking: '\u{1F615}', // 😕
  blocked: '\u{1F527}', // 🔧
  error: '\u{1F636}', // 😶
}

const floating: CSSProperties = {
  position: 'fixed',
  right: '28px',
  bottom: '120px',
  fontSize: '44px',
  lineHeight: 1,
  zIndex: 60,
  userSelect: 'none',
  pointerEvents: 'none',
  filter: 'drop-shadow(0 2px 6px rgba(0, 0, 0, 0.3))',
}

function AgentStatusIndicator({ useSession, useSessionPendingInteraction, sessionId }: Props) {
  const running = useSession(snapshot => snapshot.running)
  const hasError = useSession(snapshot => snapshot.lastAgentError !== null)
  const blocked = useSessionPendingInteraction(pending => pending.has(sessionId))
  const mood: Mood = blocked ? 'blocked' : running ? 'thinking' : hasError ? 'error' : 'waiting'
  return (
    <div style={floating} role="status" aria-label={`agent status: ${mood}`}>
      {FACE[mood]}
    </div>
  )
}

export const name = 'agent-status-indicator'
export const inject = ['slots']

/**
 * Client plugin body: contribute the indicator into the input dock once its
 * owner (ui-conversation) has declared the slot.
 * @param ctx - browser-side cordis context.
 */
export function apply(ctx: Context): void {
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      { name: 'conversation.input.dock', id: 'tali-agent-status', order: 100 },
      AgentStatusIndicator,
    ))
}
