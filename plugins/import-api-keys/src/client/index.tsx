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

function describeFormat(format: string): string {
  return format === 'pi-auth' ? "pi's auth.json" : format === 'dotenv' ? '.env file' : 'JSON key map'
}

const rowStyle = { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 12px', fontSize: 13, lineHeight: 1.45 } as const
const mono = { fontFamily: 'var(--dsh-font-mono, ui-monospace, monospace)', fontSize: 12 } as const

function Group({ title, names, note }: { title: string, names: string[], note?: (name: string) => string | undefined }) {
  if (names.length === 0) return null
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{title} <span style={{ opacity: 0.6, fontWeight: 400 }}>({names.length})</span></div>
      <div style={rowStyle}>
        {names.map(name => (
          <><span key={`${name}-n`} style={mono}>{name}</span><span key={`${name}-x`} style={{ opacity: 0.7 }}>{note?.(name) ?? ''}</span></>
        ))}
      </div>
    </div>
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
          <Group title="Stored" names={dialog.written} />
          {dialog.unchanged > 0 && <div style={{ opacity: 0.7, marginBottom: 10 }}>{dialog.unchanged} already had the same value.</div>}
          <Group title="Failed" names={dialog.failed.map(f => f.name)} note={name => dialog.failed.find(f => f.name === name)?.message} />
          {dialog.written.length > 0 && <div style={{ opacity: 0.7 }}>Providers pick new keys up on their next request — no restart needed.</div>}
        </div>
      </Modal>
    )
  }
  // confirm
  const by = (status: PlanStatus): string[] => Object.keys(dialog.keys).filter(k => dialog.plan[k]?.status === status)
  const fresh = by('new'), same = by('same'), different = by('different'), readonly = by('readonly'), invalid = by('invalid')
  const toWrite = { ...Object.fromEntries([...fresh, ...different].map(k => [k, dialog.keys[k]])) }
  const nothing = fresh.length + different.length === 0
  return (
    <Modal
      open
      title={nothing ? 'Nothing to import' : 'Import API keys?'}
      description={`${dialog.fileName} — ${describeFormat(dialog.format)}`}
      closeLabel="Cancel"
      onClose={close}
      width={520}
      footer={nothing
        ? <Button variant="primary" onClick={close}>OK</Button>
        : <><Button onClick={close}>Cancel</Button><Button variant="primary" onClick={() => { void onImport(toWrite) }}>{different.length > 0 ? `Import and replace ${different.length}` : 'Import'}</Button></>}
    >
      <div style={{ maxHeight: '55vh', overflow: 'auto' }}>
        <Group title="New" names={fresh} />
        <Group title="Will be replaced" names={different} note={() => 'stored value differs — it will be overwritten'} />
        <Group title="Unchanged" names={same} note={() => 'same value already stored'} />
        <Group title="Read-only" names={readonly} note={name => `set by the process environment (${dialog.plan[name]?.source ?? 'env'}); DSH cannot overwrite it`} />
        <Group title="Invalid" names={invalid} />
        <Group title="Skipped" names={dialog.skipped.map(s => s.name)} note={name => dialog.skipped.find(s => s.name === name)?.reason} />
      </div>
    </Modal>
  )
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
