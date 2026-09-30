import { AsyncLocalStorage } from 'node:async_hooks'
import { types } from 'node:util'
import { inspectRequest, responseEvidence } from './evidence.mjs'

const OWNER = Symbol.for('tali.anthropic-oauth-audit.fetch-owner')

function dataProperties(value) {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined
  const properties = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(properties).some(key => !('value' in properties[key]))) return undefined
  return properties
}

/** Inspect only reusable, non-coercing metadata; unsupported fetch inputs pass untouched. */
function observedOAuthRequest(input, init) {
  if (types.isProxy(input)) return false
  const options = dataProperties(init)
  if (!options) return false
  const request = input instanceof Request ? input : undefined
  const urlText = request ? Object.getOwnPropertyDescriptor(Request.prototype, 'url').get.call(request)
    : typeof input === 'string' ? input
      : input instanceof URL ? Object.getOwnPropertyDescriptor(URL.prototype, 'href').get.call(input) : undefined
  if (urlText === undefined) return false
  const url = new URL(urlText)
  const method = options.method?.value ?? (request ? Object.getOwnPropertyDescriptor(Request.prototype, 'method').get.call(request) : 'GET')
  if (typeof method !== 'string' || method.toUpperCase() !== 'POST'
    || url.origin !== 'https://api.anthropic.com' || url.pathname !== '/v1/messages'
    || url.username || url.password) return false
  const rawHeaders = options.headers?.value ?? (request ? Object.getOwnPropertyDescriptor(Request.prototype, 'headers').get.call(request) : undefined)
  if (types.isProxy(rawHeaders)) return false
  let headers
  if (rawHeaders instanceof Headers) headers = rawHeaders
  else {
    const properties = dataProperties(rawHeaders)
    if (!properties || Reflect.ownKeys(properties).some(key => typeof key !== 'string' || typeof properties[key].value !== 'string')) return false
    headers = new Headers(Object.fromEntries(Object.entries(properties).map(([key, descriptor]) => [key, descriptor.value])))
  }
  return /^Bearer sk-ant-oat[^\s]*$/i.test(Headers.prototype.get.call(headers, 'authorization') ?? '')
    && !Headers.prototype.has.call(headers, 'x-api-key')
}

/**
 * Install one reversible fetch wrapper. Only fetches started while advancing an
 * audited llm/stream iterator are inspected; concurrent calls stay independent.
 * DSH currently exposes no per-call pi-ai fetch/response hook to sibling plugins.
 */
export function installTransport({ cliUserAgent, report, mode = 'audit', target = globalThis }) {
  if (!['audit', 'observe'].includes(mode)) throw new Error('Unknown OAuth transport mode')
  if (target[OWNER]) throw new Error('anthropic-oauth-audit is already installed in this process')
  const scope = new AsyncLocalStorage()
  const original = target.fetch
  let active = true
  const publish = (state, result) => {
    if (!active) return
    state.report = result
    if (mode === 'observe') {
      // Observation must never change an inference result, even if logging fails.
      try { report(state, result) } catch { /* best-effort telemetry */ }
    } else report(state, result)
  }
  const wrapped = async function (input, init) {
    const state = scope.getStore()
    if (!active || !state) return original.call(this, input, init)
    if (mode === 'observe') {
      // Preserve the exact arguments, body ownership, redirect policy and errors.
      // Do not parse prompts or repair headers in this mode.
      let eligible = false
      try {
        eligible = observedOAuthRequest(input, init)
      } catch { /* Unsupported input is the underlying fetch's responsibility. */ }
      const response = await original.call(this, input, init)
      if (eligible) {
        try {
          if (types.isProxy(response) || Object.getPrototypeOf(response) !== Response.prototype
            || ['url', 'redirected', 'status', 'headers'].some(key => Object.hasOwn(response, key))) return response
          const property = key => Object.getOwnPropertyDescriptor(Response.prototype, key).get.call(response)
          const url = property('url')
          const destination = url ? new URL(url) : undefined
          if (!property('redirected') && (!destination || (destination.origin === 'https://api.anthropic.com'
            && destination.pathname === '/v1/messages'))) {
            const headers = property('headers')
            publish(state, responseEvidence(property('status'), { get: name => Headers.prototype.get.call(headers, name) }))
          }
        } catch { /* Unsupported response metadata must not break the stream. */ }
      }
      return response
    }
    const request = input instanceof Request ? input : undefined
    const url = new URL(request?.url ?? input)
    // Token refresh belongs to pi-ai. Never inspect its body or follow redirects
    // carrying a refresh token; it is not evidence about an inference request.
    if (url.href === 'https://platform.claude.com/v1/oauth/token') {
      return original.call(this, input, { ...init, redirect: 'error' })
    }
    const headers = new Headers(init?.headers ?? request?.headers)
    const method = init?.method ?? request?.method ?? 'GET'
    // Restore the CLI product token DSH's attribution header otherwise replaces,
    // retaining DSH's attribution verbatim. No body or tool rewriting here.
    const ua = headers.get('user-agent') ?? ''
    let repairedUserAgent = false
    if (!/^claude-cli\//.test(ua)) {
      headers.set('user-agent', `${cliUserAgent}${ua ? ` ${ua}` : ''}`)
      repairedUserAgent = true
    }
    // The installed Anthropic SDK passes URL + a serialized JSON init.body.
    // Never drain a Request/ReadableStream here: tee cancellation can hang and
    // consuming a body would change its owner's request. Unknown forms fail closed.
    const body = init?.body
    const checked = inspectRequest(url, method, headers, body)
    state.request = { ...checked, repairedUserAgent }
    if (checked.failed.length) {
      publish(state, { outcome: 'blocked', failed: checked.failed, request: state.request })
      // The SDK may wrap this as a connection error. The stream layer uses the
      // retained non-secret report instead of losing the actionable diagnostic.
      throw new Error('Anthropic OAuth wire checks failed before dispatch')
    }
    const response = await original.call(this, input, { ...init, headers, redirect: 'error' })
    publish(state, { ...responseEvidence(response.status, response.headers), request: state.request })
    // Return the SAME response: do not clone, buffer, or consume an SSE body.
    return response
  }
  target[OWNER] = wrapped
  target.fetch = wrapped
  return {
    run: (state, callback) => scope.run(state, callback),
    // Clearing scope must cover lazy iteration, not just next() construction:
    // a nested API-key request must not inherit its OAuth caller's audit state.
    async *unscoped(next) {
      const iterator = scope.run(undefined, () => next()[Symbol.asyncIterator]())
      let done = false
      try {
        while (true) {
          const result = await scope.run(undefined, () => iterator.next())
          done = result.done
          if (done) return
          yield result.value
        }
      } finally {
        if (!done) await scope.run(undefined, () => iterator.return?.())
      }
    },
    dispose() {
      active = false
      if (target.fetch === wrapped) target.fetch = original
      if (target[OWNER] === wrapped) delete target[OWNER]
      // A wrapper installed above ours may still retain wrapped. Leave it an
      // inactive passthrough rather than clobber that wrapper at teardown.
      scope.disable()
    },
  }
}
