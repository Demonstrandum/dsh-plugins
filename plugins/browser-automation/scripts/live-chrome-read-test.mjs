// LIVE (spawns Chrome, headless): chrome_get_page_content / chrome_get_page_structure
// through the plugin's real tool executes — temporary reader page vs. window
// mode, expand / section / selectors / scope, and the idle handling of a
// reader-only Chrome instance.
import { execSync } from 'node:child_process'
import * as plugin from '../index.js'

const URL = 'https://developers.notion.com/guides/mcp/get-started-with-mcp'
const defs = {}; const created = []; let unload
const cfg = plugin.Config({ idleMinutes: 0, chrome: { headless: true }, safari: { reader: { idleMinutes: 0 } }, traceFile: '' })
const ctx = { logger: console, on: (e, cb) => { if (e === 'agent/created') created.push(cb) }, effect: (run, label) => { const d = run(); if (label === 'browser-automation.mounts') unload = d; return () => {} }, tools: {}, agents: { list: () => [] }, get: () => undefined }
plugin.apply(ctx, cfg)
const agent = { id: 'session-chromeread', session: { header: { cwd: '/tmp', delegationDepth: 0 } }, ctx: { tools: { register: (d) => { defs[d.name] = d; return () => {} } } } }
created[0]({ agent })
const exec = { agent, signal: new AbortController().signal }
const run = (name, args = {}) => defs[name].execute(args, exec)
const render = (name, value) => defs[name].output.render({}, value)[0].text
// chrome-devtools-mcp sets a bare process title and pgrep -l reports it as 'node': count OUR node children (the only node children this test spawns).
const chromeProcs = () => { try { return execSync(`pgrep -lP ${process.pid}`).toString().split('\n').filter(line => /\b(node|chrome-devtools-mcp)\b/.test(line)).length } catch { return 0 } }
let failures = 0
const check = (label, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`); if (!ok) failures++ }
const t = (start) => `${Date.now() - start} ms`

try {
  // 1. Temporary page, defaults.
  let t0 = Date.now()
  const dflt = await run('chrome_get_page_content', { url: URL })
  check('url read uses a temporary page', dflt.mode === 'isolated' && dflt.browser === 'chrome', `${t(t0)}; ${dflt.content.length} chars`)
  check('no window was registered', (await run('chrome_close')) === 'No Chrome window was open.')
  check('collapsed Troubleshooting answer included', /\[mcp-remote\]\(https:[^)]*\) bridge/.test(dflt.content))
  check('"--scope" accordion body included', dflt.content.includes('--scope project'))
  check('hidden tab panels appended', /## Hidden tab panels/.test(dflt.content) && dflt.content.includes('mcp.notion.com/sse'), `expanded=${JSON.stringify(dflt.expanded)}`)
  check('auto scope picked main', /^main/.test(dflt.scope?.scope ?? ''), dflt.scope?.scope)
  check('sidebar excluded', !dflt.content.includes('Postman workspace'))
  check('own serializer emits headings', /^## Troubleshooting$/m.test(dflt.content) && /^# Connect to Notion MCP$/m.test(dflt.content), `${(dflt.content.match(/^#{1,6} /gm) ?? []).length} heading lines`)
  check('code fences for <pre>', /```[\s\S]*"mcpServers"[\s\S]*```/.test(dflt.content))
  check('links kept', dflt.content.includes('[Codex MCP documentation](https://developers.openai.com/codex/mcp/)'))
  check('no double heading markers', !/^#+ #/m.test(dflt.content))
  console.log('\n' + render('chrome_get_page_content', dflt).split('\n').slice(0, 6).join('\n') + '\n  …\n')

  // 2. expand off → NOTE.
  const flat = await run('chrome_get_page_content', { url: URL, expand: false, scope: 'page' })
  check('expand:false omits collapsed text', !/mcp-remote\S* bridge/.test(flat.content))
  check('expand:false gets a NOTE', flat.notes.some(n => /collapsed <details>/.test(n) && /tab group/.test(n)), JSON.stringify(flat.notes))
  check('scope:page keeps the sidebar', flat.content.includes('Postman workspace'))

  // 3. section / selectors / plainText / errors.
  const section = await run('chrome_get_page_content', { url: URL, section: '#troubleshooting' })
  check('section starts at its heading and stops before FAQs', section.content.trimStart().startsWith('## Troubleshooting') && !section.content.includes('interactive authorization') && /mcp-remote\S* bridge/.test(section.content), `${section.content.length} chars`)
  const sel = await run('chrome_get_page_content', { url: URL, selectors: ['#page-title', '#other-mcp-clients'], format: 'plainText' })
  check('selectors + plainText', sel.content.includes('Connect to Notion MCP') && sel.content.includes('Other MCP clients') && !sel.content.includes('Cursor is'), JSON.stringify(sel.content.slice(0, 80)))
  let bad = ''
  try { await run('chrome_get_page_content', { url: URL, selectors: ['#does-not-exist'] }) } catch (error) { bad = error.message }
  check('unknown selector errors clearly', /no element matches/.test(bad), bad)

  // 4. Structure.
  t0 = Date.now()
  const structure = await run('chrome_get_page_structure', { url: URL })
  const s = structure.structure
  check('structure has headings with selectors', s.headings.some(h => h.selector === '#troubleshooting' && h.level === 2), t(t0))
  check('structure reports collapsed details + tab group', s.collapsed.details >= 10 && s.collapsed.tablists.length >= 1)
  const outline = render('chrome_get_page_structure', structure)
  check('outline names the chrome tool', outline.includes('[temporary Chrome page]') && outline.includes('Next: chrome_get_page_content'))

  // 5. Window mode: hide-and-restore, page intact, probe.
  const opened = await run('chrome_open', { url: URL })
  const win = await run('chrome_get_page_content', { windowId: opened.windowId, section: '#faqs', expand: true })
  check('window section read', win.mode === 'window' && win.content.includes('interactive authorization') && !win.content.includes('Claude Code is Anthropic'), `${win.content.length} chars`)
  const leftovers = await run('chrome_evaluate_expression', { windowId: opened.windowId, expression: 'return document.querySelectorAll("[data-dsh-scope-hidden]").length' })
  check('window restored after scoped read', /\n0\n```$/.test(leftovers.trim()) || leftovers.includes('\n0'), leftovers.split('\n').slice(-2).join(' '))
  const plain = await run('chrome_get_page_content', { windowId: opened.windowId })
  check('window default read: expand off, probe reports the tab group', plain.collapsed?.details === 0 && plain.collapsed?.tabGroups === 1, JSON.stringify(plain.collapsed))
  check('chrome_close', (await run('chrome_close')) === `Closed ${opened.windowId}.`)

  // 6. Reader-only instance is closed by unload (idle timer disabled here) — zero leftover processes.
  const before = chromeProcs()
  await run('chrome_get_page_content', { url: 'https://example.com/', format: 'plainText' })
  check('reader instance alive after a url read (warm)', chromeProcs() >= 1, `procs=${chromeProcs()} (before ${before})`)
} finally {
  await unload()
}
await new Promise(resolve => setTimeout(resolve, 1500))
check('no chrome-devtools-mcp --isolated left after unload', chromeProcs() === 0, `procs=${chromeProcs()}`)
console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1
