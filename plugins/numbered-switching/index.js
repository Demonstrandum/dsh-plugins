/**
 * tali-numbered-switching — host half.
 *
 * Browser-only feature (see src/client): the host half exists so the Loader
 * has a row to hang the `dsh.client` bundle on. Nothing to do here.
 */
export const name = 'numbered-switching'
export const inject = []

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - host-plane plugin context.
 */
export function apply(ctx) {
  ctx.logger.info('numbered-switching: browser half serves ⌘1…⌘5 recent-session switching')
}
