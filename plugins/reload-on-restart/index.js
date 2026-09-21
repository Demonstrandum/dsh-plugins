/**
 * tali-reload-on-restart — host half.
 *
 * Nothing to do on the host: this plugin is browser-only. The package exists
 * on the Node side so the Loader row resolves and the host serves the
 * `./client` bundle (package.json `dsh.client`) to the web shell, where the
 * real work (src/client/index.ts) runs.
 */

export const name = 'reload-on-restart'

export const inject = []

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - host-plane plugin context.
 */
export function apply(ctx) {
  ctx.logger.info('reload-on-restart: browser half reloads the page when the server it booted from is gone')
}
