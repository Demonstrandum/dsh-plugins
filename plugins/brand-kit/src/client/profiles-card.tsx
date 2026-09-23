/**
 * "Brand" card on this bundle's page in the Plugins panel (sidebar ▸ Plugins ▸
 * tali-brand-kit ▸ configuration). Manages brand profiles over the host
 * half's Fetch route (index.js API_PATH):
 *
 *   - which profile is active (or "plugin config" = the row's own config),
 *     with Apply reloading the page — the `<style>` and `global` rows are
 *     rendered into the boot document, so a change is a fresh page;
 *   - the profile list: duplicate, rename, export (.brand.zip), delete;
 *   - New (from what is active right now) and Import (a .brand.zip);
 *   - an editor for one profile: every config key of the plugin, with mark
 *     and font files uploaded straight into the profile directory.
 *
 * Pure presentation over JSON; every action re-reads the host's state. The
 * chrome classes (`bk-*`) come from the host half's style row (CARD_STYLE),
 * so the card wears no inline styles and follows the theme tokens.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

/** Host route (index.js API_PATH), document-relative so proxied mounts work. */
const API = './api/brand-kit'

/** Portable profile JSON (index.js BrandConfig without fontsDir; mark/fonts are file names). */
export interface Profile {
  name?: string
  mark?: string
  markMode?: 'mask' | 'image'
  headline?: string
  turnStatus?: string
  hidePreviewBadge?: boolean
  accent?: string
  accentDark?: string
  fonts?: { file: string, family: string, weight?: number, style?: 'normal' | 'italic' }[]
  brandFont?: Typography
  headlineFont?: Typography
}
interface Typography { family?: string, weight?: number, size?: number, lineHeight?: number, letterSpacing?: number, offsetY?: number }

/** The host's `state()` (index.js). */
interface State {
  active: string
  effectiveSource: string
  error?: string
  rowConfig: Profile
  rowConfigured: boolean
  profilesDir: string
  profiles: { name: string, profile: Profile | null, error?: string }[]
  uploaded?: string
}

async function call(action: string, params: Record<string, string> = {}, body?: BodyInit, method = 'POST'): Promise<State> {
  const query = new URLSearchParams({ action, ...params })
  const response = await fetch(`${API}?${query.toString()}`, { method, body, credentials: 'same-origin' })
  const state = await response.json() as State & { error?: string }
  if (!response.ok) throw new Error(state.error ?? `HTTP ${String(response.status)}`)
  return state
}

function pickFile(accept: string): Promise<File | null> {
  return new Promise(resolve => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.onchange = () => { resolve(input.files?.[0] ?? null) }
    input.oncancel = () => { resolve(null) }
    input.click()
  })
}

function download(url: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = ''
  document.body.appendChild(a)
  a.click()
  a.remove()
}

const FONT_ACCEPT = '.woff2,.woff,.ttf,.otf'
const MARK_ACCEPT = '.svg,.png'

