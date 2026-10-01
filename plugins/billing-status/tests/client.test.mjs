import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import vm from 'node:vm'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'

const result = await build({ entryPoints: [new URL('../client.tsx', import.meta.url).pathname], bundle: true, format: 'cjs', platform: 'browser', jsx: 'automatic', write: false, loader: { '.css': 'text' }, external: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'] })
const sandbox = { module: { exports: {} }, require: name => ({ react: React, 'react/jsx-runtime': jsx, 'react-dom': {}, '@deepseek-ai/dsh-client-ui-primitives': {} })[name] }
vm.runInNewContext(result.outputFiles[0].text, sandbox)
const { parseSnapshot, formatAmount, exactAmount, sumAmounts, costTotal, sourceName, compactLabel, billingView, pillNotes, windowLabel, isStale, OAuthShield, ApiIcon, OpenRouterIcon, apply } = sandbox.module.exports
const at = Date.parse('2026-01-01T12:00:00Z')
const base = () => ({ version: 1, sessionId: 'fixture-session', totals: [], counts: { requests: 0, unpriced: 0, pending: 0, subscription: 0 }, persistence: 'ok' })
const plan = () => ({ ...base(), latest: { provider: 'anthropic-oauth', model: 'fixture-model', at, kind: 'plan', windows: [{ label: '5h', usedPercent: 3 }, { label: '7d', usedPercent: 1 }] } })
const usd = (amount, kind = 'reported') => ({ kind, currency: 'USD', amount })
const same = (actual, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), message) // vm realm arrays

test('snapshot validation addresses one session and explicit schema', () => {
  assert.ok(parseSnapshot(base(), 'fixture-session'))
  for (const change of [{ sessionId: 'other' }, { version: 2 }, { totals: [{ kind: 'reported', amount: '0', currency: 'not-a-currency' }] }, { counts: { requests: -1 } }, { totals: [{ kind: 'reported', amount: 'NaN', currency: 'USD' }] }, { persistence: 'maybe' }, { staleAfterMs: -1 }, { coverageSince: 'invalid' }]) assert.equal(parseSnapshot({ ...base(), ...change }, 'fixture-session'), null)
})
test('quota input is bounded and dates validated', () => {
  assert.ok(parseSnapshot(plan(), 'fixture-session'))
  for (const change of [{ windows: [{ label: '5h', usedPercent: 150 }] }, { windows: [{ label: '5h', usedPercent: NaN }] }, { at: 'invalid' }, { kind: 'oauth' }, { stale: 'yes' }]) assert.equal(parseSnapshot({ ...plan(), latest: { ...plan().latest, ...change } }, 'fixture-session'), null)
})
test('compact money: two decimals below 10, one from 10, no float, never a false zero', () => {
  const cases = { '0': '$0', '0.04': '$.04', '0.0423': '$.04', '1.236': '$1.24', '1.20': '$1.2', '52.4': '$52.4', '52.44': '$52.4', '520.1': '$520.1', '1024.1': '$1024.1', '9.994': '$9.99', '9.995': '$10', '9.96': '$9.96', '99.95': '$100', '0.004': '<$.01', '0.005': '$.01' }
  for (const [amount, expected] of Object.entries(cases)) assert.equal(formatAmount(amount, 'USD'), expected, amount)
  assert.equal(formatAmount('999999999999999999999.99', 'USD'), '$1000000000000000000000')
  assert.equal(formatAmount('2.52', 'EUR'), '€2.52')
  assert.equal(formatAmount('0.04', 'JPY'), 'JPY 0.04')
  assert.equal(formatAmount('0.001', 'JPY'), '<JPY 0.01')
  assert.equal(formatAmount('garbage', 'USD'), '—')
})
test('exact money keeps full precision and the currency', () => {
  assert.equal(exactAmount('0.042310', 'USD'), '$0.04231')
  assert.equal(exactAmount('2', 'CHF'), 'CHF 2')
})
test('card total: exact per-currency sum, ~ when any part is estimated; sources named by account', () => {
  assert.equal(sumAmounts(['0.733181', '0.0440322', '2']), '2.7772132')
  assert.equal(sumAmounts(['1', '2']), '3')
  assert.equal(costTotal([{ ...usd('2.994085'), scope: 'openrouter-account' }]), '$2.99')
  assert.equal(costTotal([usd('1.23'), usd('0.04', 'estimated'), { kind: 'estimated', currency: 'EUR', amount: '2' }]), '~$1.27 · ~€2')
  same([{ scope: 'openrouter-account' }, { scope: 'openrouter-tokens' }, { scope: 'model-tokens' }, {}].map(sourceName), ['OpenRouter', 'OpenRouter', 'API', 'API'])
})
test('missing is unknown, not reported zero', () => {
  const empty = billingView(base(), at)
  assert.equal(empty.unknownMoney, true)
  same(empty.money, [])
  const zero = billingView({ ...base(), totals: [usd('0')] }, at)
  same(zero.money, ['$0'])
  assert.equal(zero.unknownMoney, false)
  assert.equal(compactLabel({ ...base(), totals: [usd('0')] }, at), 'API $0')
})
test('estimates carry ~, reported has no qualifier; gaps become notes', () => {
  const data = { ...base(), totals: [usd('1.23'), usd('0.04', 'estimated')], counts: { requests: 4, unpriced: 1, pending: 1, subscription: 0 } }
  const view = billingView(data, at)
  same(view.money, ['$1.23', '~$.04'])
  same(view.notes.map(n => [n.key, n.level]), [['unpriced', 'info'], ['pending', 'status']])
  assert.equal(view.summary, 'API $1.23 · API ~$.04 · 1 unpriced request · 1 request pending')
  same(pillNotes(view).map(n => n.key), ['unpriced'])
})
test('a request in flight is not a gap: no pill icon', () => {
  const view = billingView({ ...plan(), counts: { requests: 53, unpriced: 0, pending: 1, subscription: 52 } }, at)
  same(pillNotes(view), [])
  assert.match(view.summary, /1 request pending$/)
})
test('money glyphs: OpenRouter for its reported charges, API for estimates and unknown API cost', () => {
  const data = { ...base(), totals: [{ ...usd('1.24'), scope: 'openrouter-account' }, { ...usd('0.04', 'estimated'), scope: 'model-tokens' }] }
  same(billingView(data, at).moneyIcons, ['openrouter', 'api'])
  same(billingView({ ...base(), totals: [{ ...usd('15', 'estimated'), scope: 'openrouter-tokens' }] }, at).moneyIcons, ['openrouter'])
  const routed = { ...base(), latest: { provider: 'openrouter', model: 'm', at, kind: 'unknown', windows: [] }, counts: { requests: 1, unpriced: 1, pending: 0, subscription: 0 } }
  assert.equal(billingView(routed, at).unknownIcon, 'openrouter')
  assert.equal(billingView({ ...routed, latest: { ...routed.latest, provider: 'anthropic' } }, at).unknownIcon, 'api')
})
test('a session with nothing recorded says so and uses its selected route glyph', () => {
  const view = billingView(base(), at, false, 'openrouter')
  assert.equal(view.unknownIcon, 'openrouter')
  assert.equal(view.summary, 'No requests recorded yet')
  assert.equal(billingView(base(), at, false, 'anthropic').unknownIcon, 'api')
})
test('failed requests are a separate, not-billed note', () => {
  const view = billingView({ ...base(), totals: [usd('1.2')], counts: { requests: 3, unpriced: 0, pending: 0, subscription: 0, incomplete: 2, failed: 2 } }, at)
  same(view.notes.map(n => n.text), ['2 requests incomplete', '2 failed requests (not billed)'])
  assert.equal(parseSnapshot({ ...base(), counts: { ...base().counts, failed: -1 } }, 'fixture-session'), null)
})
test('unknown cost with unpriced requests reads $ — with the count in its description', () => {
  const view = billingView({ ...base(), counts: { requests: 2, unpriced: 2, pending: 0, subscription: 0 } }, at)
  assert.equal(view.unknownMoney, true)
  assert.equal(view.summary, 'Cost unknown · 2 unpriced requests')
})
test('plan windows become labelled rings; stale keeps the reading but marks it', () => {
  const fresh = billingView(plan(), at)
  assert.equal(fresh.unknownMoney, false)
  same(fresh.quota.windows, [{ label: '5h', usedPercent: 3 }, { label: '7d', usedPercent: 1 }])
  assert.equal(fresh.summary, '5h 3% used · 7d 1% used')
  assert.equal(isStale(plan(), at + 300000), true)
  const stale = billingView(plan(), at + 300000)
  assert.equal(stale.quota.stale, true)
  same(stale.quota.windows.map(w => w.usedPercent), [3, 1])
  same(stale.notes.map(n => n.key), ['stale'])
  assert.equal(isStale({ ...plan(), latest: { ...plan().latest, stale: true } }, at), true)
  assert.equal(isStale(plan(), at - 120000), true)
})
test('stale quota does not age out historical money', () => {
  const view = billingView({ ...plan(), totals: [usd('25.2')] }, at + 300000)
  same(view.money, ['$25.2'])
  assert.equal(view.quota.stale, true)
})
test('extra has no percentage and unknown never becomes a plan claim', () => {
  const extra = billingView({ ...plan(), latest: { ...plan().latest, kind: 'extra' } }, at)
  assert.equal(extra.quota.extra, true)
  same(extra.quota.windows, [])
  const unknown = billingView({ ...plan(), latest: { ...plan().latest, kind: 'unknown' } }, at)
  assert.equal(unknown.quota.unknown, true)
  assert.equal(unknown.summary, 'Subscription usage unknown')
})
test('persistence failure and access failure are danger notes', () => {
  same(billingView({ ...base(), persistence: 'error' }, at).notes.map(n => [n.key, n.level]), [['persistence', 'danger']])
  const failed = billingView(undefined, at, true)
  assert.equal(failed.unknownMoney, true)
  assert.equal(failed.summary, 'Billing unavailable')
})
test('window labels come from provider labels or durations', () => {
  assert.equal(windowLabel({ label: '5h' }), '5h')
  assert.equal(windowLabel({ label: 'primary', windowMinutes: 300 }), '5h')
  assert.equal(windowLabel({ label: 'secondary', windowMinutes: 10080 }), '7d')
  assert.equal(windowLabel({ label: 'primary' }), undefined)
})
test('OAuth shield geometry matches the picker exactly', async () => {
  const source = await readFile(new URL('../../../deepseek-harness/packages/client/ui-model-selection/src/client/ModelSelect.tsx', import.meta.url), 'utf8')
  const glyph = source.split("if (route === 'oauth') return ")[1].split('\n')[0]
  const output = renderToStaticMarkup(React.createElement(OAuthShield))
  for (const [, path] of glyph.matchAll(/ d="([^"]+)"/g)) assert.ok(output.includes(`d="${path}"`))
  assert.ok(output.includes('cx="10" cy="7.2" r="2"'))
  assert.ok(output.includes('stroke-width="1.55"'))
})
test('OpenRouter icon matches the picker glyph exactly', async () => {
  const source = await readFile(new URL('../../../deepseek-harness/packages/client/ui-model-selection/src/client/ModelSelect.tsx', import.meta.url), 'utf8')
  const glyph = source.split('function RouteIcon')[1].split("if (route === 'openrouter') return ")[1].split('\n')[0]
  const output = renderToStaticMarkup(React.createElement(OpenRouterIcon))
  const paths = [...glyph.matchAll(/ d="([^"]+)"/g)]
  assert.equal(paths.length, 1)
  assert.ok(output.includes(`d="${paths[0][1]}"`))
  assert.ok(output.includes('stroke-width="1.65"'))
})
test('token-billing icon matches the picker API glyph exactly', async () => {
  const source = await readFile(new URL('../../../deepseek-harness/packages/client/ui-model-selection/src/client/ModelSelect.tsx', import.meta.url), 'utf8')
  const glyph = source.split('function RouteIcon')[1].split("if (route === 'openrouter') return ")[1].split('\n')[1]
  assert.ok(glyph.includes('<rect'), 'API glyph line located')
  const output = renderToStaticMarkup(React.createElement(ApiIcon))
  for (const [, path] of glyph.matchAll(/ d="([^"]+)"/g)) assert.ok(output.includes(`d="${path}"`))
  assert.ok(output.includes('x="1.8" y="3" width="16.4" height="14" rx="3"'))
})
test('mount requires only slots; unload removes own style; no client-plugin runtime imports', () => {
  let disposed
  let style
  let registered
  sandbox.document = { createElement: () => ({ dataset: {}, remove() { this.removed = true } }), head: { appendChild(node) { style = node } } }
  apply({ effect(callback) { disposed = callback() }, slots: { inject(name, callback) { assert.equal(name, 'conversation.composer.dock'); callback() }, register(config) { registered = config } } })
  assert.equal(registered.order, -10) // before the session stats (order 0): billing is leftmost
  assert.equal(registered.id, 'tali-billing-status')
  assert.ok(style.textContent.includes('padding: 1px 8px'))
  assert.ok(!/\border\s*:\s*1\s*[;}]/.test(style.textContent))
  disposed()
  assert.equal(style.removed, true)
})

