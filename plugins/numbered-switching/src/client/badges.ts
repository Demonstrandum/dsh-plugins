/**
 * Gutter badges: the slot number of each numbered session, drawn in the
 * sidebar row's leading indent (left of the status dot, so neither the dot
 * nor the title moves).
 *
 * WHY DOM PATCHING — the Workspace browser fills the `single`
 * `sidebar.workspaces` slot and offers no per-row slot (its only row seam is
 * `ctx.uiWorkspace.contributeSessionMenu`, a menu item). Same seam as the
 * session-title-slug plugin: patch the rendered rows and re-apply after React
 * re-renders (MutationObserver → one rAF-coalesced reconcile).
 *
 * ROW → SLOT KEY (targets.ts) — the local row DOM carries no id (Rows.tsx
 * renders `role="treeitem" aria-selected` with class-module names only), and
 * rows are ordered by manual order or recency, so position is no key either.
 * Routes, in order:
 *   0. `data-remote-session="<ws>:<id>"` — a dsh-remote-workspaces row; the
 *      attribute is that plugin's published row identity → `remote:` key.
 *   1. React's fiber expando (`__reactFiber$…`) on the row element: walk
 *      `.return` a few levels to `SessionNodeItem`, whose `node` prop is the
 *      SessionNode (`{ id, title, blank, … }`). Stable since React 16.
 *   2. Fallback: the row's `_title` span text matched against the list's
 *      `displayTitle`, accepted only when exactly one listed session and
 *      exactly one visible row carry that title.
 * A row that resolves to nothing simply gets no badge.
 *
 * GEOMETRY — a local session row is `padding-inline-start: calc(8px +
 * var(--dsh-workspace-indent))` (`depth * 12px`; 0 under a top-level
 * Workspace), a remote row `padding: 0 8px`; then a 16px status slot, then
 * the title. The badge is absolutely positioned over exactly that padding
 * box — its width is read from the row's computed `padding-inline-start` at
 * reconcile time, so the digit is centered in the 8px gutter left of the
 * status dot (20px under a nested Workspace) and the row's own layout is
 * untouched. The row gets `position: relative` inline while it carries a
 * badge (Rows.module.css sets the same value for its drag markers, so
 * nothing else changes).
 *
 * CSS-module classes are built `[hash]_[local]`, so `[class$="_title"]` is a
 * stable selector; ghost rows from session-title-slug (`data-tdsn-ghost`) are
 * clones without fibers and are skipped explicitly; search-result rows are
 * `<button role="treeitem">` and are skipped too (different layout, and
 * their fiber carries `result`, not `node`).
 */

const BADGE_ATTR = 'data-tns-badge'
const POSITIONED_ATTR = 'data-tns-positioned'
const STYLE_ID = 'tali-numbered-switching-style'
const ROW_SELECTOR = 'div[role="treeitem"][aria-selected]'
const GHOST_WRAPPER_SELECTOR = '[data-tdsn-ghost]'
/** dsh-remote-workspaces row identity (`<workspaceId>:<sessionId>`). */
const REMOTE_ROW_ATTR = 'data-remote-session'

const STYLE_TEXT = `
[${BADGE_ATTR}] {
  position: absolute;
  inset-block: 0;
  inset-inline-start: 0;
  width: 8px; /* overwritten per row from its computed padding */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: ui-monospace, Menlo, monospace;
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-tertiary);
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
}
[role="treeitem"][aria-selected="true"] > [${BADGE_ATTR}] {
  color: var(--dsw-alias-label-secondary);
}
`

/** What the reconciler needs from the data layer. */
export interface BadgeInputs {
  /** 1-based slot number of a slot key (targets.ts), or undefined for unnumbered ones. */
  numberOf: (key: string) => number | undefined
  /** Listed local sessions by display title → slot keys (for the title fallback). */
  titles: () => ReadonlyMap<string, readonly string[]>
  /** Tooltip text for slot `n` (e.g. "⌘3"). */
  tooltip: (n: number) => string
}

import { encodeTarget, remoteKeyOfFrameKey } from './targets.ts'

interface FiberLike {
  memoizedProps?: unknown
  return?: FiberLike | null
}

function isSessionNode(value: unknown): value is { id: string } {
  return typeof value === 'object' && value !== null
    && typeof (value as { id?: unknown }).id === 'string'
    && typeof (value as { blank?: unknown }).blank === 'boolean'
    && typeof (value as { title?: unknown }).title === 'string'
}

/**
 * Resolve a row's session id through React's fiber tree.
 * @param row - the session row element.
 * @returns the id, or undefined when the expando or the `node` prop is missing.
 */
export function fiberSessionId(row: HTMLElement): string | undefined {
  const key = Object.keys(row).find(k => k.startsWith('__reactFiber$'))
  if (key === undefined) return undefined
  let fiber = (row as unknown as Record<string, FiberLike | null | undefined>)[key]
  for (let depth = 0; fiber !== undefined && fiber !== null && depth < 12; depth++) {
    const props = fiber.memoizedProps
    const node = typeof props === 'object' && props !== null ? (props as { node?: unknown }).node : undefined
    if (isSessionNode(node)) return node.id
    fiber = fiber.return
  }
  return undefined
}

