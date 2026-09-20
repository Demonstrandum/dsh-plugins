/**
 * tali-numbered-switching — browser half.
 *
 * FEATURE — the five most recently viewed sessions hold the numbers 1…5.
 * ⌘1…⌘5 (Ctrl on non-Apple platforms) switch to the holder of that number;
 * the number is drawn in the sidebar gutter left of each holder's title.
 * Numbers are stable: a session keeps its number while it stays in the
 * recent set. Opening a sixth (novel) session — by click, search, or New
 * Session (+) — evicts the LEAST RECENTLY VIEWED holder and takes its
 * number. Pure browser state: nothing is persisted on the host; the slot
 * table lives in `sessionStorage` so a page reload (⌘R after a plugin
 * install) keeps the numbering for this window.
 *
 * WHERE IT WORKS — the DSH Dock app (`~/Applications/DSH.app`, a WKWebView
 * wrapper whose menu bar defines no ⌘digit equivalents, so the chords reach
 * the page). Real browsers reserve ⌘1…⌘9 for tabs/bookmarks (Chrome: tab
 * N; Safari: Favorites) and never deliver them to web content — nothing a
 * page can do about it, as with ⌘, (see settings-shortcut). The badges are
 * drawn everywhere regardless: they are a useful "recent five" marker even
 * where the chord is taken.
 *
 * HOW
 *   - Current session: the Session Controller list row with
 *     `retainedBy.mainView > 0` (the same derivation the Workspace browser
 *     uses for its row highlight; selection itself is private to
 *     ui-workspace's UiWorkspaceService). Every change of that id is one
 *     `touch` of the slot model (slots.ts).
 *   - Switching: `ctx.uiWorkspace.openSession(id)` — the same verb a row
 *     click runs (the one UI navigation action; it also flips the main
 *     panel back to the Conversation if a panel like Settings was showing).
 *   - Badges: badges.ts patches the rendered rows (no per-row slot exists).
 *   - Chord: one capture-phase `keydown` on `window`, claimed with
 *     preventDefault before any editor keymap; `code: Digit1…` OR `key: '1'…`
 *     so a non-Latin layout and the numeric keypad both work.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions, SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
// Type-only (erased): merges `ctx.uiWorkspace` into the cordis Context, and
// the `mainView` reference source into SessionReferenceSourceMap.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { installBadges } from './badges.ts'
import { createSlotState, holderOf, prune, restoreSlotState, slotOf, touch, type SlotState } from './slots.ts'

export { createSlotState, holderOf, prune, restoreSlotState, slotOf, touch } from './slots.ts'
export { fiberSessionId } from './badges.ts'

/** Number of numbered slots (⌘1…⌘N). */
export const SLOT_COUNT = 5
/** sessionStorage key of the slot table (per window; dies with it). */
const STORAGE_KEY = 'tali.numbered-switching.v1'

/** The branded session id, derived from the list (avoids linking @deepseek-ai/dsh-session for one type). */
type SessionId = SessionListState['ids'][number]

const IS_APPLE = /Mac|iPhone|iPad|iPod/.test(navigator.platform) || /Macintosh/.test(navigator.userAgent)
const MODIFIER_GLYPH = IS_APPLE ? '⌘' : 'Ctrl+'

/**
 * The slot number a keydown addresses: primary modifier + a digit 1…count,
 * no other modifier, not a key repeat.
 * @param event - the keydown.
 * @param count - number of slots in force.
 * @returns 1…count, or undefined when the event is not one of our chords.
 */
export function chordSlot(event: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat'>, count = SLOT_COUNT): number | undefined {
  if (event.repeat || event.altKey || event.shiftKey) return undefined
  const primary = IS_APPLE ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (!primary) return undefined
  const fromCode = /^(?:Digit|Numpad)([1-9])$/u.exec(event.code)?.[1]
  const digit = fromCode ?? (/^[1-9]$/u.test(event.key) ? event.key : undefined)
  if (digit === undefined) return undefined
  const n = Number(digit)
  return n <= count ? n : undefined
}

/**
 * The session shown in the main view, per the list's local reference counts.
 * @param list - Session Controller list snapshot.
 * @returns its id, or undefined (New Session view, or a panel is showing).
 */
export function currentSessionOf(list: SessionListState): SessionId | undefined {
  return Object.values(list.byId).find(summary => (summary.retainedBy.mainView ?? 0) > 0)?.id
}

function loadState(): SlotState {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (raw !== null) {
      const restored = restoreSlotState(JSON.parse(raw), SLOT_COUNT)
      if (restored !== undefined) return restored
    }
  } catch {
    // Storage disabled or corrupt: start empty.
  }
  return createSlotState(SLOT_COUNT)
}

function saveState(state: SlotState): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Storage disabled: numbering simply does not survive a reload.
  }
}

export const name = 'numbered-switching-client'
export const inject = ['sessions', 'workspaces', 'uiWorkspace']

/**
 * Client plugin body.
 * @param ctx - browser-side cordis context.
 */
export function apply(ctx: Context): void {
  const sessions = ctx.get('sessions') as ISessions
  const workspaces = ctx.get('workspaces') as IWorkspaces

  let state = loadState()
  let current: SessionId | undefined
  const commit = (next: SlotState): void => {
    if (next === state) return
    state = next
    saveState(state)
    badges.update()
  }

  const badges = installBadges({
    numberOf: id => slotOf(state, id),
    tooltip: n => `${MODIFIER_GLYPH}${n}`,
    titles: () => {
      const list = sessions.list.getSnapshot()
      const map = new Map<string, string[]>()
      for (const id of list.ids) {
        const summary = list.byId[id]
        if (summary === undefined) continue
        const ids = map.get(summary.displayTitle)
        if (ids === undefined) map.set(summary.displayTitle, [id])
        else ids.push(id)
      }
      return map
    },
  })
  ctx.effect(() => () => { badges.dispose() }, 'numbered-switching: gutter badges')

  // Follow the selection and the catalog: bump/seat the current session,
  // free the slots of sessions that vanished or were archived.
  const follow = (): void => {
    const list = sessions.list.getSnapshot()
    const archived = workspaces.list.getSnapshot().archivedSessionIds
    let next = prune(state, id => list.ids.includes(id as SessionId) && !archived.includes(id as SessionId))
    const now = currentSessionOf(list)
    if (now !== current) {
      current = now
      if (now !== undefined) next = touch(next, now)
    }
    commit(next)
  }
  ctx.effect(() => {
    const unsubscribeSessions = sessions.list.subscribe(follow)
    const unsubscribeWorkspaces = workspaces.list.subscribe(follow)
    follow()
    return () => {
      unsubscribeSessions()
      unsubscribeWorkspaces()
    }
  }, 'numbered-switching: follow selection')

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) return
    const n = chordSlot(event, SLOT_COUNT)
    if (n === undefined) return
    // Claim the chord even for an empty slot: the page owns ⌘1…⌘N here.
    event.preventDefault()
    event.stopPropagation()
    const target = holderOf(state, n)
    if (target === undefined || target === current) return
    ctx.uiWorkspace.openSession(target as SessionId)
  }
  ctx.effect(() => {
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, 'numbered-switching: keydown capture')

  console.info(`[numbered-switching] ${MODIFIER_GLYPH}1…${MODIFIER_GLYPH}${SLOT_COUNT} switch between the ${SLOT_COUNT} most recent sessions`)
}
