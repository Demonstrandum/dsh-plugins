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
test('subscription readings survive restart (stale), are shared per account, and usage is fetched once when needed', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'billing-quota-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let clock = '2026-01-01T00:00:00.000Z'
  const now = () => clock
  const oauthBase = { ...base, provider: 'anthropic-oauth', model: 'claude-opus-5-5' }
  const first = new BillingLedger({ directory, rateCards: [], now })
  await first.record({ ...oauthBase, phase: 'start' })
  await first.record({ ...oauthBase, phase: 'evidence', evidence: { kind: 'anthropic-oauth', outcome: 'plan-evidence', windows: [{ label: '5h', usedPercent: 3 }, { label: '7d', usedPercent: 1 }] } })
  await first.record({ ...oauthBase, phase: 'finish' })
  assert.equal((await first.snapshot('session-one')).counts.unpriced, 0, 'subscription requests are not unpriced')
  await first.close()

  clock = '2026-01-01T01:00:00.000Z'
  const calls = []
  const answer = { windows: [{ label: '5h', usedPercent: 40 }, { label: '7d', usedPercent: 12 }], observedAt: '2026-01-01T01:00:00.000Z' }
  let release
  const gate = new Promise(resolve => { release = resolve })
  const second = new BillingLedger({ directory, rateCards: [], now, firstLoadWaitMs: 10, usage: async route => { calls.push(route); await gate; return answer } })
  await second.ready
  t.after(() => second.close())
  // Restored but stale while the usage read is slow: shown, and the client is told to re-poll.
  const restored = await second.snapshot('session-one')
  let latest = restored.latest
  assert.deepEqual([latest.kind, latest.stale, restored.refreshing], ['plan', true, true])
  assert.deepEqual(latest.windows.map(w => w.usedPercent), [3, 1])
  release()
  await new Promise(resolve => setTimeout(resolve, 10))
  latest = (await second.snapshot('session-one')).latest
  assert.deepEqual([latest.stale, latest.windows.map(w => w.usedPercent)], [false, [40, 12]])
  // Another session on the same account shares the account reading without a second fetch.
  await second.record({ ...oauthBase, sessionId: 'session-two', requestId: 'r2', phase: 'start' })
  assert.deepEqual((await second.snapshot('session-two')).latest.windows.map(w => w.usedPercent), [40, 12])
  clock = '2026-01-01T02:00:00.000Z'
  await second.snapshot('session-two')
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(calls, ['anthropic-oauth'], 'at most once per account per process')
  const saved = JSON.parse(await readFile(join(directory, 'quota.json'), 'utf8'))
  assert.equal(saved.accounts['anthropic-oauth'].source, 'usage-endpoint')
  assert.equal((await stat(join(directory, 'quota.json'))).mode & 0o777, 0o600)
})
test('a session with nothing recorded uses its selected route; observed traffic wins over the hint', async t => {
  const calls = []
  const { ledger } = await fixture(t, { rateCards: [], now: () => '2026-01-01T00:00:00.000Z', usage: async route => { calls.push(route) } })
  const quiet = (await ledger.snapshot('session-quiet', 'anthropic-oauth')).latest
  assert.deepEqual([quiet.provider, quiet.kind], ['anthropic-oauth', 'unobserved'])
  assert.equal((await ledger.snapshot('session-api', 'anthropic')).latest, undefined)
  assert.equal((await ledger.snapshot('session-bad', 'Not A Route!')).latest, undefined)
  await ledger.record({ ...base, sessionId: 'session-used', provider: 'anthropic', phase: 'start' })
  assert.equal((await ledger.snapshot('session-used', 'anthropic-oauth')).latest.provider, 'anthropic')
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(calls, ['anthropic-oauth'])
})
test('usage failures retry after backoff; a route with no reading shows the subscription marker', async t => {
  let calls = 0
  const { ledger } = await fixture(t, { rateCards: [], usageRetryMs: 0, usage: async () => { calls++; throw new Error('subscription usage rate limited') } })
  const oauthBase = { ...base, provider: 'anthropic-oauth', model: 'm' }
  await ledger.record({ ...oauthBase, phase: 'usage', usage: { inputTokens: 1, outputTokens: 1 } })
  await ledger.record({ ...oauthBase, phase: 'finish' })
  const latest = (await ledger.snapshot('session-one')).latest
  assert.deepEqual([latest.provider, latest.kind], ['anthropic-oauth', 'unobserved'])
  await new Promise(resolve => setTimeout(resolve, 10))
  await ledger.snapshot('session-one')
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(calls, 2)
  // API-key sessions never ask for subscription usage.
  await ledger.record({ ...base, sessionId: 'api', provider: 'anthropic', phase: 'start' })
  await ledger.snapshot('api')
  assert.equal(calls, 2)
})
const settle = () => new Promise(resolve => setTimeout(resolve, 20))
const message = (seq, time, provider, model, usage, responseId) => ({ type: 'assistant/message', seq, time, data: { usage,
  message: { role: 'assistant', content: [], source: { kind: 'model', provider, model, ...(responseId ? { replayState: { response: { responseId, responseModel: 'anthropic/claude-opus-5.5' } } } : {}) } } } })
