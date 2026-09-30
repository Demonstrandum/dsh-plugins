import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installTransport } from '../transport.mjs'
import { apply, resolveConfig } from '../index.js'

const url = 'https://api.anthropic.com/v1/messages?beta=true'
const prefix = 'anthropic-ratelimit-unified-'
const init = () => ({ method: 'POST', headers: { authorization: 'Bearer sk-ant-oat01-offline-fixture', 'user-agent': 'deepseek-harness/test' }, body: 'private prompt, deliberately not JSON' })
const response = (claim = 'five_hour', status = 200) => new Response('fixture SSE', { status, headers: {
  [prefix + 'representative-claim']: claim, [prefix + 'status']: 'allowed', [prefix + 'overage-utilization']: '0',
} })
const collect = async stream => { const chunks = []; for await (const c of stream) chunks.push(c); return chunks }

test('observe mode preserves exact fetch arguments, headers, redirects and response/body identity', async () => {
  const calls = []; const reports = []; const reply = response('overage')
  const target = { fetch: async (...args) => { calls.push(args); return reply } }
  const transport = installTransport({ mode: 'observe', target, report: (_, r) => reports.push(r) })
  try {
    const input = new URL(url); const args = init(); args.redirect = 'follow'; args.signal = new AbortController().signal
    assert.equal(await transport.run({}, () => target.fetch(input, args)), reply)
    assert.equal(calls[0][0], input); assert.equal(calls[0][1], args)
    assert.equal(args.headers['user-agent'], 'deepseek-harness/test'); assert.equal(reply.bodyUsed, false)
    assert.equal(reports[0].outcome, 'extra-usage')
    assert.doesNotMatch(JSON.stringify(reports), /offline-fixture|private prompt|authorization|user-agent/)
  } finally { transport.dispose() }
})

test('observe mode does not consume Request streams or change token refresh calls', async () => {
  const reports = []; const calls = []
  const target = { fetch: async (...args) => { calls.push(args); return response() } }
  const transport = installTransport({ mode: 'observe', target, report: (_, r) => reports.push(r) })
  let controller
  const body = new ReadableStream({ start(c) { controller = c } })
  const request = new Request(url, { ...init(), body, duplex: 'half' })
  try {
    await transport.run({}, () => target.fetch(request))
    assert.equal(request.bodyUsed, false); assert.equal(calls[0][0], request); assert.equal(reports.length, 1)
    const refresh = { method: 'POST', body: 'private-refresh', redirect: 'follow' }
    await transport.run({}, () => target.fetch('https://platform.claude.com/v1/oauth/token', refresh))
    assert.equal(calls[1][1], refresh); assert.equal(reports.length, 1)
  } finally { controller.close(); transport.dispose() }
})

test('unrecognized auth, key auth, other endpoints and redirected replies cannot establish an OAuth plan claim', async () => {
  const reports = []; let calls = 0; let redirected = false
  const target = { fetch: async () => { calls++; const reply = response(); if (redirected) Object.defineProperty(reply, 'redirected', { value: true }); return reply } }
  const transport = installTransport({ mode: 'observe', target, report: (_, r) => reports.push(r) })
  try {
    for (const which of ['key', 'no-auth', 'origin', 'path', 'method', 'redirect']) {
      const args = init(); let endpoint = url
      if (which === 'key') args.headers['x-api-key'] = 'private-key'
      if (which === 'no-auth') delete args.headers.authorization
      if (which === 'origin') endpoint = 'https://example.com/v1/messages'
      if (which === 'path') endpoint = 'https://api.anthropic.com/other'
      if (which === 'method') args.method = 'GET'
      redirected = which === 'redirect'
      await transport.run({}, () => target.fetch(endpoint, args))
    }
    assert.equal(calls, 6); assert.equal(reports.length, 0)
  } finally { transport.dispose() }
})

test('observer preserves original network exceptions, rejected replies and report callback failures', async () => {
  const originalError = new Error('fixture network error'); let fail = true
  const rejected = response('overage', 429)
  const target = { fetch: async () => { if (fail) throw originalError; return rejected } }
  const transport = installTransport({ mode: 'observe', target, report() { throw new Error('broken logger') } })
  try {
    await assert.rejects(transport.run({}, () => target.fetch(url, init())), e => e === originalError)
    fail = false
    assert.equal(await transport.run({}, () => target.fetch(url, init())), rejected)
    assert.equal(rejected.bodyUsed, false)
  } finally { transport.dispose() }
})

test('concurrent observer scopes and nested unscoped streams remain separate', async () => {
  const reports = []
  const target = { fetch: async () => { await Promise.resolve(); return response() } }
  const transport = installTransport({ mode: 'observe', target, report: (s, r) => reports.push([s.id, r.outcome]) })
  try {
    await Promise.all(['one', 'two'].map(id => transport.run({ id }, async () => {
      await collect(transport.unscoped(async function* () { await target.fetch(url, init()); yield 'nested' }))
      return target.fetch(url, init())
    })))
    assert.deepEqual(reports.map(r => r[0]).sort(), ['one', 'two'])
  } finally { transport.dispose() }
})

