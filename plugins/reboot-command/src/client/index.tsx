/**
 * tali-reboot-command — browser half.
 *
 * Hangs a dialog on the BARE `/reboot` (a ui-commands DECORATION of the host
 * command, so the catalog row, `/reboot now|wait|cancel` and the command/run
 * log stay the host's). The dialog polls the host's control channel once a
 * second while open and shows:
 *
 *   - whether a reboot is a restart (relay in front) or a quit;
 *   - every session with work in flight that a reboot would interrupt, with the
 *     same blocker vocabulary as the Host's "Move to…" refusal, plus queued
 *     follow-ups;
 *   - the armed when-idle state, if any (host-side, so it survives closing
 *     this dialog or this tab, and other clients see it too).
 *
 * Buttons: Cancel · Wait (arm: reboot once every session is idle) · Reboot now.
 * After the reboot fires the dialog stays up and brings the page back itself:
 * it waits for the server to go away, pokes the relay's loopback URL (a page
 * served straight from dsh's port would otherwise wait for the Dock app or a
 * tailnet client to reconnect), and reloads once the origin answers again —
 * belt and braces beside the reload-on-restart plugin.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

const CHANNEL = '/reboot-command'
const COMMAND = 'reboot'
const POLL_MS = 1000

type Blocker =
  | { kind: 'turn' }
  | { kind: 'queue', count: number }
  | { kind: 'jobs', labels: string[] }
  | { kind: 'subagents', count: number, running: number }

interface BusySession { sessionId: string, parentId?: string, blockers: Blocker[] }

interface Relay {
  known: boolean
  configured?: boolean
  instance?: string
  wakeUrl?: string
  loaded?: boolean
  listening?: boolean
  pid?: number
  label?: string
  error?: string
}

interface Status {
  busy: BusySession[]
  armed?: { mode: 'when-idle', since: number, by?: string }
  fired: boolean
  now: number
  relay: Relay
  process: { pid: number, port: number, uptimeSeconds: number, dshHome: string }
}

/** Dialog state owned by the plugin; the overlay component subscribes. */
interface DialogState { open: boolean, sessionId: string | undefined }
type Listener = (state: DialogState) => void

class DialogStore {
  private state: DialogState = { open: false, sessionId: undefined }
  private readonly listeners = new Set<Listener>()
  get(): DialogState { return this.state }
  open(sessionId: string): void { this.set({ open: true, sessionId }) }
  close(): void { this.set({ open: false, sessionId: undefined }) }
  private set(state: DialogState): void { this.state = state; for (const l of this.listeners) l(state) }
  subscribe(l: Listener): () => void { this.listeners.add(l); return () => { this.listeners.delete(l) } }
}

function blockerLabel(blocker: Blocker): string {
  switch (blocker.kind) {
    case 'turn': return 'a turn is running (a model request or tool call)'
    case 'queue': return `${String(blocker.count)} queued message${blocker.count === 1 ? '' : 's'} waiting for the next turn`
    case 'jobs': return `${String(blocker.labels.length)} background job${blocker.labels.length === 1 ? '' : 's'}: ${blocker.labels.slice(0, 3).join(', ')}${blocker.labels.length > 3 ? ', …' : ''}`
    case 'subagents': return blocker.running > 0
      ? `${String(blocker.count)} subagent${blocker.count === 1 ? '' : 's'} loaded, ${String(blocker.running)} running`
      : `${String(blocker.count)} subagent${blocker.count === 1 ? '' : 's'} still loaded`
  }
}

/** What a SIGTERM means here, from the relay facts; `quit` is the dangerous case. */
function relayVerdict(relay: Relay): { kind: 'restart' | 'quit' | 'unknown', text: string } {
  if (!relay.known) return { kind: 'unknown', text: 'No relay plugin is loaded on this server, so nothing here knows what supervises it: DSH comes back only if something outside restarts it.' }
  if (relay.configured === false) return { kind: 'quit', text: 'No relay is configured in front of this DSH (publishPort 0): this would QUIT DSH, and it will not come back by itself.' }
  if (relay.error !== undefined) return { kind: 'unknown', text: `Could not read the relay LaunchAgent (${relay.error}); whether DSH comes back is not known.` }
  if (relay.loaded !== true) return { kind: 'quit', text: `The relay LaunchAgent${relay.label === undefined ? '' : ` ${relay.label}`} is not loaded: this would QUIT DSH, and it will not come back by itself.` }
  return { kind: 'restart', text: `The relay is in front (LaunchAgent pid ${String(relay.pid ?? '?')}): DSH comes back on the next connection and this page reloads through “Starting DSH…”.` }
}

const small = { fontSize: 12, opacity: 0.75 } as const
const mono = { fontFamily: 'var(--dsh-font-mono, ui-monospace, monospace)', fontSize: 12 } as const

