/**
 * Agent status indicator, browser half. A stack of large icons pinned to the
 * bottom-right of the chat area: every agent state *transition* appends an
 * entry which rises in from the bottom of the screen while the whole stack
 * shifts up in lockstep (one container FLIP transition, no per-entry motion).
 * Only the 4 most recent entries show; historical ones sit at half opacity.
 *
 *   🙂          waiting — no turn running
 *   🤨          thinking — turn running, no tool call in flight (pi-web glyph)
 *   <tool>      a tool call is in flight: its pi-web icon ([>] bash, ✏️ edit,
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
import type { ReactNode } from 'react'
import { useLayoutEffect, useEffect, useRef, useState } from 'react'
import { resolveToolGlyph, thinkingGlyph } from './toolIcons.ts'

type Props = PropsRuntime<'conversation.input.dock'>

const WAITING = '\u{1F642}' // 🙂
const ERROR = '\u{1F636}' // 😶
const BLOCKED_BADGE = '\u270B' // ✋

/** Most recent entries kept on screen (newest at the bottom). */
const STACK_SIZE = 4
/** Vertical distance between stacked entries, px. */
const STACK_GAP = 56

/** Terminal icon for shell calls: gray-bordered black square, green prompt chevron. */
function TerminalIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
      <rect x="1.5" y="1.5" width="37" height="37" rx="8" fill="#0b0b0d" stroke="#8a8a8e" strokeWidth="2" />
      <path
        d="M12 13 L21 20 L12 27"
        fill="none"
        stroke="#34d399"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Map a resolver token (emoji glyph or `svg:<name>`) to its rendering. */
function renderIcon(token: string): ReactNode {
  if (token === 'svg:terminal') return <TerminalIcon />
  return token
}

interface StackEntry {
  readonly key: number
  readonly token: string
  readonly label: string
  readonly badge: boolean
}

/** One observed status: `identity` changes exactly when a new entry is due. */
interface Status {
  readonly identity: string
  readonly token: string
  readonly label: string
  readonly badge: boolean
}

function AgentStatusIndicator({ useSession, useChat, useSessionPendingInteraction, sessionId }: Props) {
  const running = useSession(snapshot => snapshot.running)
  const hasError = useSession(snapshot => snapshot.lastAgentError !== null)
  const blocked = useSessionPendingInteraction(pending => pending.has(sessionId))
  // Selector returns a primitive ("callId|token") so re-renders happen only
  // when the in-flight call changes, not on every streaming publication.
  const runningCall = useChat(chat => {
    const calls = chat.legacy.runningCalls
    const call = calls.length > 0 ? calls[calls.length - 1] : undefined
    return call === undefined ? null : `${call.callId}|${resolveToolGlyph(call.name, call.argsRaw)}`
  })

  let status: Status
  if (blocked) {
    const token = runningCall === null ? resolveToolGlyph('default') : runningCall.split('|')[1]!
    status = { identity: `blocked:${token}`, token, label: 'blocked on your input', badge: true }
  } else if (runningCall !== null) {
    const [callId, token] = runningCall.split('|') as [string, string]
    status = { identity: `tool:${callId}`, token, label: 'running a tool', badge: false }
  } else if (running) {
    status = { identity: 'think', token: thinkingGlyph(), label: 'thinking', badge: false }
  } else if (hasError) {
    status = { identity: 'error', token: ERROR, label: 'error', badge: false }
  } else {
    status = { identity: 'wait', token: WAITING, label: 'waiting', badge: false }
  }

  const [entries, setEntries] = useState<readonly StackEntry[]>([])
  const lastIdentity = useRef<string | null>(null)
  const seq = useRef(0)
  const { identity, token, label, badge } = status
  useEffect(() => {
    if (identity === lastIdentity.current) return
    lastIdentity.current = identity
    seq.current += 1
    const entry: StackEntry = { key: seq.current, token, label, badge }
    setEntries(prev => [...prev, entry].slice(-STACK_SIZE))
  }, [identity, token, label, badge])

  // Lockstep shift: when an entry is appended, every entry's `bottom` moves up
  // one slot with NO per-entry transition; the container starts one slot down
  // (putting the new entry at the screen's bottom edge) and transitions to
  // rest, so the entire stack rises together in a single motion.
  const stackRef = useRef<HTMLDivElement | null>(null)
  const newestKey = entries.length > 0 ? entries[entries.length - 1]!.key : 0
  const animatedKey = useRef(0)
  useLayoutEffect(() => {
    if (newestKey === animatedKey.current) return
    animatedKey.current = newestKey
    const el = stackRef.current
    if (el === null) return
    el.style.transition = 'none'
    el.style.transform = `translateY(${STACK_GAP}px)`
    void el.offsetHeight // flush so the jump is committed before the transition
    el.style.transition = 'transform 300ms ease'
    el.style.transform = 'translateY(0)'
  }, [newestKey])

  return (
    <div ref={stackRef} className="tali-agent-status-stack">
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
            {renderIcon(entry.token)}
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
  right: 14px;
  bottom: 8px;
  width: 48px;
  z-index: 60;
  pointer-events: none;
  will-change: transform;
}
.tali-agent-status-entry {
  position: absolute;
  right: 0;
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 40px;
  line-height: 1;
  user-select: none;
  filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.3));
  transition: opacity 300ms ease;
}
.tali-agent-status-badge {
  position: absolute;
  right: -4px;
  top: -8px;
  font-size: 20px;
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
