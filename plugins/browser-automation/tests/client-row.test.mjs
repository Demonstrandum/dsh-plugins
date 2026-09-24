// Headless check of the browser half (lib/client.js): load the bundle under a
// fake `window.__ModuleLoader__` with stub platform modules, capture what
// `apply(ctx)` registers, and render the screenshot row for every result shape
// it must cover (claiming a toolview key suppresses the generic card for ALL of
// them). React comes from the checkout through the linked ui-primitives package
// (the plugin itself has no react dependency — it is a shell platform module).
//
// Run `pnpm build` first; `pnpm run check` does both.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = resolve(here, '../lib/client.js')
const require = createRequire(import.meta.url)
const fromPrimitives = createRequire(require.resolve('@deepseek-ai/dsh-client-ui-primitives/package.json'))
const React = fromPrimitives('react')
const { renderToStaticMarkup } = fromPrimitives('react-dom/server')
const jsxRuntime = fromPrimitives('react/jsx-runtime')

/** Minimal stand-ins for the shell's primitives: enough structure to assert on. */
const primitives = {
  DisclosureRow: ({ icon, title, open, expandable, collapsedContent, children }) =>
    React.createElement('div', { 'data-disclosure': title, 'data-open': open, 'data-expandable': expandable },
      icon,
      React.createElement('span', { className: 'title' }, title),
      collapsedContent,
      open ? React.createElement('div', { className: 'body' }, children) : null),
  StateDot: ({ state }) => React.createElement('i', { 'data-state': state }),
  IconGlobeOutline14: () => React.createElement('i', { 'data-icon': 'globe' }),
}
const platform = {
  react: React,
  'react/jsx-runtime': jsxRuntime,
  'react-dom': { createPortal: (node) => node },
  '@deepseek-ai/dsh-client-ui-primitives': primitives,
}

function loadBundle() {
  assert.ok(existsSync(bundlePath), `lib/client.js missing — run pnpm build (${bundlePath})`)
  let loaded
  globalThis.window = { __ModuleLoader__: { load: (entry) => { loaded = entry } } }
  try {
    new Function(readFileSync(bundlePath, 'utf8'))()
  } finally {
    delete globalThis.window
  }
  assert.ok(loaded, 'bundle did not call window.__ModuleLoader__.load')
  const requires = []
  const mod = loaded.factory((id) => {
    requires.push(id)
    if (!(id in platform)) throw new Error(`non-platform require: ${id}`)
    return platform[id]
  })
  return { id: loaded.id, mod, requires }
}

/** Fake ctx.slots: `inject` calls back immediately, `register` records. */
function fakeCtx() {
  const registered = []
  return {
    registered,
    slots: {
      inject: (slot, cb) => { assert.equal(slot, 'tool.call.toolview'); cb() },
      register: (spec, component) => { registered.push({ spec, component }); return () => {} },
    },
  }
}

// The exact shape a live session recorded (session-564bf3cd seq 137, 2026-09-23).
const attachment = {
  attachmentId: 'sha256:87b661f4e7bf001bdfdfceb57764bef07004e1ca3bb11f56460f0aeec0dd7bb9',
  mediaType: 'image/webp', width: 780, height: 1480, bytes: 27250, name: 'safari-1790082845845.png',
}
const argsRaw = JSON.stringify({ fullPage: false })
const settledOk = {
  kind: 'tool-result', callId: 'c1', isError: false, time: 2000, callTime: 1000, meta: undefined,
  call: { argsRaw },
  content: [{ type: 'image', attachment }, { type: 'text', text: '[s:8:0]; 780×1480 px; viewport; 82 kB png' }],
}
const settledFile = {
  ...settledOk,
  content: [{ type: 'text', text: '[c:0:1]; 2560×1440 px; viewport; 1.2 MB png; saved to /tmp/dsh-chrome-screenshot-1.png; not shown inline: the current model does not declare image input. View it with read_image' }],
}
const settledError = {
  ...settledOk, isError: true, error: { name: 'HarnessError', code: 'TOOL_ERROR' },
  content: [{ type: 'text', text: 'chrome_get_screenshot: server tool take_screenshot failed: No page with uid 3_7\nRequest: {"uid":"3_7"}\nHint: chrome_snapshot again' }],
}
const settledAborted = { ...settledOk, isError: true, error: { name: 'HarnessError', code: 'ABORTED' }, content: [] }
const running = { callId: 'c1', argsRaw: JSON.stringify({ querySelector: '#hero' }), time: 1000 }

