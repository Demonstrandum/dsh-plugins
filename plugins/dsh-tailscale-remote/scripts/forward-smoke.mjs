#!/usr/bin/env node
/**
 * End-to-end smoke test of loopback forwarding across the language boundary:
 * the Swift client half (dock-app/Sources/PortForward.swift, driven by
 * dock-app/Tools/forward-smoke.swift) against the real Node route
 * (forward.mjs) — no DSH, no Tailscale, no Dock app install.
 *
 *   pnpm forward:smoke
 *
 * What it proves: probe → HTTP refusal codes reach Swift; listener binds on the
 * remote's port number; bytes round-trip through NWConnection ↔ WebSocket ↔
 * forward.mjs ↔ TCP in order, including a multi-megabyte burst; the local
 * connection closes when the target closes. Needs swiftc (Command Line Tools).
 */
import { execFile, spawn } from 'node:child_process'
import { copyFile, mkdtemp } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { connect, createServer as createTcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { FORWARD_PATH, handleForwardUpgrade } from '../forward.mjs'

const execFileAsync = promisify(execFile)
const here = fileURLToPath(new URL('.', import.meta.url))
const sources = ['dock-app/Sources/PortForward.swift', 'dock-app/Tools/forward-smoke.swift'].map(rel => join(here, '..', rel))

const fail = (message) => { console.error(`FAIL: ${message}`); process.exit(1) }
const listen = (server) => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))

// 1. A TCP echo target we own (so the real lsof/uid guard passes).
const echoSockets = new Set()
const echo = createTcpServer((socket) => {
  echoSockets.add(socket)
  socket.once('close', () => echoSockets.delete(socket))
  socket.pipe(socket)
})
const echoPort = await listen(echo)
// A port with nothing listening (bind, read the number, close).
const ghost = createTcpServer()
const ghostPort = await listen(ghost)
await new Promise(resolve => ghost.close(resolve))

// 2. The forward route on a bare http.Server, the way DSH's web server dispatches it.
const connections = new Set()
const http = createHttpServer((req, res) => { res.writeHead(404); res.end() })
http.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname !== FORWARD_PATH) { socket.destroy(); return }
  void handleForwardUpgrade(req, socket, head, {
    policy: () => 'admitted',
    selfUid: process.getuid(),
    reservedPorts: () => [],
    connections,
    log: line => console.error(`  [node] ${line}`),
  })
})
const httpPort = await listen(http)

// 3. Compile the harness. In a multi-file swiftc build only `main.swift` may
// hold top-level code, so the harness is staged under that name.
const stage = await mkdtemp(join(tmpdir(), 'dsh-forward-smoke-'))
const binary = join(stage, 'forward-smoke')
await copyFile(sources[1], join(stage, 'main.swift'))
console.error('compiling the Swift harness…')
await execFileAsync('/usr/bin/xcrun', ['swiftc', '-O', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13.0`, '-o', binary, sources[0], join(stage, 'main.swift'), '-framework', 'Foundation', '-framework', 'WebKit', '-framework', 'Network'], { maxBuffer: 8 * 1024 * 1024 })

// 4. Run it: forward the echo port and the ghost port.
const child = spawn(binary, [`http://127.0.0.1:${String(httpPort)}/`, String(echoPort), String(ghostPort)], { stdio: ['pipe', 'pipe', 'inherit'] })
const lines = []
let stdoutBuffer = ''
const ready = new Promise((resolve) => {
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString()
    let at
    while ((at = stdoutBuffer.indexOf('\n')) !== -1) {
      const line = stdoutBuffer.slice(0, at)
      stdoutBuffer = stdoutBuffer.slice(at + 1)
      console.error(`  [swift] ${line}`)
      lines.push(line)
      if (line === 'READY') resolve()
    }
  })
})
const timeout = setTimeout(() => fail('harness did not report within 20 s'), 20_000)
await ready
clearTimeout(timeout)

const local = lines.find(line => line.startsWith(`LOCAL ${String(echoPort)} `))
if (local === undefined) fail(`echo port was not forwarded: ${lines.join(' | ')}`)
const localPort = Number(local.split(' ')[2])
if (localPort !== echoPort) console.error(`  note: ${String(echoPort)} was busy here, forwarded on ${String(localPort)} instead`)
const refused = lines.find(line => line.startsWith(`REFUSED ${String(ghostPort)} `))
if (refused === undefined || !refused.includes('nothing-listening')) fail(`ghost port should be refused with nothing-listening: ${lines.join(' | ')}`)

// 5. Bytes through the tunnel.
const client = connect({ host: '127.0.0.1', port: localPort })
await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('error', reject) })
const received = []
let receivedBytes = 0
client.on('data', (chunk) => { received.push(chunk); receivedBytes += chunk.length })
const waitFor = (bytes, ms = 10_000) => new Promise((resolve, reject) => {
  const deadline = setTimeout(() => reject(new Error(`only ${String(receivedBytes)} of ${String(bytes)} bytes came back`)), ms)
  const check = () => { if (receivedBytes >= bytes) { clearTimeout(deadline); resolve() } else setTimeout(check, 5) }
  check()
})
const hello = 'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'
client.write(hello)
await waitFor(hello.length).catch(error => fail(error.message))
if (Buffer.concat(received).toString() !== hello) fail('first echo differs')

const burst = Buffer.alloc(3 * 1024 * 1024)
for (let index = 0; index < burst.length; index++) burst[index] = index & 0xff
client.write(burst)
await waitFor(hello.length + burst.length).catch(error => fail(error.message))
const all = Buffer.concat(received).subarray(hello.length)
if (!all.equals(burst)) fail('3 MiB burst came back different (ordering or loss)')
console.error(`  ok: ${String(burst.length)} bytes round-tripped in order`)

// 6. Target closes → local side closes.
const closed = new Promise(resolve => client.once('close', resolve))
echo.close()
for (const socket of echoSockets) socket.end()
await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('local side did not close after the target closed')), 5000))]).catch(error => fail(error.message))
console.error('  ok: local connection closed with the target')

child.stdin.end()
await new Promise(resolve => child.once('exit', resolve))
http.closeAllConnections()
http.close()
console.error('PASS')
process.exit(0)
