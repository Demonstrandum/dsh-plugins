#!/usr/bin/env node
/**
 * Repair a DSH session.jsonl.zstd whose log contains plugin-injected
 * `user/message` events (and matching `agent/inbox/spliced` inserts) whose
 * `content` is a bare string instead of a ContentBlock[]. Such a message makes
 * every later turn fail with "content.some is not a function".
 *
 * Usage: node repair-string-content.mjs <in.jsonl.zstd> <out.jsonl.zstd>
 *
 * Writes: header as its own checksummed zstd frame, then all events in one
 * frame (the reader accepts any batch framing after the header frame).
 */
import { readFile, writeFile } from 'node:fs/promises'
import { constants, zstdCompress, zstdDecompressSync } from 'node:zlib'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'

const compress = promisify(zstdCompress)
const CHECKSUM = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
const MAGIC = 0xFD2FB528

const [, , input, output] = process.argv
if (!input || !output) {
  console.error('usage: repair-string-content.mjs <in.jsonl.zstd> <out.jsonl.zstd>')
  process.exit(2)
}

/** Decode a concatenated-frame zstd container by walking frame boundaries. */
function decodeAll(buf) {
  // zstdDecompressSync stops after one frame; find frame ends by trial: decode
  // growing prefixes is too slow, so instead use the streaming decoder's
  // bytes-consumed behaviour via repeated single-frame decodes on remaining
  // buffer prefixes located by scanning for the magic number.
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf.readUInt32LE(i) === MAGIC) starts.push(i)
  }
  // Magic may appear inside compressed data; validate each candidate by
  // decoding the slice to the next candidate and keep the ones that succeed
  // greedily from the start.
  const parts = []
  let pos = 0
  while (pos < buf.length) {
    let ok = false
    for (const next of [...starts.filter(s => s > pos), buf.length]) {
      try {
        parts.push(zstdDecompressSync(buf.subarray(pos, next)))
        pos = next
        ok = true
        break
      } catch {
        // not a frame boundary; try the next candidate
      }
    }
    if (!ok) throw new Error(`cannot decode frame at byte ${pos}`)
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: parts.length }
}

function fixMessage(message) {
  if (typeof message.content !== 'string') return false
  const text = message.content
  message.content = [{ type: 'text', text }]
  if (message.role === undefined) message.role = 'user'
  if (message.id === undefined) message.id = randomUUID()
  return true
}

const original = await readFile(input)
const { text, frames } = decodeAll(original)
const lines = text.split('\n')
if (lines.at(-1) === '') lines.pop()
const header = lines[0]
if (!header.startsWith('{"type":"session"')) throw new Error('first line is not the session header')

let fixed = 0
const events = lines.slice(1).map((line) => {
  const event = JSON.parse(line)
  if (event.type === 'user/message' && fixMessage(event.data)) fixed++
  if (event.type === 'agent/inbox/spliced') {
    for (const m of event.data.inserted ?? []) if (fixMessage(m)) fixed++
  }
  return JSON.stringify(event)
})

// Verify seq contiguity. Packed chunk rows (`text-chunks` / `tool-call-chunks`)
// carry `seq0` and one `dt` entry per packed chunk, covering seq0..seq0+dt.length-1.
let expected = 0
for (const line of events) {
  const record = JSON.parse(line)
  if ('seq0' in record) {
    if (record.seq0 !== expected) throw new Error(`seq gap: expected ${expected}, got packed seq0 ${record.seq0}`)
    // Member count is texts.length / args.length (dt has one fewer entry).
    expected += (record.data.texts ?? record.data.args).length
    continue
  }
  if (record.seq !== expected) throw new Error(`seq gap: expected ${expected}, got ${record.seq}`)
  expected++
}

const headerFrame = await compress(header + '\n', CHECKSUM)
const bodyFrame = await compress(events.join('\n') + '\n', CHECKSUM)
await writeFile(output, Buffer.concat([headerFrame, bodyFrame]), { mode: 0o600 })

// Self-check: first frame decodes to exactly the header line, whole file round-trips.
const check = await readFile(output)
if (zstdDecompressSync(check).toString('utf8') !== header + '\n') throw new Error('bad header frame')
const round = decodeAll(check)
if (round.text.split('\n').length - 1 !== events.length + 1) throw new Error('round-trip line count mismatch')
console.log(`input frames: ${frames}; events: ${events.length}; fixed messages: ${fixed}; output bytes: ${check.length}`)
