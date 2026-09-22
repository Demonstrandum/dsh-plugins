// node --test: the plugin against a fake ctx — no DSH boot needed.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_MAX_WIDTH, DEFAULT_SIDE_MARGIN, MAX_MAX_WIDTH, MAX_SIDE_MARGIN, MIN_MAX_WIDTH, MOBILE_FLAG_SELECTOR,
  SELECTORS, STOCK_SIDE_MARGIN, USER_BUBBLE_SELECTOR, apply, normalizeConfig, phoneStyle,
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

const ALL_ON = {
  maxWidth: DEFAULT_MAX_WIDTH, header: true, messageActions: true, stats: true,
  sideMargin: DEFAULT_SIDE_MARGIN, codeHeaders: true, halfRadius: true,
}

test('defaults: 640px, every group on, 8px side margin', () => {
  assert.deepEqual(normalizeConfig(undefined), ALL_ON)
  assert.deepEqual(normalizeConfig({}), ALL_ON)
  const css = phoneStyle(ALL_ON)
  assert.match(css, /^@media \(max-width:640px\)\{/)
  for (const selector of Object.values(SELECTORS).flat()) assert.ok(css.includes(selector), selector)
  assert.match(css, /\{display:none\}/)
  assert.match(css, /\[data-conversation-content\]\[data-content-phase\]\{--dsh-composer-side-clearance:8px\}/)
  assert.match(css, /div:has\(> \[data-chat-flow\]\)\{padding-left:8px;padding-right:8px\}/)
  assert.match(css, /\.md-code-block pre\{border-top-left-radius/)
  assert.match(css, /\.md-code-block\{--dsl-code-block-border-radius:6px\}/)
  assert.ok(css.includes(`${USER_BUBBLE_SELECTOR}{border-radius:11px}`))
})

test('every rule is emitted twice: inside the media query and under the html[data-dsh-view="mobile"] flag', () => {
  const css = phoneStyle(ALL_ON)
  const close = css.indexOf('}}')
  assert.ok(close > 0, 'media block closes')
  const inMedia = css.slice(0, close + 2)
  const flagged = css.slice(close + 2)
  assert.ok(!inMedia.includes(MOBILE_FLAG_SELECTOR))
  assert.ok(flagged.startsWith(`${MOBILE_FLAG_SELECTOR} `))
  // Same rule count on both sides; every flagged selector is a prefixed media selector.
  const count = text => (text.match(/\{/g) ?? []).length
  assert.equal(count(flagged), count(inMedia) - 1)
  for (const selector of [...Object.values(SELECTORS).flat(), USER_BUBBLE_SELECTOR, '[data-conversation-content][data-content-phase]']) {
    assert.ok(flagged.includes(`${MOBILE_FLAG_SELECTOR} ${selector}`), selector)
  }
  // A comma list is prefixed per selector, not once for the list.
  assert.ok(flagged.includes(`,${MOBILE_FLAG_SELECTOR} ${SELECTORS.messageActions[0]}`))
})

test('sideMargin: integer 0-64; the stock value emits no padding rules', () => {
  assert.equal(normalizeConfig({ sideMargin: 0 }).sideMargin, 0)
  assert.equal(normalizeConfig({ sideMargin: MAX_SIDE_MARGIN }).sideMargin, MAX_SIDE_MARGIN)
  for (const bad of [-1, MAX_SIDE_MARGIN + 1, 8.5, '8']) {
    assert.throws(() => normalizeConfig({ sideMargin: bad }), /sideMargin must be an integer/, String(bad))
  }
  const css = phoneStyle({ ...ALL_ON, sideMargin: STOCK_SIDE_MARGIN })
  assert.doesNotMatch(css, /side-clearance|padding-left/)
})

test('codeHeaders off keeps the banner and adds no pre radius; halfRadius off keeps 12px/22px', () => {
  const noHeaders = phoneStyle({ ...ALL_ON, codeHeaders: false })
  assert.ok(!noHeaders.includes(SELECTORS.codeHeaders[0]))
  assert.doesNotMatch(noHeaders, /pre\{border-top/)
  const noRadius = phoneStyle({ ...ALL_ON, halfRadius: false })
  assert.doesNotMatch(noRadius, /border-radius:6px|border-radius:11px/)
})

test('config: maxWidth integer 320-1200, flags boolean, everything else rejected loudly', () => {
  assert.equal(normalizeConfig({ maxWidth: MIN_MAX_WIDTH }).maxWidth, MIN_MAX_WIDTH)
  assert.equal(normalizeConfig({ maxWidth: MAX_MAX_WIDTH }).maxWidth, MAX_MAX_WIDTH)
  for (const bad of [MIN_MAX_WIDTH - 1, MAX_MAX_WIDTH + 1, 400.5, '640', null, NaN]) {
    assert.throws(() => normalizeConfig({ maxWidth: bad }), /maxWidth must be an integer/, String(bad))
  }
  for (const key of ['header', 'messageActions', 'stats', 'codeHeaders', 'halfRadius']) {
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
  assert.match(logs[0], /≤480px → header, messageActions, stats, codeHeaders, halfRadius, sideMargin 8px/)
})

test('all groups off disables the rule: no listener, no style', () => {
  const { ctx, listeners, logs } = fakeContext()
  const off = { header: false, messageActions: false, stats: false, codeHeaders: false, halfRadius: false, sideMargin: STOCK_SIDE_MARGIN }
  apply(ctx, off)
  assert.equal(phoneStyle(normalizeConfig(off)), '')
  assert.equal(listeners.has('webserver/index-inject'), false)
  assert.match(logs[0], /disabled/)
})
