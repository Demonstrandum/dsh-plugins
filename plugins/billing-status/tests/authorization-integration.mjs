/** Offline only: real Cordis lifecycles, in-memory HTTP route/tracker fixtures, temporary owner/ledger files.
 * From deepseek-harness: node --import tsx/esm --test ../plugins/billing-status/tests/authorization-integration.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '../../../deepseek-harness/vendor/cordis/lib/index.js'
import * as Billing from '../index.js'
import { createSessionReadAccess, markSessionReadPolicy } from '../../dsh-tailscale-remote/session-read-access.mjs'
import { SessionOwners, loginOf } from '../../dsh-tailscale-remote/owners.mjs'
import { attachClientTracker } from '../../dsh-tailscale-remote/server.mjs'

const pathFor = id => `${Billing.SNAPSHOT_PATH}?sessionId=${id}`
const request = (id = 'session-fixture', headers = {}) => new Request(`http://localhost${pathFor(id)}`, { headers })

async function settle(ctx) {
  // Await real Cordis dependency callbacks, not wall-clock guesses.
  for (const runtime of ctx.registry.values()) {
    for (const fiber of runtime.fibers) await fiber.await()
  }
}

async function fixture(t, { beforeBilling } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'billing-authorization-'))
  const ctx = new Context()
  const routes = new Map()
  let registrations = 0
  t.after(async () => {
    try { await ctx.fiber.dispose() }
    finally { await rm(directory, { recursive: true, force: true }) }
  })
  await ctx.plugin(c => { c.provide('llm', {}) })
  const connection = await ctx.plugin(c => {
    c.provide('connection', {
      fetch: {
        register(route) {
          assert.equal(route.path, Billing.SNAPSHOT_PATH)
          assert.deepEqual(route.methods, ['GET'])
          assert.equal(routes.has(route.path), false, 'one active route per path')
          routes.set(route.path, route)
          registrations++
          return () => { if (routes.get(route.path) === route) routes.delete(route.path) }
        },
      },
    })
  })
  const mountBilling = async (module = Billing) => {
    const fiber = await ctx.plugin(module, { directory })
    await settle(ctx)
    assert.equal(routes.size, 1)
    return fiber
  }
  await beforeBilling?.(ctx)
  const billing = await mountBilling()
  return {
    ctx, routes, connection, billing, mountBilling,
    registrations: () => registrations,
    response: (...args) => {
      const route = routes.get(Billing.SNAPSHOT_PATH)
      assert.ok(route, 'billing route must be registered')
      return route.fetch(request(...args))
    },
  }
}

test('real Cordis latches ownership appearing and disappearing before the first request, across remounts', async t => {
  for (const service of ['billingAccess', 'sessionRequestAccess', 'sessionOwners']) {
    await t.test(service, async t => {
      const f = await fixture(t)
      const provider = await f.ctx.plugin(c => { c.provide(service, { canRead: () => false }) })
      await settle(f.ctx)
      await provider.dispose()
      await settle(f.ctx)
      assert.equal((await f.response()).status, 403, 'service lifecycle alone must latch, without a request')

      const before = f.registrations()
      await f.connection.restart()
      await settle(f.ctx)
      assert.ok(f.registrations() > before, 'connection restart actually recreated the route')
      assert.equal((await f.response()).status, 403)

      await f.billing.restart()
      await settle(f.ctx)
      assert.equal((await f.response()).status, 403, 'billing plugin restart preserves policy')

      await f.billing.dispose()
      assert.equal(f.routes.size, 0)
      // A new module instance also must share the root's sticky authorization mode.
      const reloaded = await import(new URL(`../index.js?authorization-fixture=${service}`, import.meta.url).href)
      const replacement = await f.mountBilling(reloaded)
      assert.equal((await f.response()).status, 403, 'plugin recreation/module evaluation preserves policy')
      await replacement.dispose()
    })
  }
})

test('real Cordis independent roots retain independent baseline access', async t => {
  const restricted = await fixture(t)
  const singleUser = await fixture(t)
  const provider = await restricted.ctx.plugin(c => { c.provide('sessionOwners', {}) })
  await settle(restricted.ctx)
  await provider.dispose()
  await settle(restricted.ctx)
  assert.equal((await restricted.response()).status, 403)
  assert.equal((await singleUser.response()).status, 200)
  await singleUser.connection.restart()
  await settle(singleUser.ctx)
  await singleUser.billing.restart()
  await settle(singleUser.ctx)
  assert.equal((await singleUser.response()).status, 200)
  assert.equal((await restricted.response()).status, 403)
})

test('tailnet root marker survives provider removal before billing first mounts', async t => {
  const f = await fixture(t, { beforeBilling: async ctx => {
    const provider = await ctx.plugin(c => {
      markSessionReadPolicy(c.root)
      c.provide('sessionRequestAccess', { canRead: () => true })
    })
    await provider.dispose()
    await settle(ctx)
    assert.equal(ctx.get('sessionRequestAccess'), undefined)
  } })
  assert.equal((await f.response()).status, 403, 'no baseline fallback after pre-billing policy marker')
  await f.connection.restart()
  await settle(f.ctx)
  assert.equal((await f.response()).status, 403)
})
test('poisoned legacy attribution cannot override explicit billing bindings', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'billing-owner-poison-'))
  const owners = new SessionOwners({ file: join(directory, 'owners.json') })
  await owners.loaded
  const server = new EventEmitter()
  const tracker = attachClientTracker(server, {
    onSession: (facts, found) => owners.record(found.sessionId, loginOf(facts, 'host@example.com'), found.method),
  })
  const bindings = Object.assign(Object.create({ 'session-inherited': 'bob@example.com' }), {
    'session-victim': 'alice@example.com',
  })
  const access = createSessionReadAccess({
    lookupOwner: id => Object.hasOwn(bindings, id) ? bindings[id] : undefined,
  })
  t.after(async () => {
    tracker.dispose()
    access.dispose()
    try { await owners.dispose() }
    finally { await rm(directory, { recursive: true, force: true }) }
  })

  // Exercise the actual legacy tracker ambiguity without opening a network listener.
  const incoming = Object.assign(new EventEmitter(), {
    method: 'POST', url: '/api/session/prompt', socket: { remoteAddress: '127.0.0.1' },
    headers: { 'x-dsh-tailscale-remote': '1', 'x-dsh-tailscale-remote-login': 'bob@example.com' },
  })
  server.emit('request', incoming)
  incoming.emit('data', Buffer.from(JSON.stringify({ payload: { args: {
    sessionId: 'session-victim', request: { sessionId: 'session-actual', content: [] },
  } } })))
  incoming.emit('end')
  assert.equal(owners.of('session-victim').owner, 'bob@example.com', 'fixture must actually poison legacy attribution')

  const canRead = (who, id = 'session-victim') => {
    const headers = access.proxyHeaders({ method: 'GET', url: pathFor(id) }, { kind: 'user', login: `${who}@example.com` })
    return access.canRead(request(id, headers), id)
  }
  assert.equal(await canRead('alice'), true)
  assert.equal(await canRead('bob'), false)
  assert.equal(await canRead('bob', 'session-inherited'), false)
  assert.equal(await canRead('bob', 'session-missing'), false)
  delete bindings['session-victim']
  assert.equal(await canRead('alice'), false, 'removing an explicit binding does not fall back to attribution')
})

test('legacy owner objects and invalid/missing policy values never authorize', async () => {
  for (const owner of [undefined, null, '', 'local', 'token', 'alice@example.com\n',
    { owner: 'alice@example.com', first: { method: 'session/prompt' } }, ['alice@example.com']]) {
    const access = createSessionReadAccess({ lookupOwner: () => owner })
    try {
      const headers = access.proxyHeaders({ method: 'GET', url: pathFor('session-fixture') }, { kind: 'user', login: 'alice@example.com' })
      assert.equal(await access.canRead(request('session-fixture', headers), 'session-fixture'), false)
    } finally { access.dispose() }
  }
})
