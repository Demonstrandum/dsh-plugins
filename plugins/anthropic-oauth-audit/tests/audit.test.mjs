import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IDENTITY, inspectRequest, responseEvidence, describe } from '../evidence.mjs'
import { installTransport } from '../transport.mjs'
import { apply, resolveConfig, Config } from '../index.js'

const URL = 'https://api.anthropic.com/v1/messages?beta=true'
const H = 'anthropic-ratelimit-unified-'
const body = JSON.stringify({ system: [{ type: 'text', text: IDENTITY }, { type: 'text', text: 'private prompt e\u0301' }],
  tools: [{ name: 'Read' }, { name: 'custom_tool' }], model: 'fixture-model', messages: [] })
const headers = () => new Headers({ authorization: 'Bearer sk-ant-oat01-fixture-only',
  'user-agent': 'claude-cli/2.1.280', 'x-app': 'cli',
  'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,other-beta' })
const init = () => ({ method: 'POST', headers: headers(), body })
const response = (claim = 'five_hour', status = 200) => new Response('fixture SSE', {
  status, headers: { [H + 'representative-claim']: claim, [H + 'status']: 'allowed' },
})

test('wire checks return only booleans and field names, never request contents', () => {
  const valid = inspectRequest(new globalThis.URL(URL), 'POST', headers(), body)
  assert.deepEqual(valid.failed, [])
  assert.doesNotMatch(JSON.stringify(valid), /fixture-only|private prompt|custom_tool/)
  const bad = headers(); bad.set('x-api-key', 'api-secret'); bad.set('authorization', 'Bearer not-oauth')
  bad.delete('anthropic-beta'); bad.set('user-agent', 'deepseek-harness/test')
  const checked = inspectRequest(new globalThis.URL('https://evil.example/v1/messages'), 'POST', bad, '{bad json')
  for (const field of ['endpoint', 'oauthBearer', 'noApiKey', 'oauthBetas', 'cliUserAgent', 'identity', 'jsonBody']) assert.ok(checked.failed.includes(field))
  assert.ok(inspectRequest(new globalThis.URL(URL), 'POST', headers(), body.replace('"Read"', '"read"')).failed.includes('toolCasing'))
})

test('plan, overage, rejected and unknown signals remain distinct', () => {
  for (const claim of ['five_hour', 'seven_day']) assert.equal(responseEvidence(200, response(claim).headers).outcome, 'plan-evidence')
  assert.equal(responseEvidence(200, response('overage').headers).outcome, 'extra-usage')
  for (const claim of ['future_claim', '', 'seven_day_opus']) assert.equal(responseEvidence(200, response(claim).headers).outcome, 'unknown')
  assert.equal(responseEvidence(200, new Headers()).outcome, 'unknown')
  const h = response().headers; h.delete(H + 'status')
  assert.equal(responseEvidence(200, h).outcome, 'unknown')
  h.set(H + 'status', 'allowed_warning')
  assert.equal(responseEvidence(200, h).outcome, 'plan-evidence')
  h.set(H + 'status', 'rejected')
  assert.equal(responseEvidence(200, h).outcome, 'unknown')
  for (const code of [401, 403, 429, 500]) {
    const evidence = responseEvidence(code, response('overage', code).headers)
    assert.equal(evidence.outcome, 'rejected')
    assert.match(describe(evidence), /billing is not established/)
  }
})

test('response evidence ignores auth/cookies/request ids and sanitizes allowlisted values', () => {
  const h = new Headers({ authorization: 'secret', 'set-cookie': 'secret', 'request-id': 'secret',
    [H + 'representative-claim']: 'arbitrary message with secrets',
    [H + 'overage-disabled-reason']: 'org_spend_cap_reached' })
  const evidence = responseEvidence(429, h)
  assert.equal(evidence.evidence['representative-claim'], '[unrecognized]')
  assert.equal(evidence.evidence['overage-disabled-reason'], 'org_spend_cap_reached')
  assert.doesNotMatch(JSON.stringify(evidence), /secret|request-id|authorization/)
  for (const name of ['status', 'representative-claim', 'overage-utilization', 'overage-disabled-reason']) {
    h.set(H + name, 'sk-ant-oat01-fixture-secret')
    assert.doesNotMatch(JSON.stringify(responseEvidence(200, h)), /fixture-secret/)
  }
})

