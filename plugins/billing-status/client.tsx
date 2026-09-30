import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import styles from './client.css'

export interface BillingSnapshot {
  version: 1
  sessionId: string
  totals: { kind: 'reported' | 'estimated'; currency: string; amount: string; scope?: 'model-tokens' | 'provider-account' | 'openrouter-account' }[]
  counts: { requests: number; unpriced: number; pending: number; subscription: number; incomplete?: number }
  latest?: { provider: string; model: string; at: string | number; kind: 'plan' | 'extra' | 'unknown' | 'unobserved' | 'rejected' | 'quota'; stale?: boolean; windows: { label: string; usedPercent: number; resetAt?: string | number; windowMinutes?: number }[]; credits?: { hasCredits: boolean; unlimited: boolean; balance?: string } }
  persistence: 'ok' | 'error'
  coverageSince?: string | number
  staleAfterMs?: number
  recovered?: boolean
  now?: string
}

const record = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const text = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 256
const decimal = (x: unknown): x is string => typeof x === 'string' && x.length <= 80 && /^\d+(?:\.\d+)?$/.test(x)
const count = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0
const timestamp = (x: unknown): x is string | number => (typeof x === 'string' || typeof x === 'number') && Number.isFinite(new Date(x).getTime())

/** Reject malformed or misaddressed data rather than showing another session's account. */
export function parseSnapshot(value: unknown, sessionId: string): BillingSnapshot | null {
  if (!record(value) || value.version !== 1 || value.sessionId !== sessionId || !Array.isArray(value.totals) || value.totals.length > 16) return null
  if (!value.totals.every(x => record(x) && ['reported', 'estimated'].includes(String(x.kind)) && typeof x.currency === 'string' && /^[A-Z]{3}$/.test(x.currency) && decimal(x.amount) && (x.scope === undefined || ['model-tokens', 'provider-account', 'openrouter-account'].includes(String(x.scope))))) return null
  const counts = value.counts
  if (!record(counts) || !['requests', 'unpriced', 'pending', 'subscription'].every(k => count(counts[k]))) return null
  if (counts.incomplete !== undefined && !count(counts.incomplete)) return null
  if (value.recovered !== undefined && typeof value.recovered !== 'boolean') return null
  if (value.now !== undefined && !timestamp(value.now)) return null
  if (!['ok', 'error'].includes(String(value.persistence))) return null
  if (value.coverageSince !== undefined && !timestamp(value.coverageSince)) return null
  if (value.staleAfterMs !== undefined && (typeof value.staleAfterMs !== 'number' || !Number.isFinite(value.staleAfterMs) || value.staleAfterMs <= 0)) return null
  if (value.latest !== undefined) {
    const x = value.latest
    if (!record(x) || !text(x.provider) || !text(x.model) || !timestamp(x.at) || !['plan', 'extra', 'unknown', 'unobserved', 'rejected', 'quota'].includes(String(x.kind))) return null
    if (x.stale !== undefined && typeof x.stale !== 'boolean') return null
    if (!Array.isArray(x.windows) || x.windows.length > 16 || !x.windows.every(w => record(w) && text(w.label) && typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent <= 100 && (w.resetAt === undefined || timestamp(w.resetAt)) && (w.windowMinutes === undefined || (typeof w.windowMinutes === 'number' && Number.isFinite(w.windowMinutes) && w.windowMinutes >= 0)))) return null
    if (x.credits !== undefined && (!record(x.credits) || typeof x.credits.hasCredits !== 'boolean' || typeof x.credits.unlimited !== 'boolean' || (x.credits.balance !== undefined && !decimal(x.credits.balance)))) return null
  }
  return value as unknown as BillingSnapshot
}

/** Display rounding only; the host remains the sole accounting authority. */
export function dollars(amount: string): string {
  if (!decimal(amount)) return 'Unknown'
  const [whole, fraction = ''] = amount.split('.')
  let scaled = BigInt(whole!) * 10000n + BigInt((fraction + '0000').slice(0, 4))
  if (Number(fraction[4] ?? '0') >= 5) scaled += 1n
  if (scaled === 0n && /[1-9]/.test(amount)) return '<$0.0001'
  const digits = (scaled % 10000n).toString().padStart(4, '0').replace(/0+$/, '').padEnd(2, '0')
  return `$${(scaled / 10000n).toString()}.${digits}`
}

/** Currency buckets stay separate; no conversion or floating-point arithmetic. */
export function formatMoney(amount: string, currency: string): string {
  if (!/^[A-Z]{3}$/.test(currency)) return 'Unknown'
  const reading = dollars(amount)
  return currency === 'USD' ? reading : reading.replace('$', `${currency} `)
}
export function isStale(snapshot: BillingSnapshot, now: number): boolean {
  const latest = snapshot.latest
  if (!latest) return false
  const at = new Date(latest.at).getTime()
  return latest.stale === true || now - at >= (snapshot.staleAfterMs ?? 300000) || at > now + 60000
}
const percent = (n: number) => `${Math.round(n * 10) / 10}%`
const shortTime = (at: string | number) => new Date(at).toLocaleString()
const evidenceLabel = { plan: 'Plan claim', extra: 'Extra usage', unknown: 'Unknown', unobserved: 'Unobserved', rejected: 'Rejected', quota: 'Quota observed' } as const

