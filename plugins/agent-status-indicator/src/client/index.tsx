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
import { EXT_TO_TYPE, FINAL_BADGES } from './finalBadges.ts'

type Props = PropsRuntime<'conversation.input.dock'>

const WAITING = '\u{1F642}' // 🙂
const ERROR = '\u{1F636}' // 😶
const BLOCKED_BADGE = '\u270B' // ✋

/** Most recent entries kept on screen (newest at the bottom). */
const STACK_SIZE = 4
/** Vertical distance between stacked entries, px. */
const STACK_GAP = 56

/**
 * Tools whose file_path argument selects a document-type icon, mapped to the
 * activity decoration shown at its bottom-right: pencil for editing, plus for
 * creating/adding, eyeball for looking.
 */
const FILE_TOOL_ACT: Readonly<Record<string, string>> = {
  edit: '\u270F\uFE0F', // ✏️
  write: '\u2795', // ➕
  read: '\u{1F441}\uFE0F', // 👁️
  read_image: '\u{1F441}\uFE0F', // 👁️
}

/** Activity decoration for running a script through a shell command. */
const RUN_ACT = '\u25B6\uFE0F' // ▶️

/** Interpreter/launcher commands whose file argument identifies the script. */
const RUNNERS = new Set([
  'node', 'ruby', 'perl', 'php', 'lua', 'rscript', 'swift', 'java',
  'bash', 'sh', 'zsh', 'tsx', 'ts-node', 'bun', 'deno', 'uv', 'uvx', 'go', 'npx',
])

/** Document-type id for a path-ish string's extension, or null. */
function docTypeForPath(path: string): string | null {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return null // dotfiles have no extension
  const ext = base.slice(dot + 1).toLowerCase()
  return Object.hasOwn(EXT_TO_TYPE, ext) ? EXT_TO_TYPE[ext]! : null
}

/**
 * The script a shell command runs, as a document-type id. Splits the command
 * line on shell connectors, then looks for `<runner> [run] <file.ext>` where
 * the runner is a known interpreter/launcher (python/node/uv/npx/go/...);
 * flags and VAR=value assignments are skipped, and the first argument whose
 * extension maps to a known type wins.
 * @param command - the bash tool's command string.
 * @returns a FINAL_BADGES key, or null when no script target is recognized.
 */
function scriptTargetType(command: string): string | null {
  for (const segment of command.split(/&&|\|\||;|\|/)) {
    const tokens = segment.trim().split(/\s+/).filter(token => token !== '')
    // Skip leading VAR=value environment assignments.
    let index = 0
    while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!)) index += 1
    const head = tokens[index]
    if (head === undefined) continue
    const runner = head.slice(head.lastIndexOf('/') + 1).toLowerCase()
    if (!RUNNERS.has(runner) && !/^python[\d.]*$/.test(runner)) continue
    for (const raw of tokens.slice(index + 1)) {
      const token = raw.replace(/^['"]|['"]$/g, '')
      if (token === 'run' || token === 'exec') continue // uv run / go run / deno run / bun run
      if (token.startsWith('-')) continue // flags
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue
      const type = docTypeForPath(token)
      if (type !== null) return type
      // npx <package> <file>: the package name has no extension; keep scanning.
      if (runner !== 'npx') break // first real argument was not a known script: give up on this segment
    }
  }
  return null
}

/** Doc-type icon + activity decoration for one tool call, or null. */
function fileCallInfo(name: string, argsRaw: string): { doc: string; act: string } | null {
  let args: Record<string, unknown>
  try {
    args = JSON.parse(argsRaw) as Record<string, unknown>
  } catch {
    return null
  }
  if (Object.hasOwn(FILE_TOOL_ACT, name)) {
    const path = args['file_path']
    if (typeof path !== 'string') return null
    const doc = docTypeForPath(path)
    return doc === null ? null : { doc, act: FILE_TOOL_ACT[name]! }
  }
  if (name === 'bash') {
    const command = args['command']
    if (typeof command !== 'string') return null
    const doc = scriptTargetType(command)
    return doc === null ? null : { doc, act: RUN_ACT }
  }
  return null
}

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
  /** Document-type main icon (FINAL_BADGES key) for file-touching calls. */
  readonly docType: string | null
  /** Activity decoration (pencil/plus/eyeball) shown on the doc-type icon. */
  readonly act: string | null
}