test('scoped fetch repairs only UA, retains attribution/body/signal, returns same SSE response', async () => {
  const calls = []; const reports = []; const reply = response()
  const target = { fetch: async (...args) => { calls.push(args); return reply } }
  const original = target.fetch
  const transport = installTransport({ target, cliUserAgent: 'claude-cli/2.1.280', report: (_, r) => reports.push(r) })
  try {
    const args = init(); args.headers.set('user-agent', 'deepseek-harness/test (+https://example.com)')
    args.signal = new AbortController().signal
    const returned = await transport.run({}, () => target.fetch(URL, args))
    assert.equal(returned, reply); assert.equal(reply.bodyUsed, false)
    assert.equal(calls[0][1].body, body); assert.equal(calls[0][1].signal, args.signal)
    assert.equal(calls[0][1].redirect, 'error')
    assert.equal(calls[0][1].headers.get('user-agent'), 'claude-cli/2.1.280 deepseek-harness/test (+https://example.com)')
    assert.equal(reports[0].outcome, 'plan-evidence')
    assert.equal(reports[0].request.repairedUserAgent, true)
    assert.doesNotMatch(JSON.stringify(reports), /fixture-only|private prompt/)
  } finally { transport.dispose() }
  assert.equal(target.fetch, original)
})

test('concurrent OAuth scopes and unscoped API-key calls do not mix', async () => {
  const calls = []; const reports = []; let release
  const gate = new Promise(resolve => { release = resolve })
  const target = { fetch: async (url, options) => { calls.push(options); await gate; return response() } }
  const transport = installTransport({ target, cliUserAgent: 'claude-cli/2.1.280', report: (s, r) => reports.push([s.id, r.outcome]) })
  try {
    const api = { method: 'POST', headers: { 'x-api-key': 'private-api-fixture' }, body: '{}' }
    const one = transport.run({ id: 'one' }, async () => { await Promise.resolve(); return target.fetch(URL, init()) })
    const two = transport.run({ id: 'two' }, () => target.fetch(URL, init()))
    const ordinary = target.fetch(URL, api)
    release(); await Promise.all([one, two, ordinary])
    assert.deepEqual(reports.map(r => r[0]).sort(), ['one', 'two'])
    assert.ok(calls.includes(api))
  } finally { transport.dispose() }
})

test('blocks wrong auth, origin, path, identity and beta overrides before sending', async () => {
  let calls = 0; const reports = []
  const target = { fetch: async () => { calls++; return response() } }
  const transport = installTransport({ target, cliUserAgent: 'claude-cli/2.1.280', report: (_, r) => reports.push(r) })
  try {
    for (const variant of ['key', 'origin', 'path', 'identity', 'beta']) {
      const args = init(); let url = URL
      if (variant === 'key') args.headers.set('x-api-key', 'private-api-fixture')
      if (variant === 'origin') url = 'https://evil.example/v1/messages'
      if (variant === 'path') url = 'https://api.anthropic.com/unexpected'
      if (variant === 'identity') args.body = '{}'
      if (variant === 'beta') args.headers.set('anthropic-beta', 'only-other-beta')
      await assert.rejects(transport.run({}, () => target.fetch(url, args)), /before dispatch/)
    }
    assert.equal(calls, 0); assert.equal(reports.length, 5)
    await transport.run({}, () => target.fetch('https://platform.claude.com/v1/oauth/token', { method: 'POST', body: 'refresh-secret' }))
    assert.equal(calls, 1); assert.equal(reports.length, 5)
  } finally { transport.dispose() }
})

