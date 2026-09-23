/**
 * tali-brand-kit — host half.
 *
 * Re-brand the DSH Web GUI. Nothing brand-specific is built in, and the
 * plugin row carries no brand either: a brand is a PROFILE — a directory
 * `$DSH_HOME/brand-profiles/<name>/` holding `profile.json` plus the files it
 * names (mark, fonts) — managed from the bundle's card in the Plugins panel
 * (src/client/profiles-card.tsx), from `cli.mjs` for unattended provisioning,
 * or by dropping the directory in place. Exactly one profile is active
 * (`state.json`); none active = the shipped DSH look. The choice is read at
 * every page render, so applying is a page reload, not a restart. An active
 * profile that no longer validates is reported on the card and the shipped
 * look stands in.
 *
 * profile.json keys (every part optional; '' / absent = the shipped part):
 *   name              wordmark beside the sidebar mark. Occupying that cell
 *                     also removes the shipped product title AND the
 *                     build-version chip (they are one slot fallback).
 *   mark              file name (in the profile) of an SVG or PNG shown in
 *                     place of the whale — sidebar brand row, collapsed rail,
 *                     and the empty-session hero.
 *   markMode          'mask' (default): the file is a CSS mask filled with the
 *                     text colour, so a monochrome mark follows the theme like
 *                     the shipped whale; 'image': drawn as-is (full-colour logos).
 *   headline          empty-session headline (shipped: "Into the Unknown").
 *   turnStatus        running-turn label under the transcript (shipped: "Deep diving...").
 *   hidePreviewBadge  drop the "Preview" pill after the headline.
 *   accent            hex colour; re-points the shipped blue ramp
 *                     (`--dsw-static-deepseek-*`, and the `--dsw-static-blue-*`
 *                     steps feature CSS uses directly) so links, info buttons,
 *                     the business state colour, user bubbles, the active
 *                     sidebar row, tabs and the send button take the colour.
 *                     Lighter/darker steps are `color-mix()`ed from it.
 *   accentDark        optional hex for the 600 step (hover/pressed); derived otherwise.
 *   fonts             `@font-face` rows: [{ file, family, weight = 400, style = 'normal' }],
 *                     files in the profile directory.
 *   brandFont         wordmark typography: { family, weight, size, lineHeight, letterSpacing, offsetY }
 *                     (the shell's brand-name box is 24px tall, 18px/600).
 *   headlineFont      headline typography: { family, weight, size, lineHeight }
 *                     (shipped: 26px/32 weight 500 in the system stack).
 *
 * Plugin row config: `profilesDir` (absolute; '' = $DSH_HOME/brand-profiles).
 *
 * HOW. The browser half (src/client) occupies the shell's brand slots
 * (`sidebar.brand.mark`, `sidebar.brand.name`, `conversation.hero.brand.mark`
 * — all `single`, so registering replaces the fallback) and substitutes the
 * two locale-owned strings in place (they have no slot and their namespace
 * has one occupant). This half validates profiles (`normalizeConfig` over the
 * resolved, absolute-path form), serves the active profile's files on
 * `API_PATH/asset` (only files the profile names), and contributes one
 * `<style>` row (font faces, the classes the components wear, the card
 * chrome, the accent override) plus a `global` row the browser half reads at
 * apply time. URLs in the style row are document-relative
 * (`./api/brand-kit/…`), so they resolve under a path-stripping proxy mount
 * (`/dsh/`) as at the root. The accent block is `html>body[…]` so it outranks
 * the theme sheet, which the client loads AFTER index-inject rows (a
 * specificity tie would lose).
 */

import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join } from 'node:path'
import { ProfileStore, defaultProfilesDir } from './profiles.mjs'

export const name = 'brand-kit'

export const inject = ['connection']

/** The plugin's Fetch route (below /api): JSON API, `/asset` for files. Mirrored in src/client. */
export const API_PATH = '/api/brand-kit'

const FILE_TYPES = { '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.svg': 'image/svg+xml', '.png': 'image/png' }
const MARK_TYPES = ['.svg', '.png']

