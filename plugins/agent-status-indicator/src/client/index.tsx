/**
 * Agent status indicator, browser half. A stack of large emoji pinned to the
 * bottom-right of the chat area: every agent state *transition* appends an
 * entry at the bottom and the older entries animate upward. Only the 4 most
 * recent entries show; historical ones render at half opacity.
 *
 *   🙂          waiting — no turn running
 *   🤨          thinking — turn running, no tool call in flight (pi-web glyph)
 *   <tool>      a tool call is in flight: its pi-web emoji ($ bash, ✏️ edit,
 *               👁️ read, 🔍 search, 🌐 web, 🤖 subagent, ... 🔧 fallback);
 *               each distinct call (by callId) is its own entry
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
import { useEffect, useRef, useState } from 'react'
import { resolveToolGlyph, thinkingGlyph } from './toolIcons.ts'

type Props = PropsRuntime<'conversation.input.dock'>

const WAITING = '\u{1F642}' // 🙂
const ERROR = '\u{1F636}' // 😶
const BLOCKED_BADGE = '\u270B' // ✋

/** Most recent entries kept on screen (newest at the bottom). */
const STACK_SIZE = 4
/** Vertical distance between stacked entries, px. */
const STACK_GAP = 52

interface StackEntry {
  readonly key: number
  readonly glyph: string
  readonly label: string
  readonly badge: boolean
}

/** One observed status: `identity` changes exactly when a new entry is due. */
interface Status {
  readonly identity: string
  readonly glyph: string
  readonly label: string
  readonly badge: boolean
}

function AgentStatusIndicator({ useSession, useChat, useSessionPendingInteraction, sessionId }: Props) {
  const running = useSession(snapshot => snapshot.running)
  const hasError = useSession(snapshot => snapshot.lastAgentError !== null)
  const blocked = useSessionPendingInteraction(pending => pending.has(sessionId))
  // Selector returns a primitive ("callId|glyph") so re-renders happen only
  // when the in-flight call changes, not on every streaming publication.
  const runningCall = useChat(chat => {
    const calls = chat.legacy.runningCalls
    const call = calls.length > 0 ? calls[calls.length - 1] : undefined
    return call === undefined ? null : `${call.callId}|${resolveToolGlyph(call.name, call.argsRaw)}`
  })

  let status: Status
  if (blocked) {
    const glyph = runningCall === null ? resolveToolGlyph('default') : runningCall.split('|')[1]!
    status = { identity: `blocked:${glyph}`, glyph, label: 'blocked on your input', badge: true }
  } else if (runningCall !== null) {
    const [callId, glyph] = runningCall.split('|') as [string, string]
    status = { identity: `tool:${callId}`, glyph, label: 'running a tool', badge: false }
  } else if (running) {
    status = { identity: 'think', glyph: thinkingGlyph(), label: 'thinking', badge: false }
  } else if (hasError) {
    status = { identity: 'error', glyph: ERROR, label: 'error', badge: false }
  } else {
    status = { identity: 'wait', glyph: WAITING, label: 'waiting', badge: false }
  }

  const [entries, setEntries] = useState<readonly StackEntry[]>([])
  const lastIdentity = useRef<string | null>(null)
  const seq = useRef(0)
  const { identity, glyph, label, badge } = status
  useEffect(() => {
    if (identity === lastIdentity.current) return
    lastIdentity.current = identity
    seq.current += 1
    const entry: StackEntry = { key: seq.current, glyph, label, badge }
    setEntries(prev => [...prev, entry].slice(-STACK_SIZE))
  }, [identity, glyph, label, badge])

  return (
    <div className="tali-agent-status-stack">
      {entries.map((entry, index) => {
        const fromBottom = entries.length - 1 - index
        return (
          <div
            key={entry.key}
            className="tali-agent-status-entry"
            style={{ bottom: `${fromBottom * STACK_GAP}px`, opacity: fromBottom === 0 ? 1 : 0.5 }}
            role={fromBottom === 0 ? 'status' : undefined}
            aria-label={fromBottom === 0 ? `agent status: ${entry.label}` : undefined}
          >
            {entry.glyph}
            {entry.badge && <span className="tali-agent-status-badge">{BLOCKED_BADGE}</span>}
          </div>
        )
      })}
    </div>
  )
}

/** Plugin-owned stylesheet (we have no CSS build pipeline; injected as an effect). */
const CSS = `
.tali-agent-status-stack {
  position: fixed;
  right: 16px;
  bottom: 10px;
  z-index: 60;
  pointer-events: none;
}
.tali-agent-status-entry {
  position: absolute;
  right: 0;
  font-size: 44px;
  line-height: 1;
  user-select: none;
  filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.3));
  transition: bottom 300ms ease, opacity 300ms ease;
  animation: tali-agent-status-in 300ms ease;
}
.tali-agent-status-badge {
  position: absolute;
  right: -6px;
  top: -10px;
  font-size: 20px;
}
@keyframes tali-agent-status-in {
  from { opacity: 0; transform: translateY(${STACK_GAP / 2}px); }
  to { transform: none; }
}
`

export const name = 'agent-status-indicator'
export const inject = ['slots']

/**
 * Client plugin body: inject the stylesheet and contribute the indicator into
 * the input dock once its owner (ui-conversation) has declared the slot.
 * @param ctx - browser-side cordis context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'tali-agent-status-indicator'
    tag.textContent = CSS
    document.head.appendChild(tag)
    return () => tag.remove()
  })
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      { name: 'conversation.input.dock', id: 'tali-agent-status', order: 100 },
      AgentStatusIndicator,
    ))
}