test('Request input is not consumed; disposal does not overwrite a later wrapper', async () => {
  const reports = []; const target = { fetch: async () => response() }
  const original = target.fetch
  const transport = installTransport({ target, cliUserAgent: 'claude-cli/2.1.280', report: (_, r) => reports.push(r) })
  const request = new Request(URL, init())
  await transport.run({}, () => target.fetch(request, { body }))
  assert.equal(request.bodyUsed, false)
  assert.equal(reports.length, 1)
  await assert.rejects(transport.run({}, () => target.fetch(request)), /before dispatch/)
  assert.equal(request.bodyUsed, false)
  assert.equal(reports.length, 2)
  assert.throws(() => installTransport({ target }), /already installed/)
  const ours = target.fetch; const later = (...args) => ours(...args); target.fetch = later
  transport.dispose()
  assert.equal(target.fetch, later)
  await transport.run({}, () => target.fetch('https://example.com'))
  assert.equal(reports.length, 2)
  target.fetch = original
})

function context() {
  const disposers = []; const logs = []; let listener; let command
  const ctx = { logger: { info: s => logs.push(s), warn: s => logs.push(s) },
    effect(fn) { disposers.push(fn()) },
    on(event, fn) { assert.equal(event, 'llm/stream'); listener = fn },
    inject(names, fn) { fn(ctx) },
    commands: { register(c) { command = c; return () => {} } },
  }
  return { ctx, logs, stream: (...args) => listener(...args),
    command: (id, rawInput = '') => command.handler({ agent: { session: { id } }, rawInput }),
    dispose: () => disposers.reverse().forEach(d => d?.()),
  }
}
const collect = async stream => { const chunks = []; for await (const c of stream) chunks.push(c); return chunks }
const opts = id => ({ provider: 'anthropic-oauth', model: 'fixture-model', sessionId: id })

test('host middleware stops unknown/overage responses with visible non-retry errors and closes iterator', async () => {
  const original = globalThis.fetch
  let closed = 0
  const c = context()
  globalThis.fetch = async () => response('overage')
  apply(c.ctx)
  try {
    const chunks = await collect(c.stream(opts('a'), async function* () {
      try { await fetch(URL, init()); yield { type: 'text-delta', text: 'not delivered' } }
      finally { closed++ }
    }))
    assert.equal(closed, 1); assert.equal(chunks.length, 1)
    assert.equal(chunks[0].reason.failure.code, 'ANTHROPIC_OAUTH_AUDIT')
    assert.match(chunks[0].reason.failure.message, /extra usage/)
    assert.equal((await c.command('a')).kind, 'error')
    assert.match(c.logs[0], /extra-usage/)
    assert.doesNotMatch(c.logs.join(), /sk-ant-oat|private prompt/)
  } finally { c.dispose(); globalThis.fetch = original }
})

test('warn mode preserves output; status is per session and bounded; aggregate warning is honest', async () => {
  const original = globalThis.fetch; const c = context(); let utilization = '0.1'
  globalThis.fetch = async () => { const r = response(); r.headers.set(H + 'overage-utilization', utilization); return r }
  apply(c.ctx, { onUnverified: 'warn', maxSessions: 1 })
  const next = async function* () { await fetch(URL, init()); yield { type: 'finish', reason: { kind: 'stop' } } }
  try {
    assert.equal((await collect(c.stream(opts('a'), next)))[0].reason.kind, 'stop')
    assert.equal((await c.command('a')).kind, 'success')
    utilization = '0.2'; await collect(c.stream(opts('a'), next))
    assert.match((await c.command('a')).text, /Account-wide.*may not be responsible/)
    await collect(c.stream(opts('b'), next))
    assert.match((await c.command('a')).text, /No OAuth request/)
    assert.equal((await c.command('b')).kind, 'success')
    assert.equal((await c.command('b', 'wrong')).kind, 'error')
  } finally { c.dispose(); globalThis.fetch = original }
})

