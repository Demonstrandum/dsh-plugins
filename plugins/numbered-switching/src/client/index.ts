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
 * REMOTE WORKSPACES — when dsh-remote-workspaces is loaded, its sessions
 * (framed from other DSH hosts) take part exactly like local ones: they are
 * numbered when viewed, evict and get evicted, and ⌘N brings their frame
 * back. The coupling is an OPTIONAL browser service that plugin provides
 * (`ctx.remoteWorkspaces`: getSelection / has / open / subscribe) plus the
 * `data-remote-session` attribute on its rows; `ctx.inject(['remoteWorkspaces'],
 * …)` runs that part only while the service exists and unwinds when the
 * plugin unloads. Without it, nothing here changes. Slot keys are
 * `local:<id>` / `remote:<ws>:<id>` (targets.ts).
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
 *   - Current LOCAL session: the Session Controller list row with
 *     `retainedBy.mainView > 0` (the same derivation the Workspace browser
 *     uses for its row highlight; selection itself is private to
 *     ui-workspace's UiWorkspaceService). It counts only while no global
 *     main panel is showing (`usePanelInfo().activePanelId === null`, read by
 *     a renderless `shell.overlay` entry): the retained local session does
 *     not become "viewed" because Settings or a remote frame covered it.
 *   - Current REMOTE session: `remoteWorkspaces.getSelection()` (defined
 *     only while the remote panel is on screen).
 *   - Every change of the current key is one `touch` of the slot model
 *     (slots.ts); vanished/archived holders are pruned on every update.
 *   - Switching: `ctx.uiWorkspace.openSession(id)` — the same verb a row
 *     click runs (the one UI navigation action; it also flips the main
 *     panel back to the Conversation if a panel like Settings was showing) —
 *     or `remoteWorkspaces.open(selection)` for a remote holder.
 *   - Badges: badges.ts patches the rendered rows (no per-row slot exists).
 *   - Chord: one capture-phase `keydown` on `window`, claimed with
 *     preventDefault before any editor keymap; `code: Digit1…` OR `key: '1'…`
 *     so a non-Latin layout and the numeric keypad both work.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions, SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only (erased): merges `ctx.uiWorkspace` into the cordis Context, the
// `mainView` reference source into SessionReferenceSourceMap, `ctx.slots`,
// and the `shell.overlay` slot + `usePanelInfo` root hook.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { useEffect } from 'react'
import { installBadges } from './badges.ts'
import { createSlotState, holderOf, prune, restoreSlotState, slotOf, touch, type SlotState } from './slots.ts'
import { decodeTarget, encodeTarget, type RemoteTarget } from './targets.ts'

export { createSlotState, holderOf, prune, restoreSlotState, slotOf, touch } from './slots.ts'
export { decodeTarget, encodeTarget } from './targets.ts'
export { fiberSessionId, rowKey } from './badges.ts'

/** Number of numbered slots (⌘1…⌘N). */
export const SLOT_COUNT = 5
/** sessionStorage key of the slot table (per window; dies with it). v2: encoded target keys. */
const STORAGE_KEY = 'tali.numbered-switching.v2'

/** The branded session id, derived from the list (avoids linking @deepseek-ai/dsh-session for one type). */
type SessionId = SessionListState['ids'][number]

/**
 * The optional service dsh-remote-workspaces provides as `ctx.remoteWorkspaces`
 * (structural copy of its `RemoteWorkspacesFace`; no build-time dependency).
 */
export interface RemoteWorkspacesFace {
  getSelection(): { workspaceId: string; sessionId: string } | undefined
  has(selection: { workspaceId: string; sessionId: string }): boolean
  open(selection: { workspaceId: string; sessionId: string }): void
  subscribe(listener: () => void): () => void
}

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
 * @returns its id, or undefined (New Session view).
 */
export function currentSessionOf(list: SessionListState): SessionId | undefined {
  return Object.values(list.byId).find(summary => (summary.retainedBy.mainView ?? 0) > 0)?.id
}

/**
 * What is on screen, as a slot key — or `'panel'` while a global panel other
 * than the remote frame shows (not a session view: nothing gets touched).
 * @param args.remote - the remote selection on screen, when the remote plugin reports one.
 * @param args.activePanelId - the layout's selected main panel (null = Conversation).
 * @param args.local - the retained local session.
 * @returns the current key, `'panel'`, or undefined for the New Session view.
 */
export function currentKeyOf(args: {
  remote: { workspaceId: string; sessionId: string } | undefined
  activePanelId: string | null
  local: string | undefined
}): string | 'panel' | undefined {
  if (args.remote !== undefined) return encodeTarget({ kind: 'remote', ...args.remote })
  if (args.activePanelId !== null) return 'panel'
  return args.local === undefined ? undefined : encodeTarget({ kind: 'local', sessionId: args.local })
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

/** Registration inject face of the panel watcher. */
interface PanelWatcherInjected {
  setActivePanel: (panelId: string | null) => void
}

/** Renders nothing; reports the layout's active main panel to apply. */
function PanelWatcher({ usePanelInfo, setActivePanel }: PropsRuntime<'shell.overlay'> & PanelWatcherInjected) {
  const activePanelId = usePanelInfo(info => info.activePanelId)
  useEffect(() => { setActivePanel(activePanelId) }, [activePanelId, setActivePanel])
  return null
}

export const name = 'numbered-switching-client'
export const inject = ['slots', 'sessions', 'workspaces', 'uiWorkspace', 'layout']

/**
 * Client plugin body.
 * @param ctx - browser-side cordis context.
 */
export function apply(ctx: Context): void {
  // An embedded shell (`?embed=<id>`, the chrome-less page dsh-remote-workspaces
  // frames for a remote session) is a SAME-ORIGIN iframe running this very
  // plugin, and iframes share the tab's sessionStorage: left running, the
  // framed instance would see its pinned session as current, prune every
  // other holder from the shared table and corrupt the outer window's
  // numbering. It has no sidebar and no chord of its own to serve; stay out.
  if (ctx.layout.embedSessionId !== undefined) {
    console.info('[numbered-switching] embedded shell: inactive')
    return
  }
  const sessions = ctx.get('sessions') as ISessions
  const workspaces = ctx.get('workspaces') as IWorkspaces

  let state = loadState()
  let current: string | 'panel' | undefined
  let activePanelId: string | null = null
  /** Present only while dsh-remote-workspaces is loaded (see the inject below). */
  let remote: RemoteWorkspacesFace | undefined

  const commit = (next: SlotState): void => {
    if (next === state) return
    state = next
    saveState(state)
    badges.update()
  }

  const badges = installBadges({
    numberOf: key => slotOf(state, key),
    tooltip: n => `${MODIFIER_GLYPH}${n}`,
    titles: () => {
      const list = sessions.list.getSnapshot()
      const map = new Map<string, string[]>()
      for (const id of list.ids) {
        const summary = list.byId[id]
        if (summary === undefined) continue
        const key = encodeTarget({ kind: 'local', sessionId: id })
        const keys = map.get(summary.displayTitle)
        if (keys === undefined) map.set(summary.displayTitle, [key])
        else keys.push(key)
      }
      return map
    },
  })
  ctx.effect(() => () => { badges.dispose() }, 'numbered-switching: gutter badges')

  /**
   * A holder may keep its slot while it is still listed (and not archived).
   * A remote holder is pruned only on positive evidence from the remote
   * plugin: while that plugin is absent (not installed, or mid-reload — its
   * service disappears for a moment during a bundle hot-swap, and at boot it
   * may come up after this one) the answer is "unknown", and unknown keeps
   * the slot. A stale remote key then just sits there without a row until
   * the LRU rule evicts it.
   */
  const isLive = (key: string): boolean => {
    const target = decodeTarget(key)
    if (target === undefined) return false
    if (target.kind === 'local') {
      const id = target.sessionId as SessionId
      return sessions.list.getSnapshot().ids.includes(id)
        && !workspaces.list.getSnapshot().archivedSessionIds.includes(id)
    }
    return remote === undefined ? true : remote.has(target)
  }

  // Follow what is on screen: bump/seat the current session, free the slots
  // of sessions that vanished or were archived.
  const follow = (): void => {
    let next = prune(state, isLive)
    const now = currentKeyOf({
      remote: remote?.getSelection(),
      activePanelId,
      local: currentSessionOf(sessions.list.getSnapshot()),
    })
    if (now !== current) {
      current = now
      if (now !== undefined && now !== 'panel') next = touch(next, now)
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

  // The layout's active panel, read through the only seam that exposes it
  // (the `usePanelInfo` root hook of slot components).
  const panelInjected = (): PanelWatcherInjected => ({
    setActivePanel: (panelId) => {
      if (panelId === activePanelId) return
      activePanelId = panelId
      follow()
    },
  })
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      { name: 'shell.overlay', id: 'tali-numbered-switching-panel-watcher', order: 1000, inject: panelInjected },
      PanelWatcher,
    ))

  // Optional: remote sessions join the numbering while dsh-remote-workspaces
  // is loaded. The scoped fiber starts when the service appears and is
  // disposed when it goes (remote holders then keep their slots, unopenable
  // and unbadged, until the plugin returns or the LRU rule evicts them).
  ctx.inject(['remoteWorkspaces'], (scoped) => {
    const face = scoped.get('remoteWorkspaces') as RemoteWorkspacesFace | undefined
    if (face === undefined) return
    scoped.effect(() => {
      remote = face
      const unsubscribe = face.subscribe(follow)
      follow()
      return () => {
        unsubscribe()
        remote = undefined
        follow()
      }
    }, 'numbered-switching: remote workspaces')
    console.info('[numbered-switching] remote workspaces joined the numbering')
  })

  const openKey = (key: string): void => {
    const target = decodeTarget(key)
    if (target === undefined) return
    if (target.kind === 'local') {
      ctx.uiWorkspace.openSession(target.sessionId as SessionId)
      return
    }
    const selection: RemoteTarget = target
    remote?.open({ workspaceId: selection.workspaceId, sessionId: selection.sessionId })
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) return
    const n = chordSlot(event, SLOT_COUNT)
    if (n === undefined) return
    // Claim the chord even for an empty slot: the page owns ⌘1…⌘N here.
    event.preventDefault()
    event.stopPropagation()
    const target = holderOf(state, n)
    if (target === undefined || target === current) return
    openKey(target)
  }
  ctx.effect(() => {
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, 'numbered-switching: keydown capture')

  console.info(`[numbered-switching] ${MODIFIER_GLYPH}1…${MODIFIER_GLYPH}${SLOT_COUNT} switch between the ${SLOT_COUNT} most recent sessions`)
}
