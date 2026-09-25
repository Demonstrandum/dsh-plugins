#!/usr/bin/env node
/**
 * import-claude-session.mjs — convert a Claude Code transcript into a DSH
 * session log, OFFLINE (server stopped).
 *
 * SUPERSEDED (2026-09-24) by the `tali-import-sessions` plugin
 * (plugins/import-sessions): `/import-claude` in the GUI or `/import-claude
 * <path>` headlessly import through DSH's own services while the server runs,
 * with real image attachments, subagent child sessions and a working-session
 * fold. This script writes the on-disk artifact directly and predates format
 * v3 (no `stream` field, v2 replace spelling); keep it only as a reference for
 * the byte-level container contract described in the recipe.
 *
 * Claude Code (and therefore Supacode, which delegates persistence to the agent
 * CLIs it hosts) keeps one JSONL transcript per session under
 * `~/.claude/projects/<slug-of-cwd>/<sessionId>.jsonl`. DSH keeps a very
 * different artifact: an append-only event log (`session.jsonl.zstd`) whose
 * first line is a session header and whose events follow DSH's own vocabulary
 * and relational rules.
 *
 * This tool performs the mapping. It deliberately borrows DSH's own format
 * helpers (header line, event serialization, project/session directory layout,
 * log scanner) from the checkout instead of reimplementing the byte format, and
 * it validates its output with DSH's real scanner before reporting success.
 *
 * Mapping:
 *   user prompt            -> turn/start + user/message
 *   assistant message      -> step/start + assistant/message (+ usage)
 *     thinking               -> {type:'reasoning'}
 *     text                   -> {type:'text'}
 *     tool_use               -> {type:'tool-call'} block + tool/call event
 *   tool_result            -> tool/result (paired by callId within the step)
 *   ai-title               -> session/title at end of log (title is overridable)
 *
 * Claude Code writes ONE RECORD PER CONTENT BLOCK, not one per message: a single
 * model response contributes a run of consecutive `assistant` records that share
 * one `message.id` (thinking, then text, then one record per tool_use). Those
 * runs MUST be grouped back into a single assistant message, or every tool_use
 * lands in its own step and its tool_result looks like an orphan. Records are
 * deduplicated by `uuid` (unique per record) and never by `message.id` (shared
 * across a response's records).
 *
 * Invariant rules honored (packages/core/session/src/invariant.ts):
 *   turns number from 1 and never nest; step-scoped events require an open step;
 *   a step/end clears pending calls; tool/result requires a prior tool/call with
 *   the same callId in the same step; seq is contiguous from 0.
 *
 * Lossiness is explicit: images become text placeholders (DSH ImageBlock
 * references the attachment service, not inline base64), an individual tool
 * result body is capped, and injected context records (attachments, system
 * reminders, file-history snapshots, queue/mode bookkeeping) are dropped. Every
 * drop and truncation is counted and printed.
 *
 * Usage:
 *   node import-claude-session.mjs \
 *     --source ~/.claude/projects/-Users-tali-github-ncatlab-dash/<id>.jsonl \
 *     --cwd /Users/USER/github/ncatlab-dash \
 *     --id claude-<id> \
 *     --title "..." \
 *     [--sessions-root ~/.dsh/sessions] [--cap 8192] [--dry-run]
 */

import { createReadStream } from 'node:fs'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { zstdCompress, zstdDecompress, constants } from 'node:zlib'

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { cap: 8192, sessionsRoot: join(homedir(), '.dsh', 'sessions'), dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`missing value for ${a}`)
      return v
    }
    switch (a) {
      case '--source': out.source = resolve(next().replace(/^~/, homedir())); break
      case '--cwd': out.cwd = next(); break
      case '--id': out.id = next(); break
      case '--title': out.title = next(); break
      case '--cap': out.cap = Number(next()); break
      case '--sessions-root': out.sessionsRoot = resolve(next().replace(/^~/, homedir())); break
      case '--dsh-checkout': out.checkout = resolve(next().replace(/^~/, homedir())); break
      case '--dry-run': out.dryRun = true; break
      case '--help': case '-h': out.help = true; break
      default: throw new Error(`unknown argument: ${a}`)
    }
  }
  return out
}