test('quota and credits are not plan claims or money', () => {
  const data = { ...plan(), latest: { ...plan().latest, provider: 'openai-codex', kind: 'quota', credits: { hasCredits: true, unlimited: false, balance: '2.5' }, windows: [{ label: 'primary', usedPercent: 20 }] } }
  assert.ok(parseSnapshot(data, 'fixture-session'))
  const view = billingView(data, at)
  same(view.quota.windows, [{ label: undefined, usedPercent: 20 }])
  same(view.money, [])
  assert.equal(view.summary, '20% used')
  assert.equal(parseSnapshot({ ...data, latest: { ...data.latest, credits: { hasCredits: 'yes', unlimited: false } } }, 'fixture-session'), null)
})
test('recovered money remains and incomplete requests are explicit', () => {
  const data = { ...base(), recovered: true, now: new Date(at).toISOString(), totals: [usd('2.5')], counts: { ...base().counts, requests: 1, incomplete: 1 } }
  assert.ok(parseSnapshot(data, 'fixture-session'))
  assert.equal(compactLabel(data, at), 'API $2.5 · 1 request incomplete')
  same(billingView({ ...plan(), latest: { ...plan().latest, kind: 'rejected' } }, at).notes.map(n => n.key), ['rejected'])
})

test('actual host ledger snapshots accept OpenRouter scope and separate currency buckets', async t => {
  const { BillingLedger } = await import('../ledger.mjs')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const directory = await mkdtemp(join(tmpdir(), 'billing-ui-contract-'))
  const card = { provider: 'fixture-api', model: 'fixture-model', currency: 'EUR', version: 'fixture-v1', source: 'https://example.com/prices', inputMode: 'exclusive', inputPerMillion: '2', outputPerMillion: '8', cacheReadPerMillion: '0.2', cacheWritePerMillion: '3' }
  const ledger = new BillingLedger({ directory, rateCards: [card], now: () => new Date(at).toISOString() })
  t.after(async () => { await ledger.close(); await rm(directory, { recursive: true, force: true }) })
  const request = { sessionId: 'fixture-session', requestId: 'request-router', provider: 'openrouter', model: 'fixture-model', at: new Date(at).toISOString() }
  await ledger.record({ ...request, phase: 'evidence', evidence: { kind: 'openrouter', responseId: 'gen-fixture', reportedCost: { amount: '0.004', currency: 'USD', scope: 'openrouter-account' }, outcome: 'unknown' } })
  await ledger.record({ ...request, phase: 'finish' })
  const other = { ...request, requestId: 'request-api', provider: 'fixture-api' }
  await ledger.record({ ...other, phase: 'usage', usage: { inputTokens: 1000000, outputTokens: 0 } })
  await ledger.record({ ...other, phase: 'finish' })
  const snapshot = await ledger.snapshot('fixture-session')
  assert.ok(parseSnapshot(snapshot, 'fixture-session'))
  assert.equal(snapshot.totals.find(t => t.kind === 'reported').scope, 'openrouter-account')
  same(billingView(snapshot, at).money, ['<$.01', '~€2'])
  assert.equal(compactLabel(snapshot, at), 'OpenRouter <$.01 · API ~€2')
  const quota = { ...request, requestId: 'request-quota', provider: 'openai-codex' }
  await ledger.record({ ...quota, phase: 'evidence', evidence: { kind: 'openai-codex', outcome: 'quota-observed', windows: [{ label: 'Primary', usedPercent: 20, windowMinutes: 0 }], credits: { hasCredits: true, unlimited: false, balance: '2.5' } } })
  assert.ok(parseSnapshot(await ledger.snapshot('fixture-session'), 'fixture-session'))
})