test('observer middleware never blocks output or replaces errors, reports unobserved, and disposes commands', async () => {
  const original = globalThis.fetch
  const commands = new Map(); const disposers = []; let stream; let claim = 'overage'
  const current = { session: { id: 'session-current', requestHeader: () => ({ config: { provider: 'anthropic-oauth' } }) } }
  const ctx = {
    logger: { info() { throw new Error('logger failure') }, warn() { throw new Error('logger failure') } },
    get: name => name === 'agents' ? { list: () => [current] } : undefined,
    effect(fn) { disposers.push(fn()) },
    inject(_names, fn) { fn(ctx) },
    on(event, fn) { assert.equal(event, 'llm/stream'); stream = fn },
    commands: { register(command) { commands.set(command.name, command); return () => commands.delete(command.name) } },
  }
  globalThis.fetch = async () => response(claim)
  apply(ctx, { mode: 'observe' })
  const finish = { type: 'finish', reason: { kind: 'stop' } }
  const options = { provider: 'anthropic-oauth', model: 'fixture', sessionId: current.session.id }
  const command = () => commands.get('oauth-billing').handler({ agent: current, rawInput: '' })
  try {
    for (const nextClaim of ['overage', 'unfamiliar', 'five_hour']) {
      claim = nextClaim
      const chunks = await collect(stream(options, async function* () { await fetch(url, init()); yield finish }))
      assert.deepEqual(chunks, [finish])
      const report = await command(); assert.equal(report.kind, 'success')
      assert.match(report.text, /extra usage|unknown|subscription claim/)
      assert.doesNotMatch(report.text, /private prompt|offline-fixture|unfamiliar/)
    }
    assert.deepEqual(await collect(stream(options, async function* () { yield finish })), [finish])
    assert.match((await command()).text, /unobserved/)
    const error = new Error('native failure')
    await assert.rejects(collect(stream(options, async function* () { throw error })), e => e === error)
    assert.equal(globalThis.fetch === original, false)
  } finally { disposers.reverse().forEach(dispose => dispose?.()); globalThis.fetch = original }
  assert.equal(commands.size, 0)
})

test('configuration preserves strict audit defaults and rejects misleading observer policy options', () => {
  assert.equal(resolveConfig().mode, 'audit')
  assert.equal(resolveConfig({ mode: 'observe' }).mode, 'observe')
  assert.deepEqual(resolveConfig(resolveConfig({ mode: 'observe' })), resolveConfig({ mode: 'observe' }), 'Loader validation and apply resolution must agree')
  for (const options of [{ mode: 'bad' }, { mode: 'observe', onUnverified: 'warn' }, { mode: 'observe', cliUserAgent: 'claude-cli/2.1.280' }, { mode: 'observe', providers: ['anthropic'] }]) assert.throws(() => resolveConfig(options))
})


test('one-shot header iterables and accessor metadata are never consumed by observation', async () => {
  let headerReads = 0; let methodReads = 0; let urlCoercions = 0; const reports = []
  const target = { fetch: async (input, options) => {
    assert.equal(String(input), url)
    assert.equal(options.method, 'POST')
    const h = new Headers(options.headers)
    assert.match(h.get('authorization'), /offline-fixture/)
    return response()
  } }
  const transport = installTransport({ mode: 'observe', target, report: (_, report) => reports.push(report) })
  try {
    function* headers() { headerReads++; yield ['authorization', 'Bearer sk-ant-oat01-offline-fixture'] }
    await transport.run({}, () => target.fetch(url, { method: 'POST', headers: headers() }))
    assert.equal(headerReads, 1, 'underlying fetch must receive the unconsumed iterable')
    await transport.run({}, () => target.fetch(url, { get method() { methodReads++; return 'POST' }, headers: init().headers }))
    assert.equal(methodReads, 1)
    const coercibleUrl = { toString() { urlCoercions++; return url } }
    await transport.run({}, () => target.fetch(coercibleUrl, init()))
    assert.equal(urlCoercions, 1)
    assert.equal(reports.length, 0, 'unsupported metadata passes through without an inferred claim')
  } finally { transport.dispose() }
})

test('actual ownership adapter restricts unknown local/token identities and other principals', async () => {
  const original = globalThis.fetch; const commands = new Map(); const disposers = []
  const agent = id => ({ session: { id, requestHeader: () => ({ config: { provider: 'anthropic-oauth' } }) } })
  const current = agent('session-one'); const other = agent('session-two')
  let owner = 'local'; let otherOwner = 'local'; let actor
  const ctx = {
    logger: { info() {}, warn() {} },
    get: name => name === 'agents' ? { list: () => [current, other] }
      : name === 'sessionOwners' ? { of: id => ({ owner: id === current.session.id ? owner : otherOwner, actor: actor ?? (id === current.session.id ? owner : otherOwner) }) } : undefined,
    effect(fn) { disposers.push(fn()) }, inject(_names, fn) { fn(ctx) }, on() {},
    commands: { register(definition) { commands.set(definition.name, definition); return () => commands.delete(definition.name) } },
  }
  apply(ctx, { mode: 'observe' })
  try {
    const query = () => commands.get('oauth-billing').handler({ agent: current, rawInput: '' }).text
    for (const value of ['local', 'token', '', undefined]) {
      owner = otherOwner = value
      assert.match(query(), /session-one/); assert.doesNotMatch(query(), /session-two/)
    }
    owner = 'owner-a'; otherOwner = 'owner-b'
    assert.doesNotMatch(query(), /session-two/)
    otherOwner = owner
    assert.match(query(), /session-two/)
    actor = 'different-actor'
    assert.doesNotMatch(query(), /session-two/)
    assert.doesNotMatch(query(), /owner-a|owner-b|different-actor/)
  } finally { disposers.reverse().forEach(fn => fn?.()); globalThis.fetch = original }
})
