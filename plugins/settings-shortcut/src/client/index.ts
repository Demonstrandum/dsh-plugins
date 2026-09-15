/**
 * tali-settings-shortcut — browser half.
 *
 * One capture-phase `keydown` listener on `window`: ⌘. (Ctrl+. on non-Apple
 * platforms) toggles the shell's Settings panel.
 *
 * WHY ⌘. AND NOT ⌘, — Safari (and a Dock-installed Safari web app) resolves
 * ⌘, as the app's own Settings… menu equivalent BEFORE WebKit dispatches the
 * key to the page: the page never receives a keydown, so no web code can
 * override it (VS Code hit the same wall for vscode.dev, microsoft/vscode
 * #149478). Chrome does deliver ⌘, to the page, but the goal is one chord for
 * both browsers. ⌘. was verified with real OS-level keystrokes (System
 * Events) to reach the page and be `preventDefault`-able in both Safari
 * Technology Preview and Chrome — Safari's View ▸ Stop equivalent does not
 * take precedence.
 *
 * WHY DOM CLICKS — the settings shell (ui-settings-general SettingsRoot)
 * keeps its open state as component-local React state: no store, no slot,
 * no host RPC opens it. The only seam is the trigger button in the sidebar
 * foot. The shell build names CSS-module classes `[hash]_[local]`, so the
 * `_settingsArea` / `_trigger` / `_close` suffixes are stable across rebuilds
 * even though the hash prefix is not. Open state is the trigger's
 * `aria-expanded`; closing clicks the dialog's own close button so the
 * shell's focus-restore path runs exactly as for a mouse close.
 */
import type { Context } from '@deepseek-ai/cordis'

/** The trigger lives in the sidebar foot's settings area (ui-sidebar SidebarRoot). */
const TRIGGER_SELECTOR = '[class$="_settingsArea"] button[aria-haspopup="dialog"]'
/** Fallback if the sidebar wrapper changes: the shell's own trigger class. */
const TRIGGER_FALLBACK_SELECTOR = 'button[aria-haspopup="dialog"][class*="_trigger"]'
/** The panel's header close button (SettingsPanel). */
const CLOSE_SELECTOR = '[role="dialog"][class$="_panel"] button[class$="_close"]'

const IS_APPLE = /Mac|iPhone|iPad|iPod/.test(navigator.platform)
  || /Macintosh/.test(navigator.userAgent)

/** True for exactly the shortcut chord: primary modifier + period, nothing else. */
export function isSettingsChord(event: KeyboardEvent): boolean {
  if (event.repeat || event.altKey || event.shiftKey) return false
  const primary = IS_APPLE ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (!primary) return false
  // `key` follows the keyboard layout (a non-Latin layout may still report
  // '.' for the period key under ⌘); `code` covers the physical key and the
  // numeric keypad's decimal (which is how System Events synthesizes ⌘.).
  return event.key === '.' || event.code === 'Period' || event.code === 'NumpadDecimal'
}

function findTrigger(): HTMLButtonElement | undefined {
  const primary = document.querySelector<HTMLButtonElement>(TRIGGER_SELECTOR)
  if (primary !== null) return primary
  const fallback = document.querySelector<HTMLButtonElement>(TRIGGER_FALLBACK_SELECTOR)
  return fallback ?? undefined
}

/** Toggle the panel; returns what happened for the console trace. */
export function toggleSettings(): 'opened' | 'closed' | 'no-trigger' | 'no-close' {
  const trigger = findTrigger()
  if (trigger === undefined) return 'no-trigger'
  if (trigger.getAttribute('aria-expanded') === 'true') {
    const close = document.querySelector<HTMLButtonElement>(CLOSE_SELECTOR)
    if (close === null) return 'no-close'
    close.click()
    return 'closed'
  }
  trigger.click()
  return 'opened'
}

export const name = 'settings-shortcut-client'
export const inject: string[] = []

export function apply(ctx: Context): void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || !isSettingsChord(event)) return
    // Claim the chord before the browser's own equivalent (Safari: Stop) and
    // before any editor keymap sees it.
    event.preventDefault()
    event.stopPropagation()
    const outcome = toggleSettings()
    if (outcome === 'no-trigger' || outcome === 'no-close') {
      console.warn(`[settings-shortcut] ${outcome}: settings shell markup not found (selectors may need updating)`)
    }
  }

  ctx.effect(() => {
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, 'settings-shortcut: keydown capture')

  console.info(`[settings-shortcut] ${IS_APPLE ? '⌘.' : 'Ctrl+.'} toggles Settings`)
}
