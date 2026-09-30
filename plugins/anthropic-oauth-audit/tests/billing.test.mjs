import { test } from 'node:test'
import assert from 'node:assert/strict'
import { billingResult } from '../billing.mjs'

const now = Date.parse('2026-01-02T12:00:00.000Z')
const at = new Date(now).toISOString()
const makeAgent = (id, provider = 'anthropic-oauth', model = 'fixture-model') => ({
  session: { id, requestHeader: () => ({ config: { provider, model } }) },
})
const report = (extra = {}) => ({ provider: 'anthropic-oauth', model: 'fixture-model', at,
  outcome: 'plan-evidence', status: 200, evidence: {}, ...extra })
const render = (options = {}) => billingResult({ now, ...options })
const rows = result => result.text.split('\n').slice(2)

test('default includes only relevant loaded sessions plus relevant current, with full IDs', () => {
  const fullId = 'session-12345678-1234-4567-89ab-123456789abc'
  const latest = new Map([[fullId, report()], ['previous-oauth', report()], ['unloaded', report()]])
  const agents = { list: () => [makeAgent(fullId), makeAgent('previous-oauth', 'other'), makeAgent('unobserved'), makeAgent('other', 'other')] }
  const result = render({ latest, agents, agent: makeAgent(fullId) })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /^Loaded sessions\nResponse-header evidence · not billing receipts\n/)
  assert.equal(rows(result).length, 3)
  assert.match(rows(result)[0], new RegExp(`^${fullId} \\(current\\) · subscription claim`))
  assert.match(result.text, /previous-oauth · subscription claim/)
  assert.match(result.text, /unobserved · unobserved · provider=anthropic-oauth/)
  assert.doesNotMatch(result.text, /unloaded|\nother ·/)
})

test('default uses the latest request header provider, not agent.config', () => {
  const candidate = makeAgent('id', 'anthropic-oauth')
  candidate.config = { provider: 'other' }
  assert.match(render({ agents: { list: () => [candidate] } }).text, /id · unobserved/)
  const unrelated = makeAgent('excluded', 'other')
  unrelated.config = { provider: 'anthropic-oauth' }
  assert.doesNotMatch(render({ agents: { list: () => [unrelated] } }).text, /excluded/)
})

test('relevant current is included even when absent from the registry', () => {
  for (const options of [
    { agent: makeAgent('current') },
    { agent: makeAgent('current', 'other'), latest: new Map([['current', report()]]) },
  ]) {
    const result = render({ ...options, agents: { list: () => [] } })
    assert.equal(rows(result).length, 1)
    assert.match(result.text, /current \(current\)/)
  }
})

test('current isolates invoking session and does not consult the registry', () => {
  const result = render({ rawInput: ' current ', agent: makeAgent('one'),
    latest: new Map([['one', report()], ['two', report()]]),
    agents: { list() { assert.fail('current must not query registry') } } })
  assert.match(result.text, /^Current session\n/)
  assert.equal(rows(result).length, 1)
  assert.match(result.text, /one \(current\)/)
  assert.doesNotMatch(result.text, /two/)
})

test('current without a retained observation is unobserved, even for another provider', () => {
  for (const provider of ['anthropic-oauth', 'other']) {
    const result = render({ rawInput: 'current', agent: makeAgent('one', provider) })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /one \(current\) · unobserved/)
    assert.match(result.text, /no observation/)
    assert.doesNotMatch(result.text, /paid|fallback|API billing|subscription claim/)
  }
})

test('recent includes every retained session, unloaded entries and relevant unobserved current', () => {
  const result = render({ rawInput: 'recent', latest: new Map([['unloaded', report()], ['custom', report({ provider: 'custom-oauth' })]]),
    agents: { list() { assert.fail('recent must not query registry') } }, agent: makeAgent('current') })
  assert.match(result.text, /^Retained sessions\n/)
  assert.equal(rows(result).length, 3)
  assert.match(result.text, /current \(current\) · unobserved/)
  assert.match(result.text, /unloaded · subscription claim/)
  assert.match(result.text, /custom · subscription claim · last observed provider=custom-oauth/)
})

test('absent or unavailable registry uses an honestly labeled retained scope', () => {
  for (const agents of [undefined, {}, { list: () => undefined }, { list() { throw new Error('private failure') } }]) {
    const result = render({ agents, latest: new Map([['retained', report()]]), agent: makeAgent('other', 'other') })
    assert.match(result.text, /^Retained sessions\n/)
    assert.match(result.text, /retained · subscription claim/)
    assert.doesNotMatch(result.text, /Active|Loaded|private failure|\nother/)
  }
})

