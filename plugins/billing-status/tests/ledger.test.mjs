import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BillingLedger } from '../ledger.mjs'
import { addAmounts, priceUsage, validateRateCards, catalogCard } from '../money.mjs'

const card = { provider: 'openai', model: 'fixture-model', currency: 'USD', version: 'fixture-v1', source: 'https://example.com/prices', inputMode: 'exclusive', inputPerMillion: '2', outputPerMillion: '8', cacheReadPerMillion: '0.2', cacheWritePerMillion: '3' }
const base = { sessionId: 'session-one', requestId: 'request-one', provider: 'openai', model: 'fixture-model', at: '2026-01-01T00:00:00.000Z' }
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'billing-ledger-'))
  const ledger = new BillingLedger({ directory, rateCards: [card], ...options })
  await ledger.ready
  t.after(async () => { await ledger.close(); await rm(directory, { recursive: true, force: true }) })
  return { ledger, directory }
}
test('money is exact and cache categories/reasoning are not double-counted', () => {
  assert.equal(addAmounts(['0.1','0.2']), '0.3')
  const usage = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 2000, reasoningTokens: 80 }
  assert.equal(priceUsage(usage, card).amount, '0.0032')
  assert.equal(priceUsage({ ...usage, inputTokens: 3000 }, { ...card, inputMode: 'inclusive' }), undefined)
  assert.throws(() => validateRateCards([{ ...card, inputMode: 'inclusive' }]))
  assert.equal(priceUsage(usage, { ...card, cacheReadPerMillion: undefined }), undefined)
  assert.equal(priceUsage(usage, { ...card, maxInputTokens: 2000 }), undefined)
  assert.equal(priceUsage({ ...usage, inputTokens: -1 }, card), undefined)
  assert.equal(priceUsage({ inputTokens: 1, outputTokens: 0 }, { ...card, inputPerMillion: '0.000000000000000001' }).amount, '0.000000000000000000000001')
  assert.throws(() => validateRateCards([{ ...card, provider: 'anthropic-oauth' }]))
  assert.throws(() => validateRateCards([{ ...card, inputPerMillion: 2 }]))
})
const catalogPricing = { currency: 'USD', inputPerMillion: '4', outputPerMillion: '20', cacheReadPerMillion: '0.2', cacheWritePerMillion: '5', source: 'pi-ai catalog 2026-09-22' }
test('DSH catalog pricing: tiers select by total input, malformed pricing is rejected', () => {
  const tiered = catalogCard('anthropic', 'm', { ...catalogPricing, tiers: [{ inputTokensAbove: 200000, inputPerMillion: '8', outputPerMillion: '40', cacheReadPerMillion: '0.4', cacheWritePerMillion: '10' }] })
  assert.equal(tiered.version, 'pi-ai-catalog-2026-09-22')
  assert.equal(priceUsage({ inputTokens: 1000, outputTokens: 0 }, tiered).amount, '0.004')
  assert.equal(priceUsage({ inputTokens: 1000, outputTokens: 0, cacheReadTokens: 200000 }, tiered).amount, '0.088')
  for (const bad of [undefined, { ...catalogPricing, currency: 'usd' }, { ...catalogPricing, inputPerMillion: 4 }, { ...catalogPricing, source: 1 }, { ...catalogPricing, tiers: [{ inputTokensAbove: -1, inputPerMillion: '1', outputPerMillion: '1' }] }]) assert.equal(catalogCard('anthropic', 'm', bad), undefined)
})
test('catalog prices estimate new usage and, at read time, usage recorded before prices were known', async t => {
  const lookups = []
  let pricing
  const { ledger, directory } = await fixture(t, { rateCards: [], pricing: async (provider, model) => { lookups.push(`${provider}/${model}`); return pricing } })
  const request = { ...base, provider: 'anthropic', model: 'claude-opus-5-5' }
  await ledger.record({ ...request, phase: 'usage', usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 1000000 } })
  await ledger.record({ ...request, phase: 'finish' })
  // No price yet: unpriced, and the ledger row carries no cost.
  assert.equal((await ledger.snapshot('session-one')).counts.unpriced, 1)
  pricing = catalogPricing
  ledger.catalog.clear()
  const later = await ledger.snapshot('session-one')
  assert.deepEqual(later.totals, [{ kind: 'estimated', currency: 'USD', scope: 'model-tokens', amount: '0.206', source: 'pi-ai-catalog-2026-09-22' }])
  assert.equal(later.counts.unpriced, 0)
  assert.ok(!(await readFile(join(directory, 'ledger.jsonl'), 'utf8')).includes('estimated'), 'read-time estimates are not written back')
  await ledger.record({ ...request, requestId: 'request-two', phase: 'usage', usage: { inputTokens: 10, outputTokens: 10 } })
  await ledger.record({ ...request, requestId: 'request-two', phase: 'finish' })
  assert.equal((await ledger.snapshot('session-one')).totals[0].amount, '0.20624')
  assert.ok((await readFile(join(directory, 'ledger.jsonl'), 'utf8')).includes('pi-ai-catalog-2026-09-22'), 'live estimates persist their catalog version')
  // Subscription routes never ask for list prices.
  await ledger.record({ ...request, provider: 'anthropic-oauth', requestId: 'oauth', phase: 'usage', usage: { inputTokens: 10, outputTokens: 10 } })
  await ledger.snapshot('session-one')
  assert.ok(!lookups.some(key => key.startsWith('anthropic-oauth/')))
})
test('in-flight requests are pending not unpriced; failures before any usage are not billed', async t => {
  const { ledger } = await fixture(t, { rateCards: [] })
  await ledger.record({ ...base, phase: 'start' })
  let counts = (await ledger.snapshot('session-one')).counts
  assert.equal(counts.pending, 1)
  assert.equal(counts.unpriced, 0)
  await ledger.record({ ...base, phase: 'finish', finishReason: 'error' })
  counts = (await ledger.snapshot('session-one')).counts
  assert.deepEqual([counts.pending, counts.unpriced, counts.incomplete, counts.failed], [0, 0, 1, 1])
  // A cancelled request that did process tokens stays an (unpriced) cost, not a free failure.
  await ledger.record({ ...base, requestId: 'partial', phase: 'usage', usage: { inputTokens: 10, outputTokens: 1 } })
  await ledger.record({ ...base, requestId: 'partial', phase: 'finish', finishReason: 'aborted' })
  counts = (await ledger.snapshot('session-one')).counts
  assert.deepEqual([counts.unpriced, counts.incomplete, counts.failed], [1, 2, 1])
})
test('cumulative samples replace, distinct attempts add, other sessions are isolated', async t => {
  const { ledger } = await fixture(t)
  await ledger.record({ ...base, phase: 'start' })
  await ledger.record({ ...base, phase: 'usage', usage: { inputTokens: 1000, outputTokens: 100 } })
  await ledger.record({ ...base, phase: 'usage', usage: { inputTokens: 1000, outputTokens: 200 } })
  await ledger.record({ ...base, phase: 'finish' })
  await ledger.record({ ...base, requestId: 'request-two', phase: 'usage', usage: { inputTokens: 1000, outputTokens: 200 } })
  await ledger.record({ ...base, sessionId: 'session-other', phase: 'usage', usage: { inputTokens: 1000000, outputTokens: 0 } })
  const snapshot = await ledger.snapshot('session-one')
  assert.equal(snapshot.totals[0].amount, '0.0072')
  assert.equal(snapshot.counts.requests, 2)
  assert.equal(snapshot.counts.pending, 1)
  assert.equal((await ledger.snapshot('session-new')).totals.length, 0)
})
test('provider receipts replace estimates and duplicate response IDs do not add money', async t => {
  const { ledger } = await fixture(t, { rateCards: [{ ...card, provider: 'openrouter' }] })
  const request = { ...base, provider: 'openrouter' }
  await ledger.record({ ...request, phase: 'usage', usage: { inputTokens: 1000, outputTokens: 200 } })
  const evidence = { kind: 'openrouter', responseId: 'gen-fixture', reportedCost: { amount: '0.004', currency: 'USD', scope: 'openrouter-account' }, upstreamCost: { amount: '300' }, outcome: 'unknown' }
  await ledger.record({ ...request, phase: 'evidence', evidence })
  await ledger.record({ ...request, requestId: 'reconciled', phase: 'evidence', evidence })
  const snapshot = await ledger.snapshot('session-one')
  assert.deepEqual(snapshot.totals, [{ kind: 'reported', currency: 'USD', scope: 'openrouter-account', amount: '0.004' }])
})
test('OAuth evidence is not dollars; quota is transient and stale is explicit', async t => {
  const { ledger, directory } = await fixture(t, { now: () => '2026-01-01T01:00:00.000Z' })
  const request = { ...base, provider: 'anthropic-oauth' }
  await ledger.record({ ...request, phase: 'start' })
  await ledger.record({ ...request, phase: 'evidence', evidence: { kind: 'anthropic-oauth', outcome: 'plan-evidence', windows: [{ label: '5h', usedPercent: 3 }], token: 'never-persist-this' } })
  await ledger.record({ ...request, phase: 'finish' })
  const snapshot = await ledger.snapshot('session-one')
  assert.equal(snapshot.latest.kind, 'plan')
  assert.equal(snapshot.latest.stale, true)
  assert.equal(snapshot.counts.subscription, 1)
  assert.deepEqual(snapshot.totals, [])
  const data = await readFile(join(directory, 'ledger.jsonl'), 'utf8')
  assert.equal(data.includes('usedPercent'), false)
  assert.equal(data.includes('never-persist-this'), false)
  assert.equal((await stat(join(directory, 'ledger.jsonl'))).mode & 0o777, 0o600)
})
test('a new request invalidates an old positive claim, including same-provider account changes', async t => {
  const { ledger } = await fixture(t)
  const request = { ...base, provider: 'anthropic-oauth' }
  await ledger.record({ ...request, phase: 'evidence', evidence: { outcome: 'plan-evidence' } })
  await ledger.record({ ...request, requestId: 'new-account-request', at: '2026-01-01T00:00:01Z', phase: 'start' })
  await ledger.record({ ...request, at: '2026-01-01T00:00:02Z', phase: 'evidence', evidence: { outcome: 'plan-evidence' } })
  assert.equal((await ledger.snapshot('session-one')).latest.kind, 'unobserved')
})
test('a completed request without usage stays unpriced, never becomes a free request', async t => {
  const { ledger } = await fixture(t)
  await ledger.record({ ...base, phase: 'start' })
  await ledger.record({ ...base, phase: 'finish', finishReason: 'stop' })
  const snapshot = await ledger.snapshot('session-one')
  assert.equal(snapshot.counts.unpriced, 1)
  assert.equal(snapshot.counts.failed, 0)
  assert.deepEqual(snapshot.totals, [])
})
test('reload preserves costs but not quota; history/forks do not inherit costs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'billing-reload-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const ledger = new BillingLedger({ directory, rateCards: [card] })
  await ledger.record({ ...base, phase: 'usage', usage: { inputTokens: 1000, outputTokens: 0 } })
  await ledger.close()
  const loaded = new BillingLedger({ directory, rateCards: [{ ...card, inputPerMillion: '900' }] })
  t.after(() => loaded.close())
  assert.equal((await loaded.snapshot('session-one')).totals[0].amount, '0.002')
  assert.equal((await loaded.snapshot('session-one')).counts.pending, 0)
  assert.equal((await loaded.snapshot('session-one')).latest, undefined)
  assert.deepEqual((await loaded.snapshot('session-copy')).totals, [])
})
test('corrupt ledger and concurrent writers fail closed without disrupting inference', async t => {
  const { ledger, directory } = await fixture(t)
  await ledger.record({ ...base, phase: 'usage', usage: { inputTokens: 1000, outputTokens: 0 } })
  const other = new BillingLedger({ directory })
  await other.ready
  assert.equal((await other.snapshot('session-one')).totals[0].amount, '0.002')
  assert.equal((await other.snapshot('session-one')).persistence, 'error')
  await other.close()
  await ledger.close()
  // Prevent the fixture from closing the same handles twice.
  ledger.close = async () => {}
  await writeFile(join(directory, 'ledger.jsonl'), '{broken}\n')
  const broken = new BillingLedger({ directory })
  t.after(() => broken.close())
  await broken.record({ ...base, phase: 'start' })
  assert.equal((await broken.snapshot('session-one')).persistence, 'error')
  assert.equal(await readFile(join(directory, 'ledger.jsonl'), 'utf8'), '{broken}\n')
})

