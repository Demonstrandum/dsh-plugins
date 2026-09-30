import { AsyncLocalStorage } from 'node:async_hooks'
import { types } from 'node:util'
import { parseTelemetryJSON, openRouterEvidence } from './providers.mjs'

const OWNER = Symbol.for('tali.billing-status.passive-fetch-broker.v1')
function data(value) {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).some(key => !('value' in descriptors[key]))) return undefined
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]))
}
const native = (Class, key, object) => Object.getOwnPropertyDescriptor(Class.prototype, key).get.call(object)

/** Never coerce custom inputs or read the request body. Unsupported metadata passes through. */
export function requestKind(input, init) {
  if (types.isProxy(input)) return undefined
  const options = data(init)
  if (!options) return undefined
  const request = input instanceof Request ? input : undefined
  const urlText = request ? native(Request, 'url', request) : typeof input === 'string' ? input
    : input instanceof URL ? native(URL, 'href', input) : undefined
  if (!urlText) return undefined
  const url = new URL(urlText)
  const method = options.method ?? (request ? native(Request, 'method', request) : 'GET')
  if (typeof method !== 'string' || method.toUpperCase() !== 'POST' || url.username || url.password) return undefined
  let kind
  if (url.origin === 'https://api.anthropic.com' && url.pathname === '/v1/messages') kind = 'anthropic'
  else if (url.origin === 'https://openrouter.ai' && url.pathname === '/api/v1/chat/completions') kind = 'openrouter'
  else if (url.origin === 'https://chatgpt.com' && url.pathname === '/backend-api/codex/responses') kind = 'openai-codex'
  if (!kind) return undefined
  const raw = options.headers ?? (request ? native(Request, 'headers', request) : undefined)
  if (types.isProxy(raw)) return undefined
  let headers
  if (raw instanceof Headers) headers = raw
  else {
    const entries = data(raw)
    if (!entries || Object.values(entries).some(value => typeof value !== 'string')) return undefined
    headers = new Headers(entries)
  }
  const bearer = Headers.prototype.get.call(headers, 'authorization') ?? ''
  if (kind === 'anthropic') {
    if (/^Bearer sk-ant-oat[^\s]*$/i.test(bearer) && !Headers.prototype.has.call(headers, 'x-api-key')) kind = 'anthropic-oauth'
    else return undefined
  }
  if (kind === 'openai-codex' && !/^Bearer \S+$/i.test(bearer)) return undefined
  return { kind, origin: url.origin, pathname: url.pathname }
}

function responseMeta(response, endpoint) {
  if (types.isProxy(response) || Object.getPrototypeOf(response) !== Response.prototype
    || ['url', 'redirected', 'status', 'headers', 'body'].some(key => Object.hasOwn(response, key))) return undefined
  const url = native(Response, 'url', response)
  const destination = url ? new URL(url) : undefined
  if (native(Response, 'redirected', response) || destination
    && (destination.origin !== endpoint.origin || destination.pathname !== endpoint.pathname)) return undefined
  return { status: native(Response, 'status', response), headers: native(Response, 'headers', response) }
}

/** Bounded parser: at most 64K UTF-16 code units per SSE event or 256K for JSON.
 * Oversized SSE events are discarded through their blank line, not truncated into fake JSON.
 */
export function telemetryParser(format, publish, { eventLimit = 65536, jsonLimit = 262144 } = {}) {
  const decoder = new TextDecoder()
  let buffer = '', event = '', dropping = false, oversized = false, skipLF = false
  const parse = text => {
    try {
      const evidence = openRouterEvidence(parseTelemetryJSON(text))
      if (evidence) publish(evidence)
    } catch { /* malformed provider metadata never changes inference */ }
  }
  const line = text => {
    if (text.endsWith('\r')) text = text.slice(0, -1)
    if (!text) {
      if (!oversized && event) parse(event)
      event = ''; oversized = false
    } else if (!oversized && text.startsWith('data:')) {
      const piece = text.slice(5).replace(/^ /, '')
      if (event.length + piece.length + 1 > eventLimit) { event = ''; oversized = true }
      else event += (event ? '\n' : '') + piece
    }
  }
  const feed = text => {
    if (format === 'json') {
      if (oversized) return
      if (buffer.length + text.length > jsonLimit) { buffer = ''; oversized = true }
      else buffer += text
      return
    }
    // Process small decoded slices so a single giant upstream chunk cannot allocate
    // an unbounded concatenated line in observer-owned state.
    let start = 0
    if (skipLF && text.length) { if (text[0] === '\n') start = 1; skipLF = false }
    for (; start < text.length;) {
      const lf = text.indexOf('\n', start), cr = text.indexOf('\r', start)
      const newline = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr)
      const end = newline < 0 ? text.length : newline
      if (!dropping) {
        if (buffer.length + end - start > eventLimit) { buffer = ''; event = ''; oversized = true; dropping = true }
        else buffer += text.slice(start, end)
      }
      if (newline < 0) break
      if (!dropping) line(buffer)
      buffer = ''; dropping = false; start = newline + 1
      if (text[newline] === '\r') {
        if (text[start] === '\n') start++
        else if (start === text.length) skipLF = true
      }
    }
  }
  return {
    push(bytes) {
      for (let offset = 0; offset < bytes.length; offset += 4096) feed(decoder.decode(bytes.subarray(offset, offset + 4096), { stream: true }))
    },
    end() {
      feed(decoder.decode())
      if (format === 'json') { if (!oversized) parse(buffer) }
      else if (!dropping) { if (buffer) line(buffer); line('') }
      buffer = ''; event = ''
    },
    clear() { buffer = ''; event = ''; oversized = true },
  }
}

