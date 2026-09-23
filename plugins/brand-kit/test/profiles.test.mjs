import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeConfig } from '../index.js'
import { ProfileStore, portableProfile, resolveProfile } from '../profiles.mjs'
import * as fflate from 'fflate'

const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')
const woff = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1, 2, 3])

function fresh() { return new ProfileStore(mkdtempSync(join(tmpdir(), 'brand-profiles-')), normalizeConfig) }

test('empty store: no profiles, row config active', () => {
  const store = fresh()
  assert.deepEqual(store.list(), [])
  assert.equal(store.active(), '')
  assert.throws(() => store.setActive('nope'), /no profile named/)
})

test('upload assets, write, read, resolve, apply', () => {
  const store = fresh()
  store.putAsset('Acme', 'mark', 'mark.svg', svg)
  store.putAsset('Acme', 'font', 'Face.woff2', woff)
  const saved = store.write('Acme', { name: 'Acme', mark: 'mark.svg', accent: '#7678ed', fonts: [{ file: 'Face.woff2', family: 'Face', weight: 300 }], brandFont: { family: 'Face' } })
  assert.equal(saved.config.mark, join(store.root, 'Acme', 'mark.svg'))
  assert.equal(saved.config.fontsDir, join(store.root, 'Acme'))
  assert.deepEqual(store.list(), ['Acme'])
  store.setActive('Acme')
  assert.equal(store.active(), 'Acme')
  assert.deepEqual(portableProfile(saved.config).fonts, [{ file: 'Face.woff2', family: 'Face', weight: 300, style: 'normal' }])
  assert.equal(portableProfile(saved.config).mark, 'mark.svg')
})

test('write validates before touching profile.json', () => {
  const store = fresh()
  store.putAsset('Bad', 'mark', 'mark.svg', svg)
  assert.throws(() => store.write('Bad', { accent: 'blue' }), /accent must be/)
  assert.equal(readFileSync(join(store.root, 'Bad', 'profile.json'), 'utf8'), '{}\n')
  assert.throws(() => store.write('Bad', { mark: '../x.svg' }), /file name inside the profile/)
  assert.throws(() => store.write('Bad', { fonts: [{ file: 'missing.woff2', family: 'F' }] }), /font file not found/)
  assert.throws(() => store.putAsset('Bad', 'font', 'evil.svg', svg), /font file must be named/)
  assert.throws(() => store.write('..', {}), /profile name must be/)
})

test('duplicate, rename, delete keep the active pointer sane', () => {
  const store = fresh()
  store.putAsset('A', 'mark', 'm.svg', svg)
  store.write('A', { name: 'A', mark: 'm.svg' })
  store.duplicate('A', 'B')
  assert.ok(existsSync(join(store.root, 'B', 'm.svg')))
  assert.equal(store.read('B').config.name, 'A')
  store.setActive('B')
  store.rename('B', 'C')
  assert.equal(store.active(), '') // stale pointer resolves to '' until re-set
  store.setActive('C')
  store.delete('C')
  assert.deepEqual(store.list(), ['A'])
  assert.equal(store.active(), '')
})

test('export → import round trip; bad archives leave nothing behind', () => {
  const a = fresh()
  a.putAsset('Src', 'mark', 'mark.svg', svg)
  a.putAsset('Src', 'font', 'Face.woff2', woff)
  a.write('Src', { name: 'Src', mark: 'mark.svg', fonts: [{ file: 'Face.woff2', family: 'Face' }], headline: 'Hi' })
  const zip = a.exportZip('Src')
  const b = fresh()
  const imported = b.importZip('Dst', zip)
  assert.equal(imported.config.headline, 'Hi')
  assert.equal(readFileSync(join(b.root, 'Dst', 'Face.woff2')).length, woff.length)
  assert.throws(() => b.importZip('Dst', zip), /already exists/)
  assert.throws(() => b.importZip('Junk', new Uint8Array([1, 2, 3])), /not a zip/)
  assert.ok(!existsSync(join(b.root, 'Junk')))
  // profile.json naming a file the archive lacks → rejected, staging removed
  const broken = fflate.zipSync({ 'profile.json': new TextEncoder().encode(JSON.stringify({ mark: 'nope.svg' })) })
  assert.throws(() => b.importZip('Broken', broken), /mark file not found/)
  assert.ok(!existsSync(join(b.root, 'Broken')))
  assert.equal(readFileSync(join(b.root, 'Dst', 'profile.json'), 'utf8').includes('"headline": "Hi"'), true)
})

test('resolveProfile rejects a path as the mark', () => {
  assert.throws(() => resolveProfile('/tmp/x', { mark: 'a/b.svg' }), /file name inside the profile/)
  assert.equal(resolveProfile('/tmp/x', { mark: 'm.svg', fonts: [{ file: 'f.woff2', family: 'F' }] }).fontsDir, '/tmp/x')
})