function rowTitle(row: HTMLElement): string | undefined {
  return row.querySelector(':scope > span[class$="_title"]')?.textContent ?? undefined
}

/** Fallback: a title that names exactly one listed session and exactly one visible row. */
function titleKey(row: HTMLElement, rows: readonly HTMLElement[], titles: ReadonlyMap<string, readonly string[]>): string | undefined {
  const title = rowTitle(row)
  if (title === undefined) return undefined
  const ids = titles.get(title)
  if (ids === undefined || ids.length !== 1) return undefined
  if (rows.filter(other => rowTitle(other) === title).length !== 1) return undefined
  return ids[0]
}

/**
 * The slot key a row stands for (remote attribute, fiber, title fallback).
 * @param row - a session row element.
 * @param rows - every visible session row (title-uniqueness check).
 * @param titles - lazily built title map for the fallback.
 * @returns the key, or undefined when the row cannot be identified.
 */
export function rowKey(row: HTMLElement, rows: readonly HTMLElement[], titles: () => ReadonlyMap<string, readonly string[]>): string | undefined {
  const remote = row.getAttribute(REMOTE_ROW_ATTR)
  if (remote !== null) return remoteKeyOfFrameKey(remote)
  const sessionId = fiberSessionId(row)
  if (sessionId !== undefined) return encodeTarget({ kind: 'local', sessionId })
  return titleKey(row, rows, titles())
}

function sessionRows(): HTMLElement[] {
  const out: HTMLElement[] = []
  for (const row of document.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    if (row.closest(GHOST_WRAPPER_SELECTOR) !== null) continue
    out.push(row)
  }
  return out
}

function ensureStyle(): HTMLStyleElement {
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (style === null) {
    style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = STYLE_TEXT
    document.head.append(style)
  }
  return style
}

function setBadge(row: HTMLElement, n: number, tooltip: string): void {
  let badge = row.querySelector<HTMLElement>(`:scope > [${BADGE_ATTR}]`)
  if (badge === null) {
    badge = document.createElement('span')
    badge.setAttribute(BADGE_ATTR, '')
    badge.setAttribute('aria-hidden', 'true')
    row.prepend(badge)
  }
  const text = String(n)
  if (badge.textContent !== text) badge.textContent = text
  if (badge.title !== tooltip) badge.title = tooltip
  // The gutter is the row's own leading padding (8px on a local row under a
  // top-level Workspace and on a remote row; 12px more per nesting level).
  const gutter = getComputedStyle(row).paddingInlineStart
  if (gutter !== '' && badge.style.width !== gutter) badge.style.width = gutter
  if (!row.hasAttribute(POSITIONED_ATTR)) {
    // Remember whether we set it, so the clear path restores only our own write.
    if (row.style.position === '') row.style.position = 'relative'
    row.setAttribute(POSITIONED_ATTR, row.style.position === 'relative' ? 'ours' : 'theirs')
  }
}

function clearBadge(row: HTMLElement): void {
  row.querySelector(`:scope > [${BADGE_ATTR}]`)?.remove()
  if (row.getAttribute(POSITIONED_ATTR) === 'ours') row.style.position = ''
  row.removeAttribute(POSITIONED_ATTR)
}

/**
 * Install the badge reconciler.
 * @param inputs - number lookup, title fallback data, tooltip text.
 * @returns `update()` to re-sync after a slot change, and `dispose()`.
 */
export function installBadges(inputs: BadgeInputs): { update: () => void; dispose: () => void } {
  let frame: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const style = ensureStyle()

  const sync = (): void => {
    frame = undefined
    timer = undefined
    const rows = sessionRows()
    let titles: ReadonlyMap<string, readonly string[]> | undefined
    const lazyTitles = (): ReadonlyMap<string, readonly string[]> => (titles ??= inputs.titles())
    for (const row of rows) {
      const key = rowKey(row, rows, lazyTitles)
      const n = key === undefined ? undefined : inputs.numberOf(key)
      if (n === undefined) clearBadge(row)
      else setBadge(row, n, inputs.tooltip(n))
    }
    // Badges orphaned outside a session row (should not happen; defensive).
    for (const stray of document.querySelectorAll(`[${BADGE_ATTR}]`)) {
      if (!(stray.parentElement?.matches(ROW_SELECTOR) ?? false)) stray.remove()
    }
  }
  // One reconcile per frame. A hidden document (background window, occluded
  // Dock app) never gets a frame, so fall back to a timer there: the badges
  // must be right the moment the page is seen again.
  const schedule = (): void => {
    if (frame !== undefined || timer !== undefined) return
    if (document.hidden) timer = setTimeout(sync, 0)
    else frame = window.requestAnimationFrame(sync)
  }

  // Our own writes echo through the observer; setBadge/clearBadge are
  // idempotent, so the second pass settles without further mutations.
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-selected', 'aria-expanded'],
  })
  schedule()

  return {
    update: schedule,
    dispose: () => {
      observer.disconnect()
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      if (timer !== undefined) clearTimeout(timer)
      for (const row of document.querySelectorAll<HTMLElement>(`[${POSITIONED_ATTR}]`)) clearBadge(row)
      for (const badge of document.querySelectorAll(`[${BADGE_ATTR}]`)) badge.remove()
      style.remove()
    },
  }
}
