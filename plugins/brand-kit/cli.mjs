#!/usr/bin/env node
/**
 * tali-brand-kit — headless profile management, for provisioning scripts
 * (bootstrap, sync-host) and for a machine without the GUI open:
 *
 *   node cli.mjs list
 *   node cli.mjs import <file.brand.zip | directory> --name <name> [--apply] [--replace]
 *   node cli.mjs export <name> <out.brand.zip>
 *   node cli.mjs apply <name>          # '' or 'none' = the shipped look
 *   node cli.mjs active
 *
 * The profiles directory is $DSH_HOME/brand-profiles (DSH_HOME defaults to
 * ~/.dsh) or --dir <path>. Same store and validation as the plugin: what the
 * CLI accepts, the running server accepts, and the change is visible on the
 * next page load — no restart.
 */
import { existsSync, readFileSync, statSync, writeFileSync, readdirSync, copyFileSync, mkdirSync, rmSync, renameSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { normalizeConfig } from './index.js'
import { FILE_NAME, FONT_EXTENSIONS, MARK_EXTENSIONS, ProfileStore, assertProfileName, defaultProfilesDir, resolveProfile } from './profiles.mjs'
import { extname } from 'node:path'

const args = process.argv.slice(2)
const flags = {}
const positional = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a.startsWith('--')) {
    const key = a.slice(2)
    if (key === 'apply' || key === 'replace') flags[key] = true
    else flags[key] = args[++i]
  } else positional.push(a)
}
const [command, ...rest] = positional
const store = new ProfileStore(flags.dir === undefined ? defaultProfilesDir() : resolve(flags.dir), normalizeConfig)

/**
 * A profile from a directory laid out like an export (profile.json + flat
 * assets): validated in a staging directory, then moved into place.
 */
function importDir(name, dir) {
  if (!existsSync(join(dir, 'profile.json'))) throw new Error(`brand-kit: ${dir} has no profile.json`)
  const json = JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8'))
  const target = store.dirOf(name)
  const staging = `${target}.importing-${String(process.pid)}`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  try {
    for (const entry of readdirSync(dir)) {
      // Only assets travel (a README or the source artwork beside them stays behind).
      if (!FILE_NAME.test(entry) || !statSync(join(dir, entry)).isFile()) continue
      if (entry !== 'profile.json' && ![...MARK_EXTENSIONS, ...FONT_EXTENSIONS].includes(extname(entry).toLowerCase())) continue
      copyFileSync(join(dir, entry), join(staging, entry))
    }
    normalizeConfig(resolveProfile(staging, json))
    if (flags.replace) rmSync(target, { recursive: true, force: true })
    renameSync(staging, target)
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
  return store.read(name)
}

try {
  switch (command) {
    case 'list': {
      const active = store.active()
      for (const name of store.list()) console.log(`${name === active ? '* ' : '  '}${name}`)
      if (store.list().length === 0) console.log(`(no profiles in ${store.root})`)
      break
    }
    case 'active':
      console.log(store.active() || '(none — shipped look)')
      break
    case 'apply': {
      const name = rest[0] === undefined || rest[0] === 'none' ? '' : rest[0]
      store.setActive(name)
      console.log(name === '' ? 'active: none (shipped look)' : `active: ${name}`)
      break
    }
    case 'export': {
      const [name, out] = rest
      if (name === undefined || out === undefined) throw new Error('usage: export <name> <out.brand.zip>')
      writeFileSync(out, store.exportZip(name))
      console.log(`wrote ${out}`)
      break
    }
    case 'import': {
      const source = rest[0]
      if (source === undefined) throw new Error('usage: import <file.brand.zip | directory> --name <name> [--apply] [--replace]')
      const name = assertProfileName(flags.name ?? basename(source).replace(/\.brand\.zip$|\.zip$/i, ''))
      if (store.has(name) && !flags.replace) throw new Error(`brand-kit: a profile named ${JSON.stringify(name)} already exists (--replace to overwrite)`)
      if (statSync(source).isDirectory()) importDir(name, resolve(source))
      else {
        if (flags.replace && store.has(name)) store.delete(name)
        store.importZip(name, new Uint8Array(readFileSync(source)))
      }
      console.log(`imported ${name} → ${store.dirOf(name)}`)
      if (flags.apply) { store.setActive(name); console.log(`active: ${name}`) }
      break
    }
    default:
      console.error('usage: cli.mjs list | active | apply <name|none> | export <name> <out.brand.zip> | import <zip|dir> --name <name> [--apply] [--replace]  [--dir <profiles dir>]')
      process.exit(2)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
