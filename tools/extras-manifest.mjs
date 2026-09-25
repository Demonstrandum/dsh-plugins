#!/usr/bin/env node
/**
 * Read <repo>/extras/dsh-extras.yml (the optional private layer) and print one
 * tab-separated line per plugin:
 *
 *   <abs path>  <bundle>  <install yes|no>  <status>  <check script or ->
 *
 * `status` is the evaluated `requires` block: `-` when the plugin has none,
 * `ok` when at least one listed requirement is present on this machine, else
 * `missing:<what was looked for>`. Callers skip `missing:*` rows with that
 * text as the reason — no installer needs to know what the plugin is for.
 *
 *   requires:                      # ANY one present → ok
 *     app: [/Applications/Foo.app, com.example.foo]   # paths (exist) or bundle ids (LaunchServices, macOS)
 *     command: foo                 # on PATH
 *   check: bin/check-foo           # optional; the bootstrap runs it after the build and turns each stdout line into a to-do item
 *
 * Prints nothing (exit 0) when the submodule is absent or empty — callers treat
 * that as "no extras". The manifest is a fixed shape (see the extras README),
 * so a tiny reader beats shipping a YAML library to every tool that needs it.
 *
 *   node tools/extras-manifest.mjs [repo-root]
 */
import { existsSync, accessSync, constants } from 'node:fs'
import { readFileSync } from 'node:fs'
import { resolve, dirname, delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'

const root = resolve(process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'))
const extras = resolve(root, 'extras')
const file = resolve(extras, 'dsh-extras.yml')
if (!existsSync(file)) process.exit(0)

// --- minimal YAML subset: `plugins:` list of mappings, nested `requires:` mapping, flow or block lists.
const raw = readFileSync(file, 'utf8').split(/\r?\n/).map(l => l.replace(/\s+#.*$/, '').replace(/^\s*#.*$/, ''))
const lines = raw.map((text, i) => ({ text, indent: text.match(/^\s*/)[0].length, n: i })).filter(l => l.text.trim())
const scalar = v => {
  v = v.trim()
  if (/^\[.*\]$/.test(v)) return v.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean).map(unquote)
  return unquote(v)
}
const unquote = s => s.replace(/^(['"])(.*)\1$/, '$2')
const plugins = []
const top = lines.findIndex(l => l.indent === 0 && /^plugins:\s*$/.test(l.text))
if (top >= 0) {
  let i = top + 1
  while (i < lines.length && lines[i].indent > 0) {
    const l = lines[i]
    const item = /^\s*-\s+(\w+):\s*(.*)$/.exec(l.text)
    if (item) {
      const cur = { [item[1]]: scalar(item[2]) }
      const base = l.indent
      i++
      while (i < lines.length && lines[i].indent > base) {
        const f = /^\s*(\w+):\s*(.*)$/.exec(lines[i].text)
        if (!f) { i++; continue }
        if (f[2].trim() === '') {
          // nested mapping (or block list) until indentation drops back
          const nested = {}; const list = []; const ni = lines[i].indent; i++
          while (i < lines.length && lines[i].indent > ni) {
            const li = /^\s*-\s+(.*)$/.exec(lines[i].text)
            const nf = /^\s*(\w+):\s*(.*)$/.exec(lines[i].text)
            if (li) list.push(unquote(li[1]))
            else if (nf) {
              if (nf[2].trim() === '') { // block list under a nested key
                const arr = []; const ki = lines[i].indent; i++
                while (i < lines.length && lines[i].indent > ki) { const e = /^\s*-\s+(.*)$/.exec(lines[i].text); if (e) arr.push(unquote(e[1])); i++ }
                nested[nf[1]] = arr; continue
              }
              nested[nf[1]] = scalar(nf[2])
            }
            i++
          }
          cur[f[1]] = list.length ? list : nested
          continue
        }
        cur[f[1]] = scalar(f[2]); i++
      }
      plugins.push(cur)
      continue
    }
    i++
  }
}

// --- requirement evaluation
const asList = v => v == null ? [] : Array.isArray(v) ? v : [v]
const expand = p => p.startsWith('~') ? join(homedir(), p.slice(1)) : p
const onPath = cmd => (process.env.PATH ?? '').split(delimiter).some(d => { try { accessSync(join(d, cmd), constants.X_OK); return true } catch { return false } })
const bundleId = id => {
  if (process.platform !== 'darwin') return false
  try { execFileSync('osascript', ['-e', `id of application id "${id}"`], { stdio: 'ignore', timeout: 5000 }); return true } catch { return false }
}
const appPresent = a => (a.startsWith('/') || a.startsWith('~')) ? existsSync(expand(a)) : bundleId(a)
const status = req => {
  if (!req || typeof req !== 'object') return '-'
  const apps = asList(req.app), cmds = asList(req.command)
  if (!apps.length && !cmds.length) return '-'
  if (apps.some(appPresent) || cmds.some(onPath)) return 'ok'
  const what = [...apps.map(a => a.startsWith('/') ? a.split('/').pop() : a), ...cmds.map(c => `\`${c}\``)]
  return `missing:${what.join(' / ')}`
}

for (const p of plugins) {
  if (!p.path) continue
  const install = String(p.install ?? 'true') !== 'false'
  const check = p.check ? resolve(extras, p.check) : '-'
  process.stdout.write(`${resolve(extras, p.path)}\t${p.bundle ?? ''}\t${install ? 'yes' : 'no'}\t${status(p.requires)}\t${check}\n`)
}
