import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BillingStatus, type BillingSnapshot } from '../client.tsx'
import styles from '../client.css'

const style = document.createElement('style')
style.textContent = styles + `
:root{--dsw-alias-label-tertiary:#797d87;--dsw-alias-label-secondary:#535763;--dsw-alias-label-primary:#232632;--dsw-specific-menu:#fff;--dsw-alias-interactive-bg-hover:#8882;--dsw-elevation-prominent:0 4px 24px #0003}
body{margin:24px;font-family:system-ui;background:#f7f8fa;color:#232632}*{box-sizing:border-box}
.fixture-controls{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:180px}.fixture-controls button{padding:5px 8px}
.fixture-dock{display:flex;gap:12px;align-items:center;justify-content:center;min-width:0;max-width:760px;margin:auto}
.fixture-dock>[data-slot]{display:contents}.fixture-stat{white-space:nowrap;border:0;background:none;padding:1px 8px;color:#797d87;font:13px/20px system-ui;flex-shrink:0}.fixture-title{font-size:16px}
.fixture-order .tali-billing-root{order:1}
@media(prefers-color-scheme:dark){:root{--dsw-alias-label-tertiary:#90949e;--dsw-alias-label-secondary:#c4c7cf;--dsw-alias-label-primary:#eee;--dsw-specific-menu:#282b33}body{background:#181b22;color:#ddd}}
`
document.head.appendChild(style)

type Scenario = 'plan' | 'quota' | 'rejected' | 'recovered' | 'reported' | 'mixed' | 'zero' | 'unknown' | 'stale' | 'extra' | 'error' | 'forbidden' | 'delayed' | 'wrong-session'
const requests: { sessionId: string; url: string; aborted: boolean; scenario: Scenario }[] = []
let scenario: Scenario = 'plan'
let update: ((next: Scenario, id?: string) => void) | undefined
let mount: ((value: boolean) => void) | undefined
let hide: ((value: boolean) => void) | undefined
let order: ((value: boolean) => void) | undefined

function makeSnapshot(sessionId: string): BillingSnapshot {
  const base: BillingSnapshot = { version: 1, sessionId, totals: [], counts: { requests: 2, unpriced: 0, pending: 0, subscription: 2 }, persistence: 'ok', coverageSince: new Date().toISOString() }
  if (scenario === 'recovered') return { ...base, recovered: true, totals: [{ kind: 'reported', currency: 'USD', amount: '2.5' }], counts: { ...base.counts, incomplete: 1 } }
  if (scenario === 'quota') return { ...base, latest: { provider: 'openai-codex-oauth', model: 'fixture-codex', at: new Date().toISOString(), kind: 'quota', windows: [{ label: 'Primary', usedPercent: 20, windowMinutes: 300 }], credits: { hasCredits: true, unlimited: false, balance: '2.50' } } }
  if (scenario === 'unknown' || scenario === 'wrong-session') return { ...base, sessionId: scenario === 'wrong-session' ? 'somebody-else' : sessionId, counts: { requests: 2, unpriced: 2, pending: 0, subscription: 0 } }
  if (scenario === 'reported' || scenario === 'zero' || scenario === 'mixed') base.totals.push({ kind: 'reported', currency: 'USD', amount: scenario === 'zero' ? '0' : '1.23', scope: 'openrouter-account' })
  if (scenario === 'mixed') { base.totals.push({ kind: 'estimated', currency: 'USD', amount: '0.04231', scope: 'model-tokens' }); base.counts.unpriced = 1; base.counts.pending = 1 }
  if (!['reported', 'zero'].includes(scenario)) base.latest = { provider: 'anthropic-oauth', model: 'fixture-model', at: new Date().toISOString(), kind: scenario === 'extra' ? 'extra' : scenario === 'rejected' ? 'rejected' : 'plan', stale: scenario === 'stale', windows: [{ label: '5h', usedPercent: 3, resetAt: new Date(Date.now() + 3600000).toISOString() }, { label: '7d', usedPercent: 1 }] }
  if (scenario === 'error') base.persistence = 'error'
  return base
}

// Only fixture data, never provider credentials or model inference.
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.href)
  if (url.pathname !== '/fixture/api/billing-status/snapshot') throw new Error('Endpoint is not document-relative')
  const sessionId = url.searchParams.get('sessionId') ?? ''
  const request = { sessionId, url: url.pathname, aborted: false, scenario }
  requests.push(request)
  if (scenario === 'delayed') return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => { request.aborted = true; reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
  })
  return new Response(JSON.stringify(makeSnapshot(sessionId)), { status: scenario === 'forbidden' ? 403 : 200, headers: { 'content-type': 'application/json' } })
}
function Fixture() {
  const [selection, setSelection] = useState({ id: 'fixture-a', revision: 0 })
  const [mounted, setMounted] = useState(true)
  const [hidden, setHidden] = useState(false)
  const [ordered, setOrdered] = useState(false)
  update = (next, id = 'fixture-a') => { scenario = next; setSelection(s => ({ id, revision: s.revision + 1 })) }
  mount = setMounted
  hide = setHidden
  order = setOrdered
  return <><h1 className="fixture-title">Billing status fixture</h1><div className="fixture-controls">
    {(['plan', 'quota', 'rejected', 'recovered', 'reported', 'mixed', 'zero', 'unknown', 'stale', 'extra', 'error', 'forbidden', 'delayed', 'wrong-session'] as Scenario[]).map(name => <button key={name} onClick={() => update?.(name)}>{name}</button>)}
    <button onClick={() => order?.(!ordered)}>Order {ordered ? '1' : '0'}</button><button onClick={() => hide?.(!hidden)}>Hide dock</button><button onClick={() => mount?.(!mounted)}>Unmount</button>
  </div><div className={`fixture-dock ${ordered ? 'fixture-order' : ''}`} style={{ display: hidden ? 'none' : undefined }}>
    <span data-slot="conversation.composer.dock"><button className="fixture-stat" id="stats">2 turns</button><button className="fixture-stat" id="tokens">96% cache</button>
      {mounted && <BillingStatus key={`${selection.id}:${selection.revision}`} sessionId={selection.id} running />}
    </span><button className="fixture-stat" id="context">◔ 69%</button>
  </div></>
}
createRoot(document.getElementById('root')!).render(<Fixture />)

