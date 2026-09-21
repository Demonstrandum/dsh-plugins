// node --experimental-strip-types --test: pure logic + the wrapper against a fake ctx.modules.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classify, graphRows } from '../src/client/detect.ts'
import { install } from '../src/client/index.ts'

const boot = [
  { id: '@deepseek-ai/dsh-typert-registry', rev: 'a6d1f937258924bf-0' },
  { id: '@deepseek-ai/dsh-api-gateway', rev: 'a6d1f937258924bf-1' },
  { id: 'tali-settings-shortcut', rev: 'a6d1f937258924bf-2' },
]
const known = () => new Map(boot.map(row => [row.id, row.rev]))
const graph = (entries: unknown) => ({ rev: 'x', entries, batches: [] })

test('graphRows reads {entries:[{id,rev}]} and ignores junk', () => {
  assert.deepEqual(graphRows(graph([...boot, { id: 3 }, null, { id: 'x' }])), boot)
  assert.deepEqual(graphRows(undefined), [])
  assert.deepEqual(graphRows({ entries: 'nope' }), [])
})

test('identical graph (the first SSE frame after boot) is unchanged', () => {
  assert.deepEqual(classify(known(), boot), { kind: 'unchanged', common: 3 })
})

test('a new host process re-mints every rev → restart', () => {
  const restarted = boot.map((row, i) => ({ id: row.id, rev: `d2901a337faae82b-${String(i)}` }))
  assert.deepEqual(classify(known(), restarted), { kind: 'restart', changed: 3 })
})

test('one rebuilt bundle (content-hash rev) → partial, not restart', () => {
  const rows = boot.map(row => row.id === 'tali-settings-shortcut' ? { ...row, rev: '0f3c9a1b2d4e' } : row)
  assert.deepEqual(classify(known(), rows), { kind: 'partial', changed: 1, common: 3 })
})

test('rows only added or removed keep the verdict unchanged', () => {
  assert.deepEqual(classify(known(), [...boot, { id: 'new-plugin', rev: 'a6d1f937258924bf-3' }]), { kind: 'unchanged', common: 3 })
  assert.deepEqual(classify(known(), boot.slice(0, 2)), { kind: 'unchanged', common: 2 })
})

test('no rows in common → unrelated (never a reload)', () => {
  assert.deepEqual(classify(known(), [{ id: 'other', rev: 'z' }]), { kind: 'unrelated' })
  assert.deepEqual(classify(new Map(), boot), { kind: 'unrelated' })
})

function fakeModules() {
  const calls: string[] = []
  const entries = {
    async sync(_graph: unknown) { calls.push('sync') },
    async reload(id: string, rev: string) { calls.push(`reload ${id} ${rev}`) },
  }
  return { modules: { manifest: { modules: boot }, entries }, calls, entries }
}

test('install: a restart graph reloads the page once and never reaches entries.sync', async () => {
  const { modules, calls } = fakeModules()
  let reloads = 0
  install(modules, () => { reloads += 1 })
  const restarted = graph(boot.map((row, i) => ({ id: row.id, rev: `ffffffffffffffff-${String(i)}` })))
  await modules.entries.sync(restarted)
  await modules.entries.sync(restarted)
  assert.equal(reloads, 1)
  assert.deepEqual(calls, [])
})

test('install: unchanged and partial graphs pass through and update the revision table', async () => {
  const { modules, calls, entries } = fakeModules()
  let reloads = 0
  const installed = install(modules, () => { reloads += 1 })
  await modules.entries.sync(graph(boot))
  const partial = boot.map(row => row.id === 'tali-settings-shortcut' ? { ...row, rev: 'hash1' } : row)
  await modules.entries.sync(graph(partial))
  assert.equal(installed.known.get('tali-settings-shortcut'), 'hash1')
  // The same rows again are now "unchanged", not a restart.
  await modules.entries.sync(graph(partial))
  assert.equal(reloads, 0)
  assert.deepEqual(calls, ['sync', 'sync', 'sync'])
  // rebuilt frames keep the table current too
  await modules.entries.reload('@deepseek-ai/dsh-api-gateway', 'hash2')
  assert.equal(installed.known.get('@deepseek-ai/dsh-api-gateway'), 'hash2')
  assert.equal(calls.at(-1), 'reload @deepseek-ai/dsh-api-gateway hash2')
  installed.dispose()
  assert.equal(typeof entries.sync, 'function')
  await modules.entries.sync(graph(boot.map(row => ({ ...row, rev: 'new' }))))
  assert.equal(reloads, 0, 'after dispose the wrapper is gone')
})
