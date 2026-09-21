// node --test: the plugin against a fake webServer/ctx — no DSH boot needed.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GENERIC_PRODUCT_TITLE, apply, identityStyle, isSafeColor, isSafeLabel, normalizeConfig, titleScript } from '../index.js'

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

test('defaults: "DSH" wordmark + title script, subtle badge, no whale colour, no routes', () => {
  const { ctx, routes, listeners } = fakeContext()
  apply(ctx, undefined)
  assert.equal(routes.size, 0)
  const table = []
  listeners.get('webserver/index-inject')(table)
  assert.deepEqual(table.map(row => row.kind), ['style', 'script'])
  assert.match(table[0].text, /_buildVersion.*opacity:\.4/)
  assert.match(table[0].text, /_localBuildTitle"\]::before\{content:"DSH";font-size:12px/)
  assert.match(table[0].text, /_fallbackBrandName"\]::before\{content:"DSH";font-size:17px/)
  assert.doesNotMatch(table[0].text, /_brandMark/)
  assert.equal(table[1].placement, 'body')
  assert.doesNotMatch(table[1].text, /<\/script/i)
})

test('label "DSH Local Build" opts out of renaming; stock badge and no colour then inject nothing', () => {
  const { ctx, listeners } = fakeContext()
  apply(ctx, { label: GENERIC_PRODUCT_TITLE, versionBadge: 'stock' })
  assert.equal(listeners.has('webserver/index-inject'), false)
})

/** Run the title script against a minimal document whose <title> mutates like a browser's. */
function runTitleScript(script, initialTitle, dock) {
  let observer
  const titleEl = {}
  const doc = {
    _title: initialTitle,
    get title() { return this._title },
    set title(v) { this._title = v; observer?.() },
    querySelector: (sel) => sel === 'title' ? titleEl : null,
  }
  const MutationObserver = class { constructor(fn) { this.fn = fn } observe() { observer = this.fn } }
  // eslint-disable-next-line no-new-func
  new Function('globalThis', 'document', 'MutationObserver', script)({ __DSH_DOCK__: dock }, doc, MutationObserver)
  return doc
}

test('titleScript substitutes the label now and on later title changes', () => {
  const doc = runTitleScript(titleScript({ label: 'DSH Preview' }), 'DSH Local Build', undefined)
  assert.equal(doc.title, 'DSH Preview')
  doc.title = 'my session — DSH Local Build'
  assert.equal(doc.title, 'my session — DSH Preview')
  doc.title = 'unrelated'
  assert.equal(doc.title, 'unrelated')
})

test('titleScript defers to a Dock app\'s own name', () => {
  const doc = runTitleScript(titleScript({ label: 'DSH' }), 'x — DSH Local Build', { name: 'DSH Remote' })
  assert.equal(doc.title, 'x — DSH Remote')
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
  assert.throws(() => normalizeConfig({ label: 'x";}</style>' }), /label/)
  assert.throws(() => normalizeConfig({ label: '' }), /label/)
  assert.deepEqual(normalizeConfig(null), { label: 'DSH', brandColor: '', versionBadge: 'subtle', dockLabel: '' })
})

test('isSafeLabel', () => {
  for (const ok of ['DSH', 'DSH Remote', 'DSH-dev', 'v0.1_x']) assert.equal(isSafeLabel(ok), true, ok)
  for (const bad of ['', ' DSH', 'a"b', 'x\\y', 'a'.repeat(33)]) assert.equal(isSafeLabel(bad), false, bad)
})

test('isSafeColor accepts hex and names only', () => {
  for (const ok of ['#E5484D', '#abc', 'red', 'RebeccaPurple']) assert.equal(isSafeColor(ok), true, ok)
  for (const bad of ['', '#12345', 'rgb(1,2,3)', 'url(x)', 'red }', '#E5484D;']) assert.equal(isSafeColor(bad), false, bad)
})

test('identityStyle composes the rule groups', () => {
  assert.equal(identityStyle({ label: GENERIC_PRODUCT_TITLE, brandColor: '', versionBadge: 'stock' }), '')
  assert.equal(identityStyle({ label: GENERIC_PRODUCT_TITLE, brandColor: 'red', versionBadge: 'subtle' }).split('\n').length, 2)
  assert.equal(identityStyle({ label: 'DSH', brandColor: 'red', versionBadge: 'subtle' }).split('\n').length, 5)
})
