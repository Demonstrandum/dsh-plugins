/**
 * tali-import-api-keys — browser half.
 *
 * `/import-api-keys` is a CLIENT command (ui-commands contribution, kind
 * `action`): picking it in the slash menu or pressing Enter on the bare line
 * runs here and never produces a chat message. Flow:
 *
 *   native file picker → parse (parse.mjs: pi auth.json / flat map / .env)
 *   → POST /import-api-keys/plan (host compares against the credential store)
 *   → modal: New / Unchanged / Will be replaced / Skipped, Import or Cancel
 *   → remote.credentials.set per key (DSH's own write path; consumers
 *     re-resolve per request, so keys are live at once) → done modal.
 *
 * Why the plan round trip: `describe` never returns values, so only the host
 * can say whether a stored key DIFFERS. Values cross the wire once for the
 * plan and once per write, over the admitted connection — never the
 * attachment store, never disk in the browser.
 *
 * The same page runs in the local app, a hybrid remote frame and the
 * direct-remote (blue) app, which is the whole point of doing this in the
 * browser: the file lives on the machine the person is sitting at.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// `ctx.remote.credentials` typing rides the assembly package, as in ui-settings-models.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState } from 'react'
// @ts-expect-error plain ESM without a declaration file; esbuild inlines it
import { parseKeyFile } from '../../parse.mjs'

const CHANNEL = '/import-api-keys'
const COMMAND = 'import-api-keys'

type PlanStatus = 'new' | 'same' | 'different' | 'readonly' | 'invalid'
interface PlanEntry { status: PlanStatus, source?: string }
interface Skipped { name: string, reason: string }

type Dialog =
  | { kind: 'error', title: string, message: string }
  | { kind: 'confirm', fileName: string, format: string, keys: Record<string, string>, plan: Record<string, PlanEntry>, skipped: Skipped[] }
  | { kind: 'busy', total: number, done: number }
  | { kind: 'done', written: string[], failed: { name: string, message: string }[], unchanged: number }

type Listener = (dialog: Dialog | undefined) => void

/** One dialog at a time, owned by the plugin; the overlay component subscribes. */
class DialogStore {
  private current: Dialog | undefined
  private readonly listeners = new Set<Listener>()
  get(): Dialog | undefined { return this.current }
  set(dialog: Dialog | undefined): void { this.current = dialog; for (const l of this.listeners) l(dialog) }
  subscribe(l: Listener): () => void { this.listeners.add(l); return () => { this.listeners.delete(l) } }
}

/** pi's auth store; also where the Dock app's picker starts when it can. */
const PI_AUTH_DIR = '~/.pi/agent'

/**
 * A page cannot choose where the file picker opens. The DSH Dock app (our own
 * WKWebView wrapper) can, and listens for a one-shot hint on its script
 * message handler; in an ordinary browser this is a no-op.
 */
function hintDockAppPicker(): void {
  const handlers = (window as unknown as { webkit?: { messageHandlers?: { dshDock?: { postMessage(body: unknown): void } } } }).webkit?.messageHandlers
  try {
    handlers?.dshDock?.postMessage({ type: 'open-panel', file: `${PI_AUTH_DIR}/auth.json`, directory: PI_AUTH_DIR, message: "Choose an API-key file — pi's auth.json, a JSON key map, or a .env file", showsHiddenFiles: true })
  } catch { /* not the Dock app */ }
}

function pickFile(): Promise<File | undefined> {
  hintDockAppPicker()
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,.env,application/json,text/plain'
    input.style.display = 'none'
    let settled = false
    const finish = (file: File | undefined): void => {
      if (settled) return
      settled = true
      input.remove()
      resolve(file)
    }
    input.addEventListener('change', () => finish(input.files?.[0]))
    // Cancel: the picker fires `cancel` in current engines; a focus return without a change is the fallback.
    input.addEventListener('cancel', () => finish(undefined))
    window.addEventListener('focus', () => { setTimeout(() => finish(input.files?.[0]), 400) }, { once: true })
    document.body.append(input)
    input.click()
  })
}

