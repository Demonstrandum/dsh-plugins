/**
 * tali-brand-kit — brand profiles on disk.
 *
 * A profile is a directory `$DSH_HOME/brand-profiles/<name>/` holding
 * `profile.json` plus the assets it names (mark file, font files). The JSON
 * is the plugin's config in *portable* form: `mark` and `fonts[].file` are
 * bare file names inside the directory and there is no `fontsDir`, so a
 * profile can be zipped, moved to another machine and imported unchanged.
 * {@link resolveProfile} turns it into the absolute-path config the rest of
 * the plugin consumes (and validates it with the same `normalizeConfig`).
 *
 * `state.json` in the profiles directory records which profile is active
 * (`{ active: '<name>' }`; absent or '' = the plugin row's own config). The
 * active profile is read at every page render, so applying one needs no
 * restart — just a reload of the page.
 *
 * Export/import are zip archives (fflate) of the directory: `profile.json`
 * at the root plus flat asset files. Import accepts only file names matching
 * {@link FILE_NAME} with known extensions, caps the archive and each file,
 * and validates the resolved config before anything is written.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { unzipSync, zipSync } from 'fflate'

/** Profile names: what a directory can be called and a UI can show. */
export const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,40}$/
/** Asset file names inside a profile (no paths, no hidden files). */
export const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/
export const MARK_EXTENSIONS = ['.svg', '.png']
export const FONT_EXTENSIONS = ['.woff2', '.woff', '.ttf', '.otf']
/** Import/upload caps: the archive as a whole and any single file. */
export const MAX_ARCHIVE_BYTES = 24 * 1024 * 1024
export const MAX_FILE_BYTES = 8 * 1024 * 1024

/** `$DSH_HOME/brand-profiles` (DSH_HOME defaults to ~/.dsh, as the CLI does). */
export function defaultProfilesDir() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'brand-profiles')
}

function fail(message) { throw new Error(`brand-kit: ${message}`) }

/**
 * @param {string} name - candidate profile name.
 * @returns {string} the name, when valid.
 */
export function assertProfileName(name) {
  if (!PROFILE_NAME.test(name)) fail(`profile name must be 1-41 of letters, digits, space, '.', '_', '-' and start alphanumeric, got ${JSON.stringify(name)}`)
  return name
}

/**
 * Portable profile JSON → absolute-path config input (still to be run through `normalizeConfig`).
 * @param {string} dir - the profile directory.
 * @param {Record<string, unknown>} json - parsed profile.json.
 * @returns {Record<string, unknown>} config input with absolute `mark` / `fontsDir`.
 */
export function resolveProfile(dir, json) {
  const input = { ...json }
  const mark = typeof input.mark === 'string' ? input.mark : ''
  if (mark !== '' && !FILE_NAME.test(mark)) fail(`profile mark must be a file name inside the profile, got ${JSON.stringify(mark)}`)
  input.mark = mark === '' ? '' : join(dir, mark)
  const fonts = Array.isArray(input.fonts) ? input.fonts : []
  input.fontsDir = fonts.length === 0 ? '' : dir
  return input
}

/**
 * Absolute-path config → portable profile JSON (file names only). Assets are
 * NOT copied here; see {@link ProfileStore.createFromConfig}.
 * @param {import('./index.js').BrandConfig} config - validated config.
 */
export function portableProfile(config) {
  const { fontsDir: _dir, ...rest } = config
  return { ...rest, mark: config.mark === '' ? '' : basename(config.mark) }
}

/** Filesystem-backed profile collection. */
export class ProfileStore {
  /**
   * @param {string} root - the profiles directory (created on first write).
   * @param {(input: unknown) => import('./index.js').BrandConfig} normalize - the plugin's config validator.
   */
  constructor(root, normalize) {
    this.root = root
    this.normalize = normalize
  }

  dirOf(name) { return join(this.root, assertProfileName(name)) }

