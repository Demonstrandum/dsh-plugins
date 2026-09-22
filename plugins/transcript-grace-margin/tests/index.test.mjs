// node --test: the plugin against a fake ctx — no DSH boot needed.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_MARGIN, MAX_MARGIN, apply, graceStyle, normalizeConfig } from '../index.js'

function fakeContext() {
  const listeners = new Map()
  const logs = []
  const ctx = {
    webServer: { port: 3088 },
    on(event, fn) {
      listeners.set(event, fn)
      return () => { listeners.delete(event) }
    },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(`warn: ${m}`) },
  }
  return { ctx, listeners, logs }
}

test('defaults: 160px rule on the active-phase chat column', () => {
  assert.deepEqual(normalizeConfig(undefined), { margin: DEFAULT_MARGIN })
  assert.deepEqual(normalizeConfig({}), { margin: DEFAULT_MARGIN })
  assert.equal(graceStyle({ margin: 160 }), '[data-conversation-scroll] [data-chat-flow]{padding-bottom:160px}')
})

test('config: integer 0-600 accepted, everything else rejected loudly', () => {
  assert.deepEqual(normalizeConfig({ margin: 0 }), { margin: 0 })
  assert.deepEqual(normalizeConfig({ margin: MAX_MARGIN }), { margin: MAX_MARGIN })
  for (const bad of [-1, MAX_MARGIN + 1, 12.5, '160', null, NaN, Infinity]) {
    assert.throws(() => normalizeConfig({ margin: bad }), /margin must be an integer/, String(bad))
  }
})

test('apply pushes one style row into the index-inject table', () => {
  const { ctx, listeners, logs } = fakeContext()
  apply(ctx, { margin: 200 })
  const table = []
  listeners.get('webserver/index-inject')(table)
  assert.equal(table.length, 1)
  assert.equal(table[0].kind, 'style')
  assert.match(table[0].text, /padding-bottom:200px/)
  assert.match(table[0].text, /^\/\* tali-transcript-grace-margin \*\//)
  assert.match(logs[0], /200px/)
})

test('margin 0 disables the rule: no listener, no style', () => {
  const { ctx, listeners, logs } = fakeContext()
  apply(ctx, { margin: 0 })
  assert.equal(graceStyle({ margin: 0 }), '')
  assert.equal(listeners.has('webserver/index-inject'), false)
  assert.match(logs[0], /disabled/)
})
