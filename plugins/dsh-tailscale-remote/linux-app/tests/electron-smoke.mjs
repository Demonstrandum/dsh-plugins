// Run with Electron under Xvfb. Loads the real app through its connection
// form, then exercises an iframe and hard-coded HMR on an occupied local port.
import { app, BrowserWindow, Menu } from 'electron'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { handleForwardUpgrade } from '../../forward.mjs'
import { listen } from '../forward.mjs'

app.setPath('appData', mkdtempSync(join(tmpdir(), 'dsh-electron-test-')))
app.whenReady().then(async () => {
  const sockets = new Set()
  const preview = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.end(`<p id="result">preview</p><script>
      const ws = new WebSocket('ws://localhost:${preview.address().port}/hmr');
      ws.onopen = () => ws.send('hmr works');
      ws.onmessage = e => { document.querySelector('#result').textContent = e.data; parent.postMessage(e.data, '*'); };
    </script>`)
  })
  const wss = new WebSocketServer({ server: preview })
  wss.on('connection', ws => ws.on('message', data => ws.send(data.toString())))
  const previewPort = await listen(preview)
  const bridge = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.end(`<span class="test_brandMark">whale</span><span class="test_railMark">whale</span>
      <span class="test_localBuildTitle">DSH Local Build</span><span class="test_fallbackBrandName">DSH</span>
      <span class="test_buildVersion">version</span>
      <div class="test_sidebarCol" style="--dsw-specific-sidebar-fill: rgb(100, 100, 100)"></div>
      <p id="result">waiting</p><iframe src="http://localhost:${previewPort}/"></iframe>
      <script>onmessage = e => document.querySelector('#result').textContent = e.data;</script>`)
  })
  bridge.on('upgrade', (req, socket, head) => void handleForwardUpgrade(req, socket, head, {
    policy: () => 'admitted', selfUid: 1, reservedPorts: () => [], connections: new Set(),
    lookup: async port => [{ uid: 1, pid: 1, command: 'test', names: [`127.0.0.1:${port}`] }],
  }))
  for (const server of [preview, bridge]) server.on('connection', socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket))
  })
  const bridgePort = await listen(bridge)
  const timeout = setTimeout(() => { console.error('Electron smoke timed out'); app.exit(1) }, 20_000)
  try {
    process.argv = [process.execPath, fileURLToPath(new URL('../main.mjs', import.meta.url)), '--setup']
    const setupCreated = once(app, 'browser-window-created')
    await import('../main.mjs')
    const [, setup] = await setupCreated
    await once(setup.webContents, 'did-finish-load')
    assert.equal(await setup.webContents.executeJavaScript('typeof window.dsh.connect'), 'function')
    assert.match(await setup.webContents.executeJavaScript("window.dsh.connect('http://example.com/')"), /HTTPS/)
    const mainCreated = once(app, 'browser-window-created')
    // The setup window closes after success, so its pending JS may be discarded.
    void setup.webContents.executeJavaScript(`window.dsh.connect('http://127.0.0.1:${bridgePort}/')`).catch(() => {})
    const [, window] = await mainCreated
    const ses = window.webContents.session
    assert.equal(await ses.resolveProxy('https://example.com/'), 'DIRECT')
    for (const host of ['localhost', 'app.localhost', '127.0.0.1', '[::1]']) {
      assert.match(await ses.resolveProxy(`http://${host}:${previewPort}/`), /^PROXY 127\.0\.0\.1:/, host)
    }
    await once(window.webContents, 'did-finish-load')
    const result = await window.webContents.executeJavaScript(`new Promise(resolve => {
      const poll = setInterval(() => {
        if (document.querySelector('#result').textContent === 'hmr works') { clearInterval(poll); resolve('ok'); }
      }, 25);
    })`)
    assert.equal(result, 'ok')
    const checkBranding = async () => {
      assert.deepEqual(await window.webContents.executeJavaScript(`({
        identity: globalThis.__DSH_DOCK__,
        whale: getComputedStyle(document.querySelector('.test_brandMark')).color,
        rail: getComputedStyle(document.querySelector('.test_railMark')).color,
        label: getComputedStyle(document.querySelector('.test_localBuildTitle'), '::before').content,
        fallback: getComputedStyle(document.querySelector('.test_fallbackBrandName'), '::before').content,
        styles: document.querySelectorAll('#dsh-dock-identity').length,
      })`), {
        identity: { name: 'DSH Remote', glyphColor: '#0090FF' },
        whale: 'rgb(0, 144, 255)', rail: 'rgb(0, 144, 255)',
        label: '"DSH Remote"', fallback: '"DSH Remote"', styles: 1,
      })
    }
    await checkBranding()
    assert.equal(await window.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.test_sidebarCol')).backgroundColor`), 'rgba(0, 0, 0, 0)')
    assert.match(await window.webContents.executeJavaScript(`
      document.documentElement.dataset.platform = 'darwin';
      getComputedStyle(document.querySelector('.test_sidebarCol')).backgroundColor
    `), /\/ 0\.18\)$/)
    await window.webContents.executeJavaScript(`delete document.documentElement.dataset.platform`)
    const previewFrame = window.webContents.mainFrame.frames.find(frame => frame.url.includes(`localhost:${previewPort}`))
    assert.equal(await previewFrame.executeJavaScript('typeof globalThis.__DSH_DOCK__'), 'undefined')
    const reloaded = once(window.webContents, 'did-finish-load')
    window.webContents.reload()
    await reloaded
    await checkBranding()
    const ports = Menu.getApplicationMenu().items.find(item => item.label === 'Forwarded Ports').submenu.items
    assert.equal(ports.length, 1)
    assert.ok(ports[0].label.endsWith(`→ remote ${previewPort}`))
    assert.ok(!ports[0].label.startsWith(`Local ${previewPort} `), 'occupied port must be remapped')
    assert.equal(await window.webContents.executeJavaScript('typeof require + ":" + typeof window.dsh'), 'undefined:undefined')
    console.log('PASS: setup, forwarding/HMR, shared branding after reload, unbranded preview, isolated remote renderer')
  } catch (error) { console.error(error); process.exitCode = 1 }
  finally {
    clearTimeout(timeout)
    // Exercise the application's quit cleanup before tearing down the fixtures.
    app.emit('before-quit')
    for (const window of BrowserWindow.getAllWindows()) window.destroy()
    wss.close()
    for (const socket of sockets) socket.destroy()
    preview.close(); bridge.close(); app.exit(process.exitCode || 0)
  }
})
