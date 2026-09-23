/**
 * tali-brand-kit — host half.
 *
 * Re-brand the DSH Web GUI from configuration. Nothing brand-specific is
 * built in: every asset is a file path, every string a config value, and
 * every part is optional ('' / absent = the shipped DSH look for that part).
 *
 *   name              wordmark beside the sidebar mark. Occupying that cell
 *                     also removes the shipped product title AND the
 *                     build-version chip (they are one slot fallback).
 *   mark              absolute path to an SVG (or PNG) file shown in place of
 *                     the whale — sidebar brand row, collapsed rail, and the
 *                     empty-session hero. Served at /brand-kit/mark.<ext>.
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
 *   fontsDir          directory served at /brand-kit/fonts/ (files listed in `fonts`).
 *   fonts             `@font-face` rows: [{ file, family, weight = 400, style = 'normal' }].
 *   brandFont         wordmark typography: { family, weight, size, lineHeight, letterSpacing, offsetY }
 *                     (the shell's brand-name box is 24px tall, 18px/600).
 *   headlineFont      headline typography: { family, weight, size, lineHeight }
 *                     (shipped: 26px/32 weight 500 in the system stack).
 *
 * HOW. The browser half (src/client) occupies the shell's brand slots
 * (`sidebar.brand.mark`, `sidebar.brand.name`, `conversation.hero.brand.mark`
 * — all `single`, so registering replaces the fallback) and substitutes the
 * two locale-owned strings in place (they have no slot and their namespace
 * has one occupant). This half validates the config, serves the files, and
 * contributes one `<style>` row (font faces, the classes the components wear,
 * the accent override) plus a `global` row the browser half reads at apply
 * time. URLs in the style row are document-relative (`./brand-kit/…`), so
 * they resolve under a path-stripping proxy mount (`/dsh/`) as at the root.
 * The accent block is `html>body[…]` so it outranks the theme sheet, which the
 * client loads AFTER index-inject rows (a specificity tie would lose).
 */

import { createReadStream, existsSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, isAbsolute, join } from 'node:path'

export const name = 'brand-kit'

export const inject = ['webServer']

/** URL prefix of everything this plugin serves (host root). */
export const ROUTE = '/brand-kit/'

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
 * The `<style>` row for a configuration.
 * @param {BrandConfig} config - validated config.
 * @returns {string} CSS, '' when nothing is to be injected.
 */
export function brandStyle(config) {
  const rules = []
  for (const font of config.fonts) {
    const ext = extname(font.file).toLowerCase()
    const format = ext === '.woff2' ? 'woff2' : ext === '.woff' ? 'woff' : ext === '.ttf' ? 'truetype' : 'opentype'
    rules.push(`@font-face{font-family:"${font.family}";font-weight:${String(font.weight)};font-style:${font.style};font-display:swap;src:url(.${ROUTE}fonts/${font.file}) format("${format}")}`)
  }
  if (config.name !== '') rules.push(fontRule('.brand-kit-name', config.brandFont, ['white-space:nowrap']))
  if (config.mark !== '') {
    const url = `.${ROUTE}mark${extname(config.mark).toLowerCase()}`
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
 * @returns {{ name: string, headline: string, turnStatus: string, mark: { url: string, mode: 'mask' | 'image' } | null }} payload.
 */
export function clientPayload(config) {
  return {
    name: config.name,
    headline: config.headline,
    turnStatus: config.turnStatus,
    mark: config.mark === '' ? null : { url: `.${ROUTE}mark${extname(config.mark).toLowerCase()}`, mode: config.markMode },
  }
}

function serveFile(ctx, path, routePath, label) {
  const type = FILE_TYPES[extname(path).toLowerCase()]
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: routePath,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405)
        res.end()
        return
      }
      let size
      try {
        size = (await stat(path)).size
      } catch {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': type, 'content-length': String(size), 'cache-control': 'public, max-age=86400' })
      if (req.method === 'HEAD') { res.end(); return }
      createReadStream(path).pipe(res)
    },
  }), `brand-kit: ${label}`)
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {unknown} rawConfig - the row's config (see {@link normalizeConfig}).
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const style = brandStyle(config)
  const payload = clientPayload(config)

  ctx.on('webserver/index-inject', table => {
    if (style !== '') table.push({ kind: 'style', text: `/* tali-brand-kit */\n${style}` })
    table.push({ kind: 'global', name: '__DSH_BRAND_KIT__', value: payload })
  })

  if (config.mark !== '') serveFile(ctx, config.mark, `${ROUTE}mark${extname(config.mark).toLowerCase()}`, 'mark')
  for (const font of config.fonts) serveFile(ctx, join(config.fontsDir, font.file), `${ROUTE}fonts/${font.file}`, `font ${font.file}`)

  const parts = [
    config.name === '' ? null : `name ${JSON.stringify(config.name)}`,
    config.mark === '' ? null : `mark ${config.mark} (${config.markMode})`,
    config.headline === '' ? null : `headline ${JSON.stringify(config.headline)}`,
    config.turnStatus === '' ? null : `turn status ${JSON.stringify(config.turnStatus)}`,
    config.accent === '' ? null : `accent ${config.accent}`,
    config.fonts.length === 0 ? null : `${String(config.fonts.length)} font file(s)`,
    config.hidePreviewBadge ? 'no preview badge' : null,
  ].filter(Boolean)
  ctx.logger.info(`brand-kit: ${parts.length === 0 ? 'nothing configured (shipped look)' : parts.join(', ')}`)
}
