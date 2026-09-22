/**
 * tali-transcript-grace-margin — visible "you are at the end" space under the
 * transcript.
 *
 * In the shipped client the last row of a Chat transcript stops 16px above
 * the sticky input card (ChatView.module.css `.scroll` padding), and the
 * card's 36px fade band eats most of that, so scrolling to the bottom of a
 * long session looks like the flow continues under the composer — there is
 * no visual cue that the transcript has ended. This host-only plugin adds a
 * configurable grace margin (default 160px) after the last row, so the end
 * of the transcript is unmistakable: the last turn sits clear of the input
 * card with empty space beneath it.
 *
 *   margin   px of empty space between the transcript's last row and the
 *            input card's fade band, 0–600, integer. Default 160.
 *
 * HOW. One `<style>` row through the webserver's structured
 * `webserver/index-inject` table, no client bundle. Both hooks are unhashed
 * data attributes the client renders itself (its CSS-module classes compile
 * to `<hash>_<local>` names, which we avoid):
 *
 *   [data-conversation-scroll]  the active-phase scrollport
 *                               (ui-conversation ConversationContent.tsx)
 *   [data-chat-flow]            the message column inside it
 *                               (ui-chat ChatView.tsx)
 *
 * `padding-bottom` on the column grows the scrollport's scrollHeight, and
 * ChatView's follow logic (`scrollTop = scrollHeight`, "at bottom" =
 * `scrollHeight - clientHeight - scrollTop < ε`) and its ResizeObserver on
 * the column read that same height, so auto-follow, the back-to-bottom
 * control (sticky to the scrollport, after the column) and turn navigation
 * are unaffected. Scoped to the active-phase scroller so the hero/blank
 * composer layout and embedded frames' own scrollers keep their geometry.
 * Measured 2026-09-22 on the preview server: last-row-to-card gap 16px →
 * 176px, `atBottom` still true after `scrollTop = scrollHeight`.
 */

export const name = 'transcript-grace-margin'

export const inject = ['webServer']

export const DEFAULT_MARGIN = 160
export const MAX_MARGIN = 600

/**
 * Fill in defaults and reject malformed values (plain ESM, no schema library;
 * the sibling instance-identity does the same).
 * @param {unknown} raw - the row's config, possibly absent.
 * @returns {{ margin: number }} normalized config.
 */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {}
  const margin = input.margin === undefined ? DEFAULT_MARGIN : input.margin
  if (typeof margin !== 'number' || !Number.isInteger(margin) || margin < 0 || margin > MAX_MARGIN) {
    throw new Error(`transcript-grace-margin: margin must be an integer 0-${MAX_MARGIN} (px), got ${JSON.stringify(margin)}`)
  }
  return { margin }
}

/**
 * The style row's text for a configuration.
 * @param {{ margin: number }} config - validated config.
 * @returns {string} CSS, '' when margin is 0.
 */
export function graceStyle(config) {
  if (config.margin === 0) return ''
  return `[data-conversation-scroll] [data-chat-flow]{padding-bottom:${config.margin}px}`
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {unknown} rawConfig - the row's config (see {@link normalizeConfig}).
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const style = graceStyle(config)
  if (style !== '') {
    ctx.on('webserver/index-inject', table => {
      table.push({ kind: 'style', text: `/* tali-transcript-grace-margin */\n${style}` })
    })
  }
  ctx.logger.info(`transcript-grace-margin: ${config.margin}px${style === '' ? ' (disabled)' : ''}`)
}
