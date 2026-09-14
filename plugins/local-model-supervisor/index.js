/**
 * tali-local-model-supervisor — host local model servers from DSH itself.
 *
 * Watches committed session events; when a session selects (or sends a request
 * to) a provider one of the configured servers carries, the server process is
 * started on demand and reused. When it has been idle past its window AND no
 * live session currently points at its providers, it is shut down. A server
 * that is already healthy at first touch (started by hand, another dsh
 * instance, launchd) is ADOPTED: reused but never killed — only processes this
 * plugin spawned are ever stopped. Owned children die with the dsh host too
 * (plugin unload disposes them), and a crashed child simply respawns on the
 * next matching activity.
 *
 * Config (see cordis.patch.yml for the AFM default):
 *
 *   servers:
 *     - id: afm                     # unique label, used in logs
 *       providers: [apple]          # llm provider ids whose traffic this serves
 *       command: afm                # executable (PATH-resolved) — no shell
 *       args: ['--port', '9997']
 *       healthUrl: http://127.0.0.1:9997/v1/models   # 2xx = healthy
 *       idleMinutes: 15             # shutdown window (0/absent = never idle out)
 *       startupTimeoutMs: 60000     # spawn-to-healthy deadline
 *       env: {}                     # optional extra environment
 *       logFile: /tmp/local-model-supervisor-afm.log  # child stdout/stderr (default per id)
 *
 * Semantics and limits:
 * - "Last session using it closes" is approximated as: no LIVE agent whose
 *   current model selection names one of the server's providers, AND no
 *   matching activity for `idleMinutes`. Web sessions linger loaded after the
 *   tab closes; the idle window covers that.
 * - Start is triggered by `model/selection` (user picked the model — warmup
 *   begins before the first message) and refreshed by `request/header` (every
 *   actual request). A request racing a cold start may fail once; DSH's LLM
 *   retry policy normally bridges the gap.
 * - Health is an HTTP GET returning 2xx. The probe never authenticates; point
 *   it at an unauthenticated endpoint such as `/v1/models`.
 */

import { spawn } from 'node:child_process'
import { openSync, closeSync } from 'node:fs'

export const name = 'local-model-supervisor'

export const inject = ['agents', 'sessionProjections']

const SWEEP_MS = 60_000
const PROBE_TIMEOUT_MS = 1_500
const POLL_MS = 500
const KILL_GRACE_MS = 5_000

/** Validate one server entry, failing plugin load loudly on misconfiguration. */
function validateServer(server, index) {
  const where = `local-model-supervisor: servers[${index}]`
  if (typeof server !== 'object' || server === null) throw new Error(`${where} must be an object`)
  if (typeof server.id !== 'string' || server.id.length === 0) throw new Error(`${where}.id must be a non-empty string`)
  if (!Array.isArray(server.providers) || server.providers.length === 0
    || server.providers.some(p => typeof p !== 'string' || p.length === 0)) {
    throw new Error(`${where}.providers must be a non-empty list of provider ids`)
  }
  if (typeof server.command !== 'string' || server.command.length === 0) throw new Error(`${where}.command must be a non-empty string`)
  if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some(a => typeof a !== 'string'))) {
    throw new Error(`${where}.args must be a list of strings when present`)
  }
  if (typeof server.healthUrl !== 'string' || !/^https?:\/\//.test(server.healthUrl)) {
    throw new Error(`${where}.healthUrl must be an http(s) URL`)
  }
  for (const field of ['idleMinutes', 'startupTimeoutMs']) {
    if (server[field] !== undefined && (typeof server[field] !== 'number' || server[field] < 0)) {
      throw new Error(`${where}.${field} must be a non-negative number when present`)
    }
  }
}

/** One 2xx-or-bust health probe. */
async function healthy(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    return response.ok
  } catch {
    return false
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ servers?: Array<object> }} config - managed server definitions.
 */
