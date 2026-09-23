import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accentStyle, brandStyle, clientPayload, normalizeConfig } from '../index.js'

const dir = mkdtempSync(join(tmpdir(), 'brand-kit-'))
writeFileSync(join(dir, 'mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
writeFileSync(join(dir, 'Face.woff2'), '')

test('empty profile is the shipped look', () => {
  const config = normalizeConfig(undefined)
  assert.equal(config.name, '')
  assert.equal(config.mark, '')
  assert.equal(brandStyle(config), '')
  assert.deepEqual(clientPayload(config), { name: '', headline: '', turnStatus: '', mark: null })
})

test('full profile (resolved form): files, faces, payload', () => {
  const config = normalizeConfig({
    name: 'Acme', mark: join(dir, 'mark.svg'), headline: 'Hello', turnStatus: 'Working...', hidePreviewBadge: true,
    accent: '#7678ed', fontsDir: dir, fonts: [{ file: 'Face.woff2', family: 'Face', weight: 300 }],
    brandFont: { family: '"Face", serif', weight: 300, size: 22, offsetY: -1 }, headlineFont: { family: 'Face', size: 32, lineHeight: 36 },
  })
  const css = brandStyle(config)
  assert.match(css, /@font-face\{font-family:"Face";font-weight:300;.*src:url\(\.\/api\/brand-kit\/asset\?s=&k=font&f=Face\.woff2\)/)
  assert.match(css, /\.brand-kit-name\{font-family:"Face", serif;white-space:nowrap;font-weight:300;font-size:22px;.*translateY\(-1px\)/)
  assert.match(css, /\.brand-kit-mark\{.*mask:url\(\.\/api\/brand-kit\/asset\?s=&k=mark&f=mark\.svg\)/)
  assert.match(css, /_previewBadge"\]\{display:none\}/)
  assert.match(css, /--dsw-static-deepseek-500:#7678ed;--dsw-static-blue-500:#7678ed;/)
  assert.deepEqual(clientPayload(config).mark, { url: './api/brand-kit/asset?s=&k=mark&f=mark.svg', mode: 'mask' })
  assert.match(brandStyle(config, 'Acme 1'), /asset\?s=Acme\+1&k=font/)
})

test('accent ramp derives its 600 step unless given', () => {
  assert.match(accentStyle('#123456', ''), /deepseek-600:color-mix\(in oklab,#123456 85%,black\)/)
  assert.match(accentStyle('#123456', '#0000ff'), /deepseek-600:#0000ff;/)
})

test('rejects unsafe or missing values', () => {
  assert.throws(() => normalizeConfig({ name: 'a"b' }), /name must be/)
  assert.throws(() => normalizeConfig({ accent: 'blue' }), /accent must be/)
  assert.throws(() => normalizeConfig({ mark: 'relative.svg' }), /absolute/)
  assert.throws(() => normalizeConfig({ mark: join(dir, 'missing.svg') }), /not found/)
  assert.throws(() => normalizeConfig({ fonts: [{ file: 'Face.woff2', family: 'Face' }] }), /without fontsDir/)
  assert.throws(() => normalizeConfig({ fontsDir: dir, fonts: [{ file: '../x.woff2', family: 'Face' }] }), /file must be/)
  assert.throws(() => normalizeConfig({ markMode: 'svg' }), /markMode/)
  assert.throws(() => normalizeConfig({ brandFont: { size: 500 } }), /size must be/)
})
