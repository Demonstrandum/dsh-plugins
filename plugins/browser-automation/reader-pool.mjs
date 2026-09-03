/**
 * Pool of isolated Safari "page readers" for safari_get_page_content.
 *
 * A reader is one private `safaridriver --mcp` process (hence its own STP
 * instance and window, labeled "DSH: page reader #n") driven through a private
 * MCP SDK client — nothing is registered into any agent's tool list, and no
 * agent's own browsing session is touched. The pool starts empty. A read
 * request takes an idle reader or starts a new one, so concurrent reads (e.g.
 * from subagents) each get their own window. When a read finishes, the reader
 * parks on about:blank and returns to the pool; readers beyond `maxIdle` are
 * disposed immediately, and the remaining ones are disposed after `idleMs`
 * without any read (STP quits when the last session ends).
 *
 * The extraction itself — markdown, plainText, text, textTree, html, json — is
 * WebKit's, via the server's get_page_content tool; this module only passes the
 * options through and unwraps the result (including the server's ">= 32 kB
 * goes to a temp file" behavior).
 */

import { readFile } from 'node:fs/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

export const FORMATS = ['markdown', 'plainText', 'text', 'textTree', 'html', 'json']

/**
 * @param {object} options
 * @param {string} options.driver - safaridriver executable (STP).
 * @param {string} options.shim - path to safari-mcp-shim.mjs.
 * @param {string} options.labelPrefix - window banner prefix, e.g. "DSH: ".
 * @param {number} options.maxIdle - readers kept warm after their read (>= 0).
 * @param {number} options.idleMs - dispose all warm readers after this long unused (0 = never).
 * @param {number} options.readTimeoutMs - per MCP call timeout.
 * @param {(record: object) => void} options.trace - lifecycle trace sink.
 * @param {{ warn(message: string): void }} options.logger
 */