export function apply(ctx, config) {
  const servers = Array.isArray(config?.servers) ? config.servers : []
  servers.forEach(validateServer)
  if (servers.length === 0) {
    ctx.logger.warn('local-model-supervisor: no servers configured; plugin is inert')
    return
  }
  const byProvider = new Map()
  for (const server of servers) {
    for (const provider of server.providers) {
      if (byProvider.has(provider)) throw new Error(`local-model-supervisor: provider "${provider}" is claimed by two servers`)
      byProvider.set(provider, server)
    }
  }

  /** Runtime state per server id: { child, owned, lastActivity, ensuring } */
  const states = new Map(servers.map(server => [server.id, {
    child: undefined,
    owned: false,
    lastActivity: 0,
    ensuring: undefined,
  }]))

  /** Spawn the child and wait until the health probe passes. */
  async function start(server, state) {
    const logFile = server.logFile ?? `/tmp/local-model-supervisor-${server.id}.log`
    let logFd
    try {
      logFd = openSync(logFile, 'a')
    } catch {
      logFd = 'ignore'
    }
    const child = spawn(server.command, server.args ?? [], {
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, ...server.env },
    })
    if (typeof logFd === 'number') closeSync(logFd)
    state.child = child
    state.owned = true
    child.on('exit', (code, signal) => {
      if (state.child !== child) return
      state.child = undefined
      state.owned = false
      ctx.logger.info(`local-model-supervisor: "${server.id}" exited (${signal ?? code}); will respawn on next use`)
    })
    child.on('error', (error) => {
      if (state.child === child) { state.child = undefined; state.owned = false }
      ctx.logger.warn(`local-model-supervisor: "${server.id}" failed to spawn: ${String(error)}`)
    })
    const deadline = Date.now() + (server.startupTimeoutMs ?? 60_000)
    while (Date.now() < deadline) {
      if (state.child !== child) throw new Error(`"${server.id}" exited during startup (see ${logFile})`)
      if (await healthy(server.healthUrl)) {
        ctx.logger.info(`local-model-supervisor: "${server.id}" started (pid ${child.pid}, ${server.healthUrl})`)
        return
      }
      await sleep(POLL_MS)
    }
    child.kill('SIGTERM')
    throw new Error(`"${server.id}" did not become healthy within ${server.startupTimeoutMs ?? 60_000}ms (see ${logFile})`)
  }

  /** Single-flight: adopt a healthy external server or spawn our own. */
  function ensure(server) {
    const state = states.get(server.id)
    if (state.ensuring !== undefined) return state.ensuring
    const run = (async () => {
      if (state.child !== undefined) return // our child is up (or still starting under a previous ensure)
      if (await healthy(server.healthUrl)) {
        if (!state.owned) ctx.logger.info(`local-model-supervisor: "${server.id}" already healthy at ${server.healthUrl}; adopting (will not manage its lifetime)`)
        return
      }
      await start(server, state)
    })()
    state.ensuring = run.catch((error) => {
      ctx.logger.warn(`local-model-supervisor: could not ensure "${server.id}": ${String(error)}`)
    }).finally(() => {
      if (state.ensuring === guard) state.ensuring = undefined
    })
    const guard = state.ensuring
    return state.ensuring
  }

  /** Whether any live top-level agent's current selection uses this server. */
  function inUse(server) {
    const providers = new Set(server.providers)
    for (const agent of ctx.agents.list()) {
      let selection
      try {
        const state = ctx.sessionProjections.stateOf(agent.session, 'modelSelection')
        selection = state?.pending ?? state?.lastUsed
      } catch {
        continue
      }
      if (selection !== null && selection !== undefined && providers.has(selection.provider)) return true
    }
    return false
  }

  /** Stop owned servers that idled out with no live session on their providers. */
  function sweep() {
    const now = Date.now()
    for (const server of servers) {
      const state = states.get(server.id)
      if (state.child === undefined || !state.owned) continue
      const idleMs = (server.idleMinutes ?? 0) * 60_000
      if (idleMs === 0) continue
      if (now - state.lastActivity < idleMs) continue
      if (inUse(server)) continue
      ctx.logger.info(`local-model-supervisor: "${server.id}" idle ${Math.round((now - state.lastActivity) / 60_000)}m with no live session on ${server.providers.join('/')}; stopping (pid ${state.child.pid})`)
      stop(state)
    }
  }

  /** SIGTERM an owned child, escalating to SIGKILL after a grace period. */
  function stop(state) {
    const child = state.child
    if (child === undefined) return
    child.kill('SIGTERM')
    const hardKill = setTimeout(() => {
      if (state.child === child) child.kill('SIGKILL')
    }, KILL_GRACE_MS)
    hardKill.unref?.()
  }

  ctx.on('session/event', (session, event) => {
    let provider
    if (event.type === 'model/selection') provider = event.data?.provider
    else if (event.type === 'request/header') provider = event.data?.header?.config?.provider
    if (typeof provider !== 'string') return
    const server = byProvider.get(provider)
    if (server === undefined) return
    const state = states.get(server.id)
    state.lastActivity = Date.now()
    void ensure(server)
  })

  ctx.effect(() => {
    const timer = setInterval(sweep, SWEEP_MS)
    timer.unref?.()
    return () => {
      clearInterval(timer)
      for (const state of states.values()) {
        if (state.owned) stop(state)
      }
    }
  })
}
