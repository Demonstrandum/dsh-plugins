/** Host half for the browser-only percent session-reference picker. */
export const name = 'session-reference-picker'
export const inject = []

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx) {
  ctx.logger.info('session-reference-picker: browser half serves the % session picker')
}