/** One observed status: `identity` changes exactly when a new entry is due. */
interface Status {
  readonly identity: string
  readonly token: string
  readonly label: string
  readonly badge: boolean
  readonly docType: string | null
  readonly act: string | null
}

function AgentStatusIndicator({ useSession, useChat, useSessionPendingInteraction, sessionId }: Props) {
  const running = useSession(snapshot => snapshot.running)
  const hasError = useSession(snapshot => snapshot.lastAgentError !== null)
  const blocked = useSessionPendingInteraction(pending => pending.has(sessionId))
  // Selector returns a primitive ("callId|token|docType|act") so re-renders
  // happen only when the in-flight call changes, not per streaming frame.
  const runningCall = useChat(chat => {
    const calls = chat.legacy.runningCalls
    const call = calls.length > 0 ? calls[calls.length - 1] : undefined
    if (call === undefined) return null
    const info = fileCallInfo(call.name, call.argsRaw)
    return `${call.callId}|${resolveToolGlyph(call.name, call.argsRaw)}|${info?.doc ?? ''}|${info?.act ?? ''}`
  })
  const parsedCall = runningCall === null
    ? null
    : (([, token, doc, act]: string[]) => ({
        token: token!,
        docType: doc === '' ? null : doc!,
        act: act === '' ? null : act!,
      }))(runningCall.split('|'))

  let status: Status
  if (blocked) {
    const token = parsedCall === null ? resolveToolGlyph('default') : parsedCall.token
    status = { identity: `blocked:${token}`, token, label: 'blocked on your input', badge: true, docType: parsedCall?.docType ?? null, act: parsedCall?.act ?? null }
  } else if (runningCall !== null && parsedCall !== null) {
    status = { identity: `tool:${runningCall.split('|')[0]!}`, token: parsedCall.token, label: 'running a tool', badge: false, docType: parsedCall.docType, act: parsedCall.act }
  } else if (running) {
    status = { identity: 'think', token: thinkingGlyph(), label: 'thinking', badge: false, docType: null, act: null }
  } else if (hasError) {
    status = { identity: 'error', token: ERROR, label: 'error', badge: false, docType: null, act: null }
  } else {
    status = { identity: 'wait', token: WAITING, label: 'waiting', badge: false, docType: null, act: null }
  }

  const [entries, setEntries] = useState<readonly StackEntry[]>([])
  const lastIdentity = useRef<string | null>(null)
  const seq = useRef(0)
  const { identity, token, label, badge, docType, act } = status
  useEffect(() => {
    if (identity === lastIdentity.current) return
    lastIdentity.current = identity
    seq.current += 1
    const entry: StackEntry = { key: seq.current, token, label, badge, docType, act }
    setEntries(prev => [...prev, entry].slice(-STACK_SIZE))
  }, [identity, token, label, badge, docType, act])

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
            {entry.docType !== null && FINAL_BADGES[entry.docType] !== undefined
              ? (
                <>
                  <span
                    className="tali-agent-status-docmain"
                    // eslint-disable-next-line react/no-danger -- generated, trusted markup bundled with the plugin
                    dangerouslySetInnerHTML={{ __html: FINAL_BADGES[entry.docType]! }}
                  />
                  {entry.act !== null && <span className="tali-agent-status-act">{entry.act}</span>}
                </>
                )
              : renderIcon(entry.token)}
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
.tali-agent-status-docmain {
  width: 40px;
  height: 40px;
  display: block;
}
.tali-agent-status-docmain svg {
  width: 100%;
  height: 100%;
  display: block;
}
.tali-agent-status-act {
  position: absolute;
  right: -6px;
  bottom: -4px;
  font-size: 20px;
  line-height: 1;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.6));
}
.tali-agent-status-badge {
  position: absolute;
  /* Statically tuned to the macOS emoji ink: the hand's top finger lines up
   * with the top of the default spanner glyph at 40px. */
  right: -2px;
  top: 4px;
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
