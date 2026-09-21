/**
 * tali-instance-identity — tell one DSH web instance from another at a glance.
 *
 * Several `dsh web` servers (the live one, the preview on ~/.dsh-preview, a
 * remote Mac's) all ship the same client build, so their windows look
 * identical: the same whale, the same "DSH Local Build" wordmark, the same
 * version badge. This host-only plugin colours the instance and quietens the
 * badge, with nothing rebuilt and no client bundle:
 *
 *   brandColor   CSS colour for the sidebar whale (expanded brand row and the
 *                collapsed rail) and, when set, the served `/favicon.svg`.
 *                Absent = stock (black/white, follows the theme).
 *   versionBadge 'subtle' (default) — the build-version chip under the
 *                wordmark loses its inverted box and rides the text colour at
 *                40 % opacity; 'stock' leaves the shipped chip alone.
 *   dockLabel    when set, `/manifest.webmanifest` is replaced so a Safari
 *                "Add to Dock" install of this instance gets this short name
 *                and its own app id (carrying the port). Only meaningful for
 *                Safari web-app installs; the native Dock apps built by
 *                dsh-tailscale-remote carry their own icon and label.
 *
 * HOW. The client's CSS modules compile to `<hash>_<local>` class names
 * (`rIE9vq_brandMark`, `rIE9vq_buildVersion`), and the whale path is
 * `fill="currentColor"`, so one `<style>` row contributed through the
 * webserver's structured `webserver/index-inject` table (an attribute
 * substring selector on the stable `_local` part) restyles both.
 * `element[class*=…]` outranks the module's single-class rule, so no
 * `!important` is needed. The favicon and manifest ride exact routes, which
 * the webserver matches before the static-frontend fallback that serves the
 * built `dist/` copies.
 *
 * NOT DONE HERE. The wordmark text and the window title ("DSH Local Build")
 * come from the `common` locale namespace, whose dictionaries have a single
 * occupant, and the client's DocumentTitle rewrites `document.title` on
 * mount — so a `<title>` tap (this plugin used to have one) is overridden
 * the moment the client boots. Renaming an instance needs a client bundle
 * that occupies `sidebar.brand.name`; not attempted.
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'instance-identity'

export const inject = ['webServer']

/**
 * Fill in defaults and reject malformed values (plain ESM, no schema library;
 * the siblings enforce-model-preset / local-model-supervisor do the same).
 * @param {unknown} raw - the row's config, possibly absent.
 * @returns {{ brandColor: string, versionBadge: 'subtle' | 'stock', dockLabel: string }} normalized config.
 */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {}
  const brandColor = input.brandColor === undefined ? '' : String(input.brandColor)
  const versionBadge = input.versionBadge === undefined ? 'subtle' : input.versionBadge
  const dockLabel = input.dockLabel === undefined ? '' : String(input.dockLabel)
  if (brandColor !== '' && !isSafeColor(brandColor)) {
    throw new Error(`instance-identity: brandColor must be a hex or named CSS colour, got ${JSON.stringify(brandColor)}`)
  }
  if (versionBadge !== 'subtle' && versionBadge !== 'stock') {
    throw new Error(`instance-identity: versionBadge must be 'subtle' or 'stock', got ${JSON.stringify(versionBadge)}`)
  }
  return { brandColor, versionBadge, dockLabel }
}

const HERE = dirname(fileURLToPath(import.meta.url))
const FAVICON_TEMPLATE = join(HERE, 'favicon-template.svg')

/** Cache-busting: the Dock/browser cling to icons, so never let these be cached. */
const NO_STORE = 'no-store, max-age=0'

/**
 * A colour that is safe to splice into a `<style>` row and an SVG attribute:
 * a hex triplet/sextet or a CSS named colour. Anything else is rejected
 * loudly so a typo in the profile patch does not become injected markup.
 * @param {string} value - configured colour.
 * @returns {boolean} whether it is usable verbatim.
 */
export function isSafeColor(value) {
  return /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(value) || /^[a-z]{3,20}$/i.test(value)
}

/**
 * The style row's text for a configuration.
 * @param {{ brandColor: string, versionBadge: 'subtle' | 'stock' }} config - validated config.
 * @returns {string} CSS, '' when nothing is to be injected.
 */
export function identityStyle(config) {
  const rules = []
  if (config.brandColor !== '') {
    // Expanded brand row (`_brandMark`) and the collapsed rail's toggle
    // (`_railMark`, whose ink otherwise comes from `.collapsed .iconButton`).
    rules.push(`span[class*="_brandMark"],span[class*="_railMark"]{color:${config.brandColor}}`)
  }
  if (config.versionBadge === 'subtle') {
    rules.push('span[class*="_buildVersion"]{color:inherit;background:none;opacity:.4;padding:0;border-radius:0}')
  }
  return rules.join('\n')
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {unknown} rawConfig - the row's config (see {@link normalizeConfig}).
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const port = ctx.webServer.port
  const style = identityStyle(config)

  if (style !== '') {
    ctx.on('webserver/index-inject', table => {
      table.push({ kind: 'style', text: `/* tali-instance-identity */\n${style}` })
    })
  }

  if (config.brandColor !== '') {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/favicon.svg',
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405)
          res.end()
          return
        }
        let body
        try {
          body = (await readFile(FAVICON_TEMPLATE, 'utf8')).replaceAll('__BRAND_COLOR__', config.brandColor)
        } catch (error) {
          ctx.logger.warn(`instance-identity: cannot read ${FAVICON_TEMPLATE}: ${String(error)}`)
          res.writeHead(404)
          res.end()
          return
        }
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': NO_STORE })
        res.end(req.method === 'HEAD' ? undefined : body)
      },
    }), 'instance-identity: /favicon.svg')
  }

  if (config.dockLabel !== '') {
    const manifest = JSON.stringify({
      id: `/?instance=${port}`,
      name: `${config.dockLabel} :${port}`,
      short_name: config.dockLabel,
      start_url: '/',
      scope: '/',
      display: 'fullscreen',
      icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
    }, null, 2)
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/manifest.webmanifest',
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405)
          res.end()
          return
        }
        res.writeHead(200, { 'content-type': 'application/manifest+json', 'cache-control': NO_STORE })
        res.end(req.method === 'HEAD' ? undefined : manifest)
      },
    }), 'instance-identity: /manifest.webmanifest')
  }

  ctx.logger.info(`instance-identity: port ${port}: whale ${config.brandColor === '' ? 'stock' : config.brandColor}, `
    + `version badge ${config.versionBadge}${config.dockLabel === '' ? '' : `, Dock label "${config.dockLabel}"`}`)
}
