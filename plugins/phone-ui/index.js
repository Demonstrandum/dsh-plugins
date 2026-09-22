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
 *                   its chrome). Independently of the width, every rule also
 *                   applies under `<html data-dsh-view="mobile">` — the flag
 *                   the Dock app's View ▸ Mobile stamps.
 *   header          hide the Session header incl. the view tabs. Default true.
 *   messageActions  hide the icon-action rows of assistant turn tails and
 *                   user/steering bubbles. Default true.
 *   stats           hide the composer dock (stats pills + context meter).
 *                   Default true.
 *   sideMargin      transcript and composer-card side padding in CSS px,
 *                   0–64. Stock is 32 (text) / 16 (card); 32 leaves both
 *                   alone. Default 8 — a 390px phone gains 48px of text.
 *   codeHeaders     hide the code-block banner row (language label + Copy)
 *                   on every fenced block, incl. language-less ones.
 *                   Default true.
 *   halfRadius      halve the corner radius of code blocks (12→6px) and of
 *                   the user's own message bubbles (22→11px). Default true.
 *   compactBlocks   less padding inside the transcript's boxed blocks: code
 *                   blocks 16 → 8/10px, tool-card IN/OUT sections and
 *                   command-card bodies 12/16 → 8/10px, context-injection
 *                   bodies, table cells 10/16 → 6/10px, blockquote indent
 *                   14 → 8px, user bubbles 10/16 → 8/12px. Default true.
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
 *   [data-conversation-scroll] div:has(> [data-chat-flow])
 *       ChatView's `.scroll` (padding `16px calc(clearance + 16px)`), found
 *       as the parent of the message column.
 *   [data-conversation-content] { --dsh-composer-side-clearance }
 *       the variable ConversationRoot.module.css defines on `.body` (16px);
 *       the InputBar root pads by it, so the card follows the text column.
 *   [data-chat-flow] .md-code-block
 *       ui-primitives CodeBlock: the one unhashed class; it defines
 *       `--dsl-code-block-border-radius: 12px` on itself, so a
 *       higher-specificity override of the variable re-rounds banner, block
 *       and <pre> together. The banner wrapper is the child holding
 *       `[data-code-block-banner]`.
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
export const DEFAULT_SIDE_MARGIN = 8

/** Stock transcript side padding (ChatView `.scroll`: composer clearance 16 + 16). */
export const STOCK_SIDE_MARGIN = 32
export const MAX_SIDE_MARGIN = 64

/**
 * @typedef {object} PhoneUiConfig
 * @property {number} maxWidth - media-query upper bound, CSS px.
 * @property {boolean} header - hide the Session header (title row + tabs).
 * @property {boolean} messageActions - hide per-message icon rows.
 * @property {boolean} stats - hide the composer dock (pills + context meter).
 * @property {number} sideMargin - transcript + composer side padding, CSS px
 *   (stock 32 / 16; `STOCK_SIDE_MARGIN` leaves the stock values alone).
 * @property {boolean} codeHeaders - hide the code-block banner row (language + Copy).
 * @property {boolean} halfRadius - halve the corner radius of code blocks (12→6)
 *   and user bubbles (22→11).
 * @property {boolean} compactBlocks - less padding inside boxed blocks.
 */

/**
 * Fill in defaults and reject malformed values (plain ESM, no schema library).
 * @param {unknown} raw - the row's config, possibly absent.
 * @returns {PhoneUiConfig} normalized config.
 */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {}
  const int = (/** @type {string} */ key, /** @type {number} */ fallback, /** @type {number} */ min, /** @type {number} */ max) => {
    const value = input[key] === undefined ? fallback : input[key]
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw new Error(`phone-ui: ${key} must be an integer ${min}-${max} (px), got ${JSON.stringify(value)}`)
    }
    return value
  }
  const flag = (/** @type {string} */ key) => {
    const value = input[key] === undefined ? true : input[key]
    if (typeof value !== 'boolean') throw new Error(`phone-ui: ${key} must be a boolean, got ${JSON.stringify(value)}`)
    return value
  }
  return {
    maxWidth: int('maxWidth', DEFAULT_MAX_WIDTH, MIN_MAX_WIDTH, MAX_MAX_WIDTH),
    header: flag('header'),
    messageActions: flag('messageActions'),
    stats: flag('stats'),
    sideMargin: int('sideMargin', DEFAULT_SIDE_MARGIN, 0, MAX_SIDE_MARGIN),
    codeHeaders: flag('codeHeaders'),
    halfRadius: flag('halfRadius'),
    compactBlocks: flag('compactBlocks'),
  }
}

/** Selectors per hide-group; each group is one comma list that gets `display:none`. */
export const SELECTORS = Object.freeze({
  header: ['[data-slot="conversation.session.header"] > header'],
  messageActions: [
    '[data-turn-tail][data-actions-reveal] > div:not([data-slot])',
    ':is([data-chat-flow-kind="user"],[data-chat-flow-kind="steering"]) > [data-slot="conversation.chat.node"] > div > div:nth-child(2)',
  ],
  stats: ['[data-slot="conversation.composer.bar"] div:has(> [data-slot="conversation.composer.dock"])'],
  // The CodeBlock banner wrapper (ui-primitives CodeBlock.tsx): the sticky
  // `.bannerWrap` div is identified by the `[data-code-block-banner]` row it
  // holds. `.md-code-block` is the one unhashed class the block carries.
  codeHeaders: ['[data-chat-flow] .md-code-block > div:has(> [data-code-block-banner])'],
})

