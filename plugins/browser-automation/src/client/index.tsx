/**
 * tali-browser-automation — browser half: chat rows for the inline-screenshot
 * tools, so a capture is SEEN in the transcript instead of printed as JSON.
 *
 *   chrome_get_screenshot   [globe] Chrome screenshot · c:0:1 · 1280×720 px · viewport · 82 kB png
 *   safari_get_screenshot   [globe] Safari screenshot · s:0:0 · 780×1480 px · viewport · 175 kB png
 *
 * Collapsed: the capture summary (the tool's own result text). Expanded: the
 * image at point size (device pixels ÷ 2 — the captures come from retina
 * windows), click for an in-page lightbox (fit ↔ 1:1), then the result text
 * (window id, size, NOTE:s) underneath.
 *
 * Why a toolview at all: the chat dispatches each tool card through the keyed
 * `tool.call.toolview` slot; only `read_image` claims a key that renders images,
 * every other tool falls to the generic card, which flattens a `{ type: 'image',
 * attachment }` block to its JSON — so expanding a screenshot card showed
 * `{"type":"image","attachment":{"attachmentId":…}}` and no picture. The shared
 * `tool.call.images` gallery slot is `single` and owned by the read_image entry,
 * so this row draws its own <img> from the
 * session-authorized `loadImage` loader every toolview receives.
 *
 * Claiming a key suppresses the generic card for EVERY shape of that tool, so
 * the row covers: running (no result yet), a settled capture with its image, a
 * capture without an inline image (a model without image input gets a file path
 * instead — `inlineOrFile` in curated-tools.mjs), an error, and an interrupted
 * turn. Everything but the picture is the result text, verbatim.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only imports (erased at build time): SlotMap merges for
// 'tool.call.toolview' and the session-scope standard props.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { DisclosureRow, IconGlobeOutline14, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

type Props = PropsRuntime<'tool.call.toolview'>
type Block = Props['block']
type Settled = Extract<Block, { kind: 'tool-result' }>
type LoadImage = Props['loadImage']

/** Mirror of dsh-attachment's ImageAttachmentRef (runtime narrowing at the wire boundary). */
interface ImageRef {
  attachmentId: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  bytes: number
  width: number
  height: number
  name?: string
}

const MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function positiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}
/** Defensive narrowing: the id is opaque (existence only), everything else exact. */
function asImageRef(value: unknown): ImageRef | undefined {
  if (!isRecord(value)) return undefined
  const { attachmentId, mediaType, bytes, width, height, name } = value
  if (typeof attachmentId !== 'string' || attachmentId === '') return undefined
  if (typeof mediaType !== 'string' || !MEDIA_TYPES.has(mediaType)) return undefined
  if (!positiveInt(bytes) || !positiveInt(width) || !positiveInt(height)) return undefined
  const ref: ImageRef = { attachmentId, mediaType: mediaType as ImageRef['mediaType'], bytes, width, height }
  if (typeof name === 'string') ref.name = name
  return ref
}

function isSettled(block: Block): block is Settled {
  return 'kind' in block
}

/** Flattened result text: text blocks verbatim, image blocks omitted (they render), others as JSON. */
function resultText(block: Block): string {
  if (!isSettled(block)) return ''
  const parts: string[] = []
  for (const item of block.content) {
    if (item.type === 'text') parts.push(item.text)
    else if (item.type !== 'image') parts.push(JSON.stringify(item, null, 2))
  }
  if (parts.length === 0 && block.error !== undefined) parts.push(`${block.error.name}: ${block.error.code}`)
  return parts.join('\n').trim()
}

function imageRefsOf(block: Block): ImageRef[] {
  if (!isSettled(block)) return []
  const refs: ImageRef[] = []
  for (const item of block.content) {
    if (item.type === 'image' && 'attachment' in item) {
      const ref = asImageRef((item as { attachment?: unknown }).attachment)
      if (ref !== undefined) refs.push(ref)
    }
  }
  return refs
}

