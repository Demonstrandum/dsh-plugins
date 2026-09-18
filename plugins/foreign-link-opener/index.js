/**
 * tali-foreign-link-opener — host half.
 *
 * THE PATHOLOGY. `dsh web` ships a web-app manifest, so Safari's File ▸ "Add
 * to Dock…" turns the GUI into a standalone macOS web app. Safari decides
 * whether a link opens inside that app or in the default browser by the app's
 * *scope*, and the default scope is the HOST of the installing page — the port
 * is not part of it (WWDC23 "What's new in web apps"). A DSH app installed
 * from http://127.0.0.1:3080 therefore treats http://127.0.0.1:5173 (a dev
 * server an agent started) as in-scope and opens it in a NEW DSH-branded
 * window; `window.open()` stays in the web app no matter what. There is no
 * manifest field that fixes this: `scope` can only NARROW to a path prefix of
 * the same host.
 *
 * THE FIX. The browser half (src/client) intercepts clicks on http(s) links
 * whose origin is not this server's (loopback aliases of the same port count
 * as the same server) — only while the GUI runs as an installed web app — and
 * asks this host half to hand the URL to the real browser. This half owns
 * exactly two authenticated GET routes below /api (ctx.connection.fetch is
 * GET/HEAD-only, so the opener is a GET with a required custom header; the
 * browser auth cookie is SameSite=Strict, and a cross-site page cannot set
 * the header without a CORS preflight this server never answers):
 *
 *   GET /api/foreign-links/config        → the client-relevant config as JSON
 *   GET /api/foreign-links/open?url=…    → `open -a <app> <url>` (http/https only)
 *
 * Config (all optional):
 *
 *   app: /Applications/Safari.app   # browser to hand foreign links to; '' = the system default handler (`open <url>`)
 *   when: auto                      # auto = only when the GUI runs as an installed web app (display-mode / navigator.standalone)
 *                                   # always = every foreign link, even in a normal browser tab (testing); never = inert
 *   loopbackOnly: true              # only act when the GUI itself is served from 127.0.0.1 / localhost / [::1] —
 *                                   # a phone reaching DSH through the reverse proxy must never open Safari on the Mac
 *   traceFile: ''                   # append JSON lines here ('' = off)
 */

import { execFile } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import Schema from '@deepseek-ai/schemastery'

export const name = 'foreign-link-opener'

export const inject = ['connection']

export const Config = Schema.object({
  app: Schema.string().default('/Applications/Safari.app'),
  when: Schema.union(['auto', 'always', 'never']).default('auto'),
  loopbackOnly: Schema.boolean().default(true),
  traceFile: Schema.string().default(''),
})

/** Exact Fetch routes (below /api). Mirrored in src/client/index.ts. */
export const CONFIG_PATH = '/api/foreign-links/config'
export const OPEN_PATH = '/api/foreign-links/open'
/** Header the browser half sends; its absence rejects the request (defense against cross-site GETs). */
export const REQUEST_HEADER = 'x-dsh-foreign-links'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - host-plane plugin context.
 * @param {ReturnType<typeof Config>} config - validated plugin config.
 */
export function apply(ctx, config) {
  const trace = (record) => {
    if (config.traceFile === '') return
    try { appendFileSync(config.traceFile, `${JSON.stringify({ t: new Date().toISOString(), ...record })}\n`) } catch { /* best effort */ }
  }

  if (process.platform !== 'darwin') {
    ctx.logger.warn('foreign-link-opener: only macOS Safari web apps have this pathology; plugin is inert on this platform')
    return
  }

  const clientConfig = JSON.stringify({ when: config.when, loopbackOnly: config.loopbackOnly })

  const route = (definition, label) => ctx.effect(() => {
    const dispose = ctx.connection.fetch.register(definition)
    return () => { void dispose() }
  }, label)

  route({
    path: CONFIG_PATH,
    methods: ['GET', 'HEAD'],
    // Required by the node:http bridge: a route without it is treated as
    // streaming, and a streaming GET Request throws → the webserver answers 400.
    requestBody: 'buffered',
    fetch: async (request) => {
      const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' }
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
      return new Response(clientConfig, { status: 200, headers })
    },
  }, 'foreign-link-opener: config route')

  route({
    path: OPEN_PATH,
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.headers.get(REQUEST_HEADER) !== '1') return new Response('missing request header', { status: 403 })
      const raw = new URL(request.url).searchParams.get('url') ?? ''
      let url
      try { url = new URL(raw) } catch { return new Response('not an absolute URL', { status: 400 }) }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return new Response('only http(s) URLs are opened', { status: 400 })
      if (request.method === 'HEAD') return new Response(null, { status: 200 })

      // `open` takes the URL as an argument, never through a shell: no quoting hazards.
      const args = config.app === '' ? [url.href] : ['-a', config.app, url.href]
      const failure = await new Promise((done) => execFile('/usr/bin/open', args, (error, _stdout, stderr) => done(error ? (stderr || error.message).trim() : undefined)))
      trace({ event: 'open', url: url.href, app: config.app, failure })
      if (failure !== undefined) {
        ctx.logger.warn(`foreign-link-opener: open failed for ${url.href}: ${failure}`)
        return new Response(failure, { status: 502, headers: { 'content-type': 'text/plain' } })
      }
      return new Response('opened', { status: 200, headers: { 'content-type': 'text/plain' } })
    },
  }, 'foreign-link-opener: open route')

  ctx.logger.info(`foreign-link-opener: when=${config.when}, app=${config.app === '' ? '(system default)' : config.app}`)
}