const USAGE = `usage: import-claude-session.mjs --source <transcript.jsonl> --cwd <dir> --id <sessionId>
       [--title <title>] [--cap <bytes>] [--sessions-root <dir>] [--dry-run]`

const args = parseArgs(process.argv.slice(2))
if (args.help || !args.source || !args.cwd || !args.id) {
  console.error(USAGE)
  process.exit(args.help ? 0 : 2)
}

// DSH's authoritative format helpers (Node >= 22.18 strips the TS types).
const checkout = args.checkout ?? join(homedir(), 'github', 'deepseek-harness')
const fmt = await import(
  join(checkout, 'packages', 'session', 'session-persistence-jsonl', 'src', 'format.ts')
)

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Deterministic UUID-shaped id so a re-import reproduces identical bytes. */
function detUuid(namespace, key) {
  const h = createHash('sha1').update(`${namespace}:${key}`).digest()
  const b = Buffer.from(h.subarray(0, 16))
  b[6] = (b[6] & 0x0f) | 0x50 // version 5
  b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122 variant
  const hex = b.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const stats = {
  lines: 0,
  recordsSkipped: {},
  duplicateRecords: 0,
  turns: 0,
  steps: 0,
  emitted: {},
  prompts: 0,
  interrupts: 0,
  toolCalls: 0,
  toolResults: 0,
  orphanResults: 0,
  unpairedCalls: 0,
  images: 0,
  imageBytes: 0,
  truncated: 0,
  truncatedBytes: 0,
  firstTime: null,
  lastTime: null,
  claudeTitle: null,
  models: {},
}

const bump = (bag, key, by = 1) => { bag[key] = (bag[key] ?? 0) + by }

/** Injected-context records Claude interleaves with real human turns. */
const SKIP_TEXT_PREFIXES = [
  '<system-reminder',
  '<local-command-stdout',
  '<local-command-caveat',
  '<command-name',
  '<command-message',
  '<user-prompt-submit-hook',
  '<post-tool-use-hook',
  '<task-notification',
  'Caveat: The messages below were generated',
]

/** A user-side cancel marker, not a prompt: it closes its turn instead. */
const INTERRUPT_MARKER = /^\[Request interrupted by user/

const isInjectedText = (text) => {
  const t = text.trimStart()
  return SKIP_TEXT_PREFIXES.some((p) => t.startsWith(p))
}

let seq = 0
const events = []
let lastTime = 0

/** Append one event, mirroring the persisted envelope exactly. */
function emit(type, time, data, surfaceOp) {
  const event = { type, seq: seq++, time, data }
  if (surfaceOp !== undefined) event.surfaceOp = surfaceOp
  events.push(event)
  bump(stats.emitted, type)
  return event
}

/** Bound one text payload, counting the loss. */
function cap(text, what) {
  if (typeof text !== 'string') return ''
  if (text.length <= args.cap) return text
  stats.truncated++
  stats.truncatedBytes += text.length - args.cap
  return `${text.slice(0, args.cap)}\n\n[…${what} truncated at import: ${text.length - args.cap} chars elided; original in the Claude transcript]`
}

function imagePlaceholder(mediaType, approxChars) {
  stats.images++
  stats.imageBytes += approxChars
  return `[image not imported: ${mediaType ?? 'unknown type'}, ~${Math.round(approxChars / 1024)} KB base64]`
}

/** Map one Claude content block onto zero or more DSH content blocks. */
function mapBlock(block, sink) {
  if (typeof block === 'string') { sink.push({ type: 'text', text: block }); return }
  if (block === null || typeof block !== 'object') return
  switch (block.type) {
    case 'text':
      if (typeof block.text === 'string' && block.text.length > 0) {
        sink.push({ type: 'text', text: block.text })
      }
      break
    case 'thinking':
    case 'redacted_thinking':
      if (typeof block.thinking === 'string' && block.thinking.length > 0) {
        sink.push({ type: 'reasoning', text: block.thinking })
      } else if (block.type === 'redacted_thinking') {
        sink.push({ type: 'reasoning', text: '[redacted thinking block]' })
      }
      break
    case 'image': {
      const src = block.source ?? {}
      sink.push({ type: 'text', text: imagePlaceholder(src.media_type, (src.data ?? '').length) })
      break
    }
    case 'tool_result': {
      const inner = []
      const raw = block.content
      if (typeof raw === 'string') inner.push({ type: 'text', text: cap(raw, 'tool result') })
      else if (Array.isArray(raw)) for (const b of raw) mapBlock(b, inner)
      if (inner.length === 0) inner.push({ type: 'text', text: '[empty tool result]' })
      sink.push({
        type: 'tool-result',
        toolCallId: block.tool_use_id,
        content: inner.map((b) => (b.type === 'text' ? { type: 'text', text: cap(b.text, 'tool result') } : b)),
        ...(block.is_error === true ? { isError: true } : {}),
      })
      break
    }
    default:
      sink.push({ type: 'text', text: `[unsupported block: ${String(block.type)}]` })
  }
}

// ---------------------------------------------------------------------------
// turn/step state (must satisfy the session invariant)
// ---------------------------------------------------------------------------

let turn = 0
let step = 0
let turnOpen = false
let stepOpen = false
let pending = new Map() // callId -> name, for the open step

function startTurn(time) {
  turn += 1
  stats.turns++
  emit('turn/start', time, { turn })
  turnOpen = true
  step = 0
}

function openStep(time) {
  step += 1
  stats.steps++
  emit('step/start', time, { turn, step })
  stepOpen = true
  pending = new Map()
}

function closeStep(time) {
  if (!stepOpen) return
  emit('step/end', time, { turn, step })
  stepOpen = false
  stats.unpairedCalls += pending.size
  pending = new Map()
}

function endTurn(time, reason = { kind: 'completed' }) {
  if (!turnOpen) return
  closeStep(time)
  emit('turn/end', time, { turn, reason })
  turnOpen = false
}

// ---------------------------------------------------------------------------
// convert
// ---------------------------------------------------------------------------

const seenUuid = new Set()

/**
 * The assistant message currently being assembled from a run of per-block
 * records that share one `message.id`.
 */
let pendingAssistant = null

/**
 * Flush the assembled assistant message into its own step: the assistant
 * message event first, then one tool/call event per requested call so the
 * following tool results can pair against them.
 */
function flushAssistant(at) {
  const msg = pendingAssistant
  pendingAssistant = null
  if (msg === null) return
  if (!turnOpen) startTurn(at)

  const content = []
  const calls = []
  for (const block of msg.blocks) {
    if (block?.type === 'tool_use') {
      const callId = String(block.id ?? `call_${seq}`)
      const argText = JSON.stringify(block.input ?? {})
      content.push({ type: 'tool-call', id: callId, name: String(block.name ?? 'unknown'), arguments: argText })
      calls.push({ callId, name: String(block.name ?? 'unknown'), arguments: argText })
    } else {
      mapBlock(block, content)
    }
  }
  if (content.length === 0) { bump(stats.recordsSkipped, 'assistant-empty'); return }

  closeStep(at)
  openStep(at)
  const data = {
    turn,
    step,
    message: {
      role: 'assistant',
      source: { kind: 'model', provider: 'anthropic', model: msg.model ?? 'claude' },
      content,
      id: detUuid('message', msg.key),
    },
  }
  if (msg.usage !== null) data.usage = msg.usage
  emit('assistant/message', at, data, 'append')
  for (const c of calls) {
    pending.set(c.callId, c.name)
    stats.toolCalls++
    emit('tool/call', at, { turn, step, callId: c.callId, name: c.name, arguments: c.arguments })
  }
}

const rl = createInterface({ input: createReadStream(args.source), crlfDelay: Infinity })

for await (const line of rl) {
  stats.lines++
  if (line.trim() === '') continue
  let rec
  try { rec = JSON.parse(line) } catch { bump(stats.recordsSkipped, '<unparsable>'); continue }

  const type = rec.type ?? '?'
  const time = rec.timestamp ? Date.parse(rec.timestamp) : Number.NaN
  const at = Number.isFinite(time) ? time : (lastTime || 0)

  // Claude's own auto-generated session title — the transcript's real name.
  if (type === 'ai-title') {
    if (typeof rec.aiTitle === 'string' && rec.aiTitle.length > 0) stats.claudeTitle ??= rec.aiTitle
    bump(stats.recordsSkipped, 'ai-title')
    continue
  }

  if (type !== 'user' && type !== 'assistant') {
    bump(stats.recordsSkipped, type)
    continue
  }

  // `uuid` is the per-record identity (unique); `message.id` is shared by every
  // record of one response, so it must never be used to deduplicate.
  if (typeof rec.uuid === 'string') {
    if (seenUuid.has(rec.uuid)) { stats.duplicateRecords++; continue }
    seenUuid.add(rec.uuid)
  }
  if (rec.isSidechain === true) { bump(stats.recordsSkipped, 'sidechain'); continue }

  if (stats.firstTime === null) stats.firstTime = at
  stats.lastTime = at
  lastTime = at

  const content = rec.message?.content
  const blocks = Array.isArray(content)
    ? content
    : (typeof content === 'string' ? [{ type: 'text', text: content }] : [])

  if (type === 'assistant') {
    if (rec.isMeta === true) { bump(stats.recordsSkipped, 'assistant-meta'); continue }
    const messageId = rec.message?.id ?? rec.uuid ?? `${args.id}:${seq}`
    if (pendingAssistant !== null && pendingAssistant.messageId !== messageId) flushAssistant(at)
    if (pendingAssistant === null) {
      const model = rec.message?.model ?? 'claude'
      bump(stats.models, model)
      const usage = rec.message?.usage
      pendingAssistant = {
        messageId,
        key: messageId,
        model,
        blocks: [],
        usage: usage && typeof usage === 'object'
          ? {
            inputTokens: Number(usage.input_tokens ?? 0),
            outputTokens: Number(usage.output_tokens ?? 0),
            ...(Number.isFinite(usage.cache_read_input_tokens) ? { cacheReadTokens: usage.cache_read_input_tokens } : {}),
            ...(Number.isFinite(usage.cache_creation_input_tokens) ? { cacheWriteTokens: usage.cache_creation_input_tokens } : {}),
          }
          : null,
      }
    }
    pendingAssistant.blocks.push(...blocks)
    continue
  }

  // type === 'user': the assistant run it answers is complete
  flushAssistant(at)

  const promptTexts = []
  const promptImages = []
  const toolResults = []
  for (const b of blocks) {
    if (b?.type === 'text' && typeof b.text === 'string' && !isInjectedText(b.text)) promptTexts.push(b.text)
    else if (b?.type === 'image') promptImages.push(b)
    else if (b?.type === 'tool_result') toolResults.push(b)
  }

  // 1. tool results land in the step opened by the assistant message they answer
  for (const b of toolResults) {
    const callId = String(b.tool_use_id ?? '')
    if (!stepOpen || !pending.has(callId)) { stats.orphanResults++; continue }
    pending.delete(callId)
    const sink = []
    mapBlock(b, sink)
    stats.toolResults++
    emit('tool/result', at, {
      turn,
      step,
      message: {
        role: 'user',
        source: { kind: 'tool', callId },
        content: sink.map((blk) => (blk.type === 'text'
          ? { type: 'text', text: cap(blk.text, 'tool result') }
          : blk)),
        id: detUuid('tool-result', rec.uuid ?? `${args.id}:${seq}`),
      },
    }, 'append')
  }

  // 2. a genuine human prompt opens a new turn; a cancel marker closes instead
  if (promptTexts.length > 0 || promptImages.length > 0) {
    if (rec.isMeta === true) { bump(stats.recordsSkipped, 'user-meta'); continue }
    const real = promptTexts.filter((text) => !INTERRUPT_MARKER.test(text.trim()))
    if (real.length === 0 && promptImages.length === 0) {
      stats.interrupts++
      closeStep(at)
      endTurn(at, { kind: 'interrupted' })
      continue
    }
    closeStep(at)
    endTurn(at)
    startTurn(at)
    stats.prompts++
    const out = real.map((text) => ({ type: 'text', text }))
    for (const img of promptImages) {
      const src = img.source ?? {}
      out.push({ type: 'text', text: imagePlaceholder(src.media_type, (src.data ?? '').length) })
    }
    emit('user/message', at, {
      role: 'user',
      source: { kind: 'user' },
      content: out,
      id: detUuid('message', rec.uuid ?? `${args.id}:${seq}`),
    }, 'append')
  } else if (toolResults.length === 0) {
    bump(stats.recordsSkipped, 'user-empty')
  }
}

// close the trailing bracket, then record the title
flushAssistant(lastTime || stats.firstTime || Date.now())
endTurn(lastTime || stats.firstTime || Date.now())
const title = args.title ?? stats.claudeTitle ?? 'Imported Claude Code session'
emit('session/title', lastTime || stats.firstTime || Date.now(), {
  title,
  messageSeqs: [],
  source: { kind: 'user' },
})

// ---------------------------------------------------------------------------
// header + serialize with DSH's own helpers
// ---------------------------------------------------------------------------

const createdAt = stats.firstTime ?? Date.now()
const header = fmt.toHeaderLine({
  version: 0,
  id: args.id,
  createdAt,
  cwd: args.cwd,
  isSeeded: false,
  delegationDepth: 0,
})

// DSH's artifact is a CONCATENATED-FRAME container, not one frame: the first
// zstd frame must decode to exactly the header line (the reader asserts this and
// refuses the log otherwise), and each later frame carries a batch of events.
const FRAME_EVENTS = 2000
const ZSTD_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
const compressFrame = async (text) => promisify(zstdCompress)(Buffer.from(text, 'utf8'), ZSTD_OPTIONS)

const eventLines = fmt.eventLines(events, false).split('\n')
const frames = [await compressFrame(`${JSON.stringify(header)}\n`)]
for (let i = 0; i < eventLines.length; i += FRAME_EVENTS) {
  frames.push(await compressFrame(`${eventLines.slice(i, i + FRAME_EVENTS).join('\n')}\n`))
}
const compressed = Buffer.concat(frames)
const raw = Buffer.from(`${JSON.stringify(header)}\n${eventLines.join('\n')}\n`, 'utf8')
const logFile = fmt.logPath(args.sessionsRoot, args.cwd, args.id, 'zstd')

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

const num = (n) => n.toLocaleString('en-US')
console.log(`source        ${args.source}`)
console.log(`session id    ${args.id}`)
console.log(`cwd           ${args.cwd}`)
console.log(`title         ${title}${args.title === undefined && stats.claudeTitle ? '  (Claude auto-title)' : ''}`)
console.log(`span          ${new Date(createdAt).toISOString()} -> ${new Date(stats.lastTime).toISOString()}`)
console.log(`turns/steps   ${num(stats.turns)} / ${num(stats.steps)}   prompts ${num(stats.prompts)}   interrupted turns ${num(stats.interrupts)}`)
console.log(`tool activity ${num(stats.toolCalls)} calls, ${num(stats.toolResults)} results`)
console.log(`models        ${Object.entries(stats.models).map(([m, c]) => `${m}×${c}`).join(', ')}`)
console.log(`images        ${num(stats.images)} (${num(stats.imageBytes)} base64 chars) -> text placeholders`)
console.log(`truncated     ${num(stats.truncated)} payloads, ${num(stats.truncatedBytes)} chars elided`)
console.log(`dropped       ${num(stats.orphanResults)} orphan tool results, ${num(stats.unpairedCalls)} unanswered calls, ${num(stats.duplicateRecords)} replayed records`)
console.log(`raw jsonl     ${num(raw.length)} bytes`)
console.log(`compressed    ${num(compressed.length)} bytes`)
console.log('skipped       ' + Object.entries(stats.recordsSkipped).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(', '))

if (args.dryRun) {
  console.log('\n--dry-run: nothing written')
  process.exit(0)
}

await mkdir(join(logFile, '..'), { recursive: true })
await writeFile(logFile, compressed)
console.log(`\nwrote ${logFile}`)

// ---------------------------------------------------------------------------
// validate with DSH's own scanner
// ---------------------------------------------------------------------------

const plain = raw
const scanned = fmt.scanLog(plain)

const problems = []

// The physical contract the reader enforces: the artifact is a concatenated-frame
// container whose FIRST frame decodes to exactly the header line. Node's zstd
// decoder stops after one frame, so decoding the file proves that boundary.
const onDisk = await readFile(logFile)
const headerLine = `${JSON.stringify(header)}\n`
const decodedFirstFrame = Buffer.from(await promisify(zstdDecompress)(onDisk)).toString('utf8')
if (decodedFirstFrame !== headerLine) {
  problems.push('first frame is not exactly the header line (DSH refuses such a log)')
}
const expectedBytes = frames.reduce((total, frame) => total + frame.length, 0)
if (onDisk.length !== expectedBytes) {
  problems.push(`artifact is ${onDisk.length} bytes, expected ${expectedBytes} concatenated frames`)
}

if (scanned.meta.id !== args.id) problems.push(`header id ${scanned.meta.id} != ${args.id}`)
if (scanned.meta.cwd !== args.cwd) problems.push(`header cwd ${scanned.meta.cwd} != ${args.cwd}`)
if (scanned.events.length !== events.length) problems.push(`read ${scanned.events.length} events, wrote ${events.length}`)
scanned.events.forEach((e, i) => { if (e.seq !== i) problems.push(`seq gap at ${i}: ${e.seq}`) })
if (scanned.committedBytes !== raw.length) problems.push(`committed ${scanned.committedBytes} != ${raw.length}`)

// replay the relational invariant over what DSH will read back
{
  let openTurn = null, openStep = null, nextTurn = 1, nextStep = 1
  const calls = new Set()
  for (const e of scanned.events) {
    const d = e.data
    switch (e.type) {
      case 'turn/start':
        if (openTurn !== null) problems.push(`turn/start ${d.turn} while ${openTurn} open`)
        if (d.turn !== nextTurn) problems.push(`turn/start expected ${nextTurn}, got ${d.turn}`)
        openTurn = d.turn; nextStep = 1; break
      case 'turn/end':
        if (openTurn !== d.turn) problems.push(`turn/end ${d.turn} != open ${openTurn}`)
        if (openStep !== null) problems.push(`turn/end ${d.turn} with step ${openStep} open`)
        openTurn = null; nextTurn += 1; break
      case 'step/start':
        if (openTurn !== d.turn) problems.push(`step/start in ${d.turn}, open turn ${openTurn}`)
        if (openStep !== null) problems.push(`step/start ${d.step} while ${openStep} open`)
        if (d.step !== nextStep) problems.push(`step/start expected ${nextStep}, got ${d.step}`)
        openStep = d.step; break
      case 'step/end':
        if (openTurn !== d.turn || openStep !== d.step) problems.push(`step/end ${d.turn}/${d.step} mismatched`)
        calls.clear(); openStep = null; nextStep += 1; break
      case 'assistant/message':
      case 'tool/call':
        if (openTurn !== d.turn || openStep !== d.step) problems.push(`${e.type} outside its step`)
        if (e.type === 'tool/call') calls.add(d.callId)
        break
      case 'tool/result': {
        if (openTurn !== d.turn || openStep !== d.step) problems.push('tool/result outside its step')
        const id = d.message.source.callId
        if (!calls.has(id)) problems.push(`tool/result for ${id} with no prior tool/call`)
        calls.delete(id); break
      }
      default: break
    }
  }
  if (openTurn !== null) problems.push(`log ends with turn ${openTurn} still open`)
}

if (problems.length > 0) {
  console.error('\nVALIDATION FAILED:')
  for (const p of problems.slice(0, 20)) console.error('  - ' + p)
  process.exit(1)
}
console.log(`validated: ${num(scanned.events.length)} events, header + seq contiguity + turn/step/call relations OK`)
