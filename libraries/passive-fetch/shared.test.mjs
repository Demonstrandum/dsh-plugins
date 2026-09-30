import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { acquirePassiveFetch } from './index.mjs'
import { installTransport } from '../../plugins/anthropic-oauth-audit/transport.mjs'
import { IDENTITY } from '../../plugins/anthropic-oauth-audit/evidence.mjs'
import { installCollector } from '../../plugins/billing-status/collector.mjs'

const A = 'https://api.anthropic.com/v1/messages'
const O = 'https://openrouter.ai/api/v1/chat/completions'
const init = { method: 'POST', headers: { authorization: 'Bearer sk-ant-oat01-fixture' } }
const headers = { 'anthropic-ratelimit-unified-representative-claim': 'five_hour', 'anthropic-ratelimit-unified-status': 'allowed' }
const opts = { provider: 'anthropic-oauth', model: 'fixture', sessionId: 'session-fixture' }
const finish = { type: 'finish', reason: { kind: 'stop' } }
const context = () => ({ effect: fn => fn(), on(name, fn) { this.listener = fn; return () => {} } })
const consume = async stream => { const results = []; for await (const value of stream) results.push(value); return results }

test('both vendored modules equal canonical source byte-for-byte', async () => {
  const source = await readFile(new URL('./index.mjs', import.meta.url), 'utf8')
  for (const name of ['anthropic-oauth-audit', 'billing-status']) {
    assert.equal(await readFile(new URL(`../../plugins/${name}/passive-fetch.mjs`, import.meta.url), 'utf8'), source)
  }
})
test('audit and billing capture one response metadata object with one native headers access', async () => {
  const reply = new Response(null, { headers })
  const target = { fetch: async () => reply }, original = target.fetch
  const ctx = context(), a = [], b = []
  const audit = installTransport({ target, mode: 'observe', report: (_, report) => a.push(report) })
  const wrapper = target.fetch
  const off = installCollector(ctx, event => b.push(event), { target })
  assert.equal(target.fetch, wrapper)
  let reads = 0
  const descriptor = Object.getOwnPropertyDescriptor(Response.prototype, 'headers')
  Object.defineProperty(Response.prototype, 'headers', { ...descriptor, get() { reads++; return descriptor.get.call(this) } })
  try {
    await audit.run({}, () => consume(ctx.listener(opts, async function* () { assert.equal(await target.fetch(A, init), reply); yield finish })))
    assert.equal(reads, 1)
    assert.equal(a.length, 1)
    assert.equal(a[0].outcome, 'plan-evidence')
    assert.equal(b.find(x => x.evidence)?.evidence.outcome, 'plan-evidence')
  } finally { Object.defineProperty(Response.prototype, 'headers', descriptor); audit.dispose(); off() }
  assert.equal(target.fetch, original)
})
test('audit unscoped nesting clears only audit while billing still receives its own request', async () => {
  const target = { fetch: async () => new Response(null, { headers }) }
  const ctx = context(), a = [], b = []
  const audit = installTransport({ target, mode: 'observe', report: (state, report) => a.push({ id: state.id, report }) })
  const off = installCollector(ctx, event => b.push(event), { target })
  try {
    await audit.run({ id: 'outer' }, async () => {
      await consume(audit.unscoped(() => ctx.listener(opts, async function* () { await target.fetch(A, init); yield finish })))
      await target.fetch(A, init)
    })
    assert.equal(a.length, 1)
    assert.equal(a[0].id, 'outer')
    assert.equal(b.filter(x => x.phase === 'evidence').length, 1)
  } finally { off(); audit.dispose() }
})
test('multiple billing subscribers share one body parser and both receive receipts', async () => {
  let taps = 0, reads = 0
  const response = new Response(new ReadableStream({ pull(controller) { reads++; controller.enqueue(new TextEncoder().encode('fixture')); controller.close() } }, { highWaterMark: 0 }))
  const target = { fetch: async () => response }
  const a = acquirePassiveFetch(target), b = acquirePassiveFetch(target)
  const events = [[], []]
  const state = index => ({ active: () => true, beginHTTP: () => ({}), headers() {},
    bodyTap: { key: 'fixture-v1', apply(reply, publish) { taps++; publish({ amount: { value: '0.1' } }); return reply } },
    evidence(_, evidence) { events[index].push(evidence); if (index === 0) evidence.amount.value = 'mutated' },
  })
  try {
    assert.equal(await a.run(state(0), () => b.run(state(1), () => target.fetch(O, init))), response)
    assert.equal(taps, 1)
    assert.equal(reads, 0)
    assert.equal(events[1][0].amount.value, '0.1')
    assert.equal(await response.text(), 'fixture')
    assert.equal(reads, 1)
  } finally { a.release(); b.release() }
})
test('disposing one subscriber mid-fetch leaves the other active', async () => {
  let resolve
  const target = { fetch: () => new Promise(yes => { resolve = yes }) }, original = target.fetch
  const a = acquirePassiveFetch(target), b = acquirePassiveFetch(target), events = []
  const state = id => ({ active: () => true, beginHTTP: () => id, headers: () => events.push(id) })
  const pending = a.run(state('a'), () => b.run(state('b'), () => target.fetch(A, init)))
  a.release()
  resolve(new Response(null, { headers }))
  await pending
  assert.deepEqual(events, ['b'])
  b.release()
  assert.equal(target.fetch, original)
})
test('broken observer metadata cannot break inference or another observer', async () => {
  const reply = new Response(null)
  const target = { fetch: async () => reply }
  const a = acquirePassiveFetch(target), b = acquirePassiveFetch(target), evidence = []
  const broken = { active: () => true, beginHTTP: () => 1, headers() { throw new Error('fixture') }, get bodyTap() { throw new Error('fixture') } }
  const working = { active: () => true, beginHTTP: () => 2, headers: () => evidence.push('observed') }
  try { assert.equal(await a.run(broken, () => b.run(working, () => target.fetch(O, init))), reply); assert.deepEqual(evidence, ['observed']) }
  finally { a.release(); b.release() }
})
test('actual npm packs are standalone and packed packages share one protocol broker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passive-pack-'))
  try {
    const imports = {}
    for (const name of ['anthropic-oauth-audit', 'billing-status']) {
      const cwd = fileURLToPath(new URL(`../../plugins/${name}/`, import.meta.url))
      const text = execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], { cwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] })
      const packed = JSON.parse(text)[0]
      assert.ok(packed.files.some(file => file.path === 'passive-fetch.mjs'))
      const directory = join(root, name)
      await mkdir(directory)
      execFileSync('tar', ['-xzf', join(root, packed.filename), '-C', directory], { stdio: 'pipe' })
      const host = await import(pathToFileURL(join(directory, 'package/index.js')))
      assert.equal(typeof host.apply, 'function')
      imports[name] = await import(pathToFileURL(join(directory, 'package/passive-fetch.mjs')))
    }
    const target = { fetch: async () => new Response(null) }, original = target.fetch
    const first = imports['anthropic-oauth-audit'].acquirePassiveFetch(target), wrapper = target.fetch
    const second = imports['billing-status'].acquirePassiveFetch(target)
    assert.equal(target.fetch, wrapper)
    first.release(); assert.equal(target.fetch, wrapper)
    second.release(); assert.equal(target.fetch, original)
  } finally { await rm(root, { recursive: true, force: true }) }
})