test('empty registry does not accidentally fall back to retained sessions', () => {
  const result = render({ agents: { list: () => [] }, latest: new Map([['unloaded', report()]]) })
  assert.match(result.text, /^Loaded sessions\n/)
  assert.match(result.text, /No Anthropic OAuth sessions observed in this scope\./)
  assert.doesNotMatch(result.text, /unloaded/)
})

test('staleness begins strictly after five minutes and timestamps are canonical', () => {
  for (const [elapsed, stale] of [[0, false], [300000, false], [300001, true], [-1000, false]]) {
    const result = render({ latest: new Map([['id', report({ at: new Date(now - elapsed).toISOString() })]]) })
    assert.equal(result.text.includes(' · stale'), stale)
    assert.match(result.text, /2026-01-02T/)
  }
  for (const at of ['invalid\nforged', undefined, '2026-01-02T99:00:00Z']) {
    const result = render({ latest: new Map([['id', report({ at })]]) })
    assert.match(result.text, /time unknown/)
    assert.doesNotMatch(result.text, /forged|invalid|stale/)
  }
})

test('only allowlisted utilization is rendered as percentages, including numeric and string zero', () => {
  const result = render({ latest: new Map([['one', report({ evidence: {
    '5h-utilization': '0', '7d-utilization': 0.125, 'overage-utilization': 0,
    'fallback-percentage': '0.8', 'new-utilization': '0.8',
  } })], ['two', report({ evidence: { '5h-utilization': '1.25', '7d-utilization': '0.456' } })]]) })
  assert.match(result.text, /5h=0% · 7d=12\.5% · overage=0%/)
  assert.match(result.text, /5h=125% · 7d=45\.6%/)
  assert.doesNotMatch(result.text, /80%|fallback|new-utilization|\$|USD|total|sum/i)
})

test('defensive numeric parsing rejects arbitrary strings, coercible objects and non-finite values', () => {
  for (const bad of [undefined, null, '', ' ', 'NaN', 'Infinity', NaN, Infinity, -1, '-0.1', '1e2',
    '0x10', '0.2\nforged', true, [], { valueOf() { assert.fail('must not coerce objects') } }, '9'.repeat(25), Number.MAX_VALUE]) {
    const result = render({ latest: new Map([['id', report({ evidence: { '5h-utilization': bad, '7d-utilization': bad, 'overage-utilization': bad } })]]) })
    assert.doesNotMatch(result.text, /5h=|7d=|overage=|forged/)
  }
})

test('all outcomes have conservative fixed labels and never print unknown outcome text', () => {
  const labels = [['plan-evidence', 'subscription claim'], ['extra-usage', 'extra usage'],
    ['unknown', 'unknown'], ['rejected', 'rejected'], ['unobserved', 'unobserved'], ['blocked', 'blocked'], ['secret outcome', 'unknown']]
  for (const [outcome, label] of labels) {
    const result = render({ latest: new Map([['id', report({ outcome })]]) })
    assert.match(result.text, new RegExp(`id · ${label} ·`))
    assert.doesNotMatch(result.text, /secret outcome|API billing|paid|fallback/)
  }
})

test('raw headers, prompts, logs, failed checks and arbitrary status text are not exposed', () => {
  const entry = report({ outcome: 'blocked', status: 'private-status', prompt: 'private-prompt',
    logs: 'private-log', failed: ['private-failure'], request: { secret: 'private-request' },
    evidence: { authorization: 'private-auth', cookie: 'private-cookie', '5h-utilization': 'private-utilization',
      status: 'private-header', 'representative-claim': 'private-claim', 'overage-disabled-reason': 'private-reason' } })
  const result = render({ latest: new Map([['id', entry]]) })
  assert.doesNotMatch(result.text, /private-|authorization|cookie/)
  assert.match(result.text, /id · blocked/)
})

test('untrusted identifiers cannot create fake rows or inject markup, and are bounded', () => {
  const entry = report({ provider: 'anthropic-oauth\nFAKE\u2028ROW', model: '<img>\r\n|secret|' + 'x'.repeat(1000) })
  const result = render({ latest: new Map([['id\nFORGED\u202e\t|row', entry]]) })
  assert.equal(result.text.split('\n').length, 3)
  assert.match(result.text, /id_FORGED___row/)
  assert.doesNotMatch(result.text, /<img>|\r|\t|\u2028|\u202e|\|/)
  assert.ok(rows(result)[0].length < 400)
  for (const value of ['sk-ant-oat01-fixture-secret', 'Bearer fixture', 'api_key=fixture']) {
    const redacted = render({ latest: new Map([[value, report({ model: value, provider: value })]]) })
    assert.match(redacted.text, /\[redacted\]/)
    assert.doesNotMatch(redacted.text, /fixture/)
  }
})