/** Demand-driven tap, not Response.clone()/tee(): zero eager reads, no second consumer.
 * Original chunk identities, read errors and cancellation reasons pass through unchanged.
 */
export function tapResponse(response, publish) {
  const contentType = response.headers.get('content-type') ?? ''
  const format = /^text\/event-stream(?:;|$)/i.test(contentType) ? 'sse'
    : /^application\/(?:[\w.-]+\+)?json(?:;|$)/i.test(contentType) ? 'json' : undefined
  if (!format || !response.body || response.bodyUsed || response.body.locked) return response
  const source = response.body
  const parser = telemetryParser(format, publish)
  let reader
  const body = new ReadableStream({
    async pull(controller) {
      // Acquire only when the native consumer asks; telemetry never advances independently.
      reader ??= source.getReader()
      try {
        const chunk = await reader.read()
        if (chunk.done) {
          try { parser.end() } catch { /* observer failure */ }
          controller.close(); reader.releaseLock()
        } else {
          try { parser.push(chunk.value) } catch { parser.clear() }
          controller.enqueue(chunk.value)
        }
      } catch (error) { parser.clear(); controller.error(error); reader.releaseLock() }
    },
    async cancel(reason) {
      parser.clear()
      if (reader) { try { await reader.cancel(reason) } finally { reader.releaseLock() } }
      else await source.cancel(reason)
    },
  }, { highWaterMark: 0 })
  const tapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  for (const key of ['url', 'redirected', 'type']) Object.defineProperty(tapped, key, { value: response[key] })
  return tapped
}

/** A process-wide broker for this collector. Existing wrappers remain in the chain;
 * disposing out of order leaves an inert passthrough rather than clobbering another owner.
 * The legacy audit has its own ALS/wrapper; it can migrate to this broker separately.
 */
export function acquireBroker(target = globalThis) {
  if (target[OWNER]) { target[OWNER].references++; return target[OWNER] }
  const scope = new AsyncLocalStorage()
  const original = target.fetch
  const broker = {
    references: 1, active: true,
    run: (state, callback) => scope.run(state, callback),
    release() {
      if (--broker.references) return
      broker.active = false
      if (target.fetch === wrapped) target.fetch = original
      if (target[OWNER] === broker) delete target[OWNER]
      scope.disable()
    },
  }
  async function wrapped(input, init) {
    const state = scope.getStore()
    if (!broker.active || !state?.active()) return original.call(this, input, init)
    let endpoint, attempt
    try { endpoint = requestKind(input, init); if (endpoint) attempt = state.beginHTTP(endpoint) } catch { /* passive only */ }
    // Do not catch/wrap the native fetch failure or alter input/init.
    const response = await original.call(this, input, init)
    if (!endpoint || !attempt || !broker.active || !state.active()) return response
    try {
      const meta = responseMeta(response, endpoint)
      if (!meta) return response
      state.headers(attempt, endpoint, meta)
      if (endpoint.kind === 'openrouter' && meta.status >= 200 && meta.status < 300) {
        return tapResponse(response, evidence => { if (broker.active && state.active()) state.evidence(attempt, evidence) })
      }
    } catch { /* Metadata/tap setup failure falls back to the untouched response. */ }
    return response
  }
  target[OWNER] = broker
  target.fetch = wrapped
  return broker
}
