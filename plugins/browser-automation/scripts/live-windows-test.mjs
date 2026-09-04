// LIVE (spawns STP + Chrome): the per-session window model through the plugin's
// real tool executes, for one fake agent.
import { execSync } from 'node:child_process'
import * as plugin from '../index.js'

const defs = {}; const created = []; let unload
const cfg = plugin.Config({ idleMinutes: 0, safari: { reader: { idleMinutes: 0 } }, traceFile: '' })
const ctx = { logger: console, on: (e, cb) => { if (e === 'agent/created') created.push(cb) }, effect: (run, label) => { const d = run(); if (label === 'browser-automation.mounts') unload = d; return () => {} }, tools: {}, agents: { list: () => [] }, get: () => undefined }
plugin.apply(ctx, cfg)
const agent = { id: 'session-livetest', session: { header: { cwd: '/tmp', delegationDepth: 0 } }, ctx: { tools: { register: (d) => { defs[d.name] = d; return () => {} } } } }
created[0]({ agent })
const exec = { agent, signal: new AbortController().signal }
const run = (name, args = {}) => defs[name].execute(args, exec)
const text = (name, value) => defs[name].output.render({}, value)[0].text
const stp = () => execSync(`osascript -e 'tell application "System Events" to (name of processes) contains "Safari Technology Preview"'`).toString().trim()
const step = (label, value) => console.log(`✓ ${label}${value !== undefined ? ` → ${String(value).split('\n')[0].slice(0, 110)}` : ''}`)

// Safari: two independent windows
const s0 = await run('mcp__safari__open', { url: 'https://example.com' }); step('mcp__safari__open #1', s0.windowId + ' ' + s0.title)
const s1 = await run('mcp__safari__open', { url: 'https://www.iana.org/' }); step('mcp__safari__open #2', s1.windowId + ' ' + s1.title)
if (s0.windowId !== 's:0:0' || s1.windowId !== 's:0:1') throw new Error('safari ids')
let err = ''
try { await run('mcp__safari__evaluate', { expression: 'return 1' }) } catch (e) { err = String(e) }
if (!err.includes('2 Safari windows open')) throw new Error(`ambiguity not enforced: ${err}`); step('omitted windowId with 2 windows → error', err)
const t0 = await run('mcp__safari__evaluate', { expression: 'return document.title', windowId: 's:0:0' })
const t1 = await run('mcp__safari__evaluate', { expression: 'return document.title', windowId: 's:0:1' })
step('evaluate per window', `${t0.split('\n')[1]} | ${t1.split('\n')[1]}`)
if (!t0.includes('Example Domain') || !t1.includes('Internet Assigned')) throw new Error('windows not isolated')
const read = await run('mcp__safari__get_page_content', { windowId: 's:0:1', format: 'plainText' }); step('get_page_content (window mode)', `${read.mode} ${read.title} ${read.content.length} chars`)
const iso = await run('mcp__safari__get_page_content', { url: 'https://example.net', format: 'markdown' }); step('get_page_content (isolated)', `${iso.mode} ${iso.title}`)
if (iso.mode !== 'isolated') throw new Error('url read was not isolated')
const shot = await run('mcp__safari__get_screenshot', { windowId: 's:0:1', querySelector: 'h1' }); step('mcp__safari__get_screenshot h1', text('mcp__safari__get_screenshot', shot))
if (shot.fallbackPath === undefined) throw new Error('expected file fallback without attachment store')
const saved = await run('mcp__safari__save_screenshot', { windowId: 's:0:0', path: '/tmp/dsh-live-safari.png' }); step('mcp__safari__save_screenshot', saved.path + ' ' + saved.width + 'x' + saved.height)
step('close s:0:0', await run('mcp__safari__close', { windowId: 's:0:0' }))
const single = await run('mcp__safari__evaluate', { expression: 'return location.host' }); step('omitted windowId with 1 window → uses it', single.split('\n').join(' '))
step('mcp__safari__close all', await run('mcp__safari__close'))
const auto = await run('mcp__safari__navigate', { url: 'https://example.org' }); step('auto-open on navigate', `${auto.windowId} ${auto.title}`)
if (auto.windowId !== 's:0:2') throw new Error(`expected s:0:2, got ${auto.windowId}`)
step('mcp__safari__close all', await run('mcp__safari__close'))

// Chrome: two windows in one instance
const c0 = await run('mcp__chrome__open', { url: 'https://example.com' }); step('mcp__chrome__open #1', c0.windowId)
const c1 = await run('mcp__chrome__open', { url: 'https://www.iana.org/' }); step('mcp__chrome__open #2', c1.windowId)
if (c0.windowId !== 'c:0:0' || c1.windowId !== 'c:0:1') throw new Error('chrome ids')
err = ''
try { await run('mcp__chrome__snapshot') } catch (e) { err = String(e) }
if (!err.includes('2 Chrome windows open')) throw new Error(`chrome ambiguity: ${err}`); step('chrome omitted windowId with 2 → error', err)
const snap = await run('mcp__chrome__snapshot', { windowId: 'c:0:1' }); step('mcp__chrome__snapshot c:0:1', snap.split('\n').find(l => /iana|IANA/i.test(l)) ?? snap.slice(0, 80))
const ev = await run('mcp__chrome__evaluate', { function: '() => document.title', windowId: 'c:0:0' }); step('mcp__chrome__evaluate c:0:0', ev.split('\n').slice(-1)[0])
const cshot = await run('mcp__chrome__get_screenshot', { windowId: 'c:0:0', format: 'jpeg', quality: 40 }); step('mcp__chrome__get_screenshot', text('mcp__chrome__get_screenshot', cshot))
const csaved = await run('mcp__chrome__save_screenshot', { windowId: 'c:0:1', path: '/tmp/dsh-live-chrome.png' }); step('mcp__chrome__save_screenshot', csaved.path)
step('mcp__chrome__close c:0:0', await run('mcp__chrome__close', { windowId: 'c:0:0' }))
const nav = await run('mcp__chrome__navigate', { url: 'https://example.net' }); step('mcp__chrome__navigate (single window default)', nav.split('\n')[0])
step('mcp__chrome__close all', await run('mcp__chrome__close'))
console.log('stats after closes:', JSON.stringify(deps()))
function deps() { return { chromeProcs: Number(execSync(`ps -axo args= | grep -c '[c]hrome-devtools-mcp --isolated' || true`).toString().trim()), safariDrivers: Number(execSync(`ps -axo args= | grep -c '[s]afaridriver --mcp' || true`).toString().trim()) } }
await unload()
await new Promise(r => setTimeout(r, 2500))
console.log('after unload: STP running =', stp(), '| procs', JSON.stringify(deps()))
