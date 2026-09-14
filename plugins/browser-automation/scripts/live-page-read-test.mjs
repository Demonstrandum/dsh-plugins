// LIVE test (needs Safari Technology Preview): the page-read pipeline on a real
// docs page with collapsed <details>, a tab group, and a large sidebar —
// expand / scope / section / selectors / markHeadings / structure, in both the
// isolated reader and window mode (hide-and-restore).
import { createReaderPool } from '../reader-pool.mjs'
import { extractPage, planRead, STRUCTURE_SCRIPT, renderStructure } from '../page-read.mjs'
import { connectServer } from '../servers.mjs'

const DRIVER = '/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver'
const URL = 'https://developers.notion.com/guides/mcp/get-started-with-mcp'
let failures = 0
const check = (label, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`); if (!ok) failures++ }
const t = (start) => `${Date.now() - start} ms`

const pool = createReaderPool({ driver: DRIVER, labelPrefix: 'DSH: ', maxIdle: 1, idleMs: 0, readTimeoutMs: 60_000, trace: () => {}, logger: console })
const read = (args) => pool.read({ ...planRead(args, true), url: URL, waitMs: 0 })

try {
  // 1. Defaults (expand + auto scope + markHeadings + clean).
  let t0 = Date.now()
  const dflt = await read({})
  check('default read includes collapsed Troubleshooting answer', /\[mcp-remote\]\(https:[^)]*\) bridge/.test(dflt.content), t(t0))
  check('default read includes the "--scope" accordion body', dflt.content.includes('--scope project'))
  check('hidden tab panels appended', /## Hidden tab panels/.test(dflt.content) && dflt.content.includes('mcp.notion.com/sse'), `tabs=${dflt.expanded?.tabs}`)
  check('expanded counts reported', dflt.expanded?.details >= 10, JSON.stringify(dflt.expanded))
  check('auto scope picked main', /^main/.test(dflt.scope?.scope ?? ''), dflt.scope?.scope)
  check('sidebar nav excluded', !dflt.content.includes('Postman workspace'))
  check('headings marked', /^## Troubleshooting$/m.test(dflt.content), (dflt.content.match(/^##? /gm) ?? []).length + ' heading lines')
  check('markdown litter cleaned', !dflt.content.includes('![]()'))
  check('step numbers merged into their line', /^1\. Add the Notion server/m.test(dflt.content) && !/^2$/m.test(dflt.content))

  // 1b. WebKit's own markdown, with the heading marker hack.
  t0 = Date.now()
  const wk = await read({ format: 'webkitMarkdown' })
  check('webkitMarkdown still available with marked headings', /^## Troubleshooting$/m.test(wk.content) && /\[mcp-remote\]\(https:[^)]*\) bridge/.test(wk.content) && !/```/.test(wk.content), `${t(t0)}; ${wk.content.length} chars`)
  check('markdown (ours) keeps code fences and inline code', /```[\s\S]*"mcpServers"[\s\S]*```/.test(dflt.content) && dflt.content.includes('`~/.codex/config.toml`'))

  // 2. No expand: NOTE about collapsed content.
  t0 = Date.now()
  const flat = await read({ expand: false, scope: 'page', markHeadings: false })
  check('expand:false omits collapsed text', !/mcp-remote\S* bridge/.test(flat.content), t(t0))
  check('expand:false gets a NOTE', flat.notes.some(n => /collapsed <details>/.test(n) && /tab group/.test(n)), JSON.stringify(flat.notes))
  check('scope:page keeps the sidebar', flat.content.includes('Postman workspace'))

  // 3. Section by heading id.
  t0 = Date.now()
  const section = await read({ section: '#troubleshooting' })
  check('section starts at its heading', /^## Troubleshooting/m.test(section.content.trimStart().split('\n')[0]) || section.content.trimStart().startsWith('## Troubleshooting'), `${t(t0)}; head=${JSON.stringify(section.content.slice(0, 40))}`)
  check('section contains its answers', /mcp-remote\S* bridge/.test(section.content) && section.content.includes('Authentication issues'))
  check('section stops before FAQs', !section.content.includes('interactive authorization'))
  check('section excludes earlier content', !section.content.includes('Claude Code is Anthropic'))

  // 4. Selectors.
  t0 = Date.now()
  const sel = await read({ selectors: ['#page-title', '#other-mcp-clients'] })
  check('selectors extract only matches', sel.content.includes('Connect to Notion MCP') && sel.content.includes('Other MCP clients') && !sel.content.includes('Cursor is an AI code editor'), `${t(t0)}; ${sel.content.length} chars`)
  let bad = ''
  try { await read({ selectors: ['#does-not-exist'] }) } catch (error) { bad = error.message }
  check('unknown selector errors clearly', /no element matches/.test(bad), bad)

  // 5. Structure.
  t0 = Date.now()
  const structure = await pool.read({ ...planRead({ format: 'plainText', expand: false, scope: 'page', markHeadings: false, clean: false }, true), url: URL, waitMs: 0, skipContent: true, script: STRUCTURE_SCRIPT })
  const s = structure.scriptResult
  check('structure has headings with selectors', Array.isArray(s?.headings) && s.headings.some(h => h.selector === '#troubleshooting' && h.level === 2), t(t0))
  check('structure reports collapsed details + tab group', s?.collapsed?.details >= 10 && s?.collapsed?.tablists?.length >= 1, JSON.stringify(s?.collapsed).slice(0, 200))
  check('structure finds main', typeof s?.main?.selector === 'string', s?.main?.selector)
  const outline = renderStructure({ mode: 'isolated', structure: s })
  check('outline is compact', outline.length < 6000, `${outline.length} chars`)
  console.log('\n' + outline.split('\n').slice(0, 14).join('\n') + '\n  …\n')

  // 6. Prepare script runs before extraction.
  const prepared = await read({ expand: false, scope: 'page', prepare: 'for (const d of document.querySelectorAll("details")) d.open = true; return document.querySelectorAll("details[open]").length' })
  check('prepare runs before extraction', /mcp-remote\S* bridge/.test(prepared.content) && prepared.prepareResult >= 10, `prepareResult=${JSON.stringify(prepared.prepareResult)} chars=${prepared.content.length} hasBridge=${/mcp-remote\S* bridge/.test(prepared.content)}`)
} finally {
  await pool.dispose()
}