export function createReaderPool(options) {
  const { driver, shim, labelPrefix, maxIdle, idleMs, readTimeoutMs, trace, logger } = options
  /** @type {Array<{ id: number, client: Client, transport: StdioClientTransport, busy: boolean, dead: boolean }>} */
  const readers = []
  let nextId = 1
  let idleTimer
  let disposed = false
  /**
   * Cold-start gate. Two brand-new sessions navigating at the same instant can
   * both launch an STP instance, leaving an orphan no session owns. The first
   * read after the pool is empty holds this until its navigation completes
   * (STP is then running and later drivers reuse it); other reads wait for it.
   * @type {Promise<void> | undefined}
   */
  let warming

  async function spawnReader() {
    const id = nextId++
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [shim, '--name', `${labelPrefix}page reader #${id}`, '--', driver, '--mcp'],
      stderr: 'inherit',
    })
    const client = new Client({ name: 'dsh-browser-automation-reader', version: '0.1.0' })
    const reader = { id, client, transport, busy: true, dead: false }
    transport.onclose = () => { reader.dead = true; forget(reader) }
    transport.onerror = (error) => { logger.warn(`browser-automation: reader #${id} transport error: ${String(error)}`) }
    await client.connect(transport)
    readers.push(reader)
    trace({ event: 'reader-spawn', reader: id, pool: readers.length })
    return reader
  }

  function forget(reader) {
    const index = readers.indexOf(reader)
    if (index >= 0) readers.splice(index, 1)
    if (readers.length === 0) warming = undefined
  }

  async function disposeReader(reader, reason) {
    forget(reader)
    reader.dead = true
    try {
      await reader.client.close() // closes stdin → driver exits → its window closes
    } catch (error) {
      logger.warn(`browser-automation: reader #${reader.id} close failed: ${String(error)}`)
    }
    trace({ event: 'reader-dispose', reader: reader.id, reason, pool: readers.length })
  }

  function armIdleTimer() {
    clearTimeout(idleTimer)
    if (idleMs === 0 || readers.length === 0) return
    idleTimer = setTimeout(() => {
      if (readers.some(reader => reader.busy)) { armIdleTimer(); return }
      void Promise.all(readers.slice().map(reader => disposeReader(reader, 'idle')))
    }, idleMs)
    idleTimer.unref?.()
  }

  async function acquire() {
    if (disposed) throw new Error('browser-automation: reader pool is disposed')
    clearTimeout(idleTimer)
    const idle = readers.find(reader => !reader.busy && !reader.dead)
    if (idle !== undefined) {
      idle.busy = true
      return idle
    }
    return spawnReader()
  }

  async function release(reader) {
    if (reader.dead) { forget(reader); armIdleTimer(); return }
    reader.busy = false
    const idleCount = readers.filter(candidate => !candidate.busy && !candidate.dead).length
    if (idleCount > maxIdle) {
      await disposeReader(reader, 'surplus')
    }
    armIdleTimer()
  }

  async function call(reader, name, args) {
    const result = await reader.client.callTool({ name, arguments: args }, undefined, { timeout: readTimeoutMs })
    const text = (result.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
    if (result.isError) throw new Error(`safari ${name}: ${text || 'tool error'}`)
    return text
  }

  /**
   * Read one page in an isolated reader.
   * @param {{ url: string, format: string, maxWordsPerParagraph: number, includeURLs: boolean, waitMs: number, script?: string }} request
   * @returns {Promise<{ url: string, title: string | undefined, format: string, content: string, scriptResult?: unknown }>}
   */
  async function read(request) {
    let releaseWarm
    if (readers.length === 0 && warming === undefined) {
      warming = new Promise((resolve) => { releaseWarm = resolve })
    } else if (warming !== undefined) {
      await warming
    }
    const reader = await acquire()
    try {
      try {
        await call(reader, 'navigate_to_url', { url: request.url })
      } finally {
        if (releaseWarm !== undefined) releaseWarm()
      }
      if (request.waitMs > 0) await new Promise(resolve => setTimeout(resolve, request.waitMs))
      const raw = await call(reader, 'get_page_content', {
        format: request.format,
        region: 'entire_page',
        maxWordsPerParagraph: request.maxWordsPerParagraph,
        includeURLs: request.includeURLs,
        shortenURLs: false,
        nodeIds: 'none',
      })
      const unwrapped = await unwrap(raw)
      let scriptResult
      if (request.script !== undefined && request.script.trim() !== '') {
        // Function body semantics (the server's evaluate_javascript contract): use `return`.
        const text = await call(reader, 'evaluate_javascript', { expression: request.script })
        try { scriptResult = JSON.parse(text) } catch { scriptResult = text }
      }
      trace({ event: 'read', reader: reader.id, url: request.url, format: request.format, chars: unwrapped.content.length, script: request.script !== undefined })
      return { format: request.format, ...unwrapped, ...(request.script !== undefined ? { scriptResult } : {}) }
    } finally {
      // Park the reader on a blank page so the read page is released but the
      // window (and warm STP instance) stays for the next request.
      if (!reader.dead) {
        try { await call(reader, 'navigate_to_url', { url: 'about:blank' }) } catch { /* reader may have died mid-read; release() drops it */ }
      }
      await release(reader)
    }
  }

  /** Decode the server's result: inline JSON, or a "saved to <path>" pointer for large output. */
  async function unwrap(raw) {
    let text = raw
    const saved = /(?:saved|written)[^'\n]*'([^']+)'/i.exec(raw) ?? /\/[^\s'"]+\.(?:md|txt|json|html)\b/.exec(raw)
    if (!raw.trimStart().startsWith('{') && saved) {
      text = await readFile(saved[1] ?? saved[0], 'utf8')
    }
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && typeof parsed.content === 'string') {
        return { url: parsed.url, title: parsed.title, content: parsed.content }
      }
    } catch {
      // Not JSON: the extraction is the whole text.
    }
    return { url: undefined, title: undefined, content: text }
  }

  async function dispose() {
    disposed = true
    clearTimeout(idleTimer)
    await Promise.all(readers.slice().map(reader => disposeReader(reader, 'pool-dispose')))
  }

  return {
    read,
    dispose,
    /** Snapshot for diagnostics. */
    stats: () => ({ readers: readers.length, busy: readers.filter(reader => reader.busy).length }),
  }
}
