/**
 * tali-reboot-command — host half.
 *
 * `/reboot` restarts THIS dsh web process from inside a session: a graceful
 * SIGTERM to self, exactly what the Tailscale-remote Server pane's "Restart"
 * does. Whether that is a restart or a quit depends on what is in front of the
 * process: with the always-on relay (dsh-tailscale-remote) the next connection
 * starts dsh web again and the page comes back through "Starting DSH…";
 * without it DSH simply stops. The dialog says which.
 *
 * Two surfaces share one controller (reboot.mjs):
 *
 *   - the HOST slash command `/reboot [now|wait|cancel]` (ctx.commands): logged
 *     as command/run + command/done like /compact, typeable anywhere the
 *     composer exists (phone UI included);
 *   - the control channel `POST /reboot-command/<endpoint>` the browser half
 *     polls for the modal it hangs on the BARE `/reboot` (a ui-commands
 *     decoration): `status` (busy sessions, armed state, relay facts), `now`,
 *     `wait`, `cancel`.
 *
 * "Busy" = the same blockers the Host names when it refuses to move a live
 * session (a running turn, running background jobs, loaded subagents), plus
 * queued follow-ups. `wait` arms a host-side state that survives closing the
 * dialog or the tab and fires after 2 s of every session being idle.
 *
 * Route gate: DSH's own request rejection (Host/Origin fence + browser-session
 * cookie), the envelope dsh-tailscale-remote and import-api-keys use, so the
 * proxy forwards it for any admitted connection.
 */
import { RebootController, busySessions, describeBlockers, parseArgs } from './reboot.mjs'

export const name = 'reboot-command'
export const inject = ['webServer', 'connection', 'commands', 'agents']