const mono = { fontFamily: 'var(--dsh-font-mono, ui-monospace, monospace)', fontSize: 12 } as const

interface Row {
  name: string
  /** ticked by default and tickable / tickable but off / no box at all / box present but disabled */
  box: 'on' | 'off' | 'none' | 'disabled'
  summary: string
  value?: string
}

function rowsFor(d: Extract<Dialog, { kind: 'confirm' }>): Row[] {
  const rows: Row[] = []
  for (const [name, value] of Object.entries(d.keys)) {
    const p = d.plan[name]
    switch (p?.status) {
      case 'new': rows.push({ name, box: 'on', summary: 'new — will be added', value }); break
      case 'different': rows.push({ name, box: 'off', summary: 'already set with a different value — tick to overwrite', value }); break
      case 'same': rows.push({ name, box: 'none', summary: 'already set with the same value' }); break
      case 'readonly': rows.push({ name, box: 'disabled', summary: `set by the server's environment (${p.source ?? 'env'}) — cannot be overwritten` }); break
      default: rows.push({ name, box: 'disabled', summary: 'invalid name or empty value' })
    }
  }
  for (const s of d.skipped) rows.push({ name: s.name, box: 'disabled', summary: s.reason })
  return rows
}

function ConfirmTable({ dialog, onImport, onClose }: { dialog: Extract<Dialog, { kind: 'confirm' }>, onImport: (keys: Record<string, string>) => Promise<void>, onClose: () => void }) {
  const rows = rowsFor(dialog)
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(rows.filter(r => r.box === 'on').map(r => r.name)))
  const selected = rows.filter(r => ticked.has(r.name) && r.value !== undefined)
  const toggle = (name: string, on: boolean): void => {
    setTicked(prev => { const next = new Set(prev); if (on) next.add(name); else next.delete(name); return next })
  }
  const cell = { padding: '6px 10px', borderBottom: '1px solid var(--dsh-color-border, rgba(255,255,255,0.08))', verticalAlign: 'top', fontSize: 13, lineHeight: 1.4 } as const
  return (
    <Modal
      open
      title="Import API keys"
      closeLabel="Cancel"
      onClose={onClose}
      width={640}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={selected.length === 0} onClick={() => { void onImport(Object.fromEntries(selected.map(r => [r.name, r.value as string]))) }}>
          {selected.length === 0 ? 'Import' : `Import ${selected.length}`}
        </Button>
      </>}
    >
      <div style={{ maxHeight: '55vh', overflow: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <tbody>
            {rows.map(row => (
              <tr key={row.name} style={{ opacity: row.box === 'disabled' || row.box === 'none' ? 0.65 : 1 }}>
                <td style={{ ...cell, width: 28, paddingRight: 0 }}>
                  {row.box !== 'none' && (
                    <input type="checkbox" aria-label={`import ${row.name}`} checked={ticked.has(row.name)} disabled={row.box === 'disabled'} onChange={e => toggle(row.name, e.target.checked)} />
                  )}
                </td>
                <td style={{ ...cell, ...mono, whiteSpace: 'nowrap' }}>{row.name}</td>
                <td style={{ ...cell, opacity: 0.8 }}>{row.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  )
}

function ImportDialog({ store, onImport }: { store: DialogStore, onImport: (keys: Record<string, string>) => Promise<void> }) {
  const [dialog, setDialog] = useState<Dialog | undefined>(store.get())
  useEffect(() => store.subscribe(setDialog), [store])
  if (dialog === undefined) return null
  const close = (): void => store.set(undefined)

  if (dialog.kind === 'error') {
    return (
      <Modal open title={dialog.title} closeLabel="Close" onClose={close} width={460} footer={<Button variant="primary" onClick={close}>OK</Button>}>
        <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{dialog.message}</div>
      </Modal>
    )
  }
  if (dialog.kind === 'busy') {
    return <Modal open headless title="Importing API keys" onClose={() => {}} width={380}><div style={{ padding: 20, fontSize: 13 }}>Importing… {dialog.done} / {dialog.total}</div></Modal>
  }
  if (dialog.kind === 'done') {
    return (
      <Modal open title="API keys imported" closeLabel="Close" onClose={close} width={480} footer={<Button variant="primary" onClick={close}>OK</Button>}>
        <div style={{ fontSize: 13, lineHeight: 1.5 }}>
          {dialog.written.length > 0 && <div style={{ marginBottom: 8 }}>Stored: <span style={mono}>{dialog.written.join(', ')}</span></div>}
          {dialog.failed.map(f => <div key={f.name} style={{ marginBottom: 4 }}>Failed <span style={mono}>{f.name}</span>: {f.message}</div>)}
          {dialog.written.length > 0 && <div style={{ opacity: 0.7 }}>Providers pick new keys up on their next request — no restart needed.</div>}
        </div>
      </Modal>
    )
  }
  return <ConfirmTable key={dialog.fileName + Object.keys(dialog.keys).join(',')} dialog={dialog} onImport={onImport} onClose={close} />
}

export const name = 'import-api-keys'
export const inject = ['slots', 'commandUi', 'connection', 'remote', 'remote.credentials']

export function apply(ctx: Context): void {
  const store = new DialogStore()
  const rpc = (ctx as unknown as { connection: { rpc: ClientConnectionRpc } }).connection.rpc

  const plan = async (keys: Record<string, string>): Promise<Record<string, PlanEntry>> => {
    const result = await rpc.call(CHANNEL, 'plan', { args: { keys } })
    if (!result.ok) throw new Error(result.error.message)
    return (result.value as { plan: Record<string, PlanEntry> }).plan
  }

  const run = async (): Promise<void> => {
    const file = await pickFile()
    if (file === undefined) return
    let parsed: { format: string, keys: Record<string, string>, skipped: Skipped[] }
    try {
      parsed = parseKeyFile(await file.text())
    } catch (error) {
      store.set({ kind: 'error', title: `Cannot import ${file.name}`, message: error instanceof Error ? error.message : String(error) })
      return
    }
    if (Object.keys(parsed.keys).length === 0) {
      store.set({ kind: 'error', title: `No API keys in ${file.name}`, message: parsed.skipped.map((s: Skipped) => `${s.name}: ${s.reason}`).join('\n') || 'The file contains no usable keys.' })
      return
    }
    try {
      store.set({ kind: 'confirm', fileName: file.name, format: parsed.format, keys: parsed.keys, plan: await plan(parsed.keys), skipped: parsed.skipped })
    } catch (error) {
      store.set({ kind: 'error', title: 'Could not check the existing keys', message: error instanceof Error ? error.message : String(error) })
    }
  }

  const onImport = async (keys: Record<string, string>): Promise<void> => {
    const names = Object.keys(keys)
    const confirm = store.get()
    const unchanged = confirm?.kind === 'confirm' ? Object.values(confirm.plan).filter(p => p.status === 'same').length : 0
    store.set({ kind: 'busy', total: names.length, done: 0 })
    const written: string[] = []
    const failed: { name: string, message: string }[] = []
    for (const [i, ref] of names.entries()) {
      const response = await ctx.remote.credentials.set(ref, keys[ref])
      if (response.ok) written.push(ref)
      else failed.push({ name: ref, message: response.error.message })
      store.set({ kind: 'busy', total: names.length, done: i + 1 })
    }
    store.set({ kind: 'done', written, failed, unchanged })
  }

  ctx.effect(() => ctx.commandUi.register({
    name: COMMAND,
    label: () => 'import-api-keys',
    description: () => "Import provider API keys from a file (pi's auth.json, a JSON map, or .env) into this DSH's credentials",
    available: () => true,
    ui: { kind: 'action', run: () => { void run() } },
  }), 'import-api-keys: /import-api-keys')

  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'tali-import-api-keys',
    inject: () => ({ store, onImport }),
  }, ({ store, onImport }: { store: DialogStore, onImport: (keys: Record<string, string>) => Promise<void> }) => <ImportDialog store={store} onImport={onImport} />)), 'import-api-keys: dialog overlay')
}