function orderedTotals(snapshot: BillingSnapshot) {
  return [...snapshot.totals].sort((a, b) => a.kind !== b.kind ? (a.kind === 'reported' ? -1 : 1) : `${a.currency}/${a.scope ?? ''}`.localeCompare(`${b.currency}/${b.scope ?? ''}`))
}
export function compactLabel(snapshot: BillingSnapshot, now: number): string {
  const parts = orderedTotals(snapshot).map(t => `${t.kind === 'estimated' ? 'Est. ' : ''}${formatMoney(t.amount, t.currency)}${t.kind === 'reported' ? ' reported' : ''}`)
  if (snapshot.latest) {
    const latest = snapshot.latest
    if (isStale(snapshot, now)) parts.push('Stale')
    else if (latest.kind === 'plan' || latest.kind === 'quota') parts.push(latest.windows.length ? latest.windows.map(w => `${w.label} ${percent(w.usedPercent)}`).join(' · ') : latest.kind === 'plan' ? 'Plan claim' : 'Quota')
    else if (latest.kind === 'extra') parts.push('Extra usage')
    else if (latest.kind === 'rejected') parts.push('Rejected')
    else if (parts.length === 0) parts.push(`Billing ${latest.kind}`)
  }
  if (snapshot.counts.unpriced > 0) parts.push(`${snapshot.counts.unpriced} unpriced`)
  if (snapshot.counts.pending > 0) parts.push(`${snapshot.counts.pending} pending`)
  if ((snapshot.counts.incomplete ?? 0) > 0) parts.push(`${snapshot.counts.incomplete} incomplete`)
  if (parts.length === 0) parts.push('Billing unobserved')
  if (snapshot.persistence === 'error') parts.push('Partial · Not saved')
  return parts.join(' · ')
}

/** Exact glyph from ui-model-selection/ModelSelect.tsx RouteIcon(oauth). */
export function OAuthShield() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 1.8 17 4.4v4.7c0 4.2-2.7 7.3-7 9.1-4.3-1.8-7-4.9-7-9.1V4.4l7-2.6Z" fill="none" stroke="currentColor" strokeWidth="1.55" /><circle cx="10" cy="7.2" r="2" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M6.8 13.5c.5-2.1 1.6-3.2 3.2-3.2s2.8 1.1 3.2 3.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
}

function useVisible(ref: RefObject<HTMLSpanElement>) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    let intersects = false
    const update = () => setVisible(intersects && document.visibilityState !== 'hidden' && node.getClientRects().length > 0)
    const observer = new IntersectionObserver(entries => { intersects = entries[0]?.isIntersecting ?? false; update() })
    observer.observe(node)
    document.addEventListener('visibilitychange', update)
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', update) }
  }, [ref])
  return visible
}

type SnapshotState = { sessionId: string; snapshot?: BillingSnapshot; failed?: boolean; clockOffset?: number }
function useSnapshot(sessionId: string, visible: boolean, running: boolean) {
  const [state, setState] = useState<SnapshotState>({ sessionId })
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!visible) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let active: AbortController | undefined
    let failures = 0
    const poll = async () => {
      active = new AbortController()
      const timeout = setTimeout(() => active?.abort(), 15000)
      try {
        const response = await fetch(`api/billing-status/snapshot?sessionId=${encodeURIComponent(sessionId)}`, { signal: active.signal, credentials: 'same-origin', cache: 'no-store' })
        if (!response.ok) throw new Error('Snapshot unavailable')
        const snapshot = parseSnapshot(await response.json(), sessionId)
        if (!snapshot) throw new Error('Invalid snapshot')
        failures = 0
        if (!stopped) setState({ sessionId, snapshot, clockOffset: snapshot.now ? new Date(snapshot.now).getTime() - Date.now() : 0 })
      } catch {
        // Never retain account evidence after an authorization/network failure.
        failures++
        if (!stopped) setState({ sessionId, failed: true })
      } finally {
        clearTimeout(timeout)
        if (!stopped) {
          setNow(Date.now())
          timer = setTimeout(() => { void poll() }, failures ? Math.min(60000, 15000 * 2 ** Math.min(failures - 1, 3)) : running ? 5000 : 30000)
        }
      }
    }
    void poll()
    return () => { stopped = true; clearTimeout(timer); active?.abort() }
  }, [sessionId, visible, running])
  // Age evidence even if the endpoint hangs; money never expires with quota TTL.
  useEffect(() => {
    if (!visible) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [visible])
  return { state: state.sessionId === sessionId ? state : { sessionId }, now: now + (state.clockOffset ?? 0) }
}

