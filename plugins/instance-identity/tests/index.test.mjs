// node --test: the plugin against a fake webServer/ctx — no DSH boot needed.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, identityStyle, isSafeColor, normalizeConfig } from '../index.js'

function fakeContext(port = 3088) {
  const routes = new Map()
  const listeners = new Map()
  const logs = []
  const ctx = {
    webServer: {
      port,
      register(route) {
        routes.set(route.path, route.handler)
        return () => { routes.delete(route.path) }
      },
    },
    effect(fn) { return fn() },
    on(event, fn) {
      listeners.set(event, fn)
      return () => { listeners.delete(event) }
    },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(`warn: ${m}`) },
  }
  return { ctx, routes, listeners, logs }
}

/** Drive a registered exact-route handler with a GET and collect the response. */
async function get(handler, method = 'GET') {
  let status
  let headers
  let body
  await handler({ method }, {
    writeHead(s, h) { status = s; headers = h ?? {} },
    end(b) { body = b },
  })
  return { status, headers, body }
}

test('defaults: subtle badge only, no whale colour, no routes', () => {
  const { ctx, routes, listeners } = fakeContext()
  apply(ctx, undefined)
  assert.equal(routes.size, 0)
  const table = []
  listeners.get('webserver/index-inject')(table)
  assert.equal(table.length, 1)
  assert.equal(table[0].kind, 'style')
  assert.match(table[0].text, /_buildVersion.*opacity:\.4/)
  assert.doesNotMatch(table[0].text, /_brandMark/)
})

test('versionBadge: stock and no colour injects nothing', () => {
  const { ctx, listeners } = fakeContext()
  apply(ctx, { versionBadge: 'stock' })
  assert.equal(listeners.has('webserver/index-inject'), false)
})

test('brandColor colours the whale and serves a recoloured favicon', async () => {
  const { ctx, routes, listeners } = fakeContext()
  apply(ctx, { brandColor: '#0090FF' })
  const table = []
  listeners.get('webserver/index-inject')(table)
  assert.match(table[0].text, /span\[class\*="_brandMark"\],span\[class\*="_railMark"\]\{color:#0090FF\}/)
  const favicon = await get(routes.get('/favicon.svg'))
  assert.equal(favicon.status, 200)
  assert.equal(favicon.headers['content-type'], 'image/svg+xml')
  assert.equal(favicon.headers['cache-control'], 'no-store, max-age=0')
  assert.match(favicon.body, /fill="#0090FF"/)
  assert.doesNotMatch(favicon.body, /__BRAND_COLOR__|<style/)
  assert.equal((await get(routes.get('/favicon.svg'), 'POST')).status, 405)
  assert.equal(routes.has('/manifest.webmanifest'), false)
})

test('dockLabel replaces the manifest with a port-scoped app id', async () => {
  const { ctx, routes } = fakeContext(3081)
  apply(ctx, { dockLabel: 'DSH-dev' })
  const res = await get(routes.get('/manifest.webmanifest'))
  assert.equal(res.status, 200)
  const manifest = JSON.parse(res.body)
  assert.equal(manifest.short_name, 'DSH-dev')
  assert.equal(manifest.name, 'DSH-dev :3081')
  assert.equal(manifest.id, '/?instance=3081')
  assert.equal(manifest.icons[0].src, '/favicon.svg')
})

test('malformed config fails loudly', () => {
  assert.throws(() => normalizeConfig({ brandColor: 'red;}</style><script>' }), /brandColor/)
  assert.throws(() => normalizeConfig({ versionBadge: 'loud' }), /versionBadge/)
  assert.deepEqual(normalizeConfig(null), { brandColor: '', versionBadge: 'subtle', dockLabel: '' })
})

test('isSafeColor accepts hex and names only', () => {
  for (const ok of ['#E5484D', '#abc', 'red', 'RebeccaPurple']) assert.equal(isSafeColor(ok), true, ok)
  for (const bad of ['', '#12345', 'rgb(1,2,3)', 'url(x)', 'red }', '#E5484D;']) assert.equal(isSafeColor(bad), false, bad)
})

test('identityStyle composes both rules', () => {
  assert.equal(identityStyle({ brandColor: '', versionBadge: 'stock' }), '')
  const both = identityStyle({ brandColor: 'red', versionBadge: 'subtle' })
  assert.equal(both.split('\n').length, 2)
})
