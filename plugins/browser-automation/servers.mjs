/**
 * Private MCP connections to the browser servers. The plugin owns the
 * forwarding itself (no dsh-mcp-client): each connection is one child process
 * driven through the MCP SDK, and only the plugin's curated tools ever reach
 * the model.
 *
 * - Safari: `safaridriver --mcp` (Safari Technology Preview). One process =
 *   one automation session = one STP window whose banner reads "This window is
 *   controlled by <clientName>." — the handshake's clientInfo.name is the label.
 * - Chrome: `chrome-devtools-mcp --isolated` (own temporary profile). Chrome
 *   itself launches on the first page; pages are routed by pageId.
 */

import { execFile, execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const STP_PROCESS = 'Contents/MacOS/Safari Technology Preview'

/** PIDs of running Safari Technology Preview app instances (not helpers). */
export function stpPids() {
  try {
    return execFileSync('pgrep', ['-f', STP_PROCESS], { encoding: 'utf8' }).split('\n').map(Number).filter(Boolean)
  } catch {
    return [] // pgrep exits 1 when nothing matches
  }
}

/**
 * Host-wide ownership of the STP app instance our sessions launch.
 *
 * Apple's driver launches STP on a session's first navigation and terminates
 * it only when THAT launching session ends; if other sessions were alive at
 * that moment, the instance is never terminated and lingers with no windows
 * (observed). We count our live Safari connections; when the first one is made
 * while no STP instance is running, any instance that appears is ours, and once
 * our count returns to zero we quit it after a short grace period (a new
 * connection within it simply reuses the warm instance).
 */
class SafariInstanceOwner {
  constructor() { this.live = 0; this.owned = false; this.timer = undefined }

  acquire() {
    clearTimeout(this.timer)
    if (this.live === 0) this.owned = stpPids().length === 0
    this.live++
  }

  release() {
    this.live = Math.max(0, this.live - 1)
    if (this.live > 0 || !this.owned) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { void this.quit() }, 3000)
    this.timer.unref?.()
  }

  async quit() {
    if (this.live > 0 || !this.owned) return
    const pids = stpPids()
    if (pids.length === 0) { this.owned = false; return }
    await new Promise(resolve => execFile('osascript', ['-e', 'quit app "Safari Technology Preview"'], () => resolve()))
    await new Promise(resolve => setTimeout(resolve, 2000))
    for (const pid of stpPids()) {
      if (pids.includes(pid)) { try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ } }
    }
    this.owned = false
  }

  async dispose() {
    clearTimeout(this.timer)
    this.live = 0
    await this.quit()
  }
}

export const safariInstance = new SafariInstanceOwner()

/**
 * Spawn one MCP server and complete the handshake.
 * @param {{ command: string, args: string[], clientName: string, cwd?: string, timeoutMs: number, safari?: boolean, onClose?: () => void, onError?: (error: unknown) => void }} options
 * @returns {Promise<ServerConnection>}
 */
export async function connectServer(options) {
  if (options.safari) safariInstance.acquire()
  let released = false
  const release = () => { if (!released && options.safari) { released = true; safariInstance.release() } }
  const transport = new StdioClientTransport({
    command: options.command,
    args: options.args,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    stderr: 'inherit',
  })
  const client = new Client({ name: options.clientName, version: '0.1.0' })
  let closed = false
  transport.onclose = () => { closed = true; release(); options.onClose?.() }
  transport.onerror = (error) => { options.onError?.(error) }
  try {
    await client.connect(transport)
  } catch (error) {
    release()
    throw error
  }
  const timeout = options.timeoutMs

  /** Call a tool and return the raw MCP result (content blocks, isError). */
  async function callRaw(name, args) {
    return client.callTool({ name, arguments: args ?? {} }, undefined, { timeout })
  }

  /** Call a tool and return its text; throws on isError. */
  async function callText(name, args) {
    const result = await callRaw(name, args)
    const text = textOf(result)
    if (result.isError) throw new Error(`${name}: ${text || 'tool error'}`)
    return text
  }

  return {
    get closed() { return closed },
    callRaw,
    callText,
    /** Close stdin so the server exits cleanly (safaridriver: ~20 ms, closes its window). */
    async close() {
      if (closed) return
      closed = true
      try { await client.close() } finally { release() }
    },
  }
}

/** Join the text blocks of an MCP result. */
export function textOf(result) {
  return (result.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
}

/** First image block of an MCP result as bytes, or undefined. */
export function imageOf(result) {
  const block = (result.content ?? []).find(candidate => candidate.type === 'image' && typeof candidate.data === 'string')
  if (block === undefined) return undefined
  return { data: new Uint8Array(Buffer.from(block.data, 'base64')), mediaType: block.mimeType ?? 'image/png' }
}

/**
 * Decode a get_page_content result into `{ url?, title?, content }`.
 *
 * Apple's server answers either with an inline JSON envelope `{title,url,content,format}` or, past roughly
 * 40 kB, with the pointer "Saved large output to '<path>' (…)" whose file holds the same envelope. `content`
 * is text for every format (json/html included). Never emit `undefined` fields: DSH requires lossless JSON.
 * @param {string} raw
 * @returns {Promise<{ url?: string, title?: string, content: string }>}
 */
export async function unwrapPageContent(raw) {
  let text = raw
  const saved = /(?:saved|written)[^'\n]*'([^']+)'/i.exec(raw) ?? /\/[^\s'"]+\.(?:md|txt|json|html)\b/.exec(raw)
  if (!raw.trimStart().startsWith('{') && saved) {
    text = await readFile(saved[1] ?? saved[0], 'utf8')
  }
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && 'content' in parsed) {
      return {
        ...(typeof parsed.url === 'string' ? { url: parsed.url } : {}),
        ...(typeof parsed.title === 'string' ? { title: parsed.title } : {}),
        content: typeof parsed.content === 'string' ? parsed.content : JSON.stringify(parsed.content),
      }
    }
  } catch {
    // Not JSON: the extraction is the whole text.
  }
  return { content: text }
}

/** Decode Apple's JSON text results (sometimes double-encoded). */
export function parseJsonText(text) {
  let value = text
  for (let i = 0; i < 2 && typeof value === 'string'; i++) {
    try { value = JSON.parse(value) } catch { break }
  }
  return value
}

/**
 * @typedef {object} ServerConnection
 * @property {boolean} closed
 * @property {(name: string, args?: object) => Promise<object>} callRaw
 * @property {(name: string, args?: object) => Promise<string>} callText
 * @property {() => Promise<void>} close
 */
