#!/usr/bin/env node
/**
 * shrink-session-surface.mjs — hide an oversized imported transcript's older
 * history from the MODEL while keeping every byte in the session log.
 *
 * Why: an imported transcript is replayed as live model-visible history, so a
 * long one (the nLab→Dash import is 8,639 surface events ≈ 1.26M tokens by the
 * token meter and ~2.5M by a provider tokenizer) exceeds every model window.
 * Every prompt is then rejected, and compaction cannot rescue it either: the
 * LLM-free tool-result pruner only trims results above `thresholdChars`, and
 * the summarizing path must send the same oversized history. Deadlock.
 *
 * This tool applies the same surface-replace mechanism compaction uses,
 * without any model call:
 *
 *   compaction/start   (standalone bracket — requires no open turn)
 *   compaction/prune   shadow price of the replaced range
 *   user/message       the replacement checkpoint, surfaceOp {replace}
 *   compaction/end
 *
 * The ordering is the token meter's shadow-price protocol: the replacement MUST
 * be appended immediately after its metering event, and the claim's range MUST
 * equal the replacement's `surfaceOp` range, or the meter fails loud. The
 * shadowed events stay in the log, so the transcript remains inspectable and
 * rewindable — only the model stops seeing them.
 *
 * Run it with the server STOPPED (or the session closed): the running server
 * owns a live session's cursor, and appending behind its back makes the log and
 * its in-memory state diverge.
 *
 * Usage:
 *   node shrink-session-surface.mjs --session <sessionId> [--keep-turns 20]
 *        [--sessions-root ~/.dsh/sessions] [--dry-run] [--note-file <path>]
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { constants, zstdCompress } from 'node:zlib'
import { promisify } from 'node:util'

const args = { keepTurns: 20, sessionsRoot: join(homedir(), '.dsh', 'sessions'), dryRun: false }
for (let i = 0; i < process.argv.length - 2; i++) {
  const flag = process.argv[i + 2]
  const value = () => {
    const v = process.argv[++i + 2]
    if (v === undefined) throw new Error(`missing value for ${flag}`)
    return v
  }
  if (flag === '--session') args.session = value()
  else if (flag === '--keep-turns') args.keepTurns = Number(value())
  else if (flag === '--sessions-root') args.sessionsRoot = resolve(value().replace(/^~/, homedir()))
  else if (flag === '--note-file') args.noteFile = resolve(value().replace(/^~/, homedir()))
  else if (flag === '--dry-run') args.dryRun = true
  else if (flag !== '--') throw new Error(`unknown argument: ${flag}`)
}
if (args.session === undefined) {
  console.error('usage: shrink-session-surface.mjs --session <sessionId> [--keep-turns N] [--dry-run]')
  process.exit(2)
}

const checkout = join(homedir(), 'github', 'deepseek-harness')
const fmt = await import(join(checkout, 'packages', 'session', 'session-persistence-jsonl', 'src', 'format.ts'))
const { estimateMessage } = await import(join(checkout, 'packages', 'llm', 'token-meter', 'src', 'estimate.ts'))

const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])

/** The session package's own `deriveEventMessage` (not importable: TS parameter properties). */
function deriveEventMessage(event) {
  if (event.type === 'user/message') return event.data
  if (event.type === 'assistant/message') return event.data.message.content.length === 0 ? null : event.data.message
  if (event.type === 'tool/result') return event.data.message
  return null
}

/** Read a concatenated-frame log as plaintext (node:zlib stops at the first frame). */
function readLog(path) {
  try {
    return execFileSync('zstd', ['-dc', path], { maxBuffer: 1 << 30 })
  } catch (error) {
    throw new Error(
      `could not decode ${path} with the zstd CLI (${error.message.split('\n')[0]}); `
      + 'install zstd or use a machine that has it',
    )
  }
}

function findLog(root, id) {
  for (const project of readdirSync(root)) {
    const candidate = join(root, project, fmt.encodeSegment(id), 'session.jsonl.zstd')
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`no session log for '${args.session}' under ${root}`)
}

const file = findLog(args.sessionsRoot, args.session)
const plain = readLog(file)
const lines = plain.toString('utf8').split('\n').filter(line => line !== '')
const header = JSON.parse(lines[0])
const events = lines.slice(1).map(line => JSON.parse(line))
events.forEach((event, index) => {
  if (event.seq !== index) throw new Error(`log is not contiguous: event ${index} has seq ${event.seq}`)
})