export function BillingStatus({ sessionId, running = false }: { sessionId: string; running?: boolean }) {
  const rootRef = useRef<HTMLSpanElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const visible = useVisible(rootRef)
  const { state, now } = useSnapshot(sessionId, visible, running)
  const snapshot = state.snapshot
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const position = useAnchoredPosition({ open: open && visible, anchorRef: rootRef, panelRef, side: 'top', gap: 8, margin: 12 })
  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)
  useEffect(() => { if (!visible) setOpen(false) }, [visible])
  const placed = position !== null
  useEffect(() => {
    if (!open || !placed) return
    panelRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); triggerRef.current?.focus() }
      if (event.key === 'Tab' && panelRef.current?.contains(document.activeElement)) {
        // Non-modal details: return to the trigger, then follow native DOM order.
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, placed])
  const label = snapshot ? compactLabel(snapshot, now) : state.failed ? 'Billing unavailable' : 'Billing unobserved'
  const latest = snapshot?.latest
  const shield = latest && (latest.kind === 'plan' || latest.kind === 'quota' || latest.kind === 'extra' || latest.provider.endsWith('-oauth'))
  const row = (label: string, value: string | number) => <div className="tali-billing-row" key={label}><dt>{label}</dt><dd>{value}</dd></div>
  return <span className="tali-billing-root" ref={rootRef}>
    <button type="button" className="tali-billing-pill" ref={triggerRef} aria-label={`Billing: ${label}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen(!open)}>
      {shield && <OAuthShield />}<span className="tali-billing-label">{label}</span>
    </button>
    {open && visible && createPortal(<div className="tali-billing-panel" role="dialog" aria-label="Billing details" id={panelId} ref={panelRef} tabIndex={-1} style={position ?? { visibility: 'hidden', left: 0, top: 0 }}>
      <div className="tali-billing-heading">Billing</div>
      <dl className="tali-billing-rows">
        {row('Scope', 'This session')}
        {!snapshot && row('Status', state.failed ? 'Unavailable' : 'Unobserved')}
        {snapshot && <>
          {snapshot.totals.length === 0 && row('Cost', 'Unknown')}
          {orderedTotals(snapshot).map((t, i) => <div className="tali-billing-row" key={`total-${i}`}><dt>{t.kind === 'reported' ? 'Reported' : 'Estimated'}{t.scope ? ` · ${t.scope === 'model-tokens' ? 'Model tokens' : t.scope === 'openrouter-account' ? 'OpenRouter account' : 'Provider account'}` : ''}</dt><dd>{formatMoney(t.amount, t.currency)}</dd></div>)}
          {row('Requests', snapshot.counts.requests)}{row('Unpriced', snapshot.counts.unpriced)}{row('Pending', snapshot.counts.pending)}{row('Incomplete', snapshot.counts.incomplete ?? 0)}{row('Subscription', snapshot.counts.subscription)}
          {snapshot.coverageSince !== undefined && row('Coverage start', shortTime(snapshot.coverageSince))}
          {row('Persistence', snapshot.persistence === 'ok' ? 'Saved' : 'Error')}
          {snapshot.recovered && row('History', 'Recovered')}
        </>}
      </dl>
      {latest && snapshot && <><div className="tali-billing-heading tali-billing-section">Last request</div><dl className="tali-billing-rows">
        {row('Provider', latest.provider)}{row('Model', latest.model)}{row('Evidence', evidenceLabel[latest.kind])}{row('Freshness', isStale(snapshot, now) ? 'Stale' : 'Fresh')}{row('Observed', shortTime(latest.at))}
        {latest.windows.map((w, i) => <div className="tali-billing-row" key={`window-${i}`}><dt>{w.label}{w.windowMinutes !== undefined ? ` · ${w.windowMinutes} min` : ''}</dt><dd>{percent(w.usedPercent)}{w.resetAt !== undefined && <span className="tali-billing-reset">Reset {shortTime(w.resetAt)}</span>}</dd></div>)}
        {latest.credits && row('Credits', latest.credits.unlimited ? 'Unlimited' : latest.credits.balance !== undefined ? latest.credits.balance : latest.credits.hasCredits ? 'Available' : 'None')}
      </dl></>}
    </div>, document.body)}
  </span>
}

function BillingDock(props: PropsRuntime<'conversation.composer.dock'>) {
  const running = props.useSession(s => s.running)
  // Key reset closes the panel and removes old snapshot state synchronously.
  return <BillingStatus key={props.sessionId} sessionId={props.sessionId} running={running} />
}

export const name = 'billing-status'
export const inject = ['slots']
export function apply(ctx: Context) {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.taliBilling = ''
    style.textContent = styles
    document.head.appendChild(style)
    return () => style.remove()
  })
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: 'tali-billing-status', order: 100 }, BillingDock))
}