/** The bundle's configuration card. */
export function BrandProfilesCard() {
  const [state, setState] = useState<State | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(API, { credentials: 'same-origin' })
      setState(await response.json() as State)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])
  useEffect(() => { void refresh() }, [refresh])

  const run = useCallback(async (work: () => Promise<State | void>) => {
    setBusy(true)
    setError(null)
    try {
      const next = await work()
      if (next !== undefined) setState(next)
      else await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [refresh])

  if (state === null) return <div className="bk-card"><span className="bk-muted">{error ?? 'Loading…'}</span></div>

  const apply = (name: string) => run(async () => {
    await call('apply', { name })
    location.reload()
  })
  const create = () => {
    const name = prompt('Name for the new profile (copies what is active right now):')
    if (name === null || name.trim() === '') return
    void run(() => call('create', { name: name.trim() }))
  }
  const importZip = () => run(async () => {
    const file = await pickFile('.zip')
    if (file === null) return
    const suggested = file.name.replace(/\.brand\.zip$|\.zip$/i, '')
    const name = prompt('Name for the imported profile:', suggested)
    if (name === null || name.trim() === '') return
    return call('import', { name: name.trim() }, file)
  })

  return (
    <div className="bk-card">
      <div className="bk-row">
        <span>Active:</span>
        <select
          value={state.active}
          disabled={busy}
          onChange={event => { void apply(event.target.value) }}
        >
          <option value="">{state.rowConfigured ? 'Plugin config (profile patch)' : 'None (shipped DSH look)'}</option>
          {state.profiles.map(row => <option key={row.name} value={row.name}>{row.name}</option>)}
        </select>
        <span className="bk-muted">changing reloads the page</span>
      </div>
      {state.error !== undefined && <div className="bk-error">Active profile not applied: {state.error}</div>}
      {error !== null && <div className="bk-error">{error}</div>}

      <ul className="bk-list">
        {state.profiles.length === 0 && <li className="bk-muted">No profiles yet — New copies the current look into an editable profile; Import takes a .brand.zip.</li>}
        {state.profiles.map(row => (
          <li key={row.name} className={`bk-item${row.name === state.active ? ' bk-active' : ''}`}>
            <span className="bk-name">{row.name}</span>
            {row.name === state.active && <span className="bk-tag">active</span>}
            {row.error !== undefined && <span className="bk-error" title={row.error}>invalid</span>}
            <button className="bk-btn" disabled={busy} onClick={() => { setEditing(editing === row.name ? null : row.name) }}>{editing === row.name ? 'Close' : 'Edit'}</button>
            <button className="bk-btn" disabled={busy} onClick={() => {
              const to = prompt(`Duplicate "${row.name}" as:`, `${row.name} copy`)
              if (to !== null && to.trim() !== '') void run(() => call('duplicate', { name: row.name, to: to.trim() }))
            }}>Duplicate</button>
            <button className="bk-btn" disabled={busy} onClick={() => {
              const to = prompt(`Rename "${row.name}" to:`, row.name)
              if (to !== null && to.trim() !== '' && to.trim() !== row.name) void run(() => call('rename', { name: row.name, to: to.trim() }))
            }}>Rename</button>
            <button className="bk-btn" disabled={busy} onClick={() => { download(`${API}?action=export&name=${encodeURIComponent(row.name)}`) }}>Export</button>
            <button className="bk-btn" disabled={busy} onClick={() => {
              if (confirm(`Delete profile "${row.name}"? Its files are removed from ${state.profilesDir}.`)) void run(() => call('delete', { name: row.name }))
            }}>Delete</button>
          </li>
        ))}
      </ul>
      <div className="bk-row">
        <button className="bk-btn bk-primary" disabled={busy} onClick={create}>New from current</button>
        <button className="bk-btn" disabled={busy} onClick={() => { void importZip() }}>Import .brand.zip…</button>
        <span className="bk-muted">{state.profilesDir}</span>
      </div>

      {editing !== null && state.profiles.some(row => row.name === editing) && (
        <ProfileEditor
          key={editing}
          name={editing}
          initial={state.profiles.find(row => row.name === editing)?.profile ?? {}}
          busy={busy}
          isActive={editing === state.active}
          run={run}
        />
      )}
    </div>
  )
}

interface EditorProps {
  name: string
  initial: Profile
  busy: boolean
  isActive: boolean
  run: (work: () => Promise<State | void>) => Promise<void>
}

/** One profile's fields; Save validates on the host and re-reads. */
function ProfileEditor({ name, initial, busy, isActive, run }: EditorProps) {
  const [draft, setDraft] = useState<Profile>(() => structuredClone(initial))
  const dirty = useRef(false)
  const set = <K extends keyof Profile>(key: K, value: Profile[K]) => { dirty.current = true; setDraft(d => ({ ...d, [key]: value })) }
  const setType = (key: 'brandFont' | 'headlineFont', field: keyof Typography, value: string) => {
    dirty.current = true
    setDraft(d => {
      const block: Typography = { ...(d[key] ?? {}) }
      if (field === 'family') block.family = value
      else if (value === '') delete block[field]
      else block[field] = Number(value)
      return { ...d, [key]: block }
    })
  }
  const save = () => run(async () => {
    const next = await call('save', { name }, JSON.stringify(draft))
    dirty.current = false
    if (isActive) location.reload()
    return next
  })
  const uploadMark = () => run(async () => {
    const file = await pickFile(MARK_ACCEPT)
    if (file === null) return
    const next = await call('upload', { name, kind: 'mark', file: file.name }, file)
    set('mark', next.uploaded ?? file.name)
    return next
  })
  const addFont = () => run(async () => {
    const file = await pickFile(FONT_ACCEPT)
    if (file === null) return
    const next = await call('upload', { name, kind: 'font', file: file.name }, file)
    const family = file.name.replace(/\.[^.]+$/, '').replace(/[-_]?(light|regular|medium|bold|italic|thin|black)$/i, '').replace(/[-_]+/g, ' ')
    set('fonts', [...(draft.fonts ?? []), { file: next.uploaded ?? file.name, family, weight: 400, style: 'normal' }])
    return next
  })
  const fonts = draft.fonts ?? []
  const type = (key: 'brandFont' | 'headlineFont', field: keyof Typography) => draft[key]?.[field]

  return (
    <div className="bk-form">
      <div className="bk-sub">Profile “{name}”</div>
      <label>Wordmark</label>
      <input type="text" value={draft.name ?? ''} placeholder="(keep the shipped title)" onChange={e => { set('name', e.target.value) }} />
      <label>Mark</label>
      <div className="bk-inline">
        <span className={draft.mark ? '' : 'bk-muted'}>{draft.mark || 'none'}</span>
        <button className="bk-btn" disabled={busy} onClick={() => { void uploadMark() }}>Upload…</button>
        {draft.mark && <button className="bk-btn" disabled={busy} onClick={() => { set('mark', '') }}>Clear</button>}
        <select value={draft.markMode ?? 'mask'} onChange={e => { set('markMode', e.target.value as 'mask' | 'image') }}>
          <option value="mask">mask (follows text colour)</option>
          <option value="image">image (as-is)</option>
        </select>
      </div>
      <label>Headline</label>
      <input type="text" value={draft.headline ?? ''} placeholder="Into the Unknown" onChange={e => { set('headline', e.target.value) }} />
      <label>Turn status</label>
      <input type="text" value={draft.turnStatus ?? ''} placeholder="Deep diving..." onChange={e => { set('turnStatus', e.target.value) }} />
      <label>Preview badge</label>
      <div className="bk-inline">
        <input type="checkbox" checked={draft.hidePreviewBadge ?? false} onChange={e => { set('hidePreviewBadge', e.target.checked) }} />
        <span className="bk-muted">hide the “Preview” pill after the headline</span>
      </div>
      <label>Accent</label>
      <div className="bk-inline">
        <input type="color" value={draft.accent || '#4176e6'} onChange={e => { set('accent', e.target.value) }} />
        <input type="text" value={draft.accent ?? ''} placeholder="#rrggbb (empty = shipped blue)" onChange={e => { set('accent', e.target.value) }} />
        {draft.accent && <button className="bk-btn" disabled={busy} onClick={() => { set('accent', ''); set('accentDark', '') }}>Clear</button>}
      </div>
      <label>Accent dark</label>
      <div className="bk-inline">
        <input type="color" value={draft.accentDark || draft.accent || '#4176e6'} onChange={e => { set('accentDark', e.target.value) }} />
        <input type="text" value={draft.accentDark ?? ''} placeholder="derived from accent" onChange={e => { set('accentDark', e.target.value) }} />
      </div>

      <div className="bk-sub">Fonts</div>
      <label>Files</label>
      <div>
        {fonts.map((font, index) => (
          <div key={`${font.file}-${String(index)}`} className="bk-inline" style={{ marginBottom: 4 }}>
            <span className="bk-muted">{font.file}</span>
            <input type="text" value={font.family} placeholder="family" style={{ width: 160 }} onChange={e => { set('fonts', fonts.map((f, i) => i === index ? { ...f, family: e.target.value } : f)) }} />
            <input type="number" value={font.weight ?? 400} min={100} max={900} step={100} onChange={e => { set('fonts', fonts.map((f, i) => i === index ? { ...f, weight: Number(e.target.value) } : f)) }} />
            <select value={font.style ?? 'normal'} onChange={e => { set('fonts', fonts.map((f, i) => i === index ? { ...f, style: e.target.value as 'normal' | 'italic' } : f)) }}>
              <option value="normal">normal</option>
              <option value="italic">italic</option>
            </select>
            <button className="bk-btn" disabled={busy} onClick={() => { set('fonts', fonts.filter((_, i) => i !== index)) }}>Remove</button>
          </div>
        ))}
        <button className="bk-btn" disabled={busy} onClick={() => { void addFont() }}>Add font file…</button>
      </div>
      {(['brandFont', 'headlineFont'] as const).map(key => (
        <TypographyRows key={key} label={key === 'brandFont' ? 'Wordmark type' : 'Headline type'} value={draft[key] ?? {}} onChange={(field, v) => { setType(key, field, v) }} shipped={key === 'brandFont' ? '18 / 24, weight 600' : '26 / 32, weight 500'} />
      ))}

      <div className="bk-sub" />
      <div />
      <div className="bk-inline">
        <button className="bk-btn bk-primary" disabled={busy} onClick={() => { void save() }}>Save{isActive ? ' and reload' : ''}</button>
        <span className="bk-muted">Empty text fields keep the shipped DSH text; font families must match a font file's family.</span>
      </div>
    </div>
  )
}

function TypographyRows({ label, value, onChange, shipped }: { label: string, value: Typography, onChange: (field: keyof Typography, value: string) => void, shipped: string }) {
  const num = (field: keyof Typography, placeholder: string) => (
    <input type="number" value={value[field] ?? ''} placeholder={placeholder} step="any" onChange={e => { onChange(field, e.target.value) }} />
  )
  return (
    <>
      <label>{label}</label>
      <div className="bk-inline">
        <input type="text" value={value.family ?? ''} placeholder="font-family (empty = system)" style={{ width: 220 }} onChange={e => { onChange('family', e.target.value) }} />
        {num('weight', 'weight')}{num('size', 'size px')}{num('lineHeight', 'line px')}{num('letterSpacing', 'tracking em')}{num('offsetY', 'y px')}
        <span className="bk-muted">shipped {shipped}</span>
      </div>
    </>
  )
}
