/**
 * tali-phone-ui — a chat-only presentation of a Session on phone-width
 * viewports.
 *
 * The shipped client has no responsive CSS: at 390–430 CSS px (an iPhone,
 * whether the full GUI or a `?embed=<sessionId>` page from the per-session
 * QR code) a Session still carries its desktop chrome — the header (title,
 * agent-preset chip, `…` menu, right-dock toggle, and the Chat | Trajectory
 * tab strip), an icon row under every message (copy, feedback, branch,
 * usage/time pills, clock) and the composer dock (turn/step pills, token
 * pill, context meter). None of it is useful on a phone and together it
 * costs ~130px of a 740px viewport. This host-only plugin hides the three
 * groups below a configurable viewport width and leaves everything else
 * (transcript, composer card with its model/permission pickers, approvals,
 * queue dock) untouched.
 *
 *   maxWidth        the media query's `max-width` in CSS px, integer
 *                   320–1200. Default 640 (phones in either orientation are
 *                   ≤ 430 px wide; an iPad portrait is 768–834 px and keeps
 *                   its chrome).
 *   header          hide the Session header incl. the view tabs. Default true.
 *   messageActions  hide the icon-action rows of assistant turn tails and
 *                   user/steering bubbles. Default true.
 *   stats           hide the composer dock (stats pills + context meter).
 *                   Default true.
 *
 * HOW. One `<style>` row through the webserver's structured
 * `webserver/index-inject` table, no client bundle (the sibling
 * transcript-grace-margin does the same). Every hook is an unhashed
 * attribute the client renders itself — CSS-module classes compile to
 * `<hash>_<local>` and are deliberately avoided:
 *
 *   [data-slot="conversation.session.header"] > header
 *       the slot outlet (`display:contents`) around the header element
 *       (ui-conversation ConversationSession.tsx); the tab strip is inside it.
 *   [data-turn-tail][data-actions-reveal] > div:not([data-slot])
 *       the turn tail's own actions row — its only non-slot child; the
 *       `conversation.chat.turnTail` slot outlet (galleries, deliverables)
 *       stays (ui-chat TurnTailNodeView.tsx).
 *   :is([data-chat-flow-kind="user"],[data-chat-flow-kind="steering"])
 *     > [data-slot="conversation.chat.node"] > div > div:nth-child(2)
 *       the user bubble row is `userRow > (userStack, actions)`; the second
 *       child is the copy/clock row (ui-chat MessageItem.tsx UserStyleBubble).
 *   [data-slot="conversation.composer.bar"] div:has(> [data-slot="conversation.composer.dock"])
 *       the InputBar's `.dock` wrapper, identified by the dock slot outlet it
 *       contains; hiding the wrapper also hides the ContextMeter beside the
 *       pills (ui-conversation InputBar.tsx). `:has()` — Safari ≥ 15.4.
 *
 * Measured 2026-09-23 on the preview server at 390×844: all four selectors
 * resolve, the scrollport starts at y=0, the composer card sits at the
 * bottom edge.
 */

export const name = 'phone-ui'

export const inject = ['webServer']

export const DEFAULT_MAX_WIDTH = 640
export const MIN_MAX_WIDTH = 320
export const MAX_MAX_WIDTH = 1200

/**
 * @typedef {object} PhoneUiConfig
 * @property {number} maxWidth - media-query upper bound, CSS px.
 * @property {boolean} header - hide the Session header (title row + tabs).
 * @property {boolean} messageActions - hide per-message icon rows.
 * @property {boolean} stats - hide the composer dock (pills + context meter).
 */

/**
 * Fill in defaults and reject malformed values (plain ESM, no schema library).
 * @param {unknown} raw - the row's config, possibly absent.
 * @returns {PhoneUiConfig} normalized config.
 */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {}
  const maxWidth = input.maxWidth === undefined ? DEFAULT_MAX_WIDTH : input.maxWidth
  if (typeof maxWidth !== 'number' || !Number.isInteger(maxWidth) || maxWidth < MIN_MAX_WIDTH || maxWidth > MAX_MAX_WIDTH) {
    throw new Error(`phone-ui: maxWidth must be an integer ${MIN_MAX_WIDTH}-${MAX_MAX_WIDTH} (px), got ${JSON.stringify(maxWidth)}`)
  }
  const flag = (/** @type {string} */ key) => {
    const value = input[key] === undefined ? true : input[key]
    if (typeof value !== 'boolean') throw new Error(`phone-ui: ${key} must be a boolean, got ${JSON.stringify(value)}`)
    return value
  }
  return { maxWidth, header: flag('header'), messageActions: flag('messageActions'), stats: flag('stats') }
}

/** Selectors per group; each group is one comma list that gets `display:none`. */
export const SELECTORS = Object.freeze({
  header: ['[data-slot="conversation.session.header"] > header'],
  messageActions: [
    '[data-turn-tail][data-actions-reveal] > div:not([data-slot])',
    ':is([data-chat-flow-kind="user"],[data-chat-flow-kind="steering"]) > [data-slot="conversation.chat.node"] > div > div:nth-child(2)',
  ],
  stats: ['[data-slot="conversation.composer.bar"] div:has(> [data-slot="conversation.composer.dock"])'],
})

/**
 * The style row's text for a configuration.
 * @param {PhoneUiConfig} config - validated config.
 * @returns {string} CSS, '' when every group is off.
 */
export function phoneStyle(config) {
  const selectors = /** @type {(keyof typeof SELECTORS)[]} */ (Object.keys(SELECTORS))
    .filter(group => config[group])
    .flatMap(group => SELECTORS[group])
  if (selectors.length === 0) return ''
  return `@media (max-width:${config.maxWidth}px){${selectors.join(',')}{display:none}}`
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {unknown} rawConfig - the row's config (see {@link normalizeConfig}).
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const style = phoneStyle(config)
  if (style !== '') {
    ctx.on('webserver/index-inject', table => {
      table.push({ kind: 'style', text: `/* tali-phone-ui */\n${style}` })
    })
  }
  const groups = ['header', 'messageActions', 'stats'].filter(group => config[/** @type {'header'|'messageActions'|'stats'} */ (group)])
  ctx.logger.info(`phone-ui: ≤${config.maxWidth}px hides ${groups.length === 0 ? 'nothing (disabled)' : groups.join(', ')}`)
}
