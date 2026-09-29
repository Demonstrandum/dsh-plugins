import type { Context } from '@deepseek-ai/cordis'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { Button, Modal, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState } from 'react'

interface Archive { name: string, bytes: number, modifiedAt: string }
interface Listing { home: string, backups: string, shownBackups: string, archives: Archive[], restoring: boolean }
interface Saved { name: string, path: string, displayPath: string, counts: { workspaces: number, sessions: number }, bytes: number }
interface RestoreArchive { name: string, counts: { workspaces: number, sessions: number }, bytes: number }
interface RestoreAttempt { id: string, selected: RestoreArchive, rollback: RestoreArchive, shownBackups: string }
interface RestoreStatus extends RestoreAttempt { state: 'pending' | 'restored' | 'rolled-back' | 'rollback-failed' | 'failed', error?: string, rollbackError?: string, warning?: string }
function ArchiveDetail({ label, archive, shownBackups }: { label: string, archive: RestoreArchive, shownBackups: string }) {
  const [copied, setCopied] = useState(false)
  const path = `${shownBackups}/${archive.name}`
  return <div style={{ marginTop: 12 }}>
    <div>{label} {archive.counts.workspaces} workspaces and {archive.counts.sessions} sessions {label === 'Restored' ? 'from:' : 'to:'}</div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 5 }}>
      <code style={{ overflowWrap: 'anywhere', flex: 1 }}>{path}</code>
      <button type="button" aria-label={`Copy ${label.toLowerCase()} path`} title={copied ? 'Copied' : 'Copy path'} style={{ border: '1px solid var(--dsh-color-border, #666)', borderRadius: 6, background: 'transparent', color: 'inherit', cursor: 'pointer', padding: 5, flexShrink: 0 }} onClick={() => { void writeClipboard(path).then(setCopied) }}>
        {copied ? <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" /></svg> : <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8.5" rx="1.5" /><path d="M10.5 5.5V3.5A1.5 1.5 0 0 0 9 2H4A1.5 1.5 0 0 0 2.5 3.5v5A1.5 1.5 0 0 0 4 10h1.5" /></svg>}
      </button>
    </div>
    <div>({megabytes(archive.bytes)}).</div>
  </div>
}
const STORAGE_KEY = 'tali-backup-restore:pending'
const megabytes = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} megabytes`
function saveAttempt(attempt: RestoreAttempt): void { try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(attempt)) } catch { /* private browser storage */ } }
function clearAttempt(): void { try { sessionStorage.removeItem(STORAGE_KEY) } catch { /* private browser storage */ } }
function pendingAttempt(): RestoreAttempt | undefined {
  try {
    const value = sessionStorage.getItem(STORAGE_KEY)
    return value === null ? undefined : JSON.parse(value) as RestoreAttempt
  } catch { return undefined }
}
type View = { kind: 'closed' } | { kind: 'loading' } | { kind: 'choose', data: Listing, selected?: string } | { kind: 'confirm-backup', backups: string } | { kind: 'backup-busy' } | { kind: 'backup-done', saved: Saved } | { kind: 'busy', text: string } | { kind: 'restore-waiting', attempt: RestoreAttempt } | { kind: 'restore-result', result: RestoreStatus } | { kind: 'error', text: string }
class Store {
  value: View = { kind: 'closed' }
  listeners = new Set<(view: View) => void>()
  set(view: View): void { this.value = view; for (const listener of this.listeners) listener(view) }
  subscribe(listener: (view: View) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
}
const CHANNEL = '/backup-restore'

function RestoreDialog({ store, rpc }: { store: Store, rpc: ClientConnectionRpc }) {
  const [view, setView] = useState<View>(store.value)
  const [copied, setCopied] = useState(false)
  useEffect(() => store.subscribe(next => { setCopied(false); setView(next) }), [store])
  const call = async (method: string, args: object = {}): Promise<unknown> => {
    const result = await rpc.call(CHANNEL, method, { args })
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  const close = (): void => {
    if (view.kind === 'busy' || view.kind === 'backup-busy' || view.kind === 'restore-waiting') return
    if (view.kind === 'restore-result') {
      clearAttempt()
      window.dispatchEvent(new Event('tali-backup-restore-dismiss'))
    }
    store.set({ kind: 'closed' })
  }
  useEffect(() => {
    const attempt = pendingAttempt()
    if (attempt === undefined) return
    let stopped = false
    let polling = false
    let observedDown = false
    let completed = false
    let dismissed = false
    const tick = async (): Promise<void> => {
      if (polling || stopped) return
      polling = true
      try {
        const status = await call('status', { id: attempt.id }) as RestoreStatus
        if (stopped || completed || dismissed) return
        if (status.state === 'pending') {
          store.set({ kind: 'restore-waiting', attempt })
        } else {
          completed = true
          store.set({ kind: 'restore-result', result: { ...status, shownBackups: attempt.shownBackups } })
        }
      } catch { /* the old server is shutting down or the relay is starting */ }
      finally { polling = false }
    }
    void tick()
    const timer = setInterval(() => {
      if (completed || stopped || dismissed) return
      void tick()
      void fetch(`${location.origin}${location.pathname}`, { method: 'HEAD', cache: 'no-store' }).then(response => {
        if (response.status === 503) observedDown = true
        else if (observedDown && !completed && !stopped) location.reload()
      }).catch(() => { observedDown = true })
    }, 2000)
    const dismissedListener = (): void => { dismissed = true; clearInterval(timer) }
    window.addEventListener('tali-backup-restore-dismiss', dismissedListener)
    return () => { stopped = true; clearInterval(timer); window.removeEventListener('tali-backup-restore-dismiss', dismissedListener) }
  }, [store, rpc])
  const backup = async (): Promise<void> => {
    store.set({ kind: 'backup-busy' })
    try { store.set({ kind: 'backup-done', saved: await call('backup') as Saved }) }
    catch (error) { store.set({ kind: 'error', text: String(error instanceof Error ? error.message : error) }) }
  }
  const restore = async (filename: string): Promise<void> => {
    store.set({ kind: 'busy', text: 'Saving rollback and preparing restore…' })
    try {
      const attempt = await call('restore', { name: filename }) as RestoreAttempt
      saveAttempt(attempt)
      store.set({ kind: 'restore-waiting', attempt })
      // A pending attempt survives reload; the mounted status poll watches
      // shutdown, reconnects and reports the worker's verified outcome.
    } catch (error) { store.set({ kind: 'error', text: `Restore aborted before shutdown: ${String(error instanceof Error ? error.message : error)}. The current home was not replaced.` }) }
  }
  if (view.kind === 'closed') return null
  return (
    <Modal open title={view.kind === 'choose' ? 'Restore DSH' : view.kind === 'confirm-backup' ? 'Back up DSH?' : view.kind === 'backup-done' ? 'DSH backup saved' : 'DSH backup and restore'} onClose={close} closeLabel="Cancel" width={620} footer={view.kind === 'choose' ? <>
      <Button onClick={close}>Cancel</Button>
      <Button variant="primary" disabled={!view.selected} onClick={() => { if (view.selected) void restore(view.selected) }}>Restore selected backup</Button>
    </> : view.kind === 'confirm-backup' ? <><Button onClick={close}>Cancel</Button><Button variant="primary" onClick={() => { void backup() }}>Back up now</Button></> : view.kind === 'error' || view.kind === 'restore-result' || view.kind === 'backup-done' ? <Button variant="primary" onClick={close}>Close</Button> : undefined}>
      <div style={{ fontSize: 13, lineHeight: 1.5 }}>
        {view.kind === 'loading' && 'Loading backups…'}
        {view.kind === 'confirm-backup' && <>Save a complete backup of this DSH home to <code>{view.backups}</code>?</>}
        {view.kind === 'backup-busy' && 'Creating and verifying backup…'}
        {view.kind === 'backup-done' && <>
          <div>Wrote {view.saved.counts.workspaces} workspaces and {view.saved.counts.sessions} sessions to:</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <code style={{ overflowWrap: 'anywhere', flex: 1 }}>{view.saved.displayPath}</code>
            <button type="button" aria-label="Copy backup path" title={copied ? 'Copied' : 'Copy path'} style={{ border: '1px solid var(--dsh-color-border, #666)', borderRadius: 6, background: 'transparent', color: 'inherit', cursor: 'pointer', padding: 5, flexShrink: 0 }} onClick={() => { void writeClipboard(view.saved.displayPath).then(ok => { setCopied(ok) }) }}>
              {copied ? <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" /></svg> : <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8.5" rx="1.5" /><path d="M10.5 5.5V3.5A1.5 1.5 0 0 0 9 2H4A1.5 1.5 0 0 0 2.5 3.5v5A1.5 1.5 0 0 0 4 10h1.5" /></svg>}
            </button>
          </div>
          <div style={{ marginTop: 6 }}>({(view.saved.bytes / 1_000_000).toFixed(1)} megabytes).</div>
        </>}
        {view.kind === 'busy' && view.text}
        {view.kind === 'restore-waiting' && <>Rollback saved to <code>{view.attempt.shownBackups}/{view.attempt.rollback.name}</code>. Waiting for DSH to stop and restore the selected backup…</>}
        {view.kind === 'restore-result' && <>
          {view.result.state === 'restored' && <><ArchiveDetail label="Restored" archive={view.result.selected} shownBackups={view.result.shownBackups} />{view.result.warning && <div role="alert">{view.result.warning}</div>}</>}
          {view.result.state === 'rolled-back' && <div role="alert">Restore failed: {view.result.error}. The rollback was restored; the selected backup was not loaded.</div>}
          {view.result.state === 'rollback-failed' && <div role="alert">Restore failed: {view.result.error}. Rollback also failed: {view.result.rollbackError}. Manual recovery may be required; see <code>{view.result.shownBackups}/restore.log</code>.</div>}
          {view.result.state === 'failed' && <div role="alert">Restore aborted: {view.result.error}. The current home was not replaced.</div>}
          <ArchiveDetail label="Rollback wrote" archive={view.result.rollback} shownBackups={view.result.shownBackups} />
        </>}
        {view.kind === 'error' && <span role="alert">{view.text}</span>}
        {view.kind === 'choose' && <>
          <div style={{ marginBottom: 10, fontFamily: 'monospace', overflowWrap: 'anywhere' }}>{view.data.backups}</div>
          {view.data.archives.length === 0 && <div>No backups found.</div>}
          <div style={{ maxHeight: '55vh', overflowY: 'auto' }}>
            {view.data.archives.map(archive => <label key={archive.name} style={{ display: 'flex', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--dsh-color-border, #555)', cursor: 'pointer' }}>
              <input type="radio" name="restore-backup" checked={view.selected === archive.name} onChange={() => store.set({ ...view, selected: archive.name })} />
              <span style={{ overflowWrap: 'anywhere' }}>{archive.name}<br /><small>{new Date(archive.modifiedAt).toLocaleString()} · {(archive.bytes / 1024 / 1024).toFixed(1)} MB</small></span>
            </label>)}
          </div>
          {view.selected && <div style={{ marginTop: 12, color: 'var(--dsh-color-danger, #c0392b)' }}>This replaces the complete current DSH state. A rollback ZIP will be saved first.</div>}
        </>}
      </div>
    </Modal>
  )
}

export const name = 'backup-restore'
export const inject = ['slots', 'commandUi', 'connection']
export function apply(ctx: Context): void {
  const store = new Store()
  const rpc = (ctx as unknown as { connection: { rpc: ClientConnectionRpc } }).connection.rpc
  ctx.effect(() => ctx.commandUi.decorate({ name: 'backup', available: () => true, ui: { kind: 'action', run: () => {
    store.set({ kind: 'loading' })
    void rpc.call(CHANNEL, 'list', { args: {} }).then(result => {
      if (!result.ok) throw new Error(result.error.message)
      store.set({ kind: 'confirm-backup', backups: (result.value as Listing).shownBackups })
    }).catch(error => store.set({ kind: 'error', text: String(error instanceof Error ? error.message : error) }))
  } } }), 'backup-restore: /backup confirmation')
  ctx.effect(() => ctx.commandUi.decorate({ name: 'restore', available: () => true, ui: { kind: 'action', run: () => {
    store.set({ kind: 'loading' })
    void rpc.call(CHANNEL, 'list', { args: {} }).then(result => {
      if (!result.ok) throw new Error(result.error.message)
      store.set({ kind: 'choose', data: result.value as Listing })
    }).catch(error => store.set({ kind: 'error', text: String(error instanceof Error ? error.message : error) }))
  } } }), 'backup-restore: /restore dialog')
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'tali-backup-restore', inject: () => ({ store, rpc }),
  }, ({ store, rpc }: { store: Store, rpc: ClientConnectionRpc }) => <RestoreDialog store={store} rpc={rpc} />)), 'backup-restore: dialog')
}
