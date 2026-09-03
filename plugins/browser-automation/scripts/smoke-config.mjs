// Keyless smoke: module loads, Config fills defaults, the derived MCP rows
// validate against dsh-mcp-client's schema, and the agent/created listener
// registers exactly the two scoped tools (no server is spawned).
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import * as plugin from '../index.js'

const filled = plugin.Config({})
if (filled.safari.enabled !== true || filled.chrome.enabled !== true || filled.subagents !== true || filled.idleMinutes !== 30) {
  throw new Error(`unexpected defaults: ${JSON.stringify(filled)}`)
}
const custom = plugin.Config({ chrome: { headless: true }, safari: { enabled: false }, idleMinutes: 0, subagents: false })
if (custom.safari.enabled !== false || custom.chrome.headless !== true) throw new Error(`override not applied: ${JSON.stringify(custom)}`)

for (const [browser, row] of Object.entries(plugin.resolveServers(filled))) {
  const validated = McpClient.Config({ ...row, cwd: '/tmp' })
  if (validated.serverName !== browser || validated.failOnStartupError !== true) throw new Error(`bad row for ${browser}: ${JSON.stringify(validated)}`)
  if (browser === 'chrome' && (!validated.args.includes('--isolated') || !validated.args.includes('--ignoreDefaultChromeArg=--enable-automation'))) throw new Error(`chrome args: ${validated.args}`)
}

const registered = []
const listeners = {}
const effects = []
const fakeAgent = (id, depth) => ({
  id,
  session: { header: { cwd: '/tmp', delegationDepth: depth } },
  ctx: { tools: { register: (def) => { registered.push([id, def.name]); return () => { registered.push([id, `-${def.name}`]) } } }, plugin: () => { throw new Error('must not mount at creation') } },
})
const preexisting = fakeAgent('pre', 0)
const ctx = {
  logger: { info() {}, warn(message) { throw new Error(`unexpected warn: ${message}`) } },
  on: (event, cb) => { listeners[event] = cb },
  effect: (run) => { const dispose = run(); effects.push(dispose); let done = false; return () => { if (!done) { done = true; dispose() } } },
  tools: { schemas: () => [] },
  agents: { list: () => [preexisting] },
}
plugin.apply(ctx, custom)
listeners['agent/created']({ agent: fakeAgent('top', 0) })
listeners['agent/created']({ agent: fakeAgent('child', 1) })
let expected = [['pre', 'browser_open'], ['pre', 'browser_close'], ['top', 'browser_open'], ['top', 'browser_close']]
if (JSON.stringify(registered) !== JSON.stringify(expected)) throw new Error(`registrations: ${JSON.stringify(registered)}`)
// Agent disposal releases the plugin-owned wrapper (idempotent with the scope unwind).
listeners['agent/disposed']({ agent: preexisting })
expected = [...expected, ['pre', '-browser_open'], ['pre', '-browser_close']]
if (JSON.stringify(registered) !== JSON.stringify(expected)) throw new Error(`after dispose: ${JSON.stringify(registered)}`)
console.log('smoke ok: lazy tools attached to pre-existing + new top-level agents only; rows validate')
