/**
 * Per-session QR code: a QR-glyph button in the Session header's utilities
 * row (top right, beside the right-dock toggle) that opens a small panel with
 * a QR code and link for THIS Session on another device — the chrome-less
 * `?embed=<sessionId>` page (DSH branch `feat/embed-session`, the same page
 * the remote-workspaces iframe frames) at the tailnet route this plugin
 * publishes. Scanning it on a phone shows that one Session: no sidebar, no
 * other sessions, composer and approvals intact.
 *
 * Two flavours of link, one checkbox ("Only you", ticked by default) apart:
 *   • ticked: `?embed=…` only — the device must be admitted by its Tailscale
 *     login (allow list), i.e. it is you on your phone. Nothing to leak; the
 *     only option when the token is unavailable (the control channel answers
 *     403 off-host);
 *   • unticked: the standing access token rides along (`?token=…&embed=…`;
 *     the proxy exchanges it for its cookie and keeps `embed` across the
 *     redirect) — works on any device, and is exactly as powerful as the
 *     Settings QR code: the device is admitted to the whole DSH GUI, the
 *     `embed` selector is a presentation choice, not a permission.
 * The link itself is never shown; clicking the QR code copies it.
 *
 * Facts the link relies on: the public URL and token come from the host
 * half's `status` snapshot (operators only). Off the host — a tailnet tab, a
 * direct-remote Dock app — the document's own directory IS the public URL,
 * so the panel falls back to it, token-less. The Session id keeps its
 * `session-` prefix (a bare UUID silently shows the blank hero).
 */
import type { CSSProperties, ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { renderSVG } from 'uqr'
import { Checkbox, Tooltip, useDismissOnOutsidePointer, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only (erased at build): the `conversation.session.header.utilities` slot declaration.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { RemoteApi, RemoteStatus } from './index.tsx'

/** Query parameter the embedded shell reads (`packages/client/web/src/embed.ts`). */
export const EMBED_QUERY = 'embed'
const TOKEN_QUERY = 'token'

export interface SessionQrInjected {
  api: RemoteApi
  /** The GUI's own document directory, e.g. `https://node.ts.net/dsh/` — the fallback base when the host is unreachable. */
  documentBase: string
}

export type SessionQrActionProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & InjectFace<SessionQrInjected>

/** What the panel needs from the host: the public base URL and, when readable, the standing token. */
export interface SessionLinkFacts {
  /** Public directory URL of this GUI, with trailing slash; undefined when the route is off and no fallback is usable. */
  base?: string
  /** The standing access token, undefined when the caller may not read it (off-host) or the route is off. */
  token?: string
  /** Why there is no usable base, for the panel to say. */
  problem?: string
  /** Where the base came from. */
  source: 'host' | 'document' | 'none'
}

/** True for `http://127.0.0.1:3080/`-style bases a phone could never reach. */
export function isLoopbackBase(base: string): boolean {
  try {
    const host = new URL(base).hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host.startsWith('127.') || host === '[::1]' || host === '::1' || host.endsWith('.localhost')
  } catch {
    return true
  }
}

/**
 * Derive the link facts from the host's status (or its failure) and the
 * document's own URL. Pure, for tests.
 * @param status - the host snapshot, or undefined when the control channel refused/failed.
 * @param documentBase - `new URL('./', document.baseURI).href` of the GUI.
 */
export function sessionLinkFacts(status: RemoteStatus | undefined, documentBase: string): SessionLinkFacts {
  if (status !== undefined) {
    if (status.url !== undefined && status.enabled && status.route === 'active') {
      const base = status.url.endsWith('/') ? status.url : `${status.url}/`
      let token: string | undefined
      if (status.tokenUrl !== undefined) {
        try { token = new URL(status.tokenUrl).searchParams.get(TOKEN_QUERY) ?? undefined } catch { token = undefined }
      }
      return { base, token, source: 'host' }
    }
    if (!isLoopbackBase(documentBase)) return { base: documentBase, source: 'document' }
    return { source: 'none', problem: status.enabled ? 'The Tailscale route is not active — check Settings ▸ Tailscale remote.' : 'Tailscale remote is disabled — enable it in Settings ▸ Tailscale remote to share sessions with other devices.' }
  }
  if (!isLoopbackBase(documentBase)) return { base: documentBase, source: 'document' }
  return { source: 'none', problem: 'This page is served on loopback and the Tailscale remote status is unavailable, so there is no address another device could reach.' }
}

/**
 * The link for one Session.
 * @param base - public directory URL with trailing slash.
 * @param sessionId - full Session id (`session-…`).
 * @param token - include the standing token, or undefined for an identity-only link.
 */
export function sessionLink(base: string, sessionId: string, token: string | undefined): string {
  const params = new URLSearchParams()
  // Token first: the proxy exchanges it on `/` and redirects to the rest.
  if (token !== undefined) params.set(TOKEN_QUERY, token)
  params.set(EMBED_QUERY, sessionId)
  return `${base}?${params.toString()}`
}

function qrSvg(text: string): string | undefined {
  try {
    return renderSVG(text, { ecc: 'M', border: 1 })
  } catch {
    return undefined
  }
}

const styles = {
  root: { position: 'relative', display: 'inline-flex', flex: 'none' } as CSSProperties,
  button: {
    display: 'inline-flex', flex: 'none', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, padding: 6,
    color: 'var(--dsw-alias-label-secondary)', background: 'transparent', border: 'none', borderRadius: 28, cursor: 'pointer',
  } as CSSProperties,
  buttonOpen: { background: 'var(--dsw-alias-interactive-bg-hover)' } as CSSProperties,
  panel: {
    position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 100, boxSizing: 'border-box',
    // Exactly the QR tile plus the padding: no side margins around the code.
    width: 208 + 2 * 14, maxWidth: 'calc(100vw - 24px)', padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
    borderRadius: 16, background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-module-platform))',
    border: '0.5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l4))', boxShadow: '0 8px 28px rgba(0,0,0,0.28)',
    color: 'var(--dsw-alias-label-primary)', fontSize: 12, lineHeight: '18px', textAlign: 'left', cursor: 'default',
  } as CSSProperties,
  // Bold, but sized so the title fits the 208px tile on one line.
  title: { fontSize: 12.5, lineHeight: '18px', fontWeight: 600, whiteSpace: 'nowrap' } as CSSProperties,
  caption: { fontSize: 11.5, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' } as CSSProperties,
  qrWrap: { alignSelf: 'center', width: 208, height: 208, padding: 8, boxSizing: 'border-box', borderRadius: 12, background: '#fff', border: '0.5px solid var(--dsw-alias-border-l4)', cursor: 'copy' } as CSSProperties,
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 22 } as CSSProperties,
  error: { color: 'var(--dsw-alias-state-error-primary)' } as CSSProperties,
}

