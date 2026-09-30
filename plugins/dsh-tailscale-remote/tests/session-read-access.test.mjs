import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { createSessionReadAccess, READ_GRANT_HEADER } from '../session-read-access.mjs'
import { startProxy, cookieValueFor } from '../proxy.mjs'
import { snapshotHandler } from '../../billing-status/index.js'
const url = id => `/api/billing-status/snapshot?sessionId=${id}`
const owner = name => `${name}@example.com`
function setup(options = {}) {
  return createSessionReadAccess({ lookupOwner: id => id === 'session-one' ? owner('alice') : owner('bob'),
    selfLogin: () => 'alice@example.com', requestRejection: req => req.headers.cookie === 'authenticated' ? undefined : 401, ...options })
}
const request = (id, headers = {}) => new Request(`http://localhost${url(id)}`, { headers })
test('proxy grants bind verified login, exact request and explicit owner, then expire/consume', async () => {
  let now = 1000
  const access = setup({ now: () => now })
  const grant = access.proxyHeaders({ method: 'GET', url: url('session-one') }, { kind: 'user', login: 'alice@example.com' })
  assert.equal(await access.canRead(request('session-one', grant), 'session-one'), true)
  assert.equal(await access.canRead(request('session-one', grant), 'session-one'), false)
  const other = access.proxyHeaders({ method: 'GET', url: url('session-two') }, { kind: 'user', login: 'alice@example.com' })
  assert.equal(await access.canRead(request('session-two', other), 'session-two'), false)
  const moved = access.proxyHeaders({ method: 'GET', url: url('session-one') }, { kind: 'user', login: 'alice@example.com' })
  assert.equal(await access.canRead(request('session-two', moved), 'session-two'), false)
  const expired = access.proxyHeaders({ method: 'GET', url: url('session-one') }, { kind: 'user', login: 'alice@example.com' })
  now += 15000
  assert.equal(await access.canRead(request('session-one', expired), 'session-one'), false)
  assert.deepEqual(access.proxyHeaders({ method: 'GET', url: url('session-one') }, { kind: 'cookie' }), {})
  assert.deepEqual(access.proxyHeaders({ method: 'GET', url: url('session-one') + '&sessionId=session-two' }, { kind: 'user', login: 'alice@example.com' }), {})
  const viewed = setup({ lookupOwner: () => ({ owner: 'alice@example.com', first: { method: 'session/prompt' } }) })
  assert.equal(await viewed.canRead(request('session-one', viewed.proxyHeaders({ method: 'GET', url: url('session-one') }, { kind: 'user', login: 'alice@example.com' })), 'session-one'), false)
  access.dispose(); viewed.dispose()
})
test('direct local admission needs actual loopback, DSH authentication, and no forwarding identity', async () => {
  const access = setup()
  const local = headers => ({ method: 'GET', url: url('session-one'), socket: { remoteAddress: '127.0.0.1' }, headers })
  const good = local({ cookie: 'authenticated', [READ_GRANT_HEADER]: 'forged' })
  access.localRequest(good)
  assert.notEqual(good.headers[READ_GRANT_HEADER], 'forged')
  assert.equal(await access.canRead(request('session-one', good.headers), 'session-one'), true)
  for (const bad of [local({}), local({ cookie: 'authenticated', 'x-forwarded-for': '100.64.0.3' }),
    { ...local({ cookie: 'authenticated' }), socket: { remoteAddress: '100.64.0.3' } },
    local({ cookie: 'authenticated', 'x-dsh-tailscale-remote': '1', [READ_GRANT_HEADER]: 'forged' })]) {
    access.localRequest(bad)
    assert.equal(await access.canRead(request('session-one', bad.headers), 'session-one'), false)
  }
  access.dispose()
  const after = local({ cookie: 'authenticated' }); access.localRequest(after)
  assert.equal(await access.canRead(request('session-one', after.headers), 'session-one'), false)
})
test('grant table is bounded, disposal and unknown owner deny', async () => {
  const access = setup({ maxGrants: 1, lookupOwner: () => undefined })
  const input = { method: 'GET', url: url('session-one') }, identity = { kind: 'user', login: 'alice@example.com' }
  const first = access.proxyHeaders(input, identity)
  assert.deepEqual(access.proxyHeaders(input, identity), {})
  assert.equal(await access.canRead(request('session-one', first), 'session-one'), false)
  const again = access.proxyHeaders(input, identity)
  assert.ok(again[READ_GRANT_HEADER])
  access.dispose()
  assert.equal(await access.canRead(request('session-one', again), 'session-one'), false)
})
test('invalid legacy or changed bindings never authorize an outstanding request', async () => {
  for (const value of [undefined, '', 'TOKEN', 'LOCAL', ' user@example.com', { owner: 'alice@example.com', first: { method: 'session/prompt' } }]) {
    const access = setup({ lookupOwner: () => value })
    const grant = access.proxyHeaders({ method: 'GET', url: url('session-one') }, { kind: 'user', login: 'alice@example.com' })
    assert.equal(await access.canRead(request('session-one', grant), 'session-one'), false)
    access.dispose()
  }
  let binding = 'alice@example.com'
  const access = setup({ lookupOwner: () => binding })
  const grant = access.proxyHeaders({ method: 'GET', url: url('session-one') }, { kind: 'user', login: 'alice@example.com' })
  binding = 'bob@example.com'
  assert.equal(await access.canRead(request('session-one', grant), 'session-one'), false)
  access.dispose()
})
function send(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, headers }, res => {
      const body = []; res.on('data', data => body.push(data)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(body).toString(), headers: res.headers }))
    }); req.on('error', reject); req.end()
  })
}
const peer = who => ({ host: 'node.example.ts.net', 'x-forwarded-for': '100.64.0.3', 'x-forwarded-host': 'node.example.ts.net', 'x-forwarded-proto': 'https', 'tailscale-user-login': `${who}@example.com` })
test('real proxy + Fetch billing route: owner allowed, other user/cookie/spoof denied; direct authenticated host works', async t => {
  const COOKIE = 'unit-auth=fixture', TOKEN = 'fixture-remote-token'
  const access = setup({ requestRejection: req => req.headers.cookie === COOKIE ? undefined : 401 })
  const services = new Map([['sessionRequestAccess', access], ['sessionOwners', {}]])
  let snapshots = 0
  const handler = snapshotHandler({ get: name => services.get(name) }, { snapshot: async sessionId => { snapshots++; return { sessionId, cost: '1.25' } } })
  const server = createServer(async (req, res) => {
    if (req.url.startsWith('/?token=')) { res.writeHead(303, { 'set-cookie': COOKIE, location: './' }); res.end(); return }
    if (req.headers.cookie !== COOKIE) { res.writeHead(401); res.end(); return }
    const response = await handler(new Request(`http://127.0.0.1:${server.address().port}${req.url}`, { headers: req.headers }))
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text())
  })
  server.prependListener('request', access.localRequest)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const proxy = await startProxy({ listenHost: '127.0.0.1', listenPort: 0, backendHost: '127.0.0.1', backendPort: server.address().port,
    connection: { authenticatedUrl: base => `${base}/?token=fixture` }, token: () => TOKEN,
    allowedUsers: () => ['alice@example.com','bob@example.com'], selfLogin: () => 'alice@example.com', selfAddresses: () => ['100.64.0.2'],
    publicHosts: () => ['node.example.ts.net'], cookieName: 'unit-remote', controlPrefix: '/control', sessionReadHeaders: access.proxyHeaders })
  t.after(async () => { access.dispose(); await proxy.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  assert.equal((await send(proxy.port, url('session-one'), peer('alice'))).status, 200)
  assert.equal((await send(proxy.port, url('session-one'), { ...peer('bob'), [READ_GRANT_HEADER]: 'forged', 'x-dsh-tailscale-remote-login': 'alice@example.com' })).status, 403)
  assert.equal((await send(proxy.port, url('session-one'), { cookie: `unit-remote=${cookieValueFor(TOKEN)}`, [READ_GRANT_HEADER]: 'forged' })).status, 403)
  assert.equal((await send(server.address().port, url('session-one'), { cookie: COOKIE })).status, 200)
  assert.equal((await send(server.address().port, url('session-one'), {})).status, 401)
  assert.equal(snapshots, 2)
  services.delete('sessionRequestAccess'); services.delete('sessionOwners')
  assert.equal((await send(server.address().port, url('session-one'), { cookie: COOKIE })).status, 403)
})
