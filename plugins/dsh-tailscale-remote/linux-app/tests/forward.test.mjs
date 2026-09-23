import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, request } from 'node:http'
import { createServer as tcpServer, connect } from 'node:net'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import WebSocket, { WebSocketServer } from 'ws'
import { handleForwardUpgrade } from '../../forward.mjs'
import { Forwarder, listen, loopbackPort, startProxy } from '../forward.mjs'

test('real forwarding route: HTTP, WebSockets, conflicts, denial, concurrency and cleanup', { timeout: 20_000 }, async t => {
  const tracked = new Set()
  const track = server => server.on('connection', socket => {
    tracked.add(socket)
    socket.once('close', () => tracked.delete(socket))
  })
  const echo = tcpServer(socket => socket.pipe(socket))
  const preview = createServer((req, res) => res.end(`${req.method} ${req.url} ${req.headers.host}`))
  const wss = new WebSocketServer({ server: preview })
  wss.on('connection', ws => ws.on('message', data => ws.send(data)))
  const bridge = createServer()
  for (const server of [echo, preview, bridge]) track(server)
  const echoPort = await listen(echo)
  const previewPort = await listen(preview)
  let policy = 'admitted'
  bridge.on('upgrade', (req, socket, head) => {
    assert.equal(req.headers.cookie, 'session=test')
    req.url = req.url.replace('/dsh/test', '')
    void handleForwardUpgrade(req, socket, head, {
      policy: () => policy, selfUid: 123, reservedPorts: () => [1], connections: new Set(),
      lookup: async port => [echoPort, previewPort].includes(port) ? [{ pid: 1, uid: 123, command: 'test', names: [`127.0.0.1:${port}`] }] : [],
    })
  })
  const bridgePort = await listen(bridge)
  const forwarder = new Forwarder(`http://127.0.0.1:${bridgePort}/dsh/test/`, async () => 'session=test')
  const proxy = await startProxy(forwarder)
  t.after(() => {
    proxy.close(); forwarder.dispose(); wss.close()
    for (const socket of tracked) socket.destroy()
    for (const server of [echo, preview, bridge]) server.close()
  })

  for (const host of ['localhost', '127.0.0.2', '[::1]', 'app.localhost']) assert.equal(loopbackPort(`http://${host}:5173/`), 5173)
  for (const url of ['https://example.com/', 'http://localhost.example.com/', 'http://127.example.com/', 'file:///tmp/a']) assert.equal(loopbackPort(url), null)

  const [row, same] = await Promise.all([forwarder.ensure(echoPort), forwarder.ensure(echoPort)])
  assert.equal(row, same)
  assert.notEqual(row.localPort, echoPort, 'occupied local port must be remapped')
  const client = connect(row.localPort, '127.0.0.1')
  const bytes = randomBytes(3 * 1024 * 1024)
  const received = []
  let count = 0
  const roundtrip = new Promise((resolve, reject) => {
    client.on('error', reject)
    client.on('data', chunk => { received.push(chunk); count += chunk.length; if (count === bytes.length) resolve() })
  })
  client.write(bytes)
  await roundtrip
  assert.deepEqual(Buffer.concat(received), bytes)

  const get = url => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: proxy.port, path: url, headers: { Host: new URL(url).host } }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject); req.end()
  })
  assert.deepEqual(await get(`http://localhost:${previewPort}/hello?q=1`), { status: 200, body: `GET /hello?q=1 localhost:${previewPort}` })
  assert.equal((await get('http://example.com/')).status, 502)

  // Browser WebSockets use CONNECT through an HTTP proxy, including plain ws:.
  const socket = connect(proxy.port, '127.0.0.1')
  socket.write(`CONNECT localhost:${previewPort} HTTP/1.1\r\nHost: localhost:${previewPort}\r\n\r\n`)
  const [response] = await once(socket, 'data')
  assert.match(response.toString(), /^HTTP\/1.1 200/)
  const ws = new WebSocket(`ws://localhost:${previewPort}/hmr`, { createConnection: () => socket })
  await once(ws, 'open')
  ws.send('hot reload')
  assert.equal((await once(ws, 'message'))[0].toString(), 'hot reload')
  ws.close()
  await once(ws, 'close')

  await assert.rejects(forwarder.ensure(1), { code: 'reserved' })
  policy = 'off'
  await assert.rejects(forwarder.ensure(2), { code: 'disabled' })
  policy = 'admitted'
  await assert.rejects(forwarder.ensure(2), { code: 'nothing-listening' })
  const closed = once(client, 'close')
  forwarder.close(echoPort)
  await closed
  assert.equal(forwarder.rows.has(echoPort), false)
  forwarder.dispose()
  await assert.rejects(forwarder.ensure(echoPort), /closed/)
})
