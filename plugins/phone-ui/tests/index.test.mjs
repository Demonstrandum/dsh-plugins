// node --test: the plugin against a fake ctx — no DSH boot needed.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_MAX_WIDTH, MAX_MAX_WIDTH, MIN_MAX_WIDTH, SELECTORS, apply, normalizeConfig, phoneStyle,
} from '../index.js'

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

const ALL_ON = { maxWidth: DEFAULT_MAX_WIDTH, header: true, messageActions: true, stats: true }

test('defaults: 640px, all three groups hidden', () => {
  assert.deepEqual(normalizeConfig(undefined), ALL_ON)
  assert.deepEqual(normalizeConfig({}), ALL_ON)
  const css = phoneStyle(ALL_ON)
  assert.match(css, /^@media \(max-width:640px\)\{/)
  for (const selector of Object.values(SELECTORS).flat()) assert.ok(css.includes(selector), selector)
  assert.match(css, /\{display:none\}\}$/)
})

test('config: maxWidth integer 320-1200, flags boolean, everything else rejected loudly', () => {
  assert.equal(normalizeConfig({ maxWidth: MIN_MAX_WIDTH }).maxWidth, MIN_MAX_WIDTH)
  assert.equal(normalizeConfig({ maxWidth: MAX_MAX_WIDTH }).maxWidth, MAX_MAX_WIDTH)
  for (const bad of [MIN_MAX_WIDTH - 1, MAX_MAX_WIDTH + 1, 400.5, '640', null, NaN]) {
    assert.throws(() => normalizeConfig({ maxWidth: bad }), /maxWidth must be an integer/, String(bad))
  }
  for (const key of ['header', 'messageActions', 'stats']) {
    assert.equal(normalizeConfig({ [key]: false })[key], false)
    assert.throws(() => normalizeConfig({ [key]: 'yes' }), new RegExp(`${key} must be a boolean`))
  }
})

test('groups switch off independently', () => {
  const css = phoneStyle({ ...ALL_ON, messageActions: false })
  assert.ok(css.includes(SELECTORS.header[0]))
  assert.ok(css.includes(SELECTORS.stats[0]))
  for (const selector of SELECTORS.messageActions) assert.ok(!css.includes(selector), selector)
})

test('apply pushes one style row into the index-inject table', () => {
  const { ctx, listeners, logs } = fakeContext()
  apply(ctx, { maxWidth: 480 })
  const table = []
  listeners.get('webserver/index-inject')(table)
  assert.equal(table.length, 1)
  assert.equal(table[0].kind, 'style')
  assert.match(table[0].text, /^\/\* tali-phone-ui \*\//)
  assert.match(table[0].text, /max-width:480px/)
  assert.match(logs[0], /≤480px hides header, messageActions, stats/)
})

test('all groups off disables the rule: no listener, no style', () => {
  const { ctx, listeners, logs } = fakeContext()
  const off = { header: false, messageActions: false, stats: false }
  apply(ctx, off)
  assert.equal(phoneStyle(normalizeConfig(off)), '')
  assert.equal(listeners.has('webserver/index-inject'), false)
  assert.match(logs[0], /disabled/)
})
