import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { expandHome, inspectPath, isPlainHttpHost, makeDirectory, normalizeRemoteInput, suffixFromKnownUrls } from '../resolve.mjs'

const SUFFIX = { magicDnsSuffix: 'tail1234.ts.net' }

describe('normalizeRemoteInput', () => {
  it('accepts the short forms and adds scheme, MagicDNS suffix and trailing slash', async () => {
    const cases = [
      ['user@studio', 'https://studio.tail1234.ts.net/dsh/user/'],
      ['studio/dsh/user', 'https://studio.tail1234.ts.net/dsh/user/'],
      ['studio', 'https://studio.tail1234.ts.net/'],
      ['user@studio:8443', 'https://studio.tail1234.ts.net:8443/dsh/user/'],
      ['studio.tail1234.ts.net/dsh/user/', 'https://studio.tail1234.ts.net/dsh/user/'],
      ['https://studio.tail1234.ts.net/dsh/user', 'https://studio.tail1234.ts.net/dsh/user/'],
      ['https://studio/dsh/user/', 'https://studio.tail1234.ts.net/dsh/user/'],
      ['box.example.com:8443/dsh', 'https://box.example.com:8443/dsh/'],
      ['localhost:3082/x', 'http://localhost:3082/x/'],
      ['127.0.0.1:3082', 'http://127.0.0.1:3082/'],
      ['[::1]:3080/dsh', 'http://[::1]:3080/dsh/'],
      ['10.0.0.5:3080', 'http://10.0.0.5:3080/'],
      ['http://127.0.0.1:3082', 'http://127.0.0.1:3082/'],
      ['  user@studio  ', 'https://studio.tail1234.ts.net/dsh/user/'],
    ]
    for (const [input, expected] of cases) assert.equal(await normalizeRemoteInput(input, SUFFIX), expected, input)
  })

  it('consults the suffix source only for dot-less hosts, and leaves such a host bare without one', async () => {
    let asked = 0
    const lazy = { magicDnsSuffix: async () => { asked += 1; return 'tail1234.ts.net' } }
    assert.equal(await normalizeRemoteInput('https://node.tail1234.ts.net/dsh/', lazy), 'https://node.tail1234.ts.net/dsh/')
    assert.equal(await normalizeRemoteInput('localhost:3082', lazy), 'http://localhost:3082/')
    assert.equal(asked, 0)
    assert.equal(await normalizeRemoteInput('user@studio', lazy), 'https://studio.tail1234.ts.net/dsh/user/')
    assert.equal(asked, 1)
    assert.equal(await normalizeRemoteInput('user@studio', {}), 'https://studio/dsh/user/')
  })

  it('rejects what is not a server address', async () => {
    for (const bad of ['', '   ', 'a b', 'ftp://x/', 'http://', ':3082']) {
      await assert.rejects(() => normalizeRemoteInput(bad, SUFFIX), undefined, JSON.stringify(bad))
    }
  })

  it('isPlainHttpHost / suffixFromKnownUrls', () => {
    assert.equal(isPlainHttpHost('localhost'), true)
    assert.equal(isPlainHttpHost('127.0.0.1'), true)
    assert.equal(isPlainHttpHost('[::1]'), true)
    assert.equal(isPlainHttpHost('studio'), false)
    assert.equal(isPlainHttpHost('studio.tail1234.ts.net'), false)
    assert.equal(suffixFromKnownUrls(['http://127.0.0.1:3082/', 'https://node.tail1234.ts.net/dsh/']), 'tail1234.ts.net')
    assert.equal(suffixFromKnownUrls(['http://127.0.0.1:3082/', 'not a url']), undefined)
  })
})

describe('inspectPath / makeDirectory', () => {
  let home
  before(async () => {
    home = await mkdtemp(join(tmpdir(), 'rws-home-'))
    await mkdir(join(home, 'projects', 'alpha'), { recursive: true })
    await mkdir(join(home, 'projects', 'alps'))
    await mkdir(join(home, 'projects', '.hidden'))
    await mkdir(join(home, 'Music'))
    await writeFile(join(home, 'notes.txt'), 'x')
    await symlink(join(home, 'Music'), join(home, 'projects', 'linked'))
    await writeFile(join(home, 'projects', 'file.txt'), 'x')
  })
  after(async () => { await rm(home, { recursive: true, force: true }) })

  it('expands ~ against the given home', () => {
    assert.equal(expandHome('~', '/h'), '/h')
    assert.equal(expandHome('~/x', '/h'), '/h/x')
    assert.equal(expandHome('/x', '/h'), '/x')
    assert.equal(expandHome('~x', '/h'), '~x')
  })

  it('reports an existing directory and completes the typed last segment over its siblings', async () => {
    const info = await inspectPath('~/projects/al', { home })
    assert.equal(info.home, home)
    assert.equal(info.resolved, join(home, 'projects', 'al'))
    assert.equal(info.kind, 'missing')
    assert.equal(info.creatable, true)
    assert.deepEqual(info.entries.map(entry => entry.name), ['alpha', 'alps'])
    const exact = await inspectPath('~/projects/alpha', { home })
    assert.equal(exact.kind, 'directory')
    assert.deepEqual(exact.entries.map(entry => entry.name), ['alpha'])
  })

  it('a trailing slash lists the children: directories and directory symlinks, no files, hidden only when asked', async () => {
    const info = await inspectPath('~/projects/', { home })
    assert.equal(info.kind, 'directory')
    assert.deepEqual(info.entries.map(entry => entry.name), ['alpha', 'alps', 'linked'])
    assert.equal(info.entries[0].path, join(home, 'projects', 'alpha'))
    const hidden = await inspectPath('~/projects/.h', { home })
    assert.deepEqual(hidden.entries.map(entry => entry.name), ['.hidden'])
  })

  it('a file, and a path under a file, are not creatable', async () => {
    const file = await inspectPath('~/notes.txt', { home })
    assert.equal(file.kind, 'file')
    assert.equal(file.creatable, false)
    const under = await inspectPath('~/notes.txt/deeper/x', { home, list: false })
    assert.equal(under.kind, 'missing')
    assert.equal(under.creatable, false)
    assert.equal(under.blocker, join(home, 'notes.txt'))
  })

  it('a deep missing path under a directory is creatable and makeDirectory makes it (idempotently)', async () => {
    const info = await inspectPath('~/new/deeper', { home, list: false })
    assert.deepEqual([info.kind, info.creatable], ['missing', true])
    assert.deepEqual(await makeDirectory('~/new/deeper', home), { path: join(home, 'new', 'deeper'), created: true })
    assert.deepEqual(await makeDirectory('~/new/deeper', home), { path: join(home, 'new', 'deeper'), created: false })
    await assert.rejects(() => makeDirectory('~/notes.txt', home), /not a directory/)
  })

  it('refuses relative paths; empty means home', async () => {
    await assert.rejects(() => inspectPath('projects', { home }), /absolute/)
    assert.equal((await inspectPath('', { home, list: false })).resolved, home)
  })
})