test('history backfill: OpenRouter receipts, catalog fallback, once per session, live rows and inherited events excluded', async t => {
  const usage = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 1000000 }
  const reads = [], lookups = []
  const events = [
    message(1, Date.parse('2025-12-31T00:00:00Z'), 'openrouter', '~anthropic/claude-opus-latest', usage, 'gen-inherited'),
    message(5, Date.parse('2025-12-31T10:00:00Z'), 'openrouter', '~anthropic/claude-opus-latest', usage, 'gen-ok'),
    message(6, Date.parse('2025-12-31T10:01:00Z'), 'openrouter', '~anthropic/claude-opus-latest', usage, 'gen-missing'),
    message(7, Date.parse('2025-12-31T10:02:00Z'), 'anthropic-oauth', 'claude-opus-5-5', usage),
    message(8, Date.parse('2025-12-31T10:03:00Z'), 'anthropic', 'claude-opus-5-5', usage),
    message(9, Date.parse('2026-01-01T00:00:05Z'), 'openrouter', '~anthropic/claude-opus-latest', usage, 'gen-live'),
  ]
  const { ledger, directory } = await fixture(t, { rateCards: [],
    pricing: async () => catalogPricing,
    history: async id => { reads.push(id); return { inheritedEventCount: 1, events } },
    responseCost: async (provider, id) => { lookups.push(id); if (id === 'gen-ok') return { amount: '0.5', currency: 'USD' }; throw Object.assign(new Error('missing'), { code: 'PROVIDER_ERROR' }) } })
  // A live request recorded by the ledger at 00:00:00 sets the cutoff; later log messages are already covered.
  await ledger.record({ ...base, provider: 'openrouter', model: '~anthropic/claude-opus-latest', phase: 'evidence', evidence: { kind: 'openrouter', responseId: 'gen-live', reportedCost: { amount: '0.25', currency: 'USD', scope: 'openrouter-account' }, outcome: 'unknown' } })
  await ledger.snapshot('session-one')
  await settle()
  const snapshot = await ledger.snapshot('session-one')
  assert.deepEqual(reads, ['session-one'], 'the log is read once per process')
  assert.deepEqual(lookups, ['gen-ok', 'gen-missing'])
  const byKind = Object.fromEntries(snapshot.totals.map(t => [`${t.kind}/${t.scope}`, t.amount]))
  assert.equal(byKind['reported/openrouter-account'], '0.75', 'receipt 0.5 + live 0.25')
  assert.equal(byKind['estimated/openrouter-tokens'], '0.206', 'missing receipt falls back to the catalog')
  assert.equal(byKind['estimated/model-tokens'], '0.206', 'API-key history priced from the catalog')
  assert.equal(snapshot.counts.requests, 4, 'live + 3 history rows; subscription and inherited skipped')
  const persisted = await readFile(join(directory, 'ledger.jsonl'), 'utf8')
  assert.ok(persisted.includes('history:5') && !persisted.includes('history:1') && !persisted.includes('history:7'))
  // A new process sees the history rows and adds nothing.
  await ledger.close()
  const again = new BillingLedger({ directory, rateCards: [], pricing: async () => catalogPricing, history: async () => ({ inheritedEventCount: 1, events }), responseCost: async id => { lookups.push(id) } })
  t.after(() => again.close())
  await again.snapshot('session-one'); await settle()
  assert.equal((await again.snapshot('session-one')).counts.requests, 4)
  assert.equal(lookups.length, 2)
})
test('the first snapshot waits briefly for its backfill; slow work reports refreshing', async t => {
  const usage = { inputTokens: 1000, outputTokens: 0 }
  const events = [message(3, Date.parse('2025-12-31T00:00:00Z'), 'anthropic', 'claude-opus-5-5', usage)]
  const { ledger } = await fixture(t, { rateCards: [], pricing: async () => catalogPricing, history: async () => ({ events }) })
  assert.equal((await ledger.snapshot('session-one')).totals[0].amount, '0.004', 'priced on the very first snapshot')
  let release
  const gate = new Promise(resolve => { release = resolve })
  const slow = await fixture(t, { rateCards: [], firstLoadWaitMs: 10, pricing: async () => catalogPricing, history: async () => { await gate; return { events } } })
  const first = await slow.ledger.snapshot('session-one')
  assert.deepEqual([first.totals, first.refreshing], [[], true])
  release(); await settle()
  const later = await slow.ledger.snapshot('session-one')
  assert.deepEqual([later.totals[0].amount, later.refreshing], ['0.004', undefined])
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
test('a late response from a superseded request never replaces the shown reading', async t => {
  const { ledger } = await fixture(t, { now: () => '2026-01-01T00:00:03.000Z' })
  const request = { ...base, provider: 'anthropic-oauth' }
  await ledger.record({ ...request, phase: 'evidence', evidence: { outcome: 'plan-evidence', windows: [{ label: '5h', usedPercent: 10 }] } })
  await ledger.record({ ...request, requestId: 'new-account-request', at: '2026-01-01T00:00:01Z', phase: 'start' })
  await ledger.record({ ...request, at: '2026-01-01T00:00:02Z', phase: 'evidence', evidence: { outcome: 'plan-evidence', windows: [{ label: '5h', usedPercent: 99 }] } })
  const latest = (await ledger.snapshot('session-one')).latest
  // While the new request is in flight, the last accepted account reading stays on screen.
  assert.deepEqual([latest.kind, latest.requestId, latest.windows.map(w => w.usedPercent)], ['plan', 'new-account-request', [10]])
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
test('reload preserves costs; API sessions get no quota reading; history/forks do not inherit costs', async t => {
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