/** Shipped strings the browser half replaces (kept here so the README and the client agree). */
export const SHIPPED = { headline: 'Into the Unknown', turnStatus: 'Deep diving...' }

/** A string safe inside CSS `content`/JSON without escaping. */
const SAFE_TEXT = /^[^<>"\\]{0,80}$/
const HEX = /^#[0-9a-f]{6}$/i
/** A CSS font-family list: names, quotes, commas, hyphens. */
const FONT_FAMILY = /^[A-Za-z0-9 ,"'\-]{1,120}$/
const FONT_FILE = /^[A-Za-z0-9._-]+$/

function fail(message) { throw new Error(`brand-kit: ${message}`) }

function text(input, key) {
  if (input[key] === undefined) return ''
  const value = String(input[key])
  if (!SAFE_TEXT.test(value)) fail(`${key} must be at most 80 characters without < > " or backslash, got ${JSON.stringify(value)}`)
  return value
}

function hex(input, key) {
  if (input[key] === undefined || input[key] === '') return ''
  const value = String(input[key])
  if (!HEX.test(value)) fail(`${key} must be a #rrggbb colour, got ${JSON.stringify(value)}`)
  return value
}

function number(input, key, min, max, fallback) {
  if (input[key] === undefined) return fallback
  const value = Number(input[key])
  if (!Number.isFinite(value) || value < min || value > max) fail(`${key} must be a number in ${String(min)}..${String(max)}, got ${JSON.stringify(input[key])}`)
  return value
}

function typography(input, key, defaults) {
  const raw = input[key] === undefined ? {} : input[key]
  if (raw === null || typeof raw !== 'object') fail(`${key} must be an object`)
  const family = raw.family === undefined ? '' : String(raw.family)
  if (family !== '' && !FONT_FAMILY.test(family)) fail(`${key}.family must be a CSS font-family list, got ${JSON.stringify(family)}`)
  return {
    family,
    weight: number(raw, 'weight', 100, 900, defaults.weight),
    size: number(raw, 'size', 8, 96, defaults.size),
    lineHeight: number(raw, 'lineHeight', 8, 120, defaults.lineHeight),
    letterSpacing: number(raw, 'letterSpacing', -0.2, 1, defaults.letterSpacing),
    offsetY: number(raw, 'offsetY', -12, 12, defaults.offsetY),
  }
}

/**
 * @typedef {{ family: string, weight: number, size: number, lineHeight: number, letterSpacing: number, offsetY: number }} Typography
 * @typedef {{ file: string, family: string, weight: number, style: 'normal' | 'italic' }} FontFace
 * @typedef {{ name: string, mark: string, markMode: 'mask' | 'image', headline: string, turnStatus: string,
 *   hidePreviewBadge: boolean, accent: string, accentDark: string, fontsDir: string, fonts: FontFace[],
 *   brandFont: Typography, headlineFont: Typography }} BrandConfig
 */

/**
 * Fill in defaults and reject malformed values; missing files fail the load.
 * @param {unknown} raw - the row's config, possibly absent.
 * @returns {BrandConfig} normalized config.
 */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? /** @type {Record<string, any>} */ (raw) : {}
  const mark = input.mark === undefined ? '' : String(input.mark)
  if (mark !== '') {
    if (!isAbsolute(mark)) fail(`mark must be an absolute path, got ${JSON.stringify(mark)}`)
    if (!MARK_TYPES.includes(extname(mark).toLowerCase())) fail(`mark must be an .svg or .png file, got ${JSON.stringify(mark)}`)
    if (!existsSync(mark) || !statSync(mark).isFile()) fail(`mark file not found: ${mark}`)
  }
  const markMode = input.markMode === undefined ? 'mask' : input.markMode
  if (markMode !== 'mask' && markMode !== 'image') fail(`markMode must be 'mask' or 'image', got ${JSON.stringify(markMode)}`)
  const fontsDir = input.fontsDir === undefined ? '' : String(input.fontsDir)
  if (fontsDir !== '') {
    if (!isAbsolute(fontsDir)) fail(`fontsDir must be an absolute path, got ${JSON.stringify(fontsDir)}`)
    if (!existsSync(fontsDir) || !statSync(fontsDir).isDirectory()) fail(`fontsDir not found: ${fontsDir}`)
  }
  const fontsRaw = input.fonts === undefined ? [] : input.fonts
  if (!Array.isArray(fontsRaw)) fail('fonts must be a list of { file, family, weight?, style? }')
  const fonts = fontsRaw.map((row, index) => {
    if (row === null || typeof row !== 'object') fail(`fonts[${String(index)}] must be an object`)
    const file = String(row.file ?? '')
    if (!FONT_FILE.test(file) || !Object.hasOwn(FILE_TYPES, extname(file).toLowerCase()) || extname(file) === '.svg' || extname(file) === '.png') {
      fail(`fonts[${String(index)}].file must be a .woff2/.woff/.ttf/.otf file name, got ${JSON.stringify(file)}`)
    }
    if (fontsDir === '') fail('fonts given without fontsDir')
    if (!existsSync(join(fontsDir, file))) fail(`font file not found: ${join(fontsDir, file)}`)
    const family = String(row.family ?? '')
    if (!FONT_FAMILY.test(family) || family.includes(',')) fail(`fonts[${String(index)}].family must be one family name, got ${JSON.stringify(family)}`)
    const style = row.style === undefined ? 'normal' : row.style
    if (style !== 'normal' && style !== 'italic') fail(`fonts[${String(index)}].style must be 'normal' or 'italic'`)
    return { file, family, weight: number(row, 'weight', 100, 900, 400), style }
  })
  const hidePreviewBadge = input.hidePreviewBadge === undefined ? false : input.hidePreviewBadge
  if (typeof hidePreviewBadge !== 'boolean') fail('hidePreviewBadge must be true or false')
  return {
    name: text(input, 'name'),
    mark,
    markMode,
    headline: text(input, 'headline'),
    turnStatus: text(input, 'turnStatus'),
    hidePreviewBadge,
    accent: hex(input, 'accent'),
    accentDark: hex(input, 'accentDark'),
    fontsDir,
    fonts,
    brandFont: typography(input, 'brandFont', { weight: 600, size: 18, lineHeight: 24, letterSpacing: 0, offsetY: 0 }),
    headlineFont: typography(input, 'headlineFont', { weight: 500, size: 26, lineHeight: 32, letterSpacing: 0, offsetY: 0 }),
  }
}

/**
 * Lighter and darker steps of the shipped blue ramp, as the share of the
 * accent mixed into white (light steps) or black (dark steps), in oklab.
 */
const RAMP = {
  light: { 50: 8, '50p': 10, 75: 13, 100: 18, 200: 33, 300: 55, 400: 80, 450: 90 },
  dark: { 800: 50, 900: 38, 950: 30 },
}

/**
 * The accent override rules for one colour.
 * @param {string} accent - #rrggbb.
 * @param {string} accentDark - #rrggbb for the 600 step, or '' to derive it.
 * @returns {string} one CSS rule.
 */
export function accentStyle(accent, accentDark) {
  const lines = []
  const put = (step, value) => { lines.push(`--dsw-static-deepseek-${step}:${value};--dsw-static-blue-${step}:${value};`) }
  for (const [step, share] of Object.entries(RAMP.light)) put(step, `color-mix(in oklab,${accent} ${String(share)}%,white)`)
  put(500, accent)
  put(600, accentDark === '' ? `color-mix(in oklab,${accent} 85%,black)` : accentDark)
  for (const [step, share] of Object.entries(RAMP.dark)) put(step, `color-mix(in oklab,${accent} ${String(share)}%,black)`)
  // The one alias set to a literal blue instead of a ramp step (light theme).
  lines.push(`--dsw-alias-brand-primary-new-colorprimary-new-color:${accent};`)
  return `html>body,html>body[data-ds-dark-theme]{${lines.join('')}}`
}

/**
 * One rule setting a typography block on a selector.
 * @param {string} selector - CSS selector.
 * @param {Typography} font - typography.
 * @param {string[]} extra - further declarations.
 */
function fontRule(selector, font, extra = []) {
  const parts = [...extra, `font-weight:${String(font.weight)}`, `font-size:${String(font.size)}px`, `line-height:${String(font.lineHeight)}px`, `letter-spacing:${String(font.letterSpacing)}em`]
  if (font.family !== '') parts.unshift(`font-family:${font.family}`)
  if (font.offsetY !== 0) parts.push(`transform:translateY(${String(font.offsetY)}px)`)
  return `${selector}{${parts.join(';')}}`
}

/**
 * Asset URLs the page fetches: everything goes through the plugin's Fetch
 * route (`/api/brand-kit/asset`), written document-relative so a
 * path-stripping proxy mount (`/dsh/`) resolves them like the site root.
 * `source` is the profile name or '' for the plugin row's config.
 * @param {string} source - profile name or ''.
 * @param {'mark' | 'font'} kind - asset kind.
 * @param {string} file - file name.
 */
export function assetUrl(source, kind, file) {
  const query = new URLSearchParams({ s: source, k: kind, f: file })
  return `.${API_PATH}/asset?${query.toString()}`
}

/**
 * The `<style>` row for a configuration.
 * @param {BrandConfig} config - validated config.
 * @param {string} source - profile name the assets are served from ('' = row config).
 * @returns {string} CSS, '' when nothing is to be injected.
 */
export function brandStyle(config, source = '') {
  const rules = []
  for (const font of config.fonts) {
    const ext = extname(font.file).toLowerCase()
    const format = ext === '.woff2' ? 'woff2' : ext === '.woff' ? 'woff' : ext === '.ttf' ? 'truetype' : 'opentype'
    rules.push(`@font-face{font-family:"${font.family}";font-weight:${String(font.weight)};font-style:${font.style};font-display:swap;src:url(${assetUrl(source, 'font', font.file)}) format("${format}")}`)
  }
  if (config.name !== '') rules.push(fontRule('.brand-kit-name', config.brandFont, ['white-space:nowrap']))
  if (config.mark !== '') {
    const url = assetUrl(source, 'mark', basename(config.mark))
    rules.push(config.markMode === 'mask'
      ? `.brand-kit-mark{display:block;flex:none;background:currentColor;-webkit-mask:url(${url}) center/contain no-repeat;mask:url(${url}) center/contain no-repeat}`
      : '.brand-kit-mark{display:block;flex:none;object-fit:contain}')
  }
  if (config.headline !== '' || config.headlineFont.family !== '') {
    // The headline's only stable handle: CSS modules compile to `<hash>_<local>`.
    rules.push(fontRule('[class*="_titleGroup"]>span:first-child', config.headlineFont))
  }
  if (config.hidePreviewBadge) rules.push('[class*="_titleGroup"]>[class*="_previewBadge"]{display:none}')
  if (config.accent !== '') rules.push(accentStyle(config.accent, config.accentDark))
  return rules.join('\n')
}

/**
 * What the browser half reads (`globalThis.__DSH_BRAND_KIT__`).
 * @param {BrandConfig} config - validated config.
 * @param {string} source - profile name the assets are served from ('' = row config).
 * @returns {{ name: string, headline: string, turnStatus: string, mark: { url: string, mode: 'mask' | 'image' } | null }} payload.
 */
export function clientPayload(config, source = '') {
  return {
    name: config.name,
    headline: config.headline,
    turnStatus: config.turnStatus,
    mark: config.mark === '' ? null : { url: assetUrl(source, 'mark', basename(config.mark)), mode: config.markMode },
  }
}

/** Card chrome for the Plugins-panel page (classes the browser half's components wear). */
export const CARD_STYLE = [
  '.bk-card{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:14px}',
  '.bk-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
  '.bk-muted{color:var(--dsw-alias-label-tertiary)}',
  '.bk-error{color:var(--dsw-alias-state-error-primary)}',
  '.bk-list{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}',
  '.bk-item{display:flex;align-items:center;gap:8px;padding:8px 10px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-layer-3)}',
  '.bk-item.bk-active{border-color:var(--dsw-alias-state-business-primary)}',
  '.bk-item .bk-name{flex:1;min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.bk-tag{font-size:11px;padding:1px 7px;border-radius:12px;background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-label-primary-bluish)}',
  '.bk-btn{font:inherit;font-size:12px;padding:4px 10px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2);color:inherit;cursor:pointer}',
  '.bk-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.bk-btn.bk-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent}',
  '.bk-btn:disabled{opacity:.5;cursor:default}',
  '.bk-form{display:grid;grid-template-columns:max-content 1fr;gap:8px 12px;align-items:center}',
  '.bk-form label{color:var(--dsw-alias-label-secondary);white-space:nowrap}',
  '.bk-form input[type=text],.bk-form input[type=number],.bk-form select{font:inherit;padding:4px 8px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1);color:inherit;min-width:0;width:100%;box-sizing:border-box}',
  '.bk-form input[type=number]{width:6em}',
  '.bk-form input[type=color]{width:34px;height:26px;padding:0;border:0.5px solid var(--dsw-alias-border-l4);border-radius:6px;background:none}',
  '.bk-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
  '.bk-form .bk-inline input[type=text]{width:auto;flex:1;min-width:140px}',
  '.bk-form .bk-inline input[type=number]{width:5.5em;flex:none}',
  '.bk-form .bk-inline select{width:auto}',
  '.bk-sub{grid-column:1/-1;margin-top:6px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
  '.bk-preview-mark{width:24px;height:24px;display:inline-block;background:currentColor;vertical-align:middle}',
].join('\n')

/** Per-file MIME types the asset route serves. */
export const ASSET_TYPES = FILE_TYPES

/**
 * Stream one asset file. Only files the given config names are served — the
 * route is not a directory listing.
 * @param {BrandConfig} config - the config whose files may be served.
 * @param {'mark' | 'font'} kind - asset kind.
 * @param {string} file - file name.
 * @returns {string | undefined} the absolute path, or undefined when the config does not name it.
 */
export function assetPath(config, kind, file) {
  if (kind === 'mark') return config.mark !== '' && basename(config.mark) === file ? config.mark : undefined
  if (kind === 'font') return config.fonts.some(font => font.file === file) ? join(config.fontsDir, file) : undefined
  return undefined
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {unknown} rawConfig - the row's config (see {@link normalizeConfig}).
 */
export function apply(ctx, rawConfig) {
  const input = rawConfig !== null && typeof rawConfig === 'object' ? /** @type {Record<string, unknown>} */ (rawConfig) : {}
  const profilesDir = input.profilesDir === undefined || input.profilesDir === '' ? defaultProfilesDir() : String(input.profilesDir)
  if (!isAbsolute(profilesDir)) fail(`profilesDir must be an absolute path, got ${JSON.stringify(profilesDir)}`)
  const store = new ProfileStore(profilesDir, normalizeConfig)
  /** The shipped DSH look: what an empty profile resolves to. */
  const SHIPPED_LOOK = normalizeConfig({})

  /**
   * What the page gets right now: the active profile when one is set and
   * valid, else the shipped look. A profile that fails validation (edited by
   * hand, file removed) is reported, not fatal.
   * @returns {{ source: string, config: BrandConfig, error?: string }}
   */
  function effective() {
    const active = store.active()
    if (active === '') return { source: '', config: SHIPPED_LOOK }
    try {
      return { source: active, config: store.read(active).config }
    } catch (error) {
      return { source: '', config: SHIPPED_LOOK, error: `${active}: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  ctx.on('webserver/index-inject', table => {
    const { source, config } = effective()
    const style = brandStyle(config, source)
    table.push({ kind: 'style', text: `/* tali-brand-kit */\n${CARD_STYLE}${style === '' ? '' : `\n${style}`}` })
    table.push({ kind: 'global', name: '__DSH_BRAND_KIT__', value: clientPayload(config, source) })
  })

  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
  const route = (definition, label) => ctx.effect(() => {
    const dispose = ctx.connection.fetch.register(definition)
    return () => { void dispose() }
  }, label)

  /** The card's view of the world. */
  function state() {
    const current = effective()
    return {
      active: store.active(),
      effectiveSource: current.source,
      error: current.error,
      profilesDir: store.root,
      profiles: store.list().map(name => {
        try {
          const { json: profile } = store.read(name)
          return { name, profile }
        } catch (error) {
          return { name, profile: null, error: error instanceof Error ? error.message : String(error) }
        }
      }),
    }
  }

  route({
    path: `${API_PATH}/asset`,
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered', // the node:http bridge treats a route without it as streaming; a streaming GET Request throws
    fetch: async (request) => {
      const params = new URL(request.url).searchParams
      const source = params.get('s') ?? ''
      const kind = params.get('k') ?? ''
      const file = params.get('f') ?? ''
      let config
      try {
        if (source === '') return new Response('no such profile', { status: 404 })
        config = store.read(source).config
      } catch {
        return new Response('no such profile', { status: 404 })
      }
      const path = (kind === 'mark' || kind === 'font') ? assetPath(config, kind, file) : undefined
      if (path === undefined) return new Response('not an asset of this brand', { status: 404 })
      let bytes
      try {
        bytes = await readFile(path)
      } catch {
        return new Response('file missing', { status: 404 })
      }
      const headers = { 'content-type': ASSET_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream', 'content-length': String(bytes.byteLength), 'cache-control': 'private, max-age=3600' }
      return new Response(request.method === 'HEAD' ? null : bytes, { status: 200, headers })
    },
  }, 'brand-kit: asset route')

  route({
    path: API_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const params = new URL(request.url).searchParams
      const action = params.get('action') ?? ''
      const name = params.get('name') ?? ''
      try {
        if (request.method === 'GET') {
          if (action === 'export') {
            const zip = store.exportZip(name)
            return new Response(zip, { status: 200, headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, '_')}.brand.zip"`, 'cache-control': 'no-store' } })
          }
          return json(state())
        }
        switch (action) {
          case 'apply': store.setActive(name); break
          case 'save': store.write(name, await request.json()); break
          case 'create': {
            // Empty body: copy the active profile when there is one, else start from the shipped look.
            const body = await request.text()
            if (body !== '') store.write(name, JSON.parse(body))
            else if (store.active() !== '') store.duplicate(store.active(), name)
            else store.write(name, {})
            break
          }
          case 'duplicate': store.duplicate(name, params.get('to') ?? ''); break
          case 'rename': {
            const to = params.get('to') ?? ''
            const wasActive = store.active() === name
            store.rename(name, to)
            if (wasActive) store.setActive(to)
            break
          }
          case 'delete': {
            if (store.active() === name) store.setActive('')
            store.delete(name)
            break
          }
          case 'upload': {
            const kind = params.get('kind') === 'mark' ? 'mark' : 'font'
            const file = store.putAsset(name, kind, params.get('file') ?? '', new Uint8Array(await request.arrayBuffer()))
            return json({ ...state(), uploaded: file })
          }
          case 'import': store.importZip(name, new Uint8Array(await request.arrayBuffer())); break
          default: return json({ error: `unknown action "${action}"` }, 400)
        }
        return json(state())
      } catch (error) {
        return json({ ...state(), error: error instanceof Error ? error.message.replace(/^brand-kit: /, '') : String(error) }, 400)
      }
    },
  }, 'brand-kit: profiles route')

  const current = effective()
  const parts = [
    current.source === '' ? 'no active profile (shipped look)' : `profile ${JSON.stringify(current.source)}`,
    current.config.name === '' ? null : `name ${JSON.stringify(current.config.name)}`,
    current.config.mark === '' ? null : `mark ${basename(current.config.mark)} (${current.config.markMode})`,
    current.config.accent === '' ? null : `accent ${current.config.accent}`,
    current.config.fonts.length === 0 ? null : `${String(current.config.fonts.length)} font file(s)`,
    current.error === undefined ? null : `active profile invalid: ${current.error}`,
  ].filter(Boolean)
  ctx.logger.info(`brand-kit: ${parts.join(', ')}; ${String(store.list().length)} profile(s) in ${store.root}`)
}
