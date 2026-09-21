#!/usr/bin/env node
/**
 * Read <repo>/extras/dsh-extras.yml (the optional private layer) and print
 * one line per plugin: `<abs path>\t<bundle>\t<install yes|no>\t<requires-command or ->`.
 * Prints nothing (exit 0) when the submodule is absent or empty — callers treat
 * that as "no extras". The manifest is a fixed shape (see dsh-extras README),
 * so a tiny reader beats shipping a YAML library to every tool that needs it.
 *
 *   node tools/extras-manifest.mjs [repo-root]
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'))
const file = resolve(root, 'extras', 'dsh-extras.yml')
if (!existsSync(file)) process.exit(0)
const text = readFileSync(file, 'utf8')
const lines = text.split(/\r?\n/).map(l => l.replace(/\s+#.*$/, ''))
let inPlugins = false
let current = null
const plugins = []
const flush = () => { if (current) plugins.push(current); current = null }
for (const line of lines) {
  if (/^plugins:\s*$/.test(line)) { inPlugins = true; continue }
  if (/^\S/.test(line)) { flush(); inPlugins = false; continue }
  if (!inPlugins) continue
  const item = /^\s*-\s+(\w+):\s*(.*)$/.exec(line)
  if (item) { flush(); current = { [item[1]]: item[2].trim() }; continue }
  const field = /^\s+(\w+):\s*(.*)$/.exec(line)
  if (field && current) {
    if (field[1] === 'requires') { current.requires = {}; continue }
    if (current.requires && !('requiresDone' in current) && /^\s{6,}/.test(line)) { current.requires[field[1]] = field[2].trim(); continue }
    current[field[1]] = field[2].trim()
  }
}
flush()
for (const p of plugins) {
  if (!p.path) continue
  const install = String(p.install ?? 'true') !== 'false'
  process.stdout.write(`${resolve(root, 'extras', p.path)}\t${p.bundle ?? ''}\t${install ? 'yes' : 'no'}\t${p.requires?.command ?? '-'}\n`)
}
