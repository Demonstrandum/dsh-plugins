// Keyless smoke: module loads, Config fills defaults, the derived MCP rows
import { existsSync } from 'node:fs'
// validate against dsh-mcp-client's schema, and the agent/created listener
// registers exactly the two scoped tools (no server is spawned).
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import * as plugin from '../index.js'

const filled = plugin.Config({})
if (filled.safari.enabled !== true || filled.chrome.enabled !== true || filled.subagents !== true || filled.idleMinutes !== 30) {
  throw new Error(`unexpected defaults: ${JSON.stringify(filled)}`)
}
const custom = plugin.Config({ chrome: { headless: true }, safari: { enabled: false }, idleMinutes: 0, subagents: false })
if (custom.safari.enabled !== false || custom.chrome.headless !== true) throw new Error(`override not applied: ${JSON.stringify(custom)}`)

for (const [browser, row] of Object.entries(plugin.resolveServers(filled))) {
  const validated = McpClient.Config({ ...row, cwd: '/tmp' })
  if (validated.serverName !== browser || validated.failOnStartupError !== true) throw new Error(`bad row for ${browser}: ${JSON.stringify(validated)}`)
  if (browser === 'chrome' && (!validated.args.includes('--isolated') || !validated.args.includes('--ignoreDefaultChromeArg=--enable-automation'))) throw new Error(`chrome args: ${validated.args}`)
}

const registered = []
const listeners = {}
const effects = []
const fakeAgent = (id, depth) => ({
  id,
  session: { header: { cwd: '/tmp', delegationDepth: depth } },
  ctx: { tools: { register: (def) => { registered.push([id, def.name]); return () => { registered.push([id, `-${def.name}`]) } } }, plugin: () => { throw new Error('must not mount at creation') } },
})
const preexisting = fakeAgent('pre', 0)
const ctx = {
  logger: { info() {}, warn(message) { throw new Error(`unexpected warn: ${message}`) } },
  on: (event, cb) => { listeners[event] = cb },
  effect: (run) => { const dispose = run(); effects.push(dispose); let done = false; return () => { if (!done) { done = true; dispose() } } },
  tools: { schemas: () => [] },
  agents: { list: () => [preexisting] },
}
plugin.apply(ctx, custom)
listeners['agent/created']({ agent: fakeAgent('top', 0) })
listeners['agent/created']({ agent: fakeAgent('child', 1) })
let expected = [['pre', 'browser_open'], ['pre', 'browser_close'], ['top', 'browser_open'], ['top', 'browser_close']]
if (JSON.stringify(registered) !== JSON.stringify(expected)) throw new Error(`registrations: ${JSON.stringify(registered)}`)
// Agent disposal releases the plugin-owned wrapper (idempotent with the scope unwind).
listeners['agent/disposed']({ agent: preexisting })
expected = [...expected, ['pre', '-browser_open'], ['pre', '-browser_close']]
if (JSON.stringify(registered) !== JSON.stringify(expected)) throw new Error(`after dispose: ${JSON.stringify(registered)}`)
console.log('smoke ok: lazy tools attached to pre-existing + new top-level agents only; rows validate')

// Missing STP driver: browser_open must reject BEFORE spawning, naming the remedy
// and stating that classic Safari is not a fallback.
{
  const defs = {}
  const noStp = plugin.Config({ safari: { driver: '/nonexistent/safaridriver' }, chrome: { command: '/nonexistent/chrome-devtools-mcp' } })
  const ctx2 = {
    logger: { info() {}, warn() {} },
    on: () => {},
    effect: (run) => { run(); return () => {} },
    tools: { schemas: () => [] },
    agents: { list: () => [] },
  }
  const agent = { id: 'a', session: { header: { cwd: '/tmp', delegationDepth: 0 } }, ctx: { tools: { register: (def) => { defs[def.name] = def; return () => {} } }, plugin: () => { throw new Error('spawned despite missing driver') } } }
  const created = []
  const ctx3 = { ...ctx2, on: (event, cb) => { if (event === 'agent/created') created.push(cb) } }
  plugin.apply(ctx3, noStp)
  created[0]({ agent })
  for (const browser of ['safari', 'chrome']) {
    let message = ''
    try { await defs.browser_open.execute({ browser }, { agent }) } catch (error) { message = String(error) }
    if (!message.includes('unavailable')) throw new Error(`preflight did not reject ${browser}: ${message}`)
    if (browser === 'safari' && !message.includes('classic Safari cannot be used')) throw new Error(`safari message lacks fallback statement: ${message}`)
  }
  console.log('smoke ok: missing drivers rejected before spawn with remedies')
}