export const CHANNEL = '/reboot-command'
const MAX_BODY = 16 * 1024
/** Answer the request (and let command/done land) before the process goes. */
const FIRE_DELAY_MS = 400
/** launchctl is not free: relay facts are reused across polls this long. */
const RELAY_CACHE_MS = 5000

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const log = line => ctx.logger.info(line)

  const controller = new RebootController({
    busy: () => busySessions({ agents: ctx.agents, jobs: ctx.get('jobs') }),
    fire: (reason) => {
      log(`reboot-command: sending SIGTERM to pid ${String(process.pid)} in ${String(FIRE_DELAY_MS)} ms (${reason})`)
      setTimeout(() => { process.kill(process.pid, 'SIGTERM') }, FIRE_DELAY_MS)
    },
    log,
  })
  ctx.effect(() => () => { controller.dispose() }, 'reboot-command: controller')
  // A turn ending is the moment an armed reboot most often becomes possible;
  // the controller's own 1 s poll covers jobs and queue changes.
  ctx.on('agent/status', () => { controller.evaluate() })

  // ---- relay facts (optional sibling: dsh-tailscale-remote) -------------------
  /** @type {{ instance: string, configured: boolean, wakeUrl?: string, status(): Promise<any> } | undefined} */
  let relayFace
  ctx.inject(['tailscaleRemoteRelay'], (scoped) => {
    const face = scoped.get('tailscaleRemoteRelay')
    if (face === undefined) return
    scoped.effect(() => {
      relayFace = face
      return () => { relayFace = undefined }
    }, 'reboot-command: relay face')
  })
  /** @type {{ at: number, value: any } | undefined} */
  let relayCache
  const relayFacts = async () => {
    if (relayFace === undefined) return { known: false }
    if (relayCache !== undefined && Date.now() - relayCache.at < RELAY_CACHE_MS) return relayCache.value
    let value
    if (!relayFace.configured) {
      value = { known: true, configured: false, instance: relayFace.instance }
    } else {
      try {
        const status = await relayFace.status()
        value = { known: true, configured: true, instance: relayFace.instance, wakeUrl: relayFace.wakeUrl, loaded: status?.loaded === true, listening: status?.listening === true, pid: status?.pid, label: status?.label }
      } catch (error) {
        value = { known: true, configured: true, instance: relayFace.instance, wakeUrl: relayFace.wakeUrl, error: String(error?.message ?? error) }
      }
    }
    relayCache = { at: Date.now(), value }
    return value
  }

  const snapshot = async () => ({
    ...controller.status(),
    relay: await relayFacts(),
    process: { pid: process.pid, port: ctx.webServer.port, uptimeSeconds: Math.round(process.uptime()), dshHome: process.env.DSH_HOME ?? '' },
  })

  // ---- the host slash command ---------------------------------------------------
  ctx.effect(() => ctx.commands.register({
    name: 'reboot',
    description: 'Restart this DSH server: bare = status, "now" = interrupt busy sessions, "wait" = once every session is idle, "cancel"',
    input: { hint: 'now | wait | cancel' },
    handler: async ({ agent, rawInput }) => {
      const parsed = parseArgs(rawInput)
      if (typeof parsed === 'object') return { kind: 'error', text: parsed.error }
      const relay = await relayFacts()
      const relayNote = relay.known === false
        ? 'Whether DSH comes back depends on what supervises it (no relay plugin loaded).'
        : relay.configured === false
          ? 'No relay is configured: this is a QUIT, DSH will not come back by itself.'
          : relay.loaded === true
            ? 'The relay is in front: DSH comes back on the next connection.'
            : 'The relay LaunchAgent is NOT loaded: this is a QUIT, DSH will not come back by itself.'
      switch (parsed) {
        case 'status': {
          const status = controller.status()
          const lines = [
            status.busy.length === 0 ? 'No session has work in flight.' : `${String(status.busy.length)} session${status.busy.length === 1 ? ' has' : 's have'} work in flight:`,
            ...status.busy.map(row => `  - ${row.sessionId}${row.sessionId === agent.id ? ' (this session)' : ''}: ${describeBlockers(row.blockers)}`),
            status.armed === undefined ? 'No reboot is armed.' : `A when-idle reboot is armed (since ${new Date(status.armed.since).toLocaleTimeString()}).`,
            relayNote,
            'Usage: /reboot now · /reboot wait · /reboot cancel',
          ]
          return { kind: 'success', text: lines.join('\n') }
        }
        case 'now': {
          const outcome = controller.rebootNow(agent.id)
          return outcome.ok ? { kind: 'success', text: `${outcome.message} ${relayNote}` } : { kind: 'error', text: outcome.message }
        }
        case 'wait': {
          const outcome = controller.rebootWhenIdle(agent.id)
          return outcome.ok ? { kind: 'success', text: `${outcome.message} ${relayNote}` } : { kind: 'error', text: outcome.message }
        }
        case 'cancel': {
          const outcome = controller.cancel()
          return outcome.ok ? { kind: 'success', text: outcome.message } : { kind: 'error', text: outcome.message }
        }
        default:
          return { kind: 'error', text: 'unreachable' }
      }
    },
  }), 'reboot-command: /reboot')

  // ---- control channel for the browser half --------------------------------------
  const ok = value => ({ ok: true, value })
  const fail = (code, message) => ({ ok: false, error: { code: `reboot-command/${code}`, message, details: {} } })
  const dispatch = async (endpoint, args) => {
    const by = typeof args.sessionId === 'string' ? args.sessionId : undefined
    switch (endpoint) {
      case 'status': return ok(await snapshot())
      case 'now': {
        const outcome = controller.rebootNow(by)
        return outcome.ok ? ok({ ...outcome, ...(await snapshot()) }) : fail('now', outcome.message)
      }
      case 'wait': {
        const outcome = controller.rebootWhenIdle(by)
        return outcome.ok ? ok({ ...outcome, ...(await snapshot()) }) : fail('wait', outcome.message)
      }
      case 'cancel': {
        const outcome = controller.cancel()
        return outcome.ok ? ok({ ...outcome, ...(await snapshot()) }) : fail('cancel', outcome.message)
      }
      default: return fail('unknown-endpoint', `unknown endpoint ${endpoint}`)
    }
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: CHANNEL,
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      const endpoint = new URL(req.url ?? '/', 'http://x').pathname.slice(CHANNEL.length + 1)
      if (req.method !== 'POST' || endpoint === '' || endpoint.includes('/')) { res.writeHead(404); res.end('not found'); return }
      let message
      try { message = JSON.parse(await readBody(req, MAX_BODY)) } catch { res.writeHead(400); res.end('body is not JSON'); return }
      if (typeof message !== 'object' || message === null || message.type !== 'client-request' || typeof message.rpcId !== 'string' || message.method !== endpoint) {
        res.writeHead(400); res.end('invalid client-request envelope'); return
      }
      const args = typeof message.payload?.args === 'object' && message.payload.args !== null ? message.payload.args : {}
      let result
      try {
        result = await dispatch(endpoint, args)
      } catch (error) {
        result = fail('internal', String(error?.message ?? error))
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result }))
    },
  }), 'reboot-command: control channel')

  log('reboot-command: /reboot ready (host command + control channel)')
}