  /** @returns {string[]} profile names, sorted. */
  list() {
    if (!existsSync(this.root)) return []
    return readdirSync(this.root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && PROFILE_NAME.test(entry.name) && existsSync(join(this.root, entry.name, 'profile.json')))
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b))
  }

  has(name) { return PROFILE_NAME.test(name) && existsSync(join(this.root, name, 'profile.json')) }

  /**
   * Read and validate one profile.
   * @param {string} name - profile name.
   * @returns {{ name: string, dir: string, json: Record<string, unknown>, config: import('./index.js').BrandConfig }}
   */
  read(name) {
    const dir = this.dirOf(name)
    if (!existsSync(join(dir, 'profile.json'))) fail(`no profile named ${JSON.stringify(name)}`)
    let json
    try {
      json = JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8'))
    } catch (error) {
      fail(`profile ${name}: profile.json is not valid JSON (${error instanceof Error ? error.message : String(error)})`)
    }
    if (json === null || typeof json !== 'object' || Array.isArray(json)) fail(`profile ${name}: profile.json must be an object`)
    const config = this.normalize(resolveProfile(dir, json))
    return { name, dir, json, config }
  }

  /**
   * Validate and write a profile's JSON (assets must already be in place).
   * @param {string} name - profile name (directory created when absent).
   * @param {Record<string, unknown>} json - portable profile JSON.
   */
  write(name, json) {
    const dir = this.dirOf(name)
    if (json === null || typeof json !== 'object' || Array.isArray(json)) fail('profile must be an object')
    mkdirSync(dir, { recursive: true })
    this.normalize(resolveProfile(dir, json)) // throws before anything is written
    writeFileSync(join(dir, 'profile.json'), `${JSON.stringify(json, null, 2)}\n`)
    return this.read(name)
  }

  /**
   * A new profile from an absolute-path config (the plugin row's, or another
   * profile's): assets are copied into the new directory.
   * @param {string} name - new profile name (must not exist).
   * @param {import('./index.js').BrandConfig} config - validated config.
   */
  createFromConfig(name, config) {
    const dir = this.dirOf(name)
    if (this.has(name)) fail(`a profile named ${JSON.stringify(name)} already exists`)
    mkdirSync(dir, { recursive: true })
    if (config.mark !== '') copyFileSync(config.mark, join(dir, basename(config.mark)))
    for (const font of config.fonts) copyFileSync(join(config.fontsDir, font.file), join(dir, font.file))
    return this.write(name, portableProfile(config))
  }

  duplicate(from, to) { return this.createFromConfig(to, this.read(from).config) }

  rename(from, to) {
    const source = this.dirOf(from)
    const target = this.dirOf(to)
    if (!this.has(from)) fail(`no profile named ${JSON.stringify(from)}`)
    if (existsSync(target)) fail(`a profile named ${JSON.stringify(to)} already exists`)
    renameSync(source, target)
    return this.read(to)
  }

  delete(name) {
    const dir = this.dirOf(name)
    if (!this.has(name)) fail(`no profile named ${JSON.stringify(name)}`)
    rmSync(dir, { recursive: true, force: true })
  }

  /**
   * Store an uploaded asset in a profile directory (mark or font file).
   * @param {string} name - profile name (created when absent, with an empty profile).
   * @param {'mark' | 'font'} kind - asset kind (decides the accepted extensions).
   * @param {string} file - file name inside the profile.
   * @param {Uint8Array} bytes - contents.
   * @returns {string} the stored file name.
   */
  putAsset(name, kind, file, bytes) {
    const dir = this.dirOf(name)
    const ext = extname(file).toLowerCase()
    const allowed = kind === 'mark' ? MARK_EXTENSIONS : FONT_EXTENSIONS
    if (!FILE_NAME.test(file) || !allowed.includes(ext)) fail(`${kind} file must be named like a.b with one of ${allowed.join(', ')}, got ${JSON.stringify(file)}`)
    if (bytes.byteLength === 0) fail('empty upload')
    if (bytes.byteLength > MAX_FILE_BYTES) fail(`file too large (${String(bytes.byteLength)} bytes; limit ${String(MAX_FILE_BYTES)})`)
    mkdirSync(dir, { recursive: true })
    if (!existsSync(join(dir, 'profile.json'))) writeFileSync(join(dir, 'profile.json'), '{}\n')
    writeFileSync(join(dir, file), bytes)
    return file
  }

  /**
   * Zip of the profile directory: profile.json + flat assets.
   * @param {string} name - profile name.
   * @returns {Uint8Array} archive bytes.
   */
  exportZip(name) {
    const { dir, json } = this.read(name)
    /** @type {Record<string, Uint8Array>} */
    const files = { 'profile.json': new TextEncoder().encode(`${JSON.stringify(json, null, 2)}\n`) }
    for (const entry of readdirSync(dir)) {
      if (entry === 'profile.json' || !FILE_NAME.test(entry)) continue
      const path = join(dir, entry)
      if (statSync(path).isFile()) files[entry] = new Uint8Array(readFileSync(path))
    }
    return zipSync(files, { level: 6 })
  }

  /**
   * Create a profile from an archive made by {@link exportZip} (or by hand:
   * profile.json + assets at the root; a single top-level folder is tolerated).
   * Nothing is written until the whole archive validated.
   * @param {string} name - new profile name (must not exist).
   * @param {Uint8Array} bytes - archive.
   */
  importZip(name, bytes) {
    if (this.has(name)) fail(`a profile named ${JSON.stringify(name)} already exists`)
    if (bytes.byteLength > MAX_ARCHIVE_BYTES) fail(`archive too large (${String(bytes.byteLength)} bytes; limit ${String(MAX_ARCHIVE_BYTES)})`)
    let entries
    try {
      entries = unzipSync(bytes)
    } catch (error) {
      fail(`not a zip archive (${error instanceof Error ? error.message : String(error)})`)
    }
    // Tolerate one wrapping folder ("<name>/profile.json").
    const keys = Object.keys(entries).filter(key => !key.endsWith('/') && !basename(key).startsWith('.') && !key.includes('__MACOSX'))
    const prefix = keys.includes('profile.json') ? '' : (keys.find(key => key.endsWith('/profile.json')) ?? '').replace(/profile\.json$/, '')
    if (!keys.includes(`${prefix}profile.json`)) fail('archive has no profile.json')
    /** @type {Record<string, Uint8Array>} */
    const files = {}
    for (const key of keys) {
      if (!key.startsWith(prefix)) continue
      const rel = key.slice(prefix.length)
      if (rel.includes('/')) fail(`unexpected nested entry ${JSON.stringify(key)}`)
      if (rel !== 'profile.json' && (!FILE_NAME.test(rel) || ![...MARK_EXTENSIONS, ...FONT_EXTENSIONS].includes(extname(rel).toLowerCase()))) fail(`unexpected file in archive: ${JSON.stringify(rel)}`)
      if (entries[key].byteLength > MAX_FILE_BYTES) fail(`${rel} too large`)
      files[rel] = entries[key]
    }
    let json
    try {
      json = JSON.parse(new TextDecoder().decode(files['profile.json']))
    } catch (error) {
      fail(`profile.json is not valid JSON (${error instanceof Error ? error.message : String(error)})`)
    }
    const dir = this.dirOf(name)
    // Validate against a staging directory so a bad archive leaves nothing behind.
    const staging = `${dir}.importing-${String(process.pid)}`
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    try {
      for (const [rel, data] of Object.entries(files)) writeFileSync(join(staging, rel), data)
      this.normalize(resolveProfile(staging, json))
      renameSync(staging, dir)
    } catch (error) {
      rmSync(staging, { recursive: true, force: true })
      throw error
    }
    return this.read(name)
  }

  // ---- active profile

  get stateFile() { return join(this.root, 'state.json') }

  /** @returns {string} the active profile name, '' for "the plugin row's config". */
  active() {
    try {
      const state = JSON.parse(readFileSync(this.stateFile, 'utf8'))
      const name = typeof state?.active === 'string' ? state.active : ''
      return this.has(name) ? name : ''
    } catch {
      return ''
    }
  }

  /** @param {string} name - profile name or '' to fall back to the row config. */
  setActive(name) {
    if (name !== '') { assertProfileName(name); if (!this.has(name)) fail(`no profile named ${JSON.stringify(name)}`) }
    mkdirSync(this.root, { recursive: true })
    writeFileSync(this.stateFile, `${JSON.stringify({ active: name }, null, 2)}\n`)
  }
}