// Safari row goes through the shim with a per-chat label; title projection wins over the id.
{
  const defs = {}
  const created = []
  const mounted = []
  const cfg = plugin.Config({ chrome: { enabled: false } })
  const ctx = {
    logger: { info() {}, warn(m) { throw new Error(m) } },
    on: (event, cb) => { if (event === 'agent/created') created.push(cb) },
    effect: (run) => { run(); return () => {} },
    tools: { schemas: () => [{ name: 'mcp__safari__x' }] },
    agents: { list: () => [] },
    get: (name) => name === 'sessionProjections' ? { stateOf: () => 'Loss landscape plots' } : undefined,
  }
  plugin.apply(ctx, cfg)
  const fiber = Object.assign(Promise.resolve(), { dispose: async () => {} })
  const agent = { id: 'session-abcdef12', session: { header: { cwd: '/tmp', delegationDepth: 0 } }, ctx: { tools: { register: (def) => { defs[def.name] = def; return () => {} } }, plugin: (mod, row) => { mounted.push(row); return fiber } } }
  created[0]({ agent })
  // Driver must exist for preflight; use the real STP path only if present, else skip.
  if (existsSync(cfg.safari.driver)) {
    await defs.browser_open.execute({ browser: 'safari' }, { agent })
    const row = McpClient.Config(mounted[0])
    if (row.command !== process.execPath) throw new Error(`expected node shim, got ${row.command}`)
    if (!row.args[0].endsWith('safari-mcp-shim.mjs') || row.args[1] !== '--name' || row.args[2] !== 'DSH: Loss landscape plots' || row.args[3] !== '--' || row.args[4] !== cfg.safari.driver || row.args[5] !== '--mcp') {
      throw new Error(`shim args unexpected: ${JSON.stringify(row.args)}`)
    }
    console.log('smoke ok: safari mounts through the shim with label', JSON.stringify(row.args[2]))
    if (defs.safari_get_page_content === undefined) throw new Error('safari_get_page_content not registered')
    const schema = defs.safari_get_page_content.parameters
    if (!schema.properties?.format?.enum?.includes('markdown') || !schema.required?.includes('url')) throw new Error(`reader tool schema unexpected: ${JSON.stringify(schema).slice(0, 300)}`)
    console.log('smoke ok: safari_get_page_content registered with formats', schema.properties.format.enum.join('/'))
    for (const name of ['safari_get_screenshot', 'safari_save_screenshot', 'safari_get_youtube_notes']) if (defs[name] === undefined) throw new Error(`${name} not registered`)
    if (typeof defs.safari_get_screenshot.finalizeContent !== 'function') throw new Error('safari_get_screenshot lacks finalizeContent')
    console.log('smoke ok: screenshot + youtube composite tools registered')
  } else {
    console.log('smoke skipped: STP driver not installed here')
  }
}

