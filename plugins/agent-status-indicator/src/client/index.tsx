/**
 * Agent status indicator, browser half. A large floating emoji pinned to the
 * bottom-right of the chat area reflecting the current session's agent state:
 *
 *   🙂          waiting — no turn running
 *   🤨          thinking — turn running, no tool call in flight (pi-web glyph)
 *   <tool>      a tool call is in flight: its pi-web emoji ($ bash, ✏️ edit,
 *               👁️ read, 🔍 search, 🌐 web, 🤖 subagent, ... 🔧 fallback)
 *   🔧+badge ✋  a pending interaction (approval / question) blocks on you
 *   😶          error — the last agent turn reported an error
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only imports (erased at build time): they declaration-merge the slots
// service onto ctx, the 'conversation.input.dock' SlotMap key, and the
// session-scope standard props (useSession, useChat, useSessionPendingInteraction).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CSSProperties } from 'react'
import { resolveToolGlyph, thinkingGlyph } from './toolIcons.ts'

type Props = PropsRuntime<'conversation.input.dock'>

const WAITING = '\u{1F642}' // 🙂
const ERROR = '\u{1F636}' // 😶
const BLOCKED_BADGE = '\u270B' // ✋

const floating: CSSProperties = {
  position: 'fixed',
  right: '16px',
  bottom: '10px',
  fontSize: '44px',
  lineHeight: 1,
  zIndex: 60,
  userSelect: 'none',
  pointerEvents: 'none',
  filter: 'drop-shadow(0 2px 6px rgba(0, 0, 0, 0.3))',
}

const badge: CSSProperties = {
  position: 'absolute',
  right: '-6px',
  top: '-10px',
  fontSize: '20px',
}

function AgentStatusIndicator({ useSession, useChat, useSessionPendingInteraction, sessionId }: Props) {
  const running = useSession(snapshot => snapshot.running)
  const hasError = useSession(snapshot => snapshot.lastAgentError !== null)
  const blocked = useSessionPendingInteraction(pending => pending.has(sessionId))
  // Selector returns the derived glyph (a primitive) so re-renders happen only
  // when the effective emoji changes, not on every streaming publication.
  const toolGlyph = useChat(chat => {
    const calls = chat.legacy.runningCalls
    const call = calls.length > 0 ? calls[calls.length - 1] : undefined
    return call === undefined ? null : resolveToolGlyph(call.name, call.argsRaw)
  })
  const glyph = blocked
    ? (toolGlyph ?? resolveToolGlyph('default'))
    : toolGlyph ?? (running ? thinkingGlyph() : hasError ? ERROR : WAITING)
  const label = blocked
    ? 'agent status: blocked on your input'
    : toolGlyph !== null
      ? 'agent status: running a tool'
      : running ? 'agent status: thinking' : hasError ? 'agent status: error' : 'agent status: waiting'
  return (
    <div style={floating} role="status" aria-label={label}>
      {glyph}
      {blocked && <span style={badge}>{BLOCKED_BADGE}</span>}
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