test('bad arguments return a fixed error without echoing their contents', () => {
  for (const rawInput of ['active', 'current recent', 'CURRENT', '--json', 'secret\nforged', null, 123, {}]) {
    assert.deepEqual(render({ rawInput }), { kind: 'error', text: 'Usage: /oauth-billing [current|recent]' })
  }
  assert.deepEqual(render({ rawInput: 'current' }), { kind: 'error', text: 'Current session unavailable.' })
  assert.equal(render({ rawInput: ' \n ' }).kind, 'success')
})

test('account-wide overage increase warns without assigning session responsibility or summing', () => {
  const entry = report({ evidence: { 'overage-utilization': '0.1' }, overageIncreased: true })
  const result = render({ latest: new Map([['one', entry], ['two', entry]]) })
  assert.equal(result.text.match(/overage=10%/g).length, 2)
  assert.equal(result.text.match(/account-wide overage increased; this session may not be responsible/g).length, 2)
  assert.doesNotMatch(result.text, /20%|charged|caused|total|\$/i)
  assert.doesNotMatch(render({ latest: new Map([['id', report({ overageIncreased: 'true' })]]) }).text, /Warning/)
})

test('rendering does not mutate retained entries, evidence or loaded agents', () => {
  const evidence = Object.freeze({ '5h-utilization': '0' })
  const entry = Object.freeze(report({ evidence }))
  const candidate = makeAgent('id')
  Object.freeze(candidate.session); Object.freeze(candidate)
  const loaded = Object.freeze([candidate])
  const latest = new Map([['id', entry]])
  const result = render({ latest, agents: { list: () => loaded }, agent: candidate })
  assert.match(result.text, /5h=0%/)
  assert.deepEqual([...latest], [['id', entry]])
})

test('missing or failing request headers retain observed relevance without leaking errors', () => {
  const candidate = { session: { id: 'one', requestHeader() { throw new Error('private header') } } }
  const result = render({ agents: { list: () => [candidate, { session: { id: 'excluded' } }] }, latest: new Map([['one', report()]]) })
  assert.match(result.text, /one · subscription claim/)
  assert.doesNotMatch(result.text, /private header|excluded/)
})


test('optional visibility policy hides sessions in every scope and fails closed', () => {
  for (const rawInput of ['', 'recent', 'current']) {
    for (const verdict of [false, undefined, 'true', new Error('private-owner')]) {
      const result = render({ rawInput, agent: makeAgent('hidden-session'),
        agents: { list: () => [makeAgent('visible-session'), makeAgent('hidden-session')] },
        latest: new Map([['hidden-session', report({ model: 'hidden-model', evidence: { '5h-utilization': '0.345' } })],
          ['visible-session', report()]]),
        canSeeSession(id) {
          if (id === 'visible-session') return true
          if (verdict instanceof Error) throw verdict
          return verdict
        } })
      assert.doesNotMatch(result.text, /hidden-session|hidden-model|34\.5%|private-owner/)
      if (rawInput !== 'current') assert.match(result.text, /visible-session · subscription claim/)
    }
  }
})

test('observed provider and model remain explicitly historical after a route change', () => {
  const result = render({ rawInput: 'current', agent: makeAgent('id', 'new-provider', 'new-model'),
    latest: new Map([['id', report({ model: 'old-model' })]]) })
  assert.match(result.text, /last observed provider=anthropic-oauth · last observed model=old-model/)
  assert.doesNotMatch(result.text, /new-provider|new-model/)
  const incomplete = render({ rawInput: 'current', agent: makeAgent('id', 'new-provider', 'new-model'),
    latest: new Map([['id', report({ provider: undefined, model: undefined })]]) })
  assert.doesNotMatch(incomplete.text, /provider=|model=/)
})


test('deployment controls the stale observation threshold', () => {
  const latest = new Map([['id', report({ at: '2026-01-01T00:00:00.000Z' })]])
  const args = { latest, agent: makeAgent('id'), rawInput: 'current', now: Date.parse('2026-01-01T00:00:02.000Z') }
  assert.match(billingResult({ ...args, staleAfterMs: 1000 }).text, /stale/)
  assert.doesNotMatch(billingResult({ ...args, staleAfterMs: 3000 }).text, /stale/)
})