function Banner({ tone, children }: { tone: 'info' | 'warn' | 'danger', children: ReactNode }) {
  const color = tone === 'danger' ? 'var(--dsh-color-danger, #d9534f)' : tone === 'warn' ? 'var(--dsh-color-warning, #e0a800)' : 'var(--dsh-color-border, rgba(127,127,127,0.5))'
  return (
    <div style={{ borderLeft: `3px solid ${color}`, padding: '6px 10px', fontSize: 13, lineHeight: 1.45, background: 'rgba(127,127,127,0.07)', borderRadius: 4 }}>
      {children}
    </div>
  )
}

/**
 * After the reboot fired: wait for the server to disappear, then poke the
 * relay and probe our own origin until it answers with anything but the
 * relay's 503 splash, then reload.
 */
function useComeback(active: boolean, wakeUrl: string | undefined, serverGone: boolean): 'idle' | 'going-down' | 'waiting' {
  const [phase, setPhase] = useState<'idle' | 'going-down' | 'waiting'>('idle')
  useEffect(() => {
    if (!active) { setPhase('idle'); return }
    if (!serverGone) { setPhase('going-down'); return }
    setPhase('waiting')
    let stopped = false
    const probe = async (): Promise<void> => {
      if (wakeUrl !== undefined) {
        // Opaque cross-origin GET: the relay only needs to see a connection.
        void fetch(wakeUrl, { mode: 'no-cors', cache: 'no-store' }).catch(() => {})
      }
      try {
        const response = await fetch(`${location.origin}${location.pathname}`, { method: 'HEAD', cache: 'no-store' })
        if (!stopped && response.status !== 503) location.reload()
      } catch { /* still down */ }
    }
    void probe()
    const timer = setInterval(() => { void probe() }, 2000)
    return () => { stopped = true; clearInterval(timer) }
  }, [active, serverGone, wakeUrl])
  return phase
}