const until = async (condition: () => boolean) => {
  const started = performance.now()
  while (!condition()) {
    if (performance.now() - started > 2500) throw new Error('Fixture condition timed out')
    await new Promise(requestAnimationFrame)
  }
}
const trigger = () => document.querySelector<HTMLButtonElement>('.tali-billing-pill')
const label = () => trigger()?.textContent ?? ''
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }
const fixture = {
  requests,
  select: (next: Scenario, id?: string) => update?.(next, id),
  hide: (value: boolean) => hide?.(value),
  mount: (value: boolean) => mount?.(value),
  order: (value: boolean) => order?.(value),
  async run() {
    const passed: string[] = []
    await until(() => !!update && label().includes('5h 3%'))
    assert(trigger()?.querySelector('circle[cx="10"][cy="7.2"]'), 'Exact OAuth glyph missing')
    passed.push('fresh plan and exact OAuth shield')
    trigger()?.click()
    await until(() => document.activeElement?.getAttribute('role') === 'dialog')
    assert(document.querySelector('[role="dialog"]'), 'Dialog must exist')
    assert(document.querySelector('[role="dialog"]')?.textContent?.includes('Plan claim'), 'Evidence label missing')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await until(() => !document.querySelector('[role="dialog"]'))
    assert(document.activeElement === trigger(), 'Escape must restore trigger focus')
    passed.push('click details, focus, Escape restoration')
    const root = document.querySelector<HTMLElement>('.tali-billing-root')!
    const context = document.getElementById('context')!
    assert(root.getBoundingClientRect().x < context.getBoundingClientRect().x, 'Default visual order mismatch')
    order?.(true)
    await until(() => root.getBoundingClientRect().x > context.getBoundingClientRect().x)
    assert(root.compareDocumentPosition(context) & Node.DOCUMENT_POSITION_FOLLOWING, 'Fixture must retain original DOM order')
    passed.push('order1 moves after meter but leaves reading/tab DOM order before it')
    order?.(false)
    update?.('zero')
    await until(() => label().includes('$0.00 reported'))
    passed.push('explicit reported zero')
    update?.('delayed', 'fixture-b')
    await until(() => requests.some(r => r.sessionId === 'fixture-b'))
    assert(!label().includes('$0.00') && !document.querySelector('.tali-billing-pill svg'), 'Previous session leaked while next snapshot pending')
    passed.push('no prior-session snapshot flash')
    hide?.(true)
    await until(() => requests.some(r => r.sessionId === 'fixture-b' && r.aborted))
    passed.push('hidden dock aborts in-flight fetch')
    hide?.(false)
    update?.('forbidden', 'fixture-c')
    await until(() => label() === 'Billing unavailable')
    assert(!document.querySelector('.tali-billing-pill svg'), '403 retained account icon')
    passed.push('403 drops previous account data')
    update?.('wrong-session')
    await until(() => requests.at(-1)?.scenario === 'wrong-session' && label() === 'Billing unavailable')
    passed.push('wrong-session response rejected')
    update?.('stale')
    await until(() => label() === 'Stale')
    passed.push('stale evidence never shown as fresh windows')
    update?.('quota')
    await until(() => label().includes('Primary 20%'))
    trigger()?.click()
    await until(() => document.activeElement?.getAttribute('role') === 'dialog')
    const quotaText = document.querySelector('[role="dialog"]')?.textContent ?? ''
    assert(quotaText.includes('Quota observed') && quotaText.includes('Credits2.50') && !quotaText.includes('Plan claim') && !quotaText.includes('$2.50'), 'Quota/credit semantics collapsed')
    passed.push('quota windows and credits separate from plan claim and currency')
    update?.('recovered')
    await until(() => label().includes('$2.50 reported') && label().includes('1 incomplete'))
    assert(!document.querySelector('.tali-billing-pill svg'), 'Recovered money has no fabricated current subscription')
    passed.push('recovered monetary history retained and incomplete explicit')
    update?.('delayed', 'fixture-d')
    await until(() => requests.some(r => r.sessionId === 'fixture-d'))
    mount?.(false)
    await until(() => requests.some(r => r.sessionId === 'fixture-d' && r.aborted))
    passed.push('unmount aborts in-flight fetch')
    mount?.(true)
    update?.('plan')
    await until(() => label().includes('5h 3%'))
    return passed
  },
}
Object.assign(window, { billingFixture: fixture })