/** A QR-code glyph: four finder squares and a few modules, 16 × 16 viewBox. */
function IconQr(): ReactNode {
  return (
    <svg width={15} height={15} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.5" y="1.5" width="5" height="5" rx="1" />
      <rect x="9.5" y="1.5" width="5" height="5" rx="1" />
      <rect x="1.5" y="9.5" width="5" height="5" rx="1" />
      <path d="M3.75 3.75h.5M11.75 3.75h.5M3.75 11.75h.5" strokeWidth={1.6} />
      <path d="M9.5 9.5h2v2h-2zM13.5 9.5h1M9.5 13.5h1M12.5 12.5h2v2h-2z" />
    </svg>
  )
}

/**
 * The header button and its panel. `sessionId` is the Session on screen
 * (session-scoped slot); the panel fetches the host's status when opened and
 * renders the QR client-side, so nothing runs while it is closed.
 */
export function SessionQrAction({ sessionId, api, documentBase }: SessionQrActionProps): ReactNode {
  const root = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [facts, setFacts] = useState<SessionLinkFacts | undefined>(undefined)
  /** "Only you": identity-only link. Unticked embeds the standing token. */
  const [onlyMe, setOnlyMe] = useState(true)
  const [copied, setCopied] = useState(false)
  useDismissOnOutsidePointer(root, open, setOpen)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [open])

  useEffect(() => {
    if (!open) return
    let alive = true
    setFacts(undefined)
    setCopied(false)
    api.status()
      .then(status => { if (alive) setFacts(sessionLinkFacts(status, documentBase)) })
      .catch(() => { if (alive) setFacts(sessionLinkFacts(undefined, documentBase)) })
    return () => { alive = false }
  }, [open, api, documentBase])

  const toggle = useCallback(() => { setOpen(value => !value) }, [])

  const token = facts?.token
  const includeToken = !onlyMe && token !== undefined
  const link = facts?.base === undefined ? undefined : sessionLink(facts.base, sessionId, includeToken ? token : undefined)
  const svg = link === undefined ? undefined : qrSvg(link)
  const copy = useCallback(() => {
    if (link === undefined) return
    void writeClipboard(link).then((ok) => {
      setCopied(ok)
      if (ok) setTimeout(() => setCopied(false), 1500)
    })
  }, [link])

  return (
    <div ref={root} style={styles.root} data-tailscale-remote-session-qr>
      <Tooltip label="Open this session on another device (QR code)" side="bottom" delayMs={500} disabled={open}>
        <button
          type="button"
          style={open ? { ...styles.button, ...styles.buttonOpen } : styles.button}
          aria-label="QR code for this session"
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={toggle}
        >
          <IconQr />
        </button>
      </Tooltip>
      {open && (
        <div style={styles.panel} role="dialog" aria-label="This session on another device">
          <div style={styles.title}>This session on another device</div>
          {facts === undefined && <div style={styles.caption}>Reading the Tailscale remote status…</div>}
          {facts !== undefined && link === undefined && (
            <div style={{ ...styles.caption, ...styles.error }}>{facts.problem ?? 'No address available.'}</div>
          )}
          {link !== undefined && (
            <>
              {svg === undefined
                ? <div style={{ ...styles.qrWrap, display: 'grid', placeItems: 'center', color: '#888', cursor: 'default' }}>QR unavailable</div>
                : (
                    <div
                      style={styles.qrWrap}
                      role="button"
                      tabIndex={0}
                      title="Click to copy the link"
                      aria-label="QR code for this session; click to copy the link"
                      onClick={copy}
                      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); copy() } }}
                      dangerouslySetInnerHTML={{ __html: svg }}
                    />
                  )}
              <div style={styles.row}>
                <Checkbox
                  checked={token === undefined ? true : onlyMe}
                  onChange={setOnlyMe}
                  disabled={token === undefined}
                  label="Only you"
                  title={token === undefined
                    ? 'The link relies on the device’s Tailscale login (the access token is readable from the DSH host only).'
                    : 'Ticked: only a device whose Tailscale login is on the allow list can open the link. Unticked: the access token rides along, and any device that scans is let in — with the same full access as the Settings QR code.'}
                />
                <span style={{ ...styles.caption, visibility: copied ? 'visible' : 'hidden' }} aria-live="polite">Link copied</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