function RebootDialog({ store, rpc, sessions }: { store: DialogStore, rpc: ClientConnectionRpc, sessions: ISessions }) {
  const [state, setState] = useState<DialogState>(store.get())
  useEffect(() => store.subscribe(setState), [store])
  const [status, setStatus] = useState<Status | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState(false)
  /** The host said the reboot is under way (from a status poll or our own action). */
  const [fired, setFired] = useState(false)
  /** A status poll failed after firing: the process is gone. */
  const [serverGone, setServerGone] = useState(false)
  const firedRef = useRef(false)

  const call = async (endpoint: string): Promise<Status | undefined> => {
    const result = await rpc.call(CHANNEL, endpoint, { args: { sessionId: state.sessionId } })
    if (!result.ok) throw new Error(result.error.message)
    return result.value as Status
  }

  // Poll while open. After firing, a failed poll is the signal the server is gone.
  useEffect(() => {
    if (!state.open) { setStatus(undefined); setError(undefined); setFired(false); setServerGone(false); firedRef.current = false; return }
    let stopped = false
    const tick = async (): Promise<void> => {
      try {
        const next = await call('status')
        if (stopped || next === undefined) return
        setStatus(next)
        setError(undefined)
        if (next.fired) { firedRef.current = true; setFired(true) }
      } catch (failure) {
        if (stopped) return
        if (firedRef.current) setServerGone(true)
        else setError(failure instanceof Error ? failure.message : String(failure))
      }
    }
    void tick()
    const timer = setInterval(() => { void tick() }, POLL_MS)
    return () => { stopped = true; clearInterval(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.open, state.sessionId])

  const comeback = useComeback(fired, status?.relay.wakeUrl, serverGone)

  const act = async (endpoint: 'now' | 'wait' | 'cancel'): Promise<void> => {
    setPending(true)
    setError(undefined)
    try {
      const next = await call(endpoint)
      if (next !== undefined) {
        setStatus(next)
        if (next.fired) { firedRef.current = true; setFired(true) }
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setPending(false)
    }
  }

  if (!state.open) return null
  const close = (): void => { store.close() }
  const list = sessions.list.getSnapshot()
  const titleOf = (id: string): string => list.byId[id as keyof typeof list.byId]?.displayTitle ?? id
  const cwdOf = (id: string): string | undefined => list.byId[id as keyof typeof list.byId]?.cwd
  const busy = status?.busy ?? []
  const verdict = status === undefined ? undefined : relayVerdict(status.relay)
  const armed = status?.armed
  const where = status === undefined ? '' : ` — pid ${String(status.process.pid)} on :${String(status.process.port)}${status.process.dshHome === '' ? '' : `, ${status.process.dshHome.replace(/^\/Users\/[^/]+/, '~')}`}`

  if (fired) {
    return (
      <Modal open headless title="Rebooting DSH" onClose={() => {}} width={460}>
        <div style={{ padding: 20, fontSize: 13, lineHeight: 1.5 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Rebooting DSH…</div>
          {comeback === 'going-down' && <div>Shutting the server down.</div>}
          {comeback === 'waiting' && <div>The server is down. Waiting for it to answer again, then this page reloads.</div>}
          {verdict?.kind === 'quit' && <div style={{ marginTop: 8, ...small }}>Nothing is set up to start DSH again — start it by hand if this page does not come back.</div>}
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      open
      title="Reboot DSH?"
      closeLabel="Cancel"
      onClose={close}
      width={560}
      footer={<>
        <Button variant="outline" disabled={pending} onClick={close}>{armed === undefined ? 'Cancel' : 'Close'}</Button>
        {armed !== undefined && (
          <Button variant="outline" disabled={pending} onClick={() => { void act('cancel') }}>Cancel armed reboot</Button>
        )}
        {armed === undefined && (
          <Button variant="outline" disabled={pending || status === undefined} title="Arm a reboot that fires once no session has work in flight (2 s of quiet). Survives closing this dialog." onClick={() => { void act('wait') }}>
            {busy.length === 0 ? 'Reboot when idle' : `Wait for ${String(busy.length)}, then reboot`}
          </Button>
        )}
        <Button variant="primary" disabled={pending || status === undefined} style={busy.length > 0 ? { background: 'var(--dsh-color-danger, #c0392b)', borderColor: 'var(--dsh-color-danger, #c0392b)' } : undefined} onClick={() => { void act('now') }}>
          {busy.length === 0 ? 'Reboot now' : `Interrupt ${String(busy.length)} and reboot now`}
        </Button>
      </>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13, lineHeight: 1.45 }}>
        <div>
          Restart this DSH server{where}. Sessions with work in flight are interrupted and resume cold when it is back; a pending question or approval in them has to be asked again.
        </div>
        {verdict !== undefined && <Banner tone={verdict.kind === 'restart' ? 'info' : verdict.kind === 'quit' ? 'danger' : 'warn'}>{verdict.text}</Banner>}
        {status === undefined && error === undefined && <div style={small}>Checking what is running…</div>}
        {status !== undefined && (
          busy.length === 0
            ? <div>No session has work in flight — a reboot interrupts nothing.</div>
            : (
              <div>
                <div style={{ marginBottom: 4 }}>{busy.length === 1 ? 'One session has' : `${String(busy.length)} sessions have`} work in flight that a reboot would interrupt:</div>
                <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {busy.map(row => (
                    <li key={row.sessionId}>
                      <span style={{ fontWeight: 600 }}>{titleOf(row.sessionId)}</span>
                      {row.sessionId === state.sessionId && <span style={{ ...small, marginLeft: 6 }}>(this session)</span>}
                      {row.parentId !== undefined && <span style={{ ...small, marginLeft: 6 }}>↳ subagent of {titleOf(row.parentId)}</span>}
                      {cwdOf(row.sessionId) !== undefined && <span style={{ ...mono, opacity: 0.6, marginLeft: 6 }}>{cwdOf(row.sessionId)?.replace(/^\/Users\/[^/]+/, '~')}</span>}
                      <div style={small}>{row.blockers.map(blockerLabel).join(' · ')}</div>
                    </li>
                  ))}
                </ul>
              </div>
            )
        )}
        {armed !== undefined && (
          <Banner tone="warn">
            A when-idle reboot is armed (since {new Date(armed.since).toLocaleTimeString()}{armed.by !== undefined ? `, from ${titleOf(armed.by)}` : ''}). It fires once the list above has been empty for 2 seconds — closing this dialog does not cancel it.
          </Banner>
        )}
        {error !== undefined && <div role="alert" style={{ color: 'var(--dsh-color-danger, #d9534f)' }}>{error}</div>}
        <div style={small}>Also: <span style={mono}>/reboot now</span>, <span style={mono}>/reboot wait</span>, <span style={mono}>/reboot cancel</span>; bare <span style={mono}>/reboot</span> opens this dialog.</div>
      </div>
    </Modal>
  )
}

export const name = 'reboot-command'
export const inject = ['slots', 'commandUi', 'connection', 'sessions']

export function apply(ctx: Context): void {
  const store = new DialogStore()
  const rpc = (ctx as unknown as { connection: { rpc: ClientConnectionRpc } }).connection.rpc
  const sessions = ctx.get('sessions') as ISessions

  ctx.effect(() => ctx.commandUi.decorate({
    name: COMMAND,
    available: () => true,
    ui: { kind: 'action', run: (session) => { store.open(session.sessionId) } },
  }), 'reboot-command: bare /reboot opens the dialog')

  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'tali-reboot-command',
    inject: () => ({ store, rpc, sessions }),
  }, ({ store, rpc, sessions }: { store: DialogStore, rpc: ClientConnectionRpc, sessions: ISessions }) => <RebootDialog store={store} rpc={rpc} sessions={sessions} />)), 'reboot-command: dialog overlay')
}
