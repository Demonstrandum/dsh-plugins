import { AsyncLocalStorage } from 'node:async_hooks'
import { inspectRequest, responseEvidence } from './evidence.mjs'

const OWNER = Symbol.for('tali.anthropic-oauth-audit.fetch-owner')

/**
 * Install one reversible fetch wrapper. Only fetches started while advancing an
 * audited llm/stream iterator are inspected; concurrent calls stay independent.
 * DSH currently exposes no per-call pi-ai fetch/response hook to sibling plugins.
 */
export function installTransport({ cliUserAgent, report, target = globalThis }) {
  if (target[OWNER]) throw new Error('anthropic-oauth-audit is already installed in this process')
  const scope = new AsyncLocalStorage()
  const original = target.fetch
  let active = true
  const publish = (state, result) => {
    if (!active) return
    state.report = result
    report(state, result)
  }
  const wrapped = async function (input, init) {
    const state = scope.getStore()
    if (!active || !state) return original.call(this, input, init)
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