function parseArgs(block: Block): Record<string, unknown> {
  const raw = isSettled(block) ? block.call?.argsRaw : block.argsRaw
  if (typeof raw !== 'string') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

type RowState = 'running' | 'ok' | 'error' | 'stopped'

function stateOf(block: Block): RowState {
  if (!isSettled(block)) return 'running'
  if (!block.isError) return 'ok'
  const code = block.error?.code
  return code === 'ABORTED' || code === 'ABORTED_BEFORE_DISPATCH' ? 'stopped' : 'error'
}

/** What the call asked for, from its arguments (the running row has no result text yet). */
function targetOf(args: Record<string, unknown>): string {
  if (typeof args.querySelector === 'string' && args.querySelector !== '') return `element ${JSON.stringify(args.querySelector)}`
  if (typeof args.uid === 'string' && args.uid !== '') return `element uid ${args.uid}`
  if (args.fullPage === true) return 'full page'
  return 'viewport'
}

/**
 * Collapsed summary: `c:0:1 · viewport` — the window (from the `[id]` tag the
 * host prefixes every result with) and what was captured (from the args). Pixel
 * size, byte count, the ≥ 2 MB spill note and every other `;`-separated detail
 * of the result text stay in the expanded body: they are for the model, not
 * the reader. The one exception is the file fallback (no picture in the card):
 * `· saved to file` says why there is nothing to see.
 */
function summaryOf(text: string, target: string): string {
  const line = text.split('\n')[0] ?? ''
  const id = /\[([a-z]:\d+:\d+)\]/.exec(line)?.[1]
  const parts = [id, target]
  if (line.includes('; saved to ')) parts.push('saved to file')
  return parts.filter((part): part is string => part !== undefined).join(' · ')
}

function firstLine(text: string, max = 120): string {
  const line = text.split('\n')[0] ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

// ---------------------------------------------------------------- image

/** Resolve a content-block image to a displayable URL through the session loader. */
function useImageUrl(loadImage: LoadImage, image: ImageRef): { url: string | undefined, failed: boolean } {
  const [url, setUrl] = useState<string | undefined>(() => loadImage.peek?.(image as never))
  const [failed, setFailed] = useState(false)
  const id = image.attachmentId
  useEffect(() => {
    let cancelled = false
    setFailed(false)
    loadImage(image as never).then(
      (resolved) => { if (!cancelled) setUrl(resolved) },
      () => { if (!cancelled) setFailed(true) },
    )
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, loadImage])
  return { url, failed }
}

const FRAME: CSSProperties = {
  display: 'block',
  width: 'fit-content',
  maxWidth: '100%',
  alignSelf: 'flex-start',
  borderRadius: 6,
  overflow: 'hidden',
  boxShadow: '0 0 0 1px color-mix(in srgb, currentColor 14%, transparent)',
  boxSizing: 'content-box',
}

/**
 * The capture at point size: the browsers run on a retina display, so a
 * 1280×720 CSS-px viewport arrives as 2560×1440 device pixels; halving shows it
 * at the size the page had. `max-width: 100%` keeps a full-page capture inside
 * the column; the lightbox has the 1:1 view.
 */
function Shot({ loadImage, image, alt }: { loadImage: LoadImage, image: ImageRef, alt: string }) {
  const { url, failed } = useImageUrl(loadImage, image)
  const [broken, setBroken] = useState(false)
  const [zoomed, setZoomed] = useState(false)
  const width = Math.max(1, Math.round(image.width / 2))
  if (failed || broken) return <div style={{ opacity: 0.7, fontSize: 12 }}>[image unavailable: {image.name ?? image.attachmentId}]</div>
  if (url === undefined) return <div style={{ ...FRAME, width, aspectRatio: `${image.width} / ${image.height}`, opacity: 0.4 }} />
  return (
    <div style={FRAME}>
      <img
        src={url}
        alt={alt}
        width={width}
        style={{ display: 'block', width, maxWidth: '100%', height: 'auto', cursor: 'zoom-in' }}
        onClick={(event) => { event.stopPropagation(); setZoomed(true) }}
        onError={() => setBroken(true)}
        title={`${alt} — ${image.width}×${image.height} px; click to enlarge`}
      />
      {zoomed && <Lightbox url={url} alt={alt} caption={`${alt} — ${image.width}×${image.height} px`} onClose={() => setZoomed(false)} />}
    </div>
  )
}

/**
 * Full-size view in the page (never `window.open`: the Dock app's WKWebView
 * wrapper would load the URL into its only window). Escape / click outside /
 * the × close it; a click on the image toggles fit ↔ 1:1 pixels.
 */
function Lightbox({ url, alt, caption, onClose }: { url: string, alt: string, caption: string, onClose: () => void }) {
  const [actual, setActual] = useState(false)
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const bg = getComputedStyle(document.body).backgroundColor
  const background = bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent' ? bg : (dark ? '#000' : '#fff')
  const fg = dark ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.7)'
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return createPortal(
    <div
      role="dialog"
      aria-label={alt}
      onClick={(e) => { e.stopPropagation(); onClose() }}
      style={{ position: 'fixed', inset: 0, zIndex: 10000, background, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'auto', cursor: 'zoom-out' }}
    >
      <img
        src={url}
        alt={alt}
        onClick={(e) => { e.stopPropagation(); setActual(a => !a) }}
        style={actual
          ? { display: 'block', maxWidth: 'none', cursor: 'zoom-out' }
          : { display: 'block', maxWidth: 'calc(100vw - 48px)', maxHeight: 'calc(100vh - 72px)', width: 'auto', height: 'auto', cursor: 'zoom-in' }}
      />
      <div style={{ position: 'fixed', left: 16, bottom: 12, fontSize: 12, color: fg, fontFamily: 'var(--dsh-font-mono, ui-monospace, monospace)' }}>{caption}{actual ? ' · 1:1' : ' · fit'}</div>
      <button type="button" aria-label="Close" onClick={(e) => { e.stopPropagation(); onClose() }} style={{ position: 'fixed', top: 12, right: 16, fontSize: 22, lineHeight: 1, color: fg, background: 'transparent', border: 0, cursor: 'pointer' }}>×</button>
    </div>,
    document.body,
  )
}

// ---------------------------------------------------------------- the row

// Type as the shipped ToolRow does (ToolRow.module.css `.summary`, DisclosureRow
// `.title`): the secondary content size, which follows the Settings font-size
// preference. A hardcoded 13px here rendered LARGER than the 11px title.
const ROW_STYLE: CSSProperties = { fontSize: 'var(--dsh-content-font-size-secondary, 13px)', lineHeight: 'calc(24px + var(--dsh-content-font-delta, 0px))' }
const SUMMARY_STYLE: CSSProperties = { flex: '1 1 auto', minWidth: 0, marginLeft: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'inherit', lineHeight: 'inherit', color: 'var(--dsw-alias-label-tertiary)' }
const ERROR_SUMMARY_STYLE: CSSProperties = { ...SUMMARY_STYLE, color: 'var(--dsw-alias-state-error-primary, #e5484d)' }
const BODY_STYLE: CSSProperties = { padding: '6px 0 8px 22px', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8 }
const PRE_STYLE: CSSProperties = { margin: 0, alignSelf: 'stretch', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, lineHeight: '18px', maxHeight: 360, overflow: 'auto', opacity: 0.85 }

const GLOBE = <IconGlobeOutline14 size={14} />

function leading(state: RowState): ReactNode {
  switch (state) {
    case 'error': return <StateDot state="error" />
    case 'stopped': return <StateDot state="warning" />
    case 'running': return <StateDot state="ongoing" />
    default: return GLOBE
  }
}

function browserOf(toolName: string): 'Chrome' | 'Safari' {
  return toolName.startsWith('safari_') ? 'Safari' : 'Chrome'
}

export function ScreenshotRow({ toolName, block, loadImage }: Props) {
  const [open, setOpen] = useState(false)
  const state = stateOf(block)
  const args = parseArgs(block)
  const browser = browserOf(toolName)
  const title = `${browser} screenshot`
  const text = resultText(block)
  const refs = imageRefsOf(block)
  const target = targetOf(args)

  const summary = state === 'running'
    ? `capturing ${target}…`
    : state === 'ok'
      ? summaryOf(text, target)
      : state === 'stopped'
        ? 'interrupted'
        : (firstLine(text) || 'failed')
  const summaryStyle = state === 'error' ? ERROR_SUMMARY_STYLE : SUMMARY_STYLE

  const expandable = state !== 'running' && (refs.length > 0 || text !== '')
  return (
    <div style={ROW_STYLE} data-tool-state={state} data-tool={toolName}>
      <DisclosureRow
        icon={leading(state)}
        title={title}
        open={open && expandable}
        expandable={expandable}
        expandOnRowClick
        keepContentWhenOpen
        onToggle={() => setOpen(v => !v)}
        collapsedContent={<span style={summaryStyle} title={summary}>{summary}</span>}
      >
        <div style={BODY_STYLE}>
          {refs.map(ref => <Shot key={ref.attachmentId} loadImage={loadImage} image={ref} alt={`${title}: ${target}`} />)}
          {text !== '' && <pre style={PRE_STYLE}>{text}</pre>}
        </div>
      </DisclosureRow>
    </div>
  )
}

// ---------------------------------------------------------------- plugin

/** The tools whose results carry an inline image block (curated-tools.mjs `inlineFinalizer`). */
export const SCREENSHOT_TOOLS = ['chrome_get_screenshot', 'safari_get_screenshot'] as const

export const name = 'browser-automation-client'
export const inject = ['slots']

export function apply(ctx: Context): void {
  ctx.slots.inject('tool.call.toolview', () =>
    SCREENSHOT_TOOLS.map(key => ctx.slots.register({ name: 'tool.call.toolview', key }, ScreenshotRow)))
}
