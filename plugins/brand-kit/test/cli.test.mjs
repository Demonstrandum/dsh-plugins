import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cli = new URL('../cli.mjs', import.meta.url).pathname
const run = (dir, ...args) => execFileSync('node', [cli, ...args, '--dir', dir], { encoding: 'utf8' }).trim()

test('import a profile directory, apply, list, export, re-import zip', () => {
  const profiles = mkdtempSync(join(tmpdir(), 'bk-cli-'))
  const src = mkdtempSync(join(tmpdir(), 'bk-src-'))
  writeFileSync(join(src, 'mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  writeFileSync(join(src, 'profile.json'), JSON.stringify({ name: 'Acme', mark: 'mark.svg', accent: '#7678ed' }))
  mkdirSync(join(src, 'source')) // nested things are ignored, not copied
  assert.match(run(profiles, 'import', src, '--name', 'Acme', '--apply'), /imported Acme[\s\S]*active: Acme/)
  assert.equal(run(profiles, 'active'), 'Acme')
  assert.equal(run(profiles, 'list'), '* Acme')
  assert.ok(!existsSync(join(profiles, 'Acme', 'source')))
  const zip = join(src, 'acme.brand.zip')
  run(profiles, 'export', 'Acme', zip)
  assert.match(run(profiles, 'import', zip, '--name', 'Acme2'), /imported Acme2/)
  assert.equal(run(profiles, 'apply', 'none'), 'active: none (shipped look)')
  assert.throws(() => run(profiles, 'import', src, '--name', 'Acme'), /already exists/)
  assert.match(run(profiles, 'import', src, '--name', 'Acme', '--replace'), /imported Acme/)
})
