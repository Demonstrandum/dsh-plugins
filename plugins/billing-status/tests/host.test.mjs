import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig, snapshotHandler, apply } from '../index.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const request = (id = 'session-fixture', headers) => new Request(`http://localhost/api/billing-status/snapshot?sessionId=${encodeURIComponent(id)}`, { headers })
test('snapshot API uses core authentication and fails closed when owner authorization is unavailable', async () => {
  let calls = 0
  const ledger = { snapshot: async sessionId => { calls++; return { sessionId, version: 1 } } }
  const singleUser = snapshotHandler({ get: () => undefined }, ledger)
  assert.equal((await singleUser(request())).status, 200)
  assert.equal((await singleUser(request('../escape'))).status, 400)
  const tracked = snapshotHandler({ get: key => key === 'sessionOwners' ? { of: () => ({ owner: 'some-owner' }) } : undefined }, ledger)
  const before = calls
  assert.equal((await tracked(request('session-fixture', { 'x-dsh-tailscale-remote-login': 'some-owner' }))).status, 403)
  assert.equal(calls, before)
  const permitted = snapshotHandler({ get: key => key === 'billingAccess' ? { canRead: (_, id) => id === 'session-fixture' } : undefined }, ledger)
  assert.equal((await permitted(request())).status, 200)
  assert.equal((await permitted(request('session-other'))).status, 403)
  const broken = snapshotHandler({ get: () => ({ canRead: () => { throw new Error('private identity') } }) }, ledger)
  const response = await broken(request())
  assert.equal(response.status, 503)
  assert.equal((await response.text()).includes('private identity'), false)
})
test('configuration rejects typoed or ambiguous rates', () => {
  assert.throws(() => resolveConfig({ mode: 'audit' }))
  assert.throws(() => resolveConfig({ staleAfterMs: -1 }))
  assert.throws(() => resolveConfig({ rateCards: [{ provider: 'anthropic-oauth' }] }))
  assert.equal(resolveConfig({}).staleAfterMs, 300000)
})
test('host mounts without OAuth/audit/commands/connection plugins and disposes capture', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'billing-host-'))
  const original = globalThis.fetch, disposers = [], services = new Map()
  const ctx = {
    effect(setup) { const dispose = setup(); disposers.push(dispose); return dispose },
    on() { return () => {} },
    provide(name, service) { services.set(name, service) },
    get(name) { return services.get(name) },
    inject() {},
  }
  try {
    apply(ctx, { directory })
    assert.ok(services.has('billingStatus'))
    const snapshot = await services.get('billingStatus').snapshot('session-fixture')
    assert.equal(snapshot.persistence, 'ok')
    assert.deepEqual(snapshot.totals, [])
    for (const dispose of disposers.reverse()) await dispose?.()
    assert.equal(globalThis.fetch, original)
  } finally { globalThis.fetch = original; await rm(directory, { recursive: true, force: true }) }
})