test('guard overrides opaque SDK failures; underlying cancellations are preserved', async () => {
  const original = globalThis.fetch; const c = context(); let sent = 0
  globalThis.fetch = async () => { sent++; return response() }
  apply(c.ctx)
  try {
    const chunks = await collect(c.stream(opts('a'), async function* () {
      try { await fetch(URL, { ...init(), body: '{}' }) } catch { throw new Error('Connection error') }
    }))
    assert.equal(sent, 0); assert.match(chunks[0].reason.failure.message, /identity/)
    const aborted = { type: 'finish', reason: { kind: 'aborted', failure: { message: 'Cancelled', code: 'ABORTED' } } }
    const usage = { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
    assert.deepEqual(await collect(c.stream(opts('b'), async function* () { yield usage; yield aborted })), [usage, aborted])
    const authError = { type: 'finish', reason: { kind: 'error', failure: { message: 'Sign in first', code: 'AUTH' } } }
    assert.deepEqual(await collect(c.stream(opts('d'), async function* () { yield usage; yield authError })), [usage, authError])
    const chunks2 = await collect(c.stream(opts('c'), async function* () { yield { type: 'text-delta', text: 'bypassed fetch' } }))
    assert.match(chunks2[0].reason.failure.message, /No Anthropic message response/)
    const ordinary = { provider: 'anthropic', model: 'fixture-model' }
    assert.deepEqual(await collect(c.stream(ordinary, async function* () { yield 'untouched' })), ['untouched'])
  } finally { c.dispose(); globalThis.fetch = original }
})

test('invalid configuration fails before installation', () => {
  assert.equal(Config['~standard'].validate(undefined).value.onUnverified, 'error')
  assert.ok(Config['~standard'].validate({ providers: [] }).issues)
  for (const config of [null, [], 1, { providers: [] }, { providers: [''] }, { cliUserAgent: 'bad' }, { onUnverified: 'free' }, { maxSessions: 0 }, { typo: true }]) {
    assert.throws(() => resolveConfig(config), /anthropic-oauth-audit/)
  }
})

test('a nested unaudited stream clears the outer OAuth scope for lazy fetches', async () => {
  const original = globalThis.fetch; const c = context(); let apiSent = 0
  globalThis.fetch = async (_url, args) => {
    if (new Headers(args.headers).has('x-api-key')) apiSent++
    return response()
  }
  apply(c.ctx)
  try {
    const chunks = await collect(c.stream(opts('outer'), async function* () {
      await collect(c.stream({ provider: 'anthropic' }, async function* () {
        await fetch(URL, { method: 'POST', headers: { 'x-api-key': 'fixture' }, body: '{}' })
        yield { type: 'finish', reason: { kind: 'stop' } }
      }))
      await fetch(URL, init())
      yield { type: 'finish', reason: { kind: 'stop' } }
    }))
    assert.equal(apiSent, 1)
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    assert.doesNotMatch(c.logs.join(), /blocked/)
  } finally { c.dispose(); globalThis.fetch = original }
})

test('large or streaming bodies fail closed without consuming or waiting for them', async () => {
  const large = ' '.repeat(32 * 1024 * 1024 + 1)
  assert.ok(inspectRequest(new globalThis.URL(URL), 'POST', headers(), large).failed.includes('jsonBody'))
  let controller; let calls = 0
  const stream = new ReadableStream({ start(c) { controller = c } })
  const request = new Request(URL, { method: 'POST', headers: headers(), body: stream, duplex: 'half' })
  const target = { fetch: async () => { calls++; return response() } }
  const transport = installTransport({ target, cliUserAgent: 'claude-cli/2.1.280', report() {} })
  try {
    await assert.rejects(transport.run({}, () => target.fetch(request)), /before dispatch/)
    assert.equal(request.bodyUsed, false)
    assert.equal(calls, 0)
  } finally { controller.close(); transport.dispose() }
})
