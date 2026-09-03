// Keyless smoke: module loads, Config fills defaults, the derived MCP rows
import { existsSync } from 'node:fs'
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

// Missing STP driver: browser_open must reject BEFORE spawning, naming the remedy
// and stating that classic Safari is not a fallback.
{
  const defs = {}
  const noStp = plugin.Config({ safari: { driver: '/nonexistent/safaridriver' }, chrome: { command: '/nonexistent/chrome-devtools-mcp' } })
  const ctx2 = {
    logger: { info() {}, warn() {} },
    on: () => {},
    effect: (run) => { run(); return () => {} },
    tools: { schemas: () => [] },
    agents: { list: () => [] },
  }
  const agent = { id: 'a', session: { header: { cwd: '/tmp', delegationDepth: 0 } }, ctx: { tools: { register: (def) => { defs[def.name] = def; return () => {} } }, plugin: () => { throw new Error('spawned despite missing driver') } } }
  const created = []
  const ctx3 = { ...ctx2, on: (event, cb) => { if (event === 'agent/created') created.push(cb) } }
  plugin.apply(ctx3, noStp)
  created[0]({ agent })
  for (const browser of ['safari', 'chrome']) {
    let message = ''
    try { await defs.browser_open.execute({ browser }, { agent }) } catch (error) { message = String(error) }
    if (!message.includes('unavailable')) throw new Error(`preflight did not reject ${browser}: ${message}`)
    if (browser === 'safari' && !message.includes('classic Safari cannot be used')) throw new Error(`safari message lacks fallback statement: ${message}`)
  }
  console.log('smoke ok: missing drivers rejected before spawn with remedies')
}

// Safari row goes through the shim with a per-chat label; title projection wins over the id.
{
  const defs = {}
  const created = []
  const mounted = []
  const cfg = plugin.Config({ chrome: { enabled: false } })
  const ctx = {
    logger: { info() {}, warn(m) { throw new Error(m) } },
    on: (event, cb) => { if (event === 'agent/created') created.push(cb) },
    effect: (run) => { run(); return () => {} },
    tools: { schemas: () => [{ name: 'mcp__safari__x' }] },
    agents: { list: () => [] },
    get: (name) => name === 'sessionProjections' ? { stateOf: () => 'Loss landscape plots' } : undefined,
  }
  plugin.apply(ctx, cfg)
  const fiber = Object.assign(Promise.resolve(), { dispose: async () => {} })
  const agent = { id: 'session-abcdef12', session: { header: { cwd: '/tmp', delegationDepth: 0 } }, ctx: { tools: { register: (def) => { defs[def.name] = def; return () => {} } }, plugin: (mod, row) => { mounted.push(row); return fiber } } }
  created[0]({ agent })
  // Driver must exist for preflight; use the real STP path only if present, else skip.
  if (existsSync(cfg.safari.driver)) {
    await defs.browser_open.execute({ browser: 'safari' }, { agent })
    const row = McpClient.Config(mounted[0])
    if (row.command !== process.execPath) throw new Error(`expected node shim, got ${row.command}`)
    if (!row.args[0].endsWith('safari-mcp-shim.mjs') || row.args[1] !== '--name' || row.args[2] !== 'DSH: Loss landscape plots' || row.args[3] !== '--' || row.args[4] !== cfg.safari.driver || row.args[5] !== '--mcp') {
      throw new Error(`shim args unexpected: ${JSON.stringify(row.args)}`)
    }
    console.log('smoke ok: safari mounts through the shim with label', JSON.stringify(row.args[2]))
  } else {
    console.log('smoke skipped: STP driver not installed here')
  }
}
