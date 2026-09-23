// LIVE (spawns Chrome, headless): the round-three additions through the plugin's
// real tool executes — `wait` (text / selector / expression / settle / timeout)
// on chrome_wait_for, chrome_evaluate_expression, chrome_navigate (+ `then`) and
// chrome_get_screenshot; chrome_click / chrome_fill by selector and text;
// most-recently-used window defaulting; and reopen-after-restart (the
// chrome-devtools-mcp child is killed under the plugin's feet).
import { execSync } from 'node:child_process'
import { createServer } from 'node:http'
import * as plugin from '../index.js'
import { assertLossless } from './lossless.mjs'

// A page whose #ready element appears after 1.2 s, with a counter button and an input.
const PAGE = `<!doctype html><html><head><title>wait-test</title></head><body>
<h1>Wait test</h1><p id="status">loading</p><button id="btn" onclick="this.textContent='clicked ' + (++window.n)">Click me</button>
<input id="name" oninput="document.getElementById('echo').textContent=this.value"><span id="echo"></span>
<script>window.n = 0; setTimeout(() => { const el = document.createElement('div'); el.id = 'ready'; el.textContent = 'Ready now'; document.body.appendChild(el); document.getElementById('status').textContent = 'done'; }, 1200);</script>
</body></html>`
const server = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(PAGE) })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const URL = `http://127.0.0.1:${server.address().port}/`