test('same-millisecond calls cannot revive an older route claim', async t => {
  const { ledger } = await fixture(t)
  const old = { ...base, provider: 'anthropic-oauth' }
  const newer = { ...base, requestId: 'same-ms-new', provider: 'openai' }
  await ledger.record({ ...old, phase: 'start' })
  await ledger.record({ ...newer, phase: 'start' })
  await ledger.record({ ...old, phase: 'evidence', evidence: { kind: 'anthropic-oauth', outcome: 'plan-evidence' } })
  const snapshot = await ledger.snapshot('session-one')
  assert.equal(snapshot.latest.provider, 'openai')
  assert.equal(snapshot.latest.kind, 'unobserved')
})
test('actual OAuth evidence suppresses API estimates on aliases; native receipts support aliases', async t => {
  const { ledger } = await fixture(t, { rateCards: [{ ...card, provider: 'custom' }] })
  const alias = { ...base, provider: 'custom' }
  await ledger.record({ ...alias, phase: 'usage', usage: { inputTokens: 10, outputTokens: 10 } })
  assert.equal((await ledger.snapshot('session-one')).totals[0].kind, 'estimated')
  await ledger.record({ ...alias, phase: 'evidence', evidence: { kind: 'anthropic-oauth', authKind: 'oauth', outcome: 'unknown' } })
  await ledger.record({ ...alias, phase: 'usage', usage: { inputTokens: 20, outputTokens: 20 } })
  assert.deepEqual((await ledger.snapshot('session-one')).totals, [])
  await ledger.record({ ...alias, requestId: 'router-alias', phase: 'evidence', evidence: { kind: 'openrouter', outcome: 'reported', responseId: 'gen-correction', reportedCost: { amount: '1', currency: 'USD', scope: 'openrouter-account' } } })
  await ledger.record({ ...alias, requestId: 'router-reconciled', phase: 'evidence', evidence: { kind: 'openrouter', outcome: 'reported', responseId: 'gen-correction', reportedCost: { amount: '2', currency: 'USD', scope: 'openrouter-account' } } })
  assert.equal((await ledger.snapshot('session-one')).totals[0].amount, '2')
})
