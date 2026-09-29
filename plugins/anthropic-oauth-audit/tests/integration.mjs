/** Run from deepseek-harness: node --import tsx/esm --test ../plugins/anthropic-oauth-audit/tests/integration.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PiAiAdapter } from '../../../deepseek-harness/packages/llm/llm-pi-ai/src/adapter.ts'
import { resolveProfiles } from '../../../deepseek-harness/packages/llm/llm-pi-ai/src/config.ts'
import { memoryAuth } from '../../../deepseek-harness/packages/llm/llm-pi-ai/tests/auth-double.ts'
import * as Audit from '../index.js'
import { IDENTITY } from '../evidence.mjs'

const require = createRequire(new URL('../../../deepseek-harness/packages/llm/llm-pi-ai/package.json', import.meta.url))
const { Context } = await import(require.resolve('@deepseek-ai/cordis'))
const cordisRequire = createRequire(new URL('../../../deepseek-harness/vendor/cordis/package.json', import.meta.url))
const { default: Loader } = await import(cordisRequire.resolve('@deepseek-ai/cordis-plugin-loader'))
const { default: Include } = await import(cordisRequire.resolve('@deepseek-ai/cordis-plugin-include'))
const { default: LlmRuntime, createUserMessage } = await import(require.resolve('@deepseek-ai/dsh-llm'))
const H = 'anthropic-ratelimit-unified-'
const model = 'claude-sonnet-4-5'

function sse(tool = false) {
  const events = [
    ['message_start', { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model,
      content: [], usage: { input_tokens: 10, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: tool
      ? { type: 'tool_use', id: 'tool_fixture', name: 'Bash', input: {} } : { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: tool
      ? { type: 'input_json_delta', partial_json: '{"command":"true"}' } : { type: 'text_delta', text: 'hello' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ]
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}
const collect = async iterable => { const out = []; for await (const c of iterable) out.push(c); return out }

test('real DSH adapter + installed pi-ai: OAuth wire format, native tool roundtrip, API-key isolation and disposal', async () => {
  const original = globalThis.fetch
  const requests = []
  let claim = 'five_hour'; let status = 200; let tool = true
  let waitForAbort; let refreshes = 0
  globalThis.fetch = async (url, options) => {
    if (String(url) === 'https://platform.claude.com/v1/oauth/token') {
      refreshes++
      return Response.json({ access_token: 'sk-ant-oat01-refreshed-fixture', refresh_token: 'refreshed-fixture', expires_in: 3600 })
    }
    if (waitForAbort) {
      waitForAbort()
      return new Promise((_, reject) => {
        if (options.signal.aborted) reject(options.signal.reason)
        else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
      })
    }
    requests.push({ url: String(url), headers: new Headers(options.headers), body: JSON.parse(options.body) })
    if (status !== 200) return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'fixture rate limit' } }), {
      status, headers: { 'content-type': 'application/json', [H + 'representative-claim']: claim, [H + 'status']: 'rejected' },
    })
    return new Response(sse(tool), { headers: { 'content-type': 'text/event-stream',
      ...(claim ? { [H + 'representative-claim']: claim, [H + 'status']: 'allowed' } : {}) } })
  }
  const mockFetch = globalThis.fetch
  const ctx = new Context()
  const home = await mkdtemp(join(tmpdir(), 'dsh-oauth-audit-test-'))
  try {
    let profiles = resolveProfiles({ 'anthropic-oauth': {}, anthropic: {} })
    const auth = memoryAuth({ 'anthropic-oauth': { type: 'oauth', access: 'sk-ant-oat01-offline-fixture',
      refresh: 'offline-refresh', expires: Date.now() + 3_600_000 } })
    const adapter = new PiAiAdapter({ profiles: () => profiles, auth,
      resolveApiKey: provider => Promise.resolve(provider === 'anthropic' ? 'api-key-offline-fixture' : undefined) })
    const modules = new Map([
      ['test-llm', LlmRuntime],
      ['test-provider', { name: 'test-provider', inject: ['llm'], apply(scoped) {
        scoped.llm.registerAdapter(['anthropic-oauth', 'anthropic'], adapter)
      } }],
      ['tali-anthropic-oauth-audit', Audit],
    ])
    const path = join(home, 'cordis.yml')
    await writeFile(path, '- id: llm\n  name: test-llm\n- id: provider\n  name: test-provider\n- id: audit\n  name: tali-anthropic-oauth-audit\n')
    ctx.baseUrl = pathToFileURL(home).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = { version: 'v2', async import(specifier) {
      assert.ok(modules.has(specifier), specifier)
      return modules.get(specifier)
    } }
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
    await ctx.loader.await()
    const options = provider => ({ provider, model, maxTokens: 16, system: 'private fixture prompt e\u0301',
      sessionId: 'session-offline-fixture',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'plugin', plugin: 'test' } })],
      tools: [{ name: 'bash', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'string' } } } }],
    })
    const [oauth, api] = await Promise.all([
      collect(ctx.llm.stream(options('anthropic-oauth'))), collect(ctx.llm.stream(options('anthropic'))),
    ])
    const request = requests.find(r => r.headers.has('authorization'))
    assert.ok(request, JSON.stringify(oauth))
    assert.equal(request.headers.get('authorization'), 'Bearer sk-ant-oat01-offline-fixture')
    assert.equal(request.headers.has('x-api-key'), false)
    assert.match(request.headers.get('user-agent'), /^claude-cli\/2\.1\.280 deepseek-harness\//)
    assert.equal(request.body.system[0].text, IDENTITY)
    assert.equal(request.body.system[1].text, 'private fixture prompt e\u0301')
    assert.equal(request.body.tools[0].name, 'Bash')
    assert.equal(oauth.at(-1).reason.kind, 'tool-calls', JSON.stringify(oauth))
    assert.equal(oauth.find(c => c.type === 'block-end').block.name, 'bash')
    const ordinary = requests.find(r => r.headers.has('x-api-key'))
    assert.match(ordinary.headers.get('user-agent'), /^deepseek-harness\//)
    assert.notEqual(ordinary.body.system[0].text, IDENTITY)
    assert.equal(api.at(-1).reason.kind, 'tool-calls')

    tool = false
    for (const nextClaim of ['overage', '', 'future_claim']) {
      claim = nextClaim
      const chunks = await collect(ctx.llm.stream(options('anthropic-oauth')))
      assert.equal(chunks.at(-1).reason.failure.code, 'ANTHROPIC_OAUTH_AUDIT')
      assert.equal(chunks.some(c => c.type === 'text-delta'), false)
    }
    status = 429; claim = 'overage'
    const rejected = await collect(ctx.llm.stream(options('anthropic-oauth')))
    assert.match(rejected.at(-1).reason.failure.message, /fixture rate limit/)
    assert.notEqual(rejected.at(-1).reason.failure.code, 'ANTHROPIC_OAUTH_AUDIT')

    status = 200; claim = 'five_hour'
    const sent = requests.length
    profiles = resolveProfiles({ 'anthropic-oauth': { headers: { 'anthropic-beta': 'other-beta' } }, anthropic: {} })
    const incompatible = await collect(ctx.llm.stream(options('anthropic-oauth')))
    assert.equal(requests.length, sent)
    assert.match(incompatible.at(-1).reason.failure.message, /oauthBetas/)
    profiles = resolveProfiles({ 'anthropic-oauth': {}, anthropic: {} })

    auth.stored.set('anthropic-oauth', { ...auth.stored.get('anthropic-oauth'), expires: 0 })
    const refreshed = await collect(ctx.llm.stream(options('anthropic-oauth')))
    assert.equal(refreshed.at(-1).reason.kind, 'stop', JSON.stringify(refreshed))
    assert.equal(refreshes, 1)
    assert.equal(auth.stored.get('anthropic-oauth').access, 'sk-ant-oat01-refreshed-fixture')

    const controller = new AbortController()
    const entered = new Promise(resolve => { waitForAbort = resolve })
    const cancelled = collect(ctx.llm.stream({ ...options('anthropic-oauth'), signal: controller.signal }))
    await entered
    controller.abort('fixture cancellation')
    const cancellation = await cancelled
    assert.equal(cancellation.at(-1).reason.kind, 'aborted')
    assert.notEqual(cancellation.at(-1).reason.failure.code, 'ANTHROPIC_OAUTH_AUDIT')
    waitForAbort = undefined
    // A real auth resolution failure emits usage before finish(error).
    auth.stored.clear(); status = 200
    const count = requests.length
    const unauthenticated = await collect(ctx.llm.stream(options('anthropic-oauth')))
    assert.equal(requests.length, count)
    assert.equal(unauthenticated.at(-1).reason.kind, 'error')
    assert.notEqual(unauthenticated.at(-1).reason.failure.code, 'ANTHROPIC_OAUTH_AUDIT')
    await ctx.fiber.dispose()
    assert.equal(globalThis.fetch, mockFetch)
  } finally {
    await ctx.fiber.dispose(); globalThis.fetch = original
    await rm(home, { recursive: true, force: true })
  }
})
