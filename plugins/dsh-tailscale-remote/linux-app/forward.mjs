import { createServer, connect, isIP } from 'node:net'
import { createServer as createHttpServer, request } from 'node:http'
import { pipeline } from 'node:stream'
import WebSocket, { createWebSocketStream } from 'ws'

export function loopbackPort(value) {
  const url = new URL(value)
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return null
  const host = url.hostname
  if (!(host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || (isIP(host) === 4 && host.startsWith('127.')))) return null
  return Number(url.port || (['https:', 'wss:'].includes(url.protocol) ? 443 : 80))
}

export const listen = (server, port = 0) => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(port, '127.0.0.1', () => {
    server.removeListener('error', reject)
    resolve(server.address().port)
  })
})

export class Forwarder {
  constructor(base, cookies = async () => '', changed = () => {}) {
    this.base = new URL(base)
    this.cookies = cookies
    this.changed = changed
    this.rows = new Map()
    this.pending = new Map()
    this.sockets = new Set()
    this.closed = false
    this.timer = setInterval(() => {
      for (const [port, row] of this.rows) {
        if (!row.sockets.size && Date.now() - row.active > 3600_000) this.close(port)
      }
    }, 60_000).unref()
  }

  async tunnel(port) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid TCP port')
    const url = new URL('api/loopback-forward', this.base)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('port', port)
    const cookie = await this.cookies(url.href.replace(/^ws/, 'http'))
    if (this.closed) throw new Error('Forwarder is closed')
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers: cookie ? { Cookie: cookie } : {}, handshakeTimeout: 10_000, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false })
      this.sockets.add(ws)
      const timeout = setTimeout(() => fail(new Error('Forwarding handshake timed out')), 10_000)
      const fail = error => { clearTimeout(timeout); reject(error); ws.terminate() }
      ws.on('error', fail)
      ws.once('close', () => {
        clearTimeout(timeout)
        this.sockets.delete(ws)
        reject(new Error('Forwarding connection closed before it was ready'))
      })
      ws.once('unexpected-response', (_req, response) => {
        response.resume()
        const code = response.headers['x-dsh-forward-error'] || `HTTP ${response.statusCode}`
        fail(Object.assign(new Error(`Remote port ${port}: ${code}`), { code }))
      })
      ws.once('message', (data, binary) => {
        try {
          if (binary || JSON.parse(data).type !== 'connected') throw new Error('Unexpected forwarding handshake')
          clearTimeout(timeout)
          resolve(createWebSocketStream(ws))
        } catch (error) { fail(error) }
      })
    })
  }

  ensure(port) {
    if (this.closed) return Promise.reject(new Error('Forwarder is closed'))
    if (this.rows.has(port)) return Promise.resolve(this.rows.get(port))
    if (!this.pending.has(port)) {
      this.pending.set(port, this.bind(port).finally(() => this.pending.delete(port)))
    }
    return this.pending.get(port)
  }

  async bind(port) {
    const probe = await this.tunnel(port)
    probe.on('error', () => {})
    probe.destroy()
    const row = { remotePort: port, localPort: 0, sockets: new Set(), active: Date.now() }
    const server = createServer({ pauseOnConnect: true }, async socket => {
      row.sockets.add(socket)
      socket.on('error', () => {})
      socket.once('close', () => { row.sockets.delete(socket); row.active = Date.now() })
      try {
        const stream = await this.tunnel(port)
        if (socket.destroyed) { stream.destroy(); return }
        pipeline(socket, stream, socket, () => {})
      } catch { socket.destroy() }
    })
    row.server = server
    try { row.localPort = await listen(server, port) }
    catch (error) {
      if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error
      row.localPort = await listen(server)
    }
    if (this.closed) { server.close(); throw new Error('Forwarder is closed') }
    this.rows.set(port, row)
    this.changed()
    return row
  }

  close(port) {
    const row = this.rows.get(port)
    if (!row) return
    this.rows.delete(port)
    row.server.close()
    for (const socket of row.sockets) socket.destroy()
    this.changed()
  }

  dispose() {
    this.closed = true
    clearInterval(this.timer)
    for (const port of this.rows.keys()) this.close(port)
    for (const ws of this.sockets) ws.terminate()
  }
}

// Chromium proxies only loopback destinations through this server. Keeping
// their original URLs preserves Host, cookies, and hard-coded HMR WebSockets
// even when the matching local port is occupied. Never proxy arbitrary hosts.
export async function startProxy(forwarder, report = () => {}) {
  const sockets = new Set()
  const target = async raw => {
    const port = loopbackPort(raw)
    if (!port) throw new Error('Only loopback destinations may be forwarded')
    return forwarder.ensure(port)
  }
  const server = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url)
      if (url.protocol !== 'http:') throw new Error('Expected an HTTP proxy request')
      const row = await target(url)
      if (res.destroyed) return
      const headers = { ...req.headers, connection: 'close' }
      delete headers['proxy-authorization']
      delete headers['proxy-connection']
      const upstream = request({ host: '127.0.0.1', port: row.localPort, method: req.method, path: url.pathname + url.search, headers, agent: false }, response => {
        res.writeHead(response.statusCode, response.headers)
        pipeline(response, res, () => {})
      })
      upstream.on('error', error => { res.destroy(error) })
      res.once('close', () => upstream.destroy())
      pipeline(req, upstream, () => {})
    } catch (error) { report(error); res.writeHead(502); res.end(error.message) }
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('connect', async (req, socket, head) => {
    socket.pause()
    try {
      const row = await target(`https://${req.url}`)
      if (socket.destroyed) return
      const upstream = connect(row.localPort, '127.0.0.1')
      upstream.once('connect', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        pipeline(socket, upstream, socket, () => {})
      })
      upstream.on('error', () => socket.destroy())
      socket.once('close', () => upstream.destroy())
    } catch (error) {
      report(error)
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
    }
  })
  const port = await listen(server)
  return { port, close() { server.close(); for (const socket of sockets) socket.destroy() } }
}
