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
const s0 = await run('safari_open', { url: 'https://example.com' }); step('safari_open #1', s0.windowId + ' ' + s0.title)
const s1 = await run('safari_open', { url: 'https://www.iana.org/' }); step('safari_open #2', s1.windowId + ' ' + s1.title)
if (s0.windowId !== 's:0:0' || s1.windowId !== 's:0:1') throw new Error('safari ids')
let err = ''
try { await run('safari_evaluate_expression', { expression: 'return 1' }) } catch (e) { err = String(e) }
if (!err.includes('2 Safari windows open')) throw new Error(`ambiguity not enforced: ${err}`); step('omitted windowId with 2 windows → error', err)
const t0 = await run('safari_evaluate_expression', { expression: 'return document.title', windowId: 's:0:0' })
const t1 = await run('safari_evaluate_expression', { expression: 'return document.title', windowId: 's:0:1' })
step('evaluate per window', `${t0.split('\n')[1]} | ${t1.split('\n')[1]}`)
if (!t0.includes('Example Domain') || !t1.includes('Internet Assigned')) throw new Error('windows not isolated')
const fn2 = await run('safari_evaluate_function', { function: '() => document.querySelector("h1").textContent', windowId: 's:0:1' }); step('safari_evaluate_function h1', fn2.split('\n').slice(-1)[0])
const clicked = await run('safari_click', { text: 'Domain Names', windowId: 's:0:1' }); step('safari_click by text', clicked.split('\n').slice(0, 2).join(' | '))
const back = await run('safari_navigate', { url: 'https://www.iana.org/', windowId: 's:0:1' }); step('navigate back', back.title)
const waited = await run('safari_wait_for', { text: ['Number Resources', 'nope'], timeout: 5000, windowId: 's:0:1' }); step('safari_wait_for', waited.split('\n').slice(-1)[0])
const waitedOut = await run('safari_wait_for', { text: ['zzz-not-there'], timeout: 1500, windowId: 's:0:1' }); step('safari_wait_for timeout', waitedOut.split('\n').slice(-1)[0])
const read = await run('safari_get_page_content', { windowId: 's:0:1', format: 'plainText' }); step('get_page_content (window mode)', `${read.mode} ${read.title} ${read.content.length} chars`)
const iso = await run('safari_get_page_content', { url: 'https://example.net', format: 'markdown' }); step('get_page_content (isolated)', `${iso.mode} ${iso.title}`)
if (iso.mode !== 'isolated') throw new Error('url read was not isolated')
const shot = await run('safari_get_screenshot', { windowId: 's:0:1', querySelector: 'h1' }); step('safari_get_screenshot h1', text('safari_get_screenshot', shot))
if (shot.fallbackPath === undefined) throw new Error('expected file fallback without attachment store')
const saved = await run('safari_save_screenshot', { windowId: 's:0:0', path: '/tmp/dsh-live-safari.png' }); step('safari_save_screenshot', saved.path + ' ' + saved.width + 'x' + saved.height)
step('close s:0:0', await run('safari_close', { windowId: 's:0:0' }))
const single = await run('safari_evaluate_expression', { expression: 'return location.host' }); step('omitted windowId with 1 window → uses it', single.split('\n').join(' '))
step('safari_close all', await run('safari_close'))
const auto = await run('safari_navigate', { url: 'https://example.org' }); step('auto-open on navigate', `${auto.windowId} ${auto.title}`)
if (auto.windowId !== 's:0:2') throw new Error(`expected s:0:2, got ${auto.windowId}`)
step('safari_close all', await run('safari_close'))

// Chrome: two windows in one instance
const c0 = await run('chrome_open', { url: 'https://example.com' }); step('chrome_open #1', c0.windowId)
const c1 = await run('chrome_open', { url: 'https://www.iana.org/' }); step('chrome_open #2', c1.windowId)
if (c0.windowId !== 'c:0:0' || c1.windowId !== 'c:0:1') throw new Error('chrome ids')
err = ''
try { await run('chrome_snapshot') } catch (e) { err = String(e) }
if (!err.includes('2 Chrome windows open')) throw new Error(`chrome ambiguity: ${err}`); step('chrome omitted windowId with 2 → error', err)
const snap = await run('chrome_snapshot', { windowId: 'c:0:1' }); step('chrome_snapshot c:0:1', snap.split('\n').find(l => /iana|IANA/i.test(l)) ?? snap.slice(0, 80))
const ev = await run('chrome_evaluate_function', { function: '() => document.title', windowId: 'c:0:0' }); step('chrome_evaluate c:0:0', ev.split('\n').slice(-1)[0])
const expr = await run('chrome_evaluate_expression', { expression: 'const t = document.title; return t.length', windowId: 'c:0:0' }); step('chrome_evaluate_expression', expr.split('\n').slice(-1)[0])
const inter = await run('chrome_interact', { windowId: 'c:0:1', interactions: [
  { type: 'scroll', purpose: 'scroll down', scrollDelta: { x: 0, y: 300 } },
  { type: 'click', purpose: 'open Domain Names', text: 'Domain Names' },
  { type: 'selectText', purpose: 'unsupported on purpose', text: 'x' },
  { type: 'keyPress', purpose: 'press Escape', value: 'Escape' },
] }); step('chrome_interact batch', inter.split('\n').slice(1).join(' | '))
if (!/#1 scroll.*ok/.test(inter) || !/#2 click.*ok/.test(inter) || !/#3 selectText.*FAILED/.test(inter) || !/#4 keyPress.*ok/.test(inter)) throw new Error('chrome_interact outcomes')
const cshot = await run('chrome_get_screenshot', { windowId: 'c:0:0', format: 'jpeg', quality: 40 }); step('chrome_get_screenshot', text('chrome_get_screenshot', cshot))
const csaved = await run('chrome_save_screenshot', { windowId: 'c:0:1', path: '/tmp/dsh-live-chrome.png' }); step('chrome_save_screenshot', csaved.path)
step('chrome_close c:0:0', await run('chrome_close', { windowId: 'c:0:0' }))
const nav = await run('chrome_navigate', { url: 'https://example.net' }); step('chrome_navigate (single window default)', nav.split('\n')[0])
step('chrome_close all', await run('chrome_close'))
console.log('stats after closes:', JSON.stringify(deps()))
function childCount(pattern) { try { return execSync(`pgrep -lP ${process.pid}`).toString().split('\n').filter(line => pattern.test(line)).length } catch { return 0 } }
// chrome-devtools-mcp sets a bare process title (no args in ps): count our own children instead of grepping args.
function deps() { return { chromeProcs: childCount(/\b(node|chrome-devtools-mcp)\b/), safariDrivers: Number(execSync(`ps -axo args= | grep -c '[s]afaridriver --mcp' || true`).toString().trim()) } }
await unload()
await new Promise(r => setTimeout(r, 2500))
console.log('after unload: STP running =', stp(), '| procs', JSON.stringify(deps()))