// 7. Window mode: hide-and-restore scoping must leave the page intact.
const conn = await connectServer({ command: DRIVER, args: ['--mcp'], clientName: 'DSH: page-read test window', safari: true, timeoutMs: 60_000 })
try {
  await conn.callText('navigate_to_url', { url: URL })
  const call = (name, args) => conn.callText(name, args)
  const before = JSON.parse(await call('evaluate_javascript', { expression: 'return document.body.innerText.length' }))
  const scoped = await extractPage(call, planRead({ section: '#faqs', expand: true }, false), false)
  check('window section read', scoped.content.includes('interactive authorization') && !scoped.content.includes('Claude Code is Anthropic'), `${scoped.content.length} chars; scope=${scoped.scope?.scope}`)
  const leftovers = JSON.parse(await call('evaluate_javascript', { expression: 'return document.querySelectorAll("[data-dsh-scope-hidden]").length' }))
  const after = JSON.parse(await call('evaluate_javascript', { expression: 'return document.body.innerText.length' }))
  check('window restored after scoped read', leftovers === 0 && after >= before, `leftovers=${leftovers} before=${before} after=${after}`)
  const plain = await extractPage(call, planRead({ format: 'textTree' }, false), false)
  // The details were opened by the expand above (page state persists in a window); the tab group is still there.
  check('window default read keeps uids and probes collapsed state', /uid=\d+/.test(plain.content) && plain.collapsed?.details === 0 && plain.collapsed?.tabGroups === 1, `collapsed=${JSON.stringify(plain.collapsed)} notes=${JSON.stringify(plain.notes)}`)
} finally {
  await conn.close()
}

console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1