// YouTube notes: URL canonicalization and description shaping (pure, offline).
{
  const { canonicalWatchUrl, shapeNotes, renderNotes } = await import('../youtube-notes.mjs')
  for (const input of ['https://www.youtube.com/watch?v=QgH9sr7G13Q&t=12s', 'https://youtu.be/QgH9sr7G13Q', 'youtube.com/shorts/QgH9sr7G13Q', 'QgH9sr7G13Q']) {
    const { url, videoId } = canonicalWatchUrl(input)
    if (videoId !== 'QgH9sr7G13Q' || url !== 'https://www.youtube.com/watch?v=QgH9sr7G13Q') throw new Error(`canonicalWatchUrl(${input}) → ${url}`)
  }
  let rejected = false
  try { canonicalWatchUrl('https://example.com/') } catch { rejected = true }
  if (!rejected) throw new Error('non-YouTube URL accepted')
  const notes = shapeNotes({ videoId: 'x', title: 'T', author: 'A', lengthSeconds: 2118, viewCount: 1234, keywords: [], description: 'Sponsor: https://a.example/x\n\nSECTIONS\n0:00 - Intro\n1:04 - When Deep Learning Stopped Working\n(13:20) Loss Landscapes\n1:02:03 – Late chapter\nnot a chapter 12:34 in text\nhttps://b.example/y' }, 'https://www.youtube.com/watch?v=x')
  if (notes.chapters.length !== 4 || notes.chapters[2].title !== 'Loss Landscapes' || notes.chapters[3].time !== '1:02:03') throw new Error(`chapters: ${JSON.stringify(notes.chapters)}`)
  if (notes.links.length !== 2) throw new Error(`links: ${JSON.stringify(notes.links)}`)
  const text = renderNotes(notes)
  if (!text.includes('# T') || !text.includes('35:18') || !text.includes('## Chapters (4)')) throw new Error(`render: ${text.slice(0, 200)}`)
  let threw = false
  try { shapeNotes(null, 'u') } catch { threw = true }
  if (!threw) throw new Error('null extraction accepted')
  console.log('smoke ok: youtube notes canonicalization, chapter/link parsing, render')
}

// Screenshot geometry helpers (pure) + composite tool registration.
{
  const { cropBox, rectMoved, parseMeasurement, measureScript } = await import('../safari-screenshot.mjs')
  const box = cropBox({ x: 10.4, y: 20.6, width: 100.2, height: 50 }, { width: 1024, height: 768 }, { width: 2048, height: 1536 })
  if (box.scale !== 2 || box.x !== 20 || box.y !== 41 || box.width !== 202 || box.height !== 101 || box.clipped) throw new Error(`cropBox: ${JSON.stringify(box)}`)
  const clipped = cropBox({ x: -5, y: 700, width: 100, height: 100 }, { width: 1024, height: 768 }, { width: 2048, height: 1536 })
  if (!clipped.clipped || clipped.x !== 0 || clipped.y + clipped.height !== 1536) throw new Error(`clipped: ${JSON.stringify(clipped)}`)
  let outside = false
  try { cropBox({ x: 2000, y: 0, width: 10, height: 10 }, { width: 1024, height: 768 }, { width: 2048, height: 1536 }) } catch { outside = true }
  if (!outside) throw new Error('offscreen rect accepted')
  if (rectMoved({ x: 0, y: 0, width: 10, height: 10 }, { x: 1, y: 1, width: 10, height: 10 })) throw new Error('1px jitter counted as movement')
  if (!rectMoved({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 5, width: 10, height: 10 })) throw new Error('5px movement missed')
  const measured = parseMeasurement(JSON.stringify(JSON.stringify({ rect: { x: 1, y: 2, width: 3, height: 4 }, dpr: 2, viewport: { width: 10, height: 10 }, settled: true })))
  if (measured.rect.width !== 3) throw new Error('double-encoded measurement not parsed')
  let errored = false
  try { parseMeasurement(JSON.stringify({ error: 'no element matches h9' })) } catch (e) { errored = /no element/.test(String(e)) }
  if (!errored) throw new Error('measurement error not surfaced')
  if (!measureScript('h1 > a', true).includes('"h1 > a"') || !measureScript('h1', false).includes('if (false)')) throw new Error('measureScript embedding')
  console.log('smoke ok: screenshot geometry helpers')
}
