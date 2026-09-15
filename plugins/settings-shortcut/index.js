/**
 * tali-settings-shortcut — host half.
 *
 * Nothing to do on the host: this plugin is browser-only. The package exists
 * on the Node side so the Loader row resolves and the host serves the
 * `./client` bundle (package.json `dsh.client`) to the web shell, where the
 * real work (src/client/index.ts) runs.
 */

export const name = 'settings-shortcut'

export const inject = []

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - host-plane plugin context.
 */
export function apply(ctx) {
  ctx.logger.info('settings-shortcut: browser half bound to ⌘. / Ctrl+.')
}
