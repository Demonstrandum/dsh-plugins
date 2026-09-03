// LIVE experiment (not part of check): compare parking a reader on about:blank
// vs closing its tab, for window/STP cleanup.
import { execSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
const stp = () => execSync(`osascript -e 'tell application "System Events" to (name of processes) contains "Safari Technology Preview"'`).toString().trim()
const wins = () => execSync(`osascript -l JavaScript -e 'ObjC.import("CoreGraphics"); const a=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll|$.kCGWindowListExcludeDesktopElements,$.kCGNullWindowID))); a.filter(w=>w.kCGWindowOwnerName==="Safari Technology Preview"&&w.kCGWindowLayer===0&&w.kCGWindowIsOnscreen).length'`).toString().trim()
const open = async (name) => { const t = new StdioClientTransport({ command: '/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver', args: ['--mcp'], stderr: 'inherit' }); const c = new Client({ name, version: '1' }); await c.connect(t); return c }
const call = async (c, name, args) => { const r = await c.callTool({ name, arguments: args }); return r.content.filter(b => b.type === 'text').map(b => b.text).join('') }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const park = async (c, mode) => { if (mode === 'about:blank') await call(c, 'navigate_to_url', { url: 'about:blank' }); else { for (const t of JSON.parse(await call(c, 'list_tabs', {}))) await call(c, 'close_tab', { handle: t.handle }) } }
for (const mode of ['about:blank', 'close_tab']) {
  const c = await open(`park-${mode}`)
  await call(c, 'navigate_to_url', { url: 'https://example.com' }); await sleep(500)
  console.log(`[${mode}] after nav: stp=${stp()} windows=${wins()}`)
  await park(c, mode); await sleep(500); console.log(`[${mode}] after park: windows=${wins()}`)
  await call(c, 'navigate_to_url', { url: 'https://www.iana.org/' }); await sleep(500)
  console.log(`[${mode}] after 2nd nav: windows=${wins()} title=${JSON.parse(await call(c, 'page_info', {})).title}`)
  await park(c, mode)
  await c.close(); await sleep(2000)
  console.log(`[${mode}] after close: stp=${stp()} windows=${wins()}`)
  if (stp() === 'true') { execSync('killall "Safari Technology Preview"'); await sleep(1500) }
}
