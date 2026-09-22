/**
 * tali-phone-ui — browser half: the mobile composer.
 *
 * In mobile mode (`<html data-dsh-view="mobile">` from the Dock app's View ▸
 * Mobile, or a viewport at most `--tali-phone-ui-max-width` wide — the host
 * half publishes that variable from its `maxWidth` config) the stock
 * composer card is replaced by a "tongue": a small grey tab flush with the
 * bottom edge, centred, carrying the send arrow and — while the agent runs —
 * a red stop square. Tapping the arrow opens a full-screen text entry over
 * the transcript: plain textarea (Enter = newline, no placeholder, no slash
 * menu, no attach / permission / model controls), a minimise button that
 * folds it back into the tongue, and an explicit Send button. Send writes the
 * text through the session's public input actions (`setDraft` + `submit`),
 * so admission, queueing while a turn runs and steering all behave exactly
 * as a stock submission does.
 *
 * Mounted on `conversation.input.dock` (list, session scope) — a seat inside
 * the composer stack that gives the component the session's standard props
 * (`useSession`, `useInput`, `inputActions`, `sessionId`) — but it renders
 * through portals to <body>, so it floats over the page regardless of the
 * composer seat's geometry. While it is active it stamps
 * `<html data-tali-phone-composer>`; the stylesheet installed by `apply`
 * hides the stock composer bar under that attribute only, so if this bundle
 * is absent or fails, the normal composer stays usable.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: `ctx.slots` (ui-renderer) and the conversation slot declarations (conversation.input.dock).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { MobileComposer, type MobileComposerInjected } from './MobileComposer.tsx'

export const name = 'phone-ui'

export const inject = ['slots', 'sessions']

const HTML_FLAG = 'data-tali-phone-composer'

const STYLE = `
/* The outlet itself carries an inline display:contents; hide what it renders. */
html[${HTML_FLAG}] [data-slot="conversation.composer.bar"] > * { display: none }
/* Reserve the tongue's height at the end of the transcript. */
html[${HTML_FLAG}] [data-composer-seat] { min-height: 48px }
/* ChatView's back-to-bottom control (the .toBottomSlot after the message
   column): bottom-right corner, level with the tongue, instead of the desktop
   position above the composer card at the content column's right edge. */
html[${HTML_FLAG}] [data-conversation-scroll] [data-chat-flow] + div { justify-content: flex-end; padding-left: 0; padding-right: 8px; bottom: 8px }
`

/**
 * @param ctx - browser-plane plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.id = 'tali-phone-ui-composer'
    style.textContent = STYLE
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'phone-ui: composer stylesheet')

  const sessions = ctx.get('sessions') as ISessions
  const injected: MobileComposerInjected = {
    htmlFlag: HTML_FLAG,
    cancel: (sessionId) => {
      const conversation = sessions.scope(sessionId)?.get('conversation')
      if (conversation === undefined) return Promise.resolve()
      return conversation.cancel().then(() => undefined, () => undefined)
    },
  }

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'tali-phone-ui-composer',
    order: 0,
    inject: () => injected,
  }, MobileComposer))
}