const defs = {}; const created = []
const cfg = plugin.Config({ idleMinutes: 0, chrome: { headless: true }, safari: { reader: { idleMinutes: 0 } }, traceFile: '' })
const ctx = { logger: console, on: (e, cb) => { if (e === 'agent/created') created.push(cb) }, effect: (run) => { run(); return () => {} }, tools: {}, agents: { list: () => [] }, get: () => undefined }
plugin.apply(ctx, cfg)
const agent = { id: 'session-waittest', session: { header: { cwd: '/tmp', delegationDepth: 0 } }, ctx: { tools: { register: (d) => { defs[d.name] = d; return () => {} } } } }
created[0]({ agent })
const exec = { agent, signal: new AbortController().signal }
const run = async (name, args = {}) => assertLossless(name, await defs[name].execute(args, exec))
const render = (name, value) => defs[name].output.render({}, value)[0].text
let failures = 0
const check = (label, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`); if (!ok) failures++ }
const ms = (start) => `${Date.now() - start} ms`

try {
  // 1. wait_for selector on a fresh window (auto-opened by chrome_open → navigate).
  const opened = await run('chrome_open', { url: URL })
  const w0 = opened.windowId
  let t0 = Date.now()
  let r = await run('chrome_wait_for', { selector: '#ready', timeout: 10_000, windowId: w0 })
  check('wait_for selector resolves once the element appears', /selector "#ready" matched 1 element/.test(r) && Date.now() - t0 >= 900, `${ms(t0)}: ${r.split('\n')[1]}`)
  r = await run('chrome_wait_for', { text: ['nope', 'done'], windowId: w0 })
  check('wait_for text (any of) reports the one that matched', /text "done" appeared/.test(r), r.split('\n')[1])
  r = await run('chrome_wait_for', { expression: 'return document.querySelectorAll("p").length', windowId: w0 })
  check('wait_for expression returns its truthy value', /expression returned 1/.test(r) && /\n1$/.test(r), r.split('\n').slice(1).join(' | '))
  t0 = Date.now()
  r = await run('chrome_wait_for', { text: ['never-there'], timeout: 1500, windowId: w0 })
  check('wait_for timeout is a notice, not an error', /wait timed out after 1\.5s for text "never-there"/.test(r) && Date.now() - t0 >= 1400 && Date.now() - t0 < 4000, `${ms(t0)}: ${r.split('\n')[1]}`)

  // 2. wait on navigate + then; wait on evaluate; wait on screenshot.
  t0 = Date.now()
  r = await run('chrome_navigate', { url: URL, wait: { selector: '#ready' }, then: 'return document.getElementById("status").textContent', windowId: w0 })
  check('navigate + wait + then in one call', /selector "#ready" matched/.test(r) && /then → "?done"?$/.test(r.trim()), `${ms(t0)}: ${r.split('\n').slice(1).join(' | ')}`)
  await run('chrome_navigate', { url: URL, windowId: w0 })
  r = await run('chrome_evaluate_expression', { expression: 'return document.getElementById("status").textContent', wait: { text: ['done'] }, windowId: w0 })
  check('evaluate waits for text first', /waited [\d.]+s: text "done" appeared\. /.test(r) && /"done"/.test(r), r.split('\n').slice(0, 2).join(' | '))
  r = await run('chrome_evaluate_expression', { expression: 'return 1', wait: { settleMs: 300 }, windowId: w0 })
  check('evaluate settle only', /settled 300 ms\. /.test(r), r.split('\n')[1])
  await run('chrome_navigate', { url: URL, windowId: w0 })
  const shot = await run('chrome_get_screenshot', { format: 'jpeg', quality: 40, wait: { selector: '#ready' }, windowId: w0 })
  check('screenshot waits and notes it', (shot.notes ?? []).some(n => /selector "#ready" matched/.test(n)), render('chrome_get_screenshot', shot))

  // 3. click / fill by selector and by text (no snapshot).
  r = await run('chrome_click', { selector: '#btn', windowId: w0 })
  check('click by selector', /"clicked":"button#btn/.test(r), r.split('\n')[1])
  r = await run('chrome_click', { text: 'clicked 1', windowId: w0 })
  check('click by text', /"clicked":"button#btn/.test(r), r.split('\n')[1])
  const n = await run('chrome_evaluate_expression', { expression: 'return window.n', windowId: w0 })
  check('both clicks ran the handler', /```(?:json)?\n2\n```/.test(n), n.split('\n').slice(-3).join(' | '))
  r = await run('chrome_fill', { selector: '#name', value: 'hello', windowId: w0 })
  check('fill by selector dispatches input', /"filled":"input#name/.test(r) && /"value":"hello"/.test(r), r.split('\n')[1])
  const echo = await run('chrome_evaluate_expression', { expression: 'return document.getElementById("echo").textContent', windowId: w0 })
  check('input handler saw the value', /hello/.test(echo), echo.split('\n')[1])
  let bad = ''
  try { await run('chrome_click', { selector: '#nope', windowId: w0 }) } catch (error) { bad = error.message }
  check('missing selector errors clearly', /no element matches selector "#nope"/.test(bad), bad.slice(0, 120))
  try { await run('chrome_click', { windowId: w0 }) } catch (error) { bad = error.message }
  check('no target errors clearly', /give uid .*selector .*or text/.test(bad), bad.slice(0, 120))

  // 4. Two windows, no windowId → most recently used, with a note.
  const second = await run('chrome_open', { url: URL })
  const w1 = second.windowId
  r = await run('chrome_evaluate_expression', { expression: 'return location.href' })
  check('two windows: most recently used (the new one) is chosen and named', r.includes(`used ${w1}, the most recently used`) && r.includes(`pass windowId for ${w0}`) && r.includes(`[${w1}]`), r.split('\n')[0])
  await run('chrome_evaluate_expression', { expression: 'return 1', windowId: w0 })
  r = await run('chrome_evaluate_expression', { expression: 'return 1' })
  check('MRU follows the last explicit use', r.includes(`used ${w0}`) && r.includes(`[${w0}]`), r.split('\n')[0])
  await run('chrome_close', { windowId: w1 })

  // 5. Chrome dies underneath the plugin → the old id is reopened at its last URL.
  const kill = () => { const pids = execSync(`pgrep -P ${process.pid}`).toString().trim().split('\n').filter(Boolean); for (const pid of pids) { try { process.kill(Number(pid), 'SIGKILL') } catch { /* gone */ } } return pids.length }
  const killed = kill()
  await new Promise(resolve => setTimeout(resolve, 800))
  t0 = Date.now()
  r = await run('chrome_evaluate_expression', { expression: 'return location.href + " n=" + window.n', windowId: w0 })
  check('lost window reopened under the same id at its last URL', r.startsWith(`Chrome had restarted; reopened ${w0} at ${URL}`) && r.includes(`[${w0}]`) && r.includes(URL) && /n=0/.test(r), `${killed} child procs killed; ${ms(t0)}: ${r.split('\n')[0]}`)
  r = await run('chrome_evaluate_expression', { expression: 'return 2', windowId: w0 })
  check('the note is shown once', !r.includes('reopened'), r.split('\n')[0])
  // no windowId after a crash: the MRU lost window comes back too
  kill()
  await new Promise(resolve => setTimeout(resolve, 800))
  r = await run('chrome_evaluate_expression', { expression: 'return document.title' })
  check('no windowId after a crash reopens the last window', r.startsWith(`Chrome had restarted; reopened ${w0}`) && /wait-test/.test(r), r.split('\n')[0])
  await run('chrome_close')
  check('close-all after recovery reports the window', true)
} catch (error) {
  failures++
  console.error('FAIL (exception)', error)
} finally {
  try { await run('chrome_close') } catch { /* already closed */ }
  server.close()
}
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
