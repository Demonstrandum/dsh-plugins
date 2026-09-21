import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { loadState, parseUserList, saveState } from '../state.mjs'
import { normalizeMountPath, routeUrl, isTailscaleAddress, selfIdentity } from '../tailscale.mjs'

describe('self identity', () => {
  const status = {
    Self: { UserID: 6481056089841494, TailscaleIPs: ['100.78.174.43', 'fd7a:115c:a1e0::e33a:ae2c'], Tags: null },
    User: { '6481056089841494': { LoginName: 'the maintainer@example.com' }, '7159215974098032': { LoginName: 'tagged-devices' } },
  }
  it('reads the node user login (lower-cased) and its tailnet addresses', () => {
    assert.deepEqual(selfIdentity(status), { selfLogin: 'user@example.com', selfAddresses: ['100.78.174.43', 'fd7a:115c:a1e0::e33a:ae2c'] })
  })
  it('has no login for a tagged node', () => {
    const tagged = { ...status, Self: { ...status.Self, UserID: 7159215974098032, Tags: ['tag:research'] } }
    assert.equal(selfIdentity(tagged).selfLogin, undefined)
    assert.equal(selfIdentity({}).selfLogin, undefined)
    assert.deepEqual(selfIdentity(undefined).selfAddresses, [])
  })
})

describe('state', () => {
  it('parses comma/space separated logins, lower-cased and unique', () => {
    assert.deepEqual(parseUserList(' Alice@Example.com, bob@github ,alice@example.com\n carol@x'), ['alice@example.com', 'bob@github', 'carol@x'])
    assert.deepEqual(parseUserList(['A@b', '"quoted"']), ['a@b'])
    assert.deepEqual(parseUserList(undefined), [])
  })

  it('creates a tokened disabled state on first load and round-trips with mode 0600', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tailscale-remote-'))
    const file = join(dir, 'state.json')
    const first = await loadState(file)
    assert.equal(first.enabled, false)
    assert.match(first.token, /^[A-Za-z0-9_-]{32}$/)
    assert.equal(((await stat(file)).mode & 0o777), 0o600)
    first.enabled = true
    first.allowedUsers = ['alice@example.com']
    await saveState(file, first)
    const second = await loadState(file)
    assert.deepEqual(second, first)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).token, first.token)
  })
})

describe('tailscale helpers', () => {
  it('normalizes mounts and builds the route URL with a trailing slash', () => {
    assert.equal(normalizeMountPath('dsh/'), '/dsh')
    assert.equal(normalizeMountPath('/'), '/')
    assert.equal(routeUrl('node.tail.ts.net', 443, '/dsh'), 'https://node.tail.ts.net/dsh/')
    assert.equal(routeUrl('node.tail.ts.net', 8443, '/'), 'https://node.tail.ts.net:8443/')
  })

  it('recognizes tailnet addresses', () => {
    assert.equal(isTailscaleAddress('100.114.226.21'), true)
    assert.equal(isTailscaleAddress('::ffff:100.64.0.1'), true)
    assert.equal(isTailscaleAddress('100.128.0.1'), false)
    assert.equal(isTailscaleAddress('fd7a:115c:a1e0::4101:e2ba'), true)
    assert.equal(isTailscaleAddress('127.0.0.1'), false)
  })
})

describe('direct-remote Dock app targets', async () => {
  const { parseRemoteTarget, resolveTailnetHost, remoteAppName, remoteInstance, titleCase } = await import('../dock-app.mjs')
  const status = {
    Self: { DNSName: 'air.tail1234.ts.net.' },
    Peer: { a: { DNSName: 'studio.tail1234.ts.net.' }, b: { DNSName: 'Box.tail1234.ts.net.' } },
  }
  it('parses [user@]host[/path]', () => {
    assert.deepEqual(parseRemoteTarget('me@studio/dsh/me'), { host: 'studio', path: '/dsh/me' })
    assert.deepEqual(parseRemoteTarget('studio'), { host: 'studio', path: '/dsh' })
    assert.deepEqual(parseRemoteTarget('studio/'), { host: 'studio', path: '/' })
    assert.deepEqual(parseRemoteTarget('https://studio.tail1234.ts.net/dsh/me/'), { host: 'studio.tail1234.ts.net', path: '/dsh/me', url: 'https://studio.tail1234.ts.net/dsh/me/' })
    assert.throws(() => parseRemoteTarget(''))
    assert.throws(() => parseRemoteTarget('bad host/x'))
  })
  it('resolves a bare label through tailscale status (self, peers, then the tailnet suffix)', () => {
    assert.equal(resolveTailnetHost('studio', status), 'studio.tail1234.ts.net')
    assert.equal(resolveTailnetHost('box', status), 'Box.tail1234.ts.net')
    assert.equal(resolveTailnetHost('air', status), 'air.tail1234.ts.net')
    assert.equal(resolveTailnetHost('other', status), 'other.tail1234.ts.net')
    assert.equal(resolveTailnetHost('x.example.com', status), 'x.example.com')
    assert.throws(() => resolveTailnetHost('studio', {}))
  })
  it('names and instances', () => {
    assert.equal(titleCase('studio-two'), 'Studio Two')
    assert.equal(remoteAppName('studio.tail1234.ts.net'), 'DSH Studio')
    assert.equal(remoteInstance('studio.tail1234.ts.net', '/dsh/me'), 'remote-studio-dsh-me')
    assert.equal(remoteInstance('studio', '/'), 'remote-studio')
  })
})
