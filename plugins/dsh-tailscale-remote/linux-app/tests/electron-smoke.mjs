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
    res.end(`<p id="result">waiting</p><iframe src="http://localhost:${previewPort}/"></iframe>
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
    const ports = Menu.getApplicationMenu().items.find(item => item.label === 'Forwarded Ports').submenu.items
    assert.equal(ports.length, 1)
    assert.ok(ports[0].label.endsWith(`→ remote ${previewPort}`))
    assert.ok(!ports[0].label.startsWith(`Local ${previewPort} `), 'occupied port must be remapped')
    assert.equal(await window.webContents.executeJavaScript('typeof require + ":" + typeof window.dsh'), 'undefined:undefined')
    console.log('PASS: real app setup → iframe + hard-coded HMR through a remapped port; no Node or IPC in remote page')
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
