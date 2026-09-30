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
const { parseSnapshot, dollars, formatMoney, compactLabel, isStale, OAuthShield, apply } = sandbox.module.exports
const at = Date.parse('2026-01-01T12:00:00Z')
const base = () => ({ version: 1, sessionId: 'fixture-session', totals: [], counts: { requests: 0, unpriced: 0, pending: 0, subscription: 0 }, persistence: 'ok' })
const plan = () => ({ ...base(), latest: { provider: 'anthropic-oauth', model: 'fixture-model', at, kind: 'plan', windows: [{ label: '5h', usedPercent: 3 }, { label: '7d', usedPercent: 1 }] } })

test('snapshot validation addresses one session and explicit schema', () => {
  assert.ok(parseSnapshot(base(), 'fixture-session'))
  for (const change of [{ sessionId: 'other' }, { version: 2 }, { totals: [{ kind: 'reported', amount: '0', currency: 'not-a-currency' }] }, { counts: { requests: -1 } }, { totals: [{ kind: 'reported', amount: 'NaN', currency: 'USD' }] }, { persistence: 'maybe' }, { staleAfterMs: -1 }, { coverageSince: 'invalid' }]) assert.equal(parseSnapshot({ ...base(), ...change }, 'fixture-session'), null)
})
test('quota input is bounded and dates validated', () => {
  assert.ok(parseSnapshot(plan(), 'fixture-session'))
  for (const change of [{ windows: [{ label: '5h', usedPercent: 150 }] }, { windows: [{ label: '5h', usedPercent: NaN }] }, { at: 'invalid' }, { kind: 'oauth' }, { stale: 'yes' }]) assert.equal(parseSnapshot({ ...plan(), latest: { ...plan().latest, ...change } }, 'fixture-session'), null)
})
test('money rounds for display without float arithmetic or false tiny zero', () => {
  assert.equal(dollars('0'), '$0.00')
  assert.equal(dollars('1.23456'), '$1.2346')
  assert.equal(dollars('0.00000001'), '<$0.0001')
  assert.equal(dollars('999999999999999999999.99999'), '$1000000000000000000000.00')
  assert.equal(dollars('garbage'), 'Unknown')
})
test('missing is not reported zero', () => {
  assert.equal(compactLabel(base(), at), 'Billing unobserved')
  assert.equal(compactLabel({ ...base(), totals: [{ kind: 'reported', currency: 'USD', amount: '0' }] }, at), '$0.00 reported')
})
test('money kinds stay separate, gaps and pending remain explicit', () => {
  const data = { ...base(), totals: [{ kind: 'reported', currency: 'USD', amount: '1.23' }, { kind: 'estimated', currency: 'USD', amount: '0.04' }], counts: { requests: 4, unpriced: 1, pending: 1, subscription: 0 } }
  assert.equal(compactLabel(data, at), '$1.23 reported · Est. $0.04 · 1 unpriced · 1 pending')
})
test('fresh plan windows only, stale never implies current subscription coverage', () => {
  assert.equal(compactLabel(plan(), at), '5h 3% · 7d 1%')
  assert.equal(isStale(plan(), at + 300000), true)
  assert.equal(compactLabel(plan(), at + 300000), 'Stale')
  assert.equal(isStale({ ...plan(), latest: { ...plan().latest, stale: true } }, at), true)
  assert.equal(isStale(plan(), at - 120000), true)
})
test('stale quota does not age out historical money', () => {
  assert.equal(compactLabel({ ...plan(), totals: [{ kind: 'reported', currency: 'USD', amount: '1.2' }] }, at + 300000), '$1.20 reported · Stale')
})
test('extra and unknown never become positive plan claims', () => {
  assert.equal(compactLabel({ ...plan(), latest: { ...plan().latest, kind: 'extra' } }, at), 'Extra usage')
  assert.equal(compactLabel({ ...plan(), latest: { ...plan().latest, kind: 'unknown' } }, at), 'Billing unknown')
})
test('persistence failure stays visible', () => assert.equal(compactLabel({ ...base(), persistence: 'error' }, at), 'Billing unobserved · Partial · Not saved'))
test('OAuth shield geometry matches the picker exactly', async () => {
  const source = await readFile(new URL('../../../deepseek-harness/packages/client/ui-model-selection/src/client/ModelSelect.tsx', import.meta.url), 'utf8')
  const glyph = source.split("if (route === 'oauth') return ")[1].split('\n')[0]
  const output = renderToStaticMarkup(React.createElement(OAuthShield))
  for (const [, path] of glyph.matchAll(/ d="([^"]+)"/g)) assert.ok(output.includes(`d="${path}"`))
  assert.ok(output.includes('cx="10" cy="7.2" r="2"'))
  assert.ok(output.includes('stroke-width="1.55"'))
})
test('mount requires only slots; unload removes own style; no client-plugin runtime imports', () => {
  let disposed
  let style
  let registered
  sandbox.document = { createElement: () => ({ dataset: {}, remove() { this.removed = true } }), head: { appendChild(node) { style = node } } }
  apply({ effect(callback) { disposed = callback() }, slots: { inject(name, callback) { assert.equal(name, 'conversation.composer.dock'); callback() }, register(config) { registered = config } } })
  assert.equal(registered.order, 100)
  assert.equal(registered.id, 'tali-billing-status')
  assert.ok(style.textContent.includes('padding: 1px 8px'))
  assert.ok(!/\border\s*:\s*1\s*[;}]/.test(style.textContent))
  disposed()
  assert.equal(style.removed, true)
})

test('quota and credits are not plan claims or money', () => {
  const data = { ...plan(), latest: { ...plan().latest, kind: 'quota', credits: { hasCredits: true, unlimited: false, balance: '2.5' }, windows: [{ label: 'Primary', usedPercent: 20, windowMinutes: 300 }] } }
  assert.ok(parseSnapshot(data, 'fixture-session'))
  assert.equal(compactLabel(data, at), 'Primary 20%')
  assert.equal(compactLabel({ ...data, latest: { ...data.latest, windows: [] } }, at), 'Quota')
  assert.equal(parseSnapshot({ ...data, latest: { ...data.latest, credits: { hasCredits: 'yes', unlimited: false } } }, 'fixture-session'), null)
})
test('recovered money remains and incomplete requests are explicit', () => {
  const data = { ...base(), recovered: true, now: new Date(at).toISOString(), totals: [{ kind: 'reported', currency: 'USD', amount: '2.5' }], counts: { ...base().counts, requests: 1, incomplete: 1 } }
  assert.ok(parseSnapshot(data, 'fixture-session'))
  assert.equal(compactLabel(data, at), '$2.50 reported · 1 incomplete')
  assert.equal(compactLabel({ ...plan(), latest: { ...plan().latest, kind: 'rejected' } }, at), 'Rejected')
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
  assert.equal(compactLabel(snapshot, at), '$0.004 reported · Est. EUR 2.00')
  assert.equal(formatMoney('0.00000001', 'EUR'), '<EUR 0.0001')
  assert.equal(formatMoney('999999999999999999999.99999', 'JPY'), 'JPY 1000000000000000000000.00')
  const quota = { ...request, requestId: 'request-quota', provider: 'openai-codex' }
  await ledger.record({ ...quota, phase: 'evidence', evidence: { kind: 'openai-codex', outcome: 'quota-observed', windows: [{ label: 'Primary', usedPercent: 20, windowMinutes: 0 }], credits: { hasCredits: true, unlimited: false, balance: '2.5' } } })
  assert.ok(parseSnapshot(await ledger.snapshot('fixture-session'), 'fixture-session'))
})