// ── reconstruct the current model-visible surface (appends + prior replaces) ──
const surface = []
let openTurn = null
let lastTurn = 0
for (const event of events) {
  if (event.type === 'turn/start') { openTurn = event.data.turn; lastTurn = Math.max(lastTurn, openTurn) }
  else if (event.type === 'turn/end') openTurn = null
  if (!SURFACE_TYPES.has(event.type) || event.surfaceOp === undefined) continue
  if (event.surfaceOp === 'append') {
    surface.push({ seq: event.seq, turn: event.data.turn ?? openTurn ?? lastTurn, event })
    continue
  }
  const startIdx = surface.findIndex(node => node.seq === event.surfaceOp.start)
  const endIdx = surface.findIndex(node => node.seq === event.surfaceOp.end)
  if (startIdx < 0 || endIdx < startIdx) throw new Error(`replace at seq ${event.seq} names a range outside the surface`)
  surface.splice(startIdx, endIdx - startIdx + 1, {
    seq: event.seq, turn: event.data.turn ?? openTurn ?? lastTurn, event,
  })
}

const PLUGIN = 'session-import-shrink'
if (events.some(event => event.type === 'user/message' && event.data.source?.plugin === PLUGIN)) {
  console.log('already shrunk by this tool; nothing to do')
  process.exit(0)
}
if (openTurn !== null) {
  throw new Error(`turn ${openTurn} is still open; close it before shrinking (a standalone compaction bracket needs no open turn)`)
}

const cutTurn = lastTurn - args.keepTurns
const firstKeptIdx = surface.findIndex(node => node.turn > cutTurn)
if (firstKeptIdx <= 0) {
  console.log(`nothing to shrink: the surface spans ${surface.length} nodes over turns up to ${lastTurn}`)
  process.exit(0)
}
const shadowed = surface.slice(0, firstKeptIdx)
const kept = surface.slice(firstKeptIdx)

const priceOf = (node) => {
  const message = deriveEventMessage(node.event)
  return message === null ? 0 : estimateMessage(message)
}
const shadowedTokens = shadowed.reduce((total, node) => total + priceOf(node), 0)
const keptTokens = kept.reduce((total, node) => total + priceOf(node), 0)

// ── the note that replaces the shadowed range ────────────────────────────────
const defaultNote = [
  `Imported-history checkpoint. Turns 1–${cutTurn - 1} of this transcript (the Supacode-era `
  + `Claude Code session "Build nLab Dash docset recipe", 2026-08-06 → 2026-08-25) are no longer sent to the model: `
  + `at ~${Math.round(shadowedTokens / 1000)}K tokens they exceeded every model window, which made every request fail. `
  + `They remain in this session's log — visible in the session log / trajectory view and via rewind. `
  + `The last ${args.keepTurns} turns are kept in full, below.`,
  '',
  'Project state carried over (see also the workspace file CLAUDE.local.md):',
  '- nLab → typst conversion: docset recipe done; diagram converters tikzcd→fletcher, xymatrix, '
  + 'tikzpicture→cetz built and reviewed via rewrites/out/compare-xymatrix.html (163 rows) and '
  + 'compare-tikzpicture.html (121 rows).',
  '- Bulk page compile at the end of the omitted history: 20,723/20,723 ok, 0 failed.',
  '- Test pages with `nlab-typ page NAME < content.md` — the binary reads source from STDIN; a file path '
  + 'argument silently compiles an empty page.',
  '- Bulk runner: `rewrites/bulk_pages.py --html --jobs 10` → build/typ-pages/, report rewrites/out/bulk-report.txt.',
  '- Standing rules: commit but never push ncatlab-dash; do not rebuild the docset unless asked; verify diagram '
  + 'fixes by side-by-side rendering against nLab server SVGs personally.',
].join('\n')
const note = args.noteFile === undefined ? defaultNote : readFileSync(args.noteFile, 'utf8')

// ── build the append: standalone compaction bracket + prune claim + replacement ──
const compactionId = randomUUID()
const now = Date.now()
const time = events.length > 0 ? Math.max(now, events.at(-1).time ?? 0) : now
let seq = events.length
const surfaceSpan = { start: shadowed[0].seq, end: shadowed.at(-1).seq }
const shadowedSeqs = shadowed.map(node => node.seq)