const loadImage = Object.assign(async () => 'blob:resolved', { peek: () => 'blob:peeked' })

function render(Row, props) {
  return renderToStaticMarkup(React.createElement(Row, { loadImage, ...props }))
}

test('bundle: id equals the package name and only platform modules are required', () => {
  const { id, requires } = loadBundle()
  assert.equal(id, 'tali-browser-automation')
  assert.ok(requires.includes('react') && requires.includes('@deepseek-ai/dsh-client-ui-primitives'))
})

test('apply registers one toolview per inline-screenshot tool', () => {
  const { mod } = loadBundle()
  assert.equal(mod.name, 'browser-automation-client')
  assert.deepEqual(mod.inject, ['slots'])
  const ctx = fakeCtx()
  mod.apply(ctx)
  assert.deepEqual(ctx.registered.map(r => r.spec), [
    { name: 'tool.call.toolview', key: 'chrome_get_screenshot' },
    { name: 'tool.call.toolview', key: 'safari_get_screenshot' },
  ])
  for (const r of ctx.registered) assert.equal(r.component, mod.ScreenshotRow)
})

test('settled capture: collapsed summary from the result text, image (not JSON) when open', () => {
  const { mod } = loadBundle()
  const collapsed = render(mod.ScreenshotRow, { toolName: 'safari_get_screenshot', block: settledOk, callId: 'c1' })
  assert.match(collapsed, /Safari screenshot/)
  assert.match(collapsed, /s:8:0 · 780×1480 px · viewport · 82 kB png/)
  assert.match(collapsed, /data-expandable="true"/)
  assert.match(collapsed, /data-icon="globe"/, 'ok rows lead with the browser glyph')
  assert.doesNotMatch(collapsed, /<img/, 'collapsed row must not carry the image')
  assert.doesNotMatch(collapsed, /attachmentId/)
  // useState(false) → open it by rendering the body through the primitive with open forced: the row
  // owns its state, so drive it via a wrapper that flips DisclosureRow.open.
  const realRow = primitives.DisclosureRow
  primitives.DisclosureRow = (props) => realRow({ ...props, open: props.expandable })
  try {
    const open = render(mod.ScreenshotRow, { toolName: 'safari_get_screenshot', block: settledOk, callId: 'c1' })
    assert.match(open, /<img[^>]*src="blob:peeked"/, 'the image renders from the session loader')
    assert.match(open, /width="390"/, 'point size = device pixels / 2')
    assert.match(open, /\[s:8:0\]; 780×1480 px; viewport; 82 kB png/, 'result text stays visible under the image')
    assert.doesNotMatch(open, /"attachmentId"/, 'never the raw attachment JSON')
  } finally {
    primitives.DisclosureRow = realRow
  }
})

test('file fallback (no inline image): text body, no img, still expandable', () => {
  const { mod } = loadBundle()
  const realRow = primitives.DisclosureRow
  primitives.DisclosureRow = (props) => realRow({ ...props, open: props.expandable })
  try {
    const html = render(mod.ScreenshotRow, { toolName: 'chrome_get_screenshot', block: settledFile, callId: 'c1' })
    assert.match(html, /Chrome screenshot/)
    assert.match(html, /c:0:1 · 2560×1440 px · viewport · 1.2 MB png · saved to file</, 'path and reason stay out of the summary')
    assert.doesNotMatch(html, /<img/)
    assert.match(html, /saved to \/tmp\/dsh-chrome-screenshot-1.png/)
  } finally {
    primitives.DisclosureRow = realRow
  }
})

test('error, interrupted and running shapes', () => {
  const { mod } = loadBundle()
  const error = render(mod.ScreenshotRow, { toolName: 'chrome_get_screenshot', block: settledError, callId: 'c1' })
  assert.match(error, /data-state="error"/)
  assert.match(error, /No page with uid 3_7/)
  assert.doesNotMatch(error, /Request: /, 'only the first line is the summary')

  const aborted = render(mod.ScreenshotRow, { toolName: 'chrome_get_screenshot', block: settledAborted, callId: 'c1' })
  assert.match(aborted, /data-state="warning"/)
  assert.match(aborted, /interrupted/)
  assert.match(aborted, /data-expandable="true"/, 'the error name/code text is still readable')

  const live = render(mod.ScreenshotRow, { toolName: 'safari_get_screenshot', block: running, callId: 'c1' })
  assert.match(live, /data-state="ongoing"/)
  assert.match(live, /capturing element &quot;#hero&quot;…/)
  assert.match(live, /data-expandable="false"/)
})
