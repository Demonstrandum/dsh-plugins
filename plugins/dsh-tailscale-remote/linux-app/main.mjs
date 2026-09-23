import { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, session, shell } from 'electron'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { parseRemoteTarget, resolveTailnetHost, REMOTE_GLYPH_COLOR } from '../dock-app.mjs'
import { Forwarder, loopbackPort, startProxy } from './forward.mjs'

app.setName('DSH Remote')
app.setPath('userData', join(app.getPath('appData'), 'dsh-remote'))
const configFile = join(app.getPath('userData'), 'server.json')
const setupURL = new URL('./setup.html', import.meta.url).href
const branding = await readFile(new URL('../desktop-branding.js', import.meta.url), 'utf8')
const identityScript = `${branding}(${JSON.stringify({ name: 'DSH Remote', glyphColor: REMOTE_GLYPH_COLOR })});`
const args = process.argv.slice(2)
let mainWindow, forwarder, proxy, base, remoteSession
let lastError = ''

function report(error) {
  console.error(error.message)
  // A failed page can issue many subrequests. Show one dialog per distinct error.
  if (lastError === error.message) return
  lastError = error.message
  void dialog.showMessageBox({ type: 'error', title: 'DSH Remote', message: error.message })
}

async function resolveTarget(input, user) {
  const raw = String(input).trim()
  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw)
    if (url.username || url.password || url.search || url.hash) throw new Error('Use the DSH mount URL without credentials, query, or fragment.')
    if (url.protocol !== 'https:' && loopbackPort(url) === null) throw new Error('Remote DSH URLs must use HTTPS.')
  }
  const target = parseRemoteTarget(raw)
  if (target.url) return target.url
  if (user && !/^[a-zA-Z0-9_-]+$/.test(user)) throw new Error('Invalid remote account name')
  let host = target.host
  if (!host.includes('.')) {
    const { stdout } = await promisify(execFile)('tailscale', ['status', '--json'], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 })
    host = resolveTailnetHost(host, JSON.parse(stdout))
  }
  const path = user ? `/dsh/${user}` : target.path
  return resolveTarget(`https://${host}${path.replace(/\/+$/, '')}/`)
}

function inScope(value) {
  try {
    const url = new URL(value)
    return base && url.origin === base.origin && (url.pathname === base.pathname.slice(0, -1) || url.pathname.startsWith(base.pathname))
  } catch { return false }
}

function makeWindow(url, setup = false) {
  const window = new BrowserWindow({
    title: 'DSH Remote', width: setup ? 640 : 1280, height: setup ? 440 : 900,
    webPreferences: {
      ...(setup ? { preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)) } : { session: remoteSession }),
      nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false,
    },
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!setup) openLink(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, target) => {
    if (setup || (!inScope(target) && loopbackPort(target) === null)) {
      event.preventDefault()
      if (!setup) openLink(target)
    }
  })
  window.webContents.on('will-attach-webview', event => event.preventDefault())
  window.webContents.on('dom-ready', () => {
    if (!setup && inScope(window.webContents.getURL())) {
      void window.webContents.executeJavaScript(identityScript).catch(report)
    }
  })
  window.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) report(new Error(`Could not load DSH: ${description}. Check Tailscale and the server URL; use View → Reload to retry.`))
  })
  void window.loadURL(url).catch(() => {})
  return window
}

function openLink(value) {
  try {
    const url = new URL(value)
    if (inScope(url) || loopbackPort(url) !== null) makeWindow(url.href)
    else if (['https:', 'http:', 'mailto:'].includes(url.protocol)) void shell.openExternal(url.href).catch(report)
  } catch (error) { report(error) }
}

function menu() {
  const rows = [...(forwarder?.rows.values() ?? [])].sort((a, b) => a.remotePort - b.remotePort)
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [
      { label: 'Change server…', click: () => { app.relaunch({ args: [process.argv[1], '--setup'] }); app.quit() } },
      { type: 'separator' }, { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
      { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' },
    ] },
    { label: 'Forwarded Ports', submenu: rows.length ? rows.map(row => ({
      label: `Local ${row.localPort} → remote ${row.remotePort}`,
      submenu: [
        { label: 'Copy local URL', click: () => clipboard.writeText(`http://127.0.0.1:${row.localPort}/`) },
        { label: 'Close forward', click: () => forwarder.close(row.remotePort) },
      ],
    })) : [{ label: 'No forwarded ports', enabled: false }] },
  ]))
}

async function start(url) {
  proxy?.close()
  forwarder?.dispose()
  base = new URL(url)
  const key = createHash('sha256').update(url).digest('hex').slice(0, 24)
  remoteSession = session.fromPartition(`persist:dsh-${key}`)
  const allowed = (permission, origin) => {
    try {
      const trusted = new URL(origin).origin === base.origin || loopbackPort(origin) !== null
      return trusted && ['clipboard-sanitized-write', 'fullscreen', 'loopback-network', 'local-network-access'].includes(permission)
    } catch { return false }
  }
  remoteSession.setPermissionRequestHandler((_wc, permission, callback, details) => callback(allowed(permission, details.requestingUrl)))
  remoteSession.setPermissionCheckHandler((_wc, permission, origin) => allowed(permission, origin))
  forwarder = new Forwarder(url, async endpoint => {
    const cookies = await remoteSession.cookies.get({ url: endpoint })
    return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
  }, menu)
  proxy = await startProxy(forwarder, report)
  // Last matching bypass rule wins: direct for everything except Chromium's
  // loopback destinations. PAC cannot disable Chromium's implicit local bypass.
  // A loopback DSH URL is useful for isolated testing; it is the server itself,
  // not a preview port, and must bypass forwarding.
  await remoteSession.setProxy({
    mode: 'fixed_servers', proxyRules: `http://127.0.0.1:${proxy.port}`,
    proxyBypassRules: '*;<-loopback>' + (loopbackPort(base) === null ? '' : `;${base.host}`),
  })
  mainWindow = makeWindow(url)
  menu()
}

app.on('before-quit', () => { proxy?.close(); forwarder?.dispose() })
app.on('window-all-closed', () => app.quit())

if (args.includes('--help')) {
  console.log('Usage: dsh-remote [https://host.example.ts.net/dsh/user/ | HOST [USER]]\nWithout arguments, opens the remembered server or a connection form.\n--setup: choose a different server. Requires a connected Tailscale service for tailnet hosts.')
  app.exit(0)
} else app.whenReady().then(async () => {
  menu()
  ipcMain.handle('connect', async (event, input) => {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || event.senderFrame.url !== setupURL) throw new Error('Not the connection form')
    try {
      const url = await resolveTarget(input)
      await mkdir(app.getPath('userData'), { recursive: true })
      await writeFile(configFile, JSON.stringify({ url }) + '\n', { mode: 0o600 })
      const setup = mainWindow
      await start(url)
      setup.close()
      return null
    } catch (error) { return error.message }
  })
  try {
    let target
    if (args.length && !args.includes('--setup')) target = await resolveTarget(args[0], args[1])
    else if (!args.includes('--setup')) {
      try { target = await resolveTarget(JSON.parse(await readFile(configFile, 'utf8')).url) }
      catch (error) { if (error.code !== 'ENOENT') console.error(`Ignoring saved server: ${error.message}`) }
    }
    if (target) {
      await mkdir(app.getPath('userData'), { recursive: true })
      await writeFile(configFile, JSON.stringify({ url: target }) + '\n', { mode: 0o600 })
      await start(target)
    } else mainWindow = makeWindow(setupURL, true)
  } catch (error) { dialog.showErrorBox('DSH Remote', error.message); app.exit(1) }
})