for (const auditFirst of [true, false]) test(`explicit enforcing audit remains independent and blocking: auditFirst=${auditFirst}`, async () => {
  let sent = 0
  const target = { fetch: async () => { sent++; return new Response(null, { headers }) } }
  const ctx = context(), events = [], reports = []
  let audit, off
  const addAudit = () => { audit = installTransport({ target, mode: 'audit', cliUserAgent: 'claude-cli/2.1.280', report: (_, event) => reports.push(event) }) }
  const addBilling = () => { off = installCollector(ctx, event => events.push(event), { target }) }
  if (auditFirst) { addAudit(); addBilling() } else { addBilling(); addAudit() }
  const valid = { method: 'POST', body: JSON.stringify({ system: [{ type: 'text', text: IDENTITY }], messages: [], tools: [] }),
    headers: { authorization: 'Bearer sk-ant-oat01-fixture', 'user-agent': 'claude-cli/2.1.280', 'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20', 'x-app': 'cli' } }
  try {
    await audit.run({}, () => consume(ctx.listener(opts, async function* () { await target.fetch(A, valid); yield finish })))
    assert.equal(sent, 1)
    assert.equal(reports[0].outcome, 'plan-evidence')
    assert.equal(events.find(event => event.phase === 'evidence').evidence.outcome, 'plan-evidence')
    await assert.rejects(audit.run({}, () => consume(ctx.listener(opts, async function* () { await target.fetch(A, { ...valid, body: '{}' }); yield finish }))))
    assert.equal(sent, 1, 'explicit wire enforcement still blocks invalid payloads before dispatch')
  } finally { off(); audit.dispose() }
})

test('async passive audit callbacks cannot reject the native response', async () => {
  const response = new Response(null, { headers })
  const target = { fetch: async () => response }
  const audit = installTransport({ target, mode: 'observe', report: async () => { throw new Error('fixture telemetry') } })
  try { assert.equal(await audit.run({}, () => target.fetch(A, init)), response) }
  finally { audit.dispose() }
})

test('symbol-keyed header iterables cannot be misclassified from decoy record fields', async () => {
  const events = [], target = { fetch: async () => new Response(null, { headers }) }
  let consumed = 0
  const raw = { authorization: 'Bearer sk-ant-oat01-decoy', *[Symbol.iterator]() { consumed++; yield ['x-api-key','fixture-key'] } }
  const audit = installTransport({ target, mode: 'observe', report: (_, result) => events.push(result) })
  try { await audit.run({}, () => target.fetch(A, { method: 'POST', headers: raw })); assert.equal(consumed, 0); assert.deepEqual(events, []) }
  finally { audit.dispose() }
})
