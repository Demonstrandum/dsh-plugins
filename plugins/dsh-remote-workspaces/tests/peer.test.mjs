/**
 * Two plugin instances talking to each other over HTTP: the "local" one's
 * control channel (`servers.inspectPath`, `workspaces.add`) reaches the
 * "remote" one's `fs.inspect` / `fs.mkdir` through the egress, while the
 * remote's `/api/workspace/*` is a small fake of the DSH Typert endpoints.
 * Everything runs against a temp directory; no real DSH is involved.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { apply, CONTROL_CHANNEL } from '../index.js'

/** A minimal Cordis-shaped context: routes land on one http server. */
function fakeContext({ requestRejection, fakeApi }) {
  const prefixes = []
  const disposers = []
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (fakeApi !== undefined && path.startsWith('/api/')) return fakeApi(req, res, path)
    const route = prefixes.find(entry => path === entry.path || path.startsWith(`${entry.path}/`))
    if (route === undefined) { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<h1>not found</h1>'); return }
    return route.handler(req, res)
  })
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    connection: { requestRejection, createSharedFetchHandler: () => async () => new Response('{}') },
    webServer: {
      register: (spec) => { prefixes.push(spec); return () => { prefixes.splice(prefixes.indexOf(spec), 1) } },
      registerUpgrade: () => () => {},
    },
    effect: (fn) => { const out = fn(); if (typeof out === 'function') disposers.push(out) },
  }
  return {
    ctx,
    listen: () => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: async () => {
      for (const dispose of disposers) await dispose()
      await new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()) })
    },
  }
}

/** POST one control-channel request the way the browser half does. */
function control(port, endpoint, args, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ type: 'client-request', rpcId: 'r1', method: endpoint, payload: { args } })
    const req = httpRequest({ hostname: '127.0.0.1', port, path: `${CONTROL_CHANNEL}/${endpoint}`, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(text).result) } catch { reject(new Error(`HTTP ${String(res.statusCode)}: ${text}`)) }
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

describe('peer fs endpoints over the egress', () => {
  let root, remoteHome, remote, local, remotePort, localPort
  const remoteWorkspaces = []
  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'rws-peer-'))
    remoteHome = join(root, 'remote-home')
    await mkdir(join(remoteHome, 'projects', 'existing'), { recursive: true })
    // The remote: this plugin + a fake DSH `workspace.list` / `workspace.create` (path must exist there).
    const fakeApi = (req, res, path) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', async () => {
        const message = JSON.parse(body)
        const answer = result => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result })) }
        if (path === '/api/workspace/list') return answer({ ok: true, value: { items: remoteWorkspaces, archivedSessionIds: [] } })
        if (path === '/api/workspace/create') {
          const target = message.payload.args.request.path
          try {
            if (!(await stat(target)).isDirectory()) throw new Error('not a directory')
          } catch (error) {
            return answer({ ok: false, error: { code: 'workspace/invalid-path', message: `cannot create a Workspace at "${target}": ${error.message}`, details: {} } })
          }
          let view = remoteWorkspaces.find(candidate => candidate.path === target)
          if (view === undefined) {
            view = { workspaceId: `ws-${String(remoteWorkspaces.length + 1)}`, path: target, title: target.split('/').pop(), sessionIds: [], createdAt: new Date().toISOString() }
            remoteWorkspaces.push(view)
          }
          return answer({ ok: true, value: { workspace: view, created: true } })
        }
        if (path === '/api/session/list') return answer({ ok: true, value: { items: [] } })
        answer({ ok: false, error: { code: 'gateway/arguments-invalid', message: `unknown method ${path}`, details: {} } })
      })
    }
    remote = fakeContext({ requestRejection: () => undefined, fakeApi })
    remotePort = await remote.listen()
    apply(remote.ctx, { routePrefix: '/remote', stateFile: join(root, 'remote-state.json'), servers: [] })

    local = fakeContext({ requestRejection: () => undefined })
    localPort = await local.listen()
    apply(local.ctx, { routePrefix: '/remote', stateFile: join(root, 'local-state.json'), servers: [] })
  })
  after(async () => {
    await local.close()
    await remote.close()
    await rm(root, { recursive: true, force: true })
  })

  it('fs.inspect answers for the host it runs on (the remote resolves ~ against ITS home)', async () => {
    const result = await control(remotePort, 'fs.inspect', { path: '/definitely/not/here' })
    assert.equal(result.ok, true)
    assert.deepEqual([result.value.kind, result.value.resolved], ['missing', '/definitely/not/here'])
  })

  it('servers.inspectPath goes local → egress → remote fs.inspect, with a short-name input normalized', async () => {
    const url = `127.0.0.1:${String(remotePort)}` // no scheme: normalized to http://…/
    const existing = await control(localPort, 'servers.inspectPath', { url, path: join(remoteHome, 'projects', 'ex') })
    assert.equal(existing.ok, true, JSON.stringify(existing))
    assert.equal(existing.value.kind, 'missing')
    assert.deepEqual(existing.value.entries.map(entry => entry.name), ['existing'])
    const dir = await control(localPort, 'servers.inspectPath', { url, path: join(remoteHome, 'projects', 'existing') })
    assert.equal(dir.value.kind, 'directory')
  })

  it('workspaces.add with create makes the directory on the remote, then registers the workspace there', async () => {
    const url = `http://127.0.0.1:${String(remotePort)}/`
    const target = join(remoteHome, 'projects', 'brand-new')
    const refused = await control(localPort, 'workspaces.add', { url, remotePath: target, title: 'nope' })
    assert.equal(refused.ok, false)
    assert.match(refused.error.message, /cannot create a Workspace/)
    const added = await control(localPort, 'workspaces.add', { url, remotePath: target, create: true, title: 'brand-new' })
    assert.equal(added.ok, true, JSON.stringify(added))
    assert.equal(added.value.workspace.remotePath, target)
    assert.equal((await stat(target)).isDirectory(), true)
    const state = JSON.parse(await readFile(join(root, 'local-state.json'), 'utf8'))
    assert.equal(state.workspaces.length, 1)
    assert.equal(state.servers[0].url, url)
  })

  it('a remote without the plugin makes servers.inspectPath report fs-unavailable', async () => {
    const bare = createServer((req, res) => { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<h1>no</h1>') })
    const port = await new Promise(resolve => bare.listen(0, '127.0.0.1', () => resolve(bare.address().port)))
    try {
      const result = await control(localPort, 'servers.inspectPath', { url: `localhost:${String(port)}`, path: '~/x' })
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'remote-workspaces/fs-unavailable')
    } finally {
      await new Promise(resolve => { bare.closeAllConnections?.(); bare.close(() => resolve()) })
    }
  })
})