/**
 * Opt-in flag: `<html data-dsh-view="mobile">`. The DSH Dock app's View ▸
 * Mobile stamps it (document-start script + live) so the phone rules apply
 * regardless of window width; anything else may set it the same way.
 */
export const MOBILE_FLAG_SELECTOR = 'html[data-dsh-view="mobile"]'

/** The user/steering bubble inside `userRow > userStack` (attachments row excluded). */
export const USER_BUBBLE_SELECTOR =
  ':is([data-chat-flow-kind="user"],[data-chat-flow-kind="steering"]) > [data-slot="conversation.chat.node"] > div > div:first-child > div:not([data-message-attachments])'

/**
 * Padding overrides for the boxed blocks inside the transcript, as
 * [selector, declarations]. Hooks are unhashed attributes where the client
 * has them; the two `[class*="_…"]` fallbacks name CSS-module locals the
 * way instance-identity does (`<hash>_<local>`), scoped under an attribute
 * so they cannot match outside their card.
 */
export const COMPACT_BLOCK_RULES = Object.freeze([
  // ui-primitives CodeBlock: `.block :where(pre){padding:16px}`.
  ['[data-chat-flow] .md-code-block pre', 'padding:8px 10px'],
  // ui-chat ContextInjectionRow `.body` (System prompt / injected context): 10 16 12 12.
  ['[data-chat-flow] [data-context-injection-body]', 'padding:6px 10px 8px 8px'],
  // ui-tool ToolRow / bash-sample `.ioSection` (the IN / OUT grid of a tool card): 12 16.
  ['[data-chat-flow] [data-tool] [class*="_ioSection"]', 'padding:8px 10px'],
  // ui-chat GenericCommandCard `pre.body` (slash-command output): 12 16.
  ['[data-chat-flow] [data-variant="others"] pre[class*="_body"]', 'padding:8px 10px'],
  // Markdown tables (`.tableScroll th/td`): 10 16.
  ['[data-chat-flow] table :is(th,td)', 'padding:6px 10px'],
  // Markdown blockquote: 14px indent beside the 2px bar.
  ['[data-chat-flow] blockquote', 'padding-left:8px'],
  // User bubble: 10 16.
  [USER_BUBBLE_SELECTOR, 'padding:8px 12px'],
])

/**
 * The style row's text for a configuration.
 * @param {PhoneUiConfig} config - validated config.
 * @returns {string} CSS, '' when every group is off.
 */
export function phoneStyle(config) {
  /** @type {{ selectors: string[], declarations: string }[]} */
  const rules = []
  const hidden = /** @type {(keyof typeof SELECTORS)[]} */ (Object.keys(SELECTORS))
    .filter(group => config[group])
    .flatMap(group => SELECTORS[group])
  if (hidden.length > 0) rules.push({ selectors: hidden, declarations: 'display:none' })
  if (config.sideMargin !== STOCK_SIDE_MARGIN) {
    // ChatView `.scroll` pads `calc(var(--dsh-composer-side-clearance) + 16px)`
    // (32px stock); the composer card sits at the clearance (16px). Both go to
    // the same value so the card stays flush with the text column. Two
    // attributes: `.body` defines the variable at class specificity and the
    // client's stylesheet is injected after this <style>, so a tie loses.
    rules.push({ selectors: ['[data-conversation-content][data-content-phase]'], declarations: `--dsh-composer-side-clearance:${config.sideMargin}px` })
    rules.push({ selectors: ['[data-conversation-scroll] div:has(> [data-chat-flow])'], declarations: `padding-left:${config.sideMargin}px;padding-right:${config.sideMargin}px` })
  }
  if (config.codeHeaders) {
    // With the banner gone the <pre>'s opaque fill would square off the
    // block's top corners (it only carries the bottom radii by default).
    rules.push({ selectors: ['[data-chat-flow] .md-code-block pre'], declarations: 'border-top-left-radius:var(--dsl-code-block-border-radius);border-top-right-radius:var(--dsl-code-block-border-radius)' })
  }
  if (config.halfRadius) {
    rules.push({ selectors: ['[data-chat-flow] .md-code-block'], declarations: '--dsl-code-block-border-radius:6px' })
    rules.push({ selectors: [USER_BUBBLE_SELECTOR], declarations: 'border-radius:11px' })
  }
  if (config.compactBlocks) {
    for (const [selector, declarations] of COMPACT_BLOCK_RULES) rules.push({ selectors: [selector], declarations })
  }
  if (rules.length === 0) return ''
  const render = (/** @type {string} */ prefix) =>
    rules.map(rule => `${rule.selectors.map(selector => prefix + selector).join(',')}{${rule.declarations}}`).join('')
  // Twice: once for real phones (the viewport query) and once under the
  // opt-in flag the Dock app's View ▸ Mobile stamps on <html>, so the phone
  // view can be chosen at any window width.
  return `@media (max-width:${config.maxWidth}px){${render('')}}${render(`${MOBILE_FLAG_SELECTOR} `)}`
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
  const groups = /** @type {const} */ (['header', 'messageActions', 'stats', 'codeHeaders', 'halfRadius', 'compactBlocks'])
    .filter(group => config[group])
  if (config.sideMargin !== STOCK_SIDE_MARGIN) groups.push(`sideMargin ${config.sideMargin}px`)
  ctx.logger.info(`phone-ui: ≤${config.maxWidth}px → ${style === '' ? 'nothing (disabled)' : groups.join(', ')}`)
}
