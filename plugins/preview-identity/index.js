/**
 * tali-preview-identity — make the preview/dev dsh web server visually distinct.
 *
 * The shipped web app serves `/favicon.svg` and `/manifest.webmanifest` from
 * its built `dist/` through the webserver's FALLBACK seat
 * (`@deepseek-ai/dsh-host-frontend-static`). Named routes are matched before
 * that fallback, so registering exact routes for those two paths overrides the
 * app identity without touching the DSH checkout or rebuilding anything.
 *
 * Effect: a red whale instead of the black/white one, and a "DSH-dev" Dock
 * label instead of "DSH", so a Dock-installed preview instance cannot be
 * confused with the live one. `id` and `start_url` carry the port, so macOS
 * treats the preview as a separate installable app rather than the same one.
 *
 * Load this ONLY in the dev overlay (cordis.dev.yml) — never in the live
 * profile, whose identity should stay stock.
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'preview-identity'

export const inject = ['webServer']

const HERE = dirname(fileURLToPath(import.meta.url))
const FAVICON = join(HERE, 'favicon-preview.svg')

/** Cache-busting: the Dock/browser cling to icons, so never let these be cached. */
const NO_STORE = 'no-store, max-age=0'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
export function apply(ctx) {
  const port = ctx.webServer.port
  const manifest = JSON.stringify({
    id: `/?preview=${port}`,
    name: `DSH preview :${port}`,
    short_name: 'DSH-dev',
    start_url: '/',
    scope: '/',
    display: 'fullscreen',
    icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  }, null, 2)

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
        body = await readFile(FAVICON)
      } catch (error) {
        ctx.logger.warn(`preview-identity: cannot read ${FAVICON}: ${String(error)}`)
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': NO_STORE })
      res.end(req.method === 'HEAD' ? undefined : body)
    },
  }), 'preview-identity: /favicon.svg')

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
  }), 'preview-identity: /manifest.webmanifest')

  // The <title> is the browser-tab and window label; the manifest does not
  // change it. An index tap is the sanctioned hook for markup no injection row
  // expresses.
  ctx.effect(() => ctx.webServer.tapIndex(html =>
    html.replace(/<title>[^<]*<\/title>/i, `<title>DSH preview :${port}</title>`)))

  ctx.logger.info(`preview-identity: serving red icon and "DSH-dev" manifest on port ${port}`)
}