const appended = [
  { type: 'compaction/start', seq: seq++, time, data: { compactionId, turn: null } },
  { type: 'compaction/prune', seq: seq++, time, data: { shadowedRange: surfaceSpan, shadowedSeqs, shadowedTokenCount: shadowedTokens } },
  {
    type: 'user/message',
    seq: seq++,
    time,
    data: {
      role: 'user',
      source: { kind: 'plugin', plugin: 'compact', compactionId },
      content: [{ type: 'text', text: note }],
      id: randomUUID(),
    },
    surfaceOp: { op: 'replace', start: surfaceSpan.start, end: surfaceSpan.end },
    sourceEventSeqs: [...shadowedSeqs],
  },
  { type: 'compaction/end', seq: seq++, time, data: { compactionId, turn: null } },
]

const frame = await promisify(zstdCompress)(
  Buffer.from(`${fmt.eventLines(appended, false)}\n`, 'utf8'),
  { params: { [constants.ZSTD_c_checksumFlag]: 1 } },
)

console.log(`log            ${file}`)
console.log(`surface before ${surface.length.toLocaleString()} nodes, ~${shadowedTokens + keptTokens} tokens (meter estimator)`)
console.log(`shadowing      turns 1–${cutTurn - 1}: ${shadowed.length.toLocaleString()} nodes, ~${shadowedTokens.toLocaleString()} tokens`)
console.log(`keeping        turns ${cutTurn}–${lastTurn}: ${kept.length.toLocaleString()} nodes, ~${keptTokens.toLocaleString()} tokens`)
console.log(`replacement    ${note.length.toLocaleString()} chars`)
console.log(`append         ${appended.map(event => event.type).join(' → ')} (one new zstd frame, ${frame.length.toLocaleString()} bytes)`)

if (args.dryRun) {
  console.log('\n--dry-run: nothing written')
  process.exit(0)
}

const backup = `${file}.preshrink.bak`
copyFileSync(file, backup)
writeFileSync(file, Buffer.concat([readFileSync(file), frame]))
console.log(`\nbackup         ${backup}`)
console.log(`appended       ${frame.length.toLocaleString()} bytes`)

// ── validate by re-reading the whole artifact ────────────────────────────────
const after = readLog(file).toString('utf8').split('\n').filter(line => line !== '')
const afterEvents = after.slice(1).map(line => JSON.parse(line))
const problems = []
afterEvents.forEach((event, index) => {
  if (event.seq !== index) problems.push(`seq gap at ${index}: ${event.seq}`)
})
const total = afterEvents.length
const [, prune, replacement] = afterEvents.slice(total - 4, total - 1)
const startEventSeq = afterEvents[total - 4]?.seq
if (startEventSeq === undefined) problems.push('append did not land')
else {
  const replacementSeq = afterEvents[total - 2]?.seq
  if (prune?.type !== 'compaction/prune') problems.push(`expected compaction/prune before the replacement, found ${prune?.type}`)
  if (replacement?.type !== 'user/message') problems.push(`expected the replacement user/message, found ${replacement?.type}`)
  if (prune?.seq !== replacementSeq - 1) problems.push('the prune claim is not immediately before its replacement (the meter would fail loud)')
  if (prune?.data.shadowedRange.start !== replacement?.surfaceOp.start
    || prune?.data.shadowedRange.end !== replacement?.surfaceOp.end) {
    problems.push('the claim range and the replacement surfaceOp range differ')
  }
  if (afterEvents[total - 1]?.type !== 'compaction/end') problems.push('the compaction bracket is not closed')
}
if (problems.length > 0) {
  console.error('\nVALIDATION FAILED:')
  for (const problem of problems.slice(0, 10)) console.error('  - ' + problem)
  console.error(`\nrestore with: cp "${backup}" "${file}"`)
  process.exit(1)
}

const noteTokens = estimateMessage(replacement.data)
console.log(`validated      ${afterEvents.length.toLocaleString()} events, contiguous, claim adjacent to its replacement`)
console.log(`surface after  ${(kept.length + 1).toLocaleString()} nodes, ~${(keptTokens + noteTokens).toLocaleString()} tokens (meter estimator)`)
