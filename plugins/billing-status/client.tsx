import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { IconInfoOutline14, IconWarningOutline16, Tooltip, useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import styles from './client.css'

export interface BillingSnapshot {
  version: 1
  sessionId: string
  totals: { kind: 'reported' | 'estimated'; currency: string; amount: string; scope?: 'model-tokens' | 'provider-account' | 'openrouter-account'; source?: string }[]
  counts: { requests: number; unpriced: number; pending: number; subscription: number; incomplete?: number; failed?: number }
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
  if (counts.failed !== undefined && !count(counts.failed)) return null
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

const SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£' }
const prefixOf = (currency: string) => SYMBOLS[currency] ?? `${currency} `

/** Round a decimal string half-up to `places` digits, as an integer scaled by 10^places. */
function scaled(amount: string, places: number): bigint {
  const [whole, fraction = ''] = amount.split('.')
  let value = BigInt(whole!) * 10n ** BigInt(places) + BigInt((fraction + '0'.repeat(places)).slice(0, places) || '0')
  if ((fraction[places] ?? '0') >= '5') value += 1n
  return value
}

/**
 * Compact display amount: at most two decimals below 10, one decimal from 10 up,
 * trailing zeros dropped and the leading zero omitted after a currency symbol
 * ($0, $.04, $1.24, $52.4, $1024.1). A positive amount never displays as zero.
 * Display rounding only; the host remains the sole accounting authority.
 */
export function formatAmount(amount: string, currency: string): string {
  if (!decimal(amount) || !/^[A-Z]{3}$/.test(currency)) return '—'
  const prefix = prefixOf(currency)
  const symbol = currency in SYMBOLS
  let places = 2
  let value = scaled(amount, 2)
  if (value >= 1000n) { places = 1; value = scaled(amount, 1) }
  if (value === 0n) return /[1-9]/.test(amount) ? `<${prefix}${symbol ? '' : '0'}.01` : `${prefix}0`
  const unit = 10n ** BigInt(places)
  const whole = value / unit
  const fraction = (value % unit).toString().padStart(places, '0').replace(/0+$/, '')
  return `${prefix}${whole === 0n && symbol ? '' : whole.toString()}${fraction ? `.${fraction}` : ''}`
}

/** Full-precision amount for the details card; currency buckets stay separate, no conversion. */
export function exactAmount(amount: string, currency: string): string {
  if (!decimal(amount) || !/^[A-Z]{3}$/.test(currency)) return '—'
  const [whole, fraction = ''] = amount.split('.')
  const trimmed = fraction.replace(/0+$/, '')
  return `${prefixOf(currency)}${BigInt(whole!).toString()}${trimmed ? `.${trimmed}` : ''}`
}

export function isStale(snapshot: BillingSnapshot, now: number): boolean {
  const latest = snapshot.latest
  if (!latest) return false
  const at = new Date(latest.at).getTime()
  return latest.stale === true || now - at >= (snapshot.staleAfterMs ?? 300000) || at > now + 60000
}
const percent = (n: number) => `${Math.round(n * 10) / 10}%`
const shortTime = (at: string | number) => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function orderedTotals(snapshot: BillingSnapshot) {
  return [...snapshot.totals].sort((a, b) => a.kind !== b.kind ? (a.kind === 'reported' ? -1 : 1) : `${a.currency}/${a.scope ?? ''}`.localeCompare(`${b.currency}/${b.scope ?? ''}`))
}

/** Window duration label from the provider label or its duration (300 min → 5h, 10080 min → 7d). */
export function windowLabel(window: { label: string; windowMinutes?: number }): string | undefined {
  if (/^\d+[mhdw]$/i.test(window.label)) return window.label.toLowerCase()
  const minutes = window.windowMinutes
  if (!minutes) return undefined
  if (minutes % 1440 === 0) return `${minutes / 1440}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

export type MoneyIcon = 'openrouter' | 'api'
const iconOfTotal = (t: BillingSnapshot['totals'][number]): MoneyIcon => t.kind === 'reported' && t.scope === 'openrouter-account' ? 'openrouter' : 'api'
export interface BillingNote { key: string; level: 'info' | 'danger'; text: string }
export interface BillingView {
  /** Compact money pieces; estimates carry a `~` prefix. */
  money: string[]
  /** Glyph beside each money piece: OpenRouter for its reported charges, API for token-price estimates. */
  moneyIcons: MoneyIcon[]
  /** No known amount: the money group reads `$ —`. */
  unknownMoney: boolean
  /** Glyph beside `$ —`: the last request's route. */
  unknownIcon: MoneyIcon
  quota?: { stale: boolean; extra: boolean; unknown: boolean; windows: { label?: string; usedPercent: number }[] }
  notes: BillingNote[]
  /** Full accessible description of everything the compact pill abbreviates. */
  summary: string
}

const SUBSCRIPTION_PROVIDER = /-oauth$|^openai-codex$/

/** Derive the compact pill and its descriptions from one validated snapshot. */
export function billingView(snapshot: BillingSnapshot | undefined, now: number, failed = false): BillingView {
  if (!snapshot) {
    const notes: BillingNote[] = failed ? [{ key: 'unavailable', level: 'danger', text: 'Billing unavailable' }] : []
    return { money: [], moneyIcons: [], unknownMoney: true, unknownIcon: 'api', notes, summary: failed ? 'Billing unavailable' : 'No billing observed yet' }
  }
  const totals = orderedTotals(snapshot)
  const money = totals.map(t => `${t.kind === 'estimated' ? '~' : ''}${formatAmount(t.amount, t.currency)}`)
  const latest = snapshot.latest
  const stale = isStale(snapshot, now)
  const notes: BillingNote[] = []
  let quota: BillingView['quota']
  if (latest && (latest.kind === 'plan' || latest.kind === 'quota' || latest.kind === 'extra')) {
    quota = { stale, extra: latest.kind === 'extra', unknown: false, windows: latest.kind === 'extra' ? [] : latest.windows.map(w => ({ label: windowLabel(w), usedPercent: w.usedPercent })) }
  } else if (latest && SUBSCRIPTION_PROVIDER.test(latest.provider) && totals.length === 0) {
    quota = { stale, extra: false, unknown: true, windows: [] }
  }
  const unknownMoney = totals.length === 0 && (!quota || snapshot.counts.unpriced > 0)
  if (snapshot.counts.unpriced > 0) notes.push({ key: 'unpriced', level: 'info', text: plural(snapshot.counts.unpriced, 'unpriced request') })
  if (snapshot.counts.pending > 0) notes.push({ key: 'pending', level: 'info', text: `${plural(snapshot.counts.pending, 'request')} pending` })
  if ((snapshot.counts.incomplete ?? 0) > 0) notes.push({ key: 'incomplete', level: 'info', text: `${plural(snapshot.counts.incomplete!, 'request')} incomplete` })
  if ((snapshot.counts.failed ?? 0) > 0) notes.push({ key: 'failed', level: 'info', text: `${plural(snapshot.counts.failed!, 'failed request')} (not billed)` })
  if (quota && stale && !quota.unknown) notes.push({ key: 'stale', level: 'info', text: `Quota reading from ${shortTime(latest!.at)} is stale` })
  if (latest?.kind === 'rejected') notes.push({ key: 'rejected', level: 'danger', text: 'Last request rejected' })
  if (snapshot.persistence === 'error') notes.push({ key: 'persistence', level: 'danger', text: 'Not saved; totals may be partial' })
  const parts = totals.map(t => `${t.kind === 'estimated' ? 'Estimated' : 'Reported'} ${exactAmount(t.amount, t.currency)}`)
  if (unknownMoney) parts.push('Cost unknown')
  if (quota?.extra) parts.push('Extra usage')
  else if (quota?.unknown) parts.push('Subscription usage unknown')
  else if (quota) parts.push(...quota.windows.map(w => `${w.label ? `${w.label} ` : ''}${percent(w.usedPercent)} used`))
  parts.push(...notes.map(n => n.text))
  return { money, moneyIcons: totals.map(iconOfTotal), unknownMoney, unknownIcon: latest?.provider === 'openrouter' ? 'openrouter' : 'api', quota, notes, summary: parts.join(' · ') }
}

/** Full accessible description of the compact pill. */
export function compactLabel(snapshot: BillingSnapshot, now: number): string {
  return billingView(snapshot, now).summary
}

/** Exact glyph from ui-model-selection/ModelSelect.tsx RouteIcon(oauth). */
export function OAuthShield() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 1.8 17 4.4v4.7c0 4.2-2.7 7.3-7 9.1-4.3-1.8-7-4.9-7-9.1V4.4l7-2.6Z" fill="none" stroke="currentColor" strokeWidth="1.55" /><circle cx="10" cy="7.2" r="2" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M6.8 13.5c.5-2.1 1.6-3.2 3.2-3.2s2.8 1.1 3.2 3.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
}

/** Exact glyph from ui-model-selection/ModelSelect.tsx RouteIcon(api): token-priced billing. */
export function ApiIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="1.8" y="3" width="16.4" height="14" rx="3" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="m7 7-3 3 3 3m6-6 3 3-3 3m-2.2-7.2-1.6 8.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

/** Exact glyph from ui-model-selection/ModelSelect.tsx RouteIcon(openrouter): OpenRouter-reported charges. */
export function OpenRouterIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2 10h4M6 10c2.5 0 3-4 5.5-4H17M6 10c2.5 0 3 4 5.5 4H17M14.5 3.5 17 6l-2.5 2.5M14.5 11.5 17 14l-2.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" /></svg>
}
const MoneyGlyph = ({ icon }: { icon: MoneyIcon }) => icon === 'openrouter' ? <OpenRouterIcon /> : <ApiIcon />

/** ContextMeter ring geometry: 14px viewBox, r 5.5, 2px stroke. */
const RADIUS = 5.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
export function UsageRing({ usedPercent }: { usedPercent: number }) {
  return <svg className="tali-billing-ring" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
    <circle className="tali-billing-ring-track" cx="7" cy="7" r={RADIUS} />
    <circle className="tali-billing-ring-fill" cx="7" cy="7" r={RADIUS} strokeDasharray={`${CIRCUMFERENCE * usedPercent / 100} ${CIRCUMFERENCE}`} transform="rotate(-90 7 7)" />
  </svg>
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
  const view = billingView(snapshot, now, state.failed)
  const latest = snapshot?.latest
  const iconNotes = view.unknownMoney && !view.quota ? view.notes.filter(n => n.key !== 'unpriced') : view.notes
  const danger = iconNotes.some(n => n.level === 'danger')
  const showMoney = view.money.length > 0 || view.unknownMoney
  const quota = view.quota
  const labelled = quota ? quota.windows.every(w => w.label) : false
  const totals = snapshot ? orderedTotals(snapshot) : []
  const headline = view.money.length ? view.money.join(' · ') : view.unknownMoney || !quota ? '$ —' : quota.extra ? 'Extra' : quota.windows.length ? quota.windows.map(w => `${w.label ? `${w.label} ` : ''}${percent(w.usedPercent)}`).join(' · ') : '—'
  // Consecutive pieces sharing a glyph form one group: [OpenRouter] $1.24  [API] ~$.04.
  const moneyGroups: { icon: MoneyIcon; texts: string[] }[] = []
  view.money.forEach((text, i) => {
    const icon = view.moneyIcons[i] ?? 'api'
    const last = moneyGroups[moneyGroups.length - 1]
    if (last?.icon === icon) last.texts.push(text); else moneyGroups.push({ icon, texts: [text] })
  })
  const row = (key: string, label: ReactNode, value: ReactNode, className?: string) => <div className={`tali-billing-row${className ? ` ${className}` : ''}`} key={key}><dt>{label}</dt><dd>{value}</dd></div>
  // Catalog versions arrive as `pi-ai-catalog-2026-09-22`; show `pi-ai prices`.
  const sourceLabel = (t: BillingSnapshot['totals'][number]) => t.kind === 'estimated' && t.source?.startsWith('pi-ai') ? 'pi-ai prices' : undefined
  const scopeLabel = (scope?: string) => scope === 'openrouter-account' ? 'OpenRouter' : scope === 'provider-account' ? 'Provider' : scope === 'model-tokens' ? 'Token prices' : undefined
  return <span className="tali-billing-root" ref={rootRef}>
    <Tooltip label={view.summary} side="top" delayMs={200} disabled={open}>
      <button type="button" className="tali-billing-pill" ref={triggerRef} aria-label={`Billing: ${view.summary}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen(!open)}>
        {showMoney && (moneyGroups.length
          ? moneyGroups.map((group, g) => <span key={g} className="tali-billing-group" data-billing-group="money" data-billing-icon={group.icon}>
            <MoneyGlyph icon={group.icon} />
            <span className="tali-billing-amount">{group.texts.map((text, i) => <span key={i}>{i > 0 && <span className="tali-billing-sep" aria-hidden="true">·</span>}{text}</span>)}</span>
          </span>)
          : <span className="tali-billing-group" data-billing-group="money" data-billing-icon={view.unknownIcon}>
            {snapshot && <MoneyGlyph icon={view.unknownIcon} />}
            <span className="tali-billing-amount tali-billing-unknown">$ —</span>
          </span>)}
        {quota && <span className={`tali-billing-group${quota.stale ? ' tali-billing-stale' : ''}`} data-billing-group="quota">
          <OAuthShield />
          {quota.extra ? <span className="tali-billing-extra">Extra</span>
            : quota.unknown || quota.windows.length === 0 ? <span className="tali-billing-unknown">—</span>
            : labelled ? quota.windows.map((w, i) => <span key={i} className="tali-billing-window"><span className="tali-billing-window-label">{w.label}</span><UsageRing usedPercent={w.usedPercent} /></span>)
            : <span className="tali-billing-window-label">{quota.windows.map(w => percent(w.usedPercent)).join(' · ')}</span>}
        </span>}
        {iconNotes.length > 0 && <Tooltip label={iconNotes.map(n => n.text).join('\n')} side="top">
          <span className={`tali-billing-note ${danger ? 'tali-billing-danger' : 'tali-billing-info'}`} data-billing-note={danger ? 'danger' : 'info'}>
            {danger ? <IconWarningOutline16 size={14} /> : <IconInfoOutline14 size={14} />}
          </span>
        </Tooltip>}
      </button>
    </Tooltip>
    {open && visible && createPortal(<div className="tali-billing-panel" role="dialog" aria-label="Billing details" id={panelId} ref={panelRef} tabIndex={-1} style={position ?? { visibility: 'hidden', left: 0, top: 0 }}>
      <div className="tali-billing-header">
        <span className="tali-billing-headline">Billing</span>
        <span className="tali-billing-figures">{headline}</span>
      </div>
      <dl className="tali-billing-rows">
        {totals.map((t, i) => row(`total-${i}`, <span className="tali-billing-dt-icon"><MoneyGlyph icon={iconOfTotal(t)} />{t.kind === 'estimated' ? 'Estimated' : 'Reported'}{(sourceLabel(t) ?? scopeLabel(t.scope)) && <span className="tali-billing-muted">{sourceLabel(t) ?? scopeLabel(t.scope)}</span>}</span>, `${t.kind === 'estimated' ? '~' : ''}${exactAmount(t.amount, t.currency)}`))}
        {snapshot && totals.length === 0 && view.unknownMoney && row('cost', <span className="tali-billing-dt-icon"><MoneyGlyph icon={view.unknownIcon} />Cost</span>, 'Unknown')}
        {!snapshot && row('status', 'Status', state.failed ? 'Unavailable' : 'Not observed')}
      </dl>
      {quota && latest && <div className={`tali-billing-section${quota.stale ? ' tali-billing-stale' : ''}`}>
        {quota.extra && row('extra', <span className="tali-billing-dt-icon"><OAuthShield />Subscription</span>, <span className="tali-billing-extra">Extra usage</span>)}
        {quota.unknown && row('sub', <span className="tali-billing-dt-icon"><OAuthShield />Subscription</span>, 'Unknown')}
        {!quota.extra && latest.windows.map((w, i) => <div className="tali-billing-window-row" key={`w-${i}`}>
          <div className="tali-billing-row"><dt><span className="tali-billing-dt-icon"><OAuthShield />{windowLabel(w) ? `${windowLabel(w)} window` : 'Quota'}</span></dt><dd><span className="tali-billing-window-value">{percent(w.usedPercent)}</span>{w.resetAt !== undefined && <span className="tali-billing-muted"> · resets {shortTime(w.resetAt)}</span>}</dd></div>
          <div className="tali-billing-bar"><div className="tali-billing-bar-fill" style={{ width: `${Math.max(0, Math.min(100, w.usedPercent))}%` }} /></div>
        </div>)}
        {latest.credits && row('credits', 'Credits', latest.credits.unlimited ? 'Unlimited' : latest.credits.balance !== undefined ? latest.credits.balance : latest.credits.hasCredits ? 'Available' : 'None')}
      </div>}
      {view.notes.length > 0 && <div className="tali-billing-section tali-billing-notes">
        {view.notes.map(n => <div key={n.key} className={`tali-billing-note-row ${n.level === 'danger' ? 'tali-billing-danger' : 'tali-billing-info'}`}>{n.level === 'danger' ? <IconWarningOutline16 size={14} /> : <IconInfoOutline14 size={14} />}<span>{n.text}</span></div>)}
      </div>}
      {snapshot && <dl className="tali-billing-rows tali-billing-section tali-billing-footer">
        {row('requests', 'Requests', snapshot.counts.requests)}
        {latest && row('model', 'Model', latest.model)}
        {latest && row('route', 'Route', latest.provider)}
        {latest && row('observed', 'Observed', shortTime(latest.at))}
        {snapshot.recovered && row('history', 'History', 'Restored')}
      </dl>}
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
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: 'tali-billing-status', order: -10 }, BillingDock))
}
