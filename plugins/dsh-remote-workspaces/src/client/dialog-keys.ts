/**
 * Keyboard for a confirm dialog built on the shipped `Modal`: **Enter fires
 * the default action** — the primary `Button` marked `{...DIALOG_DEFAULT}` —
 * and Escape the Modal already turns into `onClose`.
 *
 * Why: the shipped Modal neither moves focus into the dialog nor handles
 * Enter, so Enter went to whatever had focus before it opened (the composer,
 * after a slash command) and visibly did nothing. On open this hook moves
 * focus to the default button — or, while that is disabled, to the dialog
 * card itself — and puts focus back where it was when the dialog closes.
 *
 * Enter is left alone where it already means something: a focused button or
 * link (the browser clicks it — no double fire), a textarea / contenteditable
 * inside the dialog (newline), a menu / listbox row, an open shipped `Menu`
 * popup, an IME composition, and any handler that already called
 * `preventDefault` (inputs with their own Enter → confirm). Shift/Alt/Ctrl
 * opt out; plain Enter and ⌘Enter confirm. A disabled default button means
 * Enter does nothing, exactly like a click.
 *
 * Identical copies live in every plugin with such a dialog (each bundles its
 * own client half, cross-plugin runtime imports are forbidden) — keep them in
 * sync: reboot-command, import-api-keys, import-sessions, dsh-remote-workspaces.
 */
import { useEffect, useRef } from 'react'

/** Spread onto the ONE primary `Button` of the dialog: `<Button variant="primary" {...DIALOG_DEFAULT}>`. */
export const DIALOG_DEFAULT = { 'data-dialog-default': '' } as const

const DIALOG = '[role="dialog"][aria-modal="true"]'
const DEFAULT_BUTTON = 'button[data-dialog-default]'
/** Focus here owns Enter natively or semantically; the hook stays out of the way. */
const OWNS_ENTER = 'button, a[href], textarea, select, summary, [role="button"], [role="menuitem"], [role="option"], [role="menu"], [role="listbox"], [role="combobox"]'

/** The topmost modal dialog in the document (portaled last = on top). */
function topDialog(): HTMLElement | undefined {
  const all = document.querySelectorAll<HTMLElement>(DIALOG)
  return all[all.length - 1]
}

/**
 * Wire Enter → default action and focus management for the dialog this
 * component renders while `open`. `stage` re-runs the focus pull when the
 * dialog's content changes underneath (multi-step flows, a swapped Modal).
 */
export function useDialogDefaultAction(open: boolean, stage?: unknown): void {
  const restore = useRef<Element | null>(null)

  // Remember what had focus before the dialog and give it back on close/unmount.
  useEffect(() => {
    if (!open) return
    restore.current = document.activeElement
    return () => {
      const before = restore.current
      restore.current = null
      const active = document.activeElement
      if (before instanceof HTMLElement && before.isConnected && (active === null || active === document.body)) {
        before.focus({ preventScroll: true })
      }
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const dialog = topDialog()
    if (dialog === undefined) return

    // Pull focus into the dialog unless something inside it already has it.
    // Retried over the next ~200 ms: a dialog opened from a slash command races
    // the command popup's settle path, whose Lexical `editor.focus()` lands
    // asynchronously AFTER this effect and would otherwise take the keyboard
    // back to the composer behind the mask.
    const pull = (): void => {
      const active = document.activeElement
      if (active !== null && active !== document.body && dialog.contains(active) && active !== dialog) return
      const button = dialog.querySelector<HTMLButtonElement>(DEFAULT_BUTTON)
      if (button !== null && !button.disabled) {
        button.focus({ preventScroll: true })
      } else if (active !== dialog) {
        if (!dialog.hasAttribute('tabindex')) dialog.tabIndex = -1
        dialog.style.outline = 'none'
        dialog.focus({ preventScroll: true })
      }
    }
    pull()
    const timers = [0, 50, 200].map(ms => setTimeout(pull, ms))

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' || event.defaultPrevented || event.isComposing) return
      if (event.altKey || event.ctrlKey || event.shiftKey) return
      if (!dialog.isConnected || topDialog() !== dialog) return
      const target = event.target instanceof HTMLElement ? event.target : null
      if (target !== null) {
        if (target.closest(OWNS_ENTER) !== null) return
        if (dialog.contains(target) && target.isContentEditable) return
      }
      // A shipped Menu popup (portaled, transient) is open: Enter picks its row.
      if (document.querySelector('[role="menu"]') !== null) return
      const action = dialog.querySelector<HTMLButtonElement>(DEFAULT_BUTTON)
      if (action === null || action.disabled) return
      event.preventDefault()
      action.click()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      for (const timer of timers) clearTimeout(timer)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, stage])
}
