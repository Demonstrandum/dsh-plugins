/**
 * tali-reboot-command — the host-side model, kept free of Cordis so it can be
 * unit-tested with plain objects.
 *
 *   busySessions(deps)  — every live Agent with work a restart would interrupt,
 *                         the same three blockers the Host's own session-move
 *                         refusal names (`session/move-live`, move.ts
 *                         `blockersOf`) plus queued follow-ups.
 *   RebootController    — `now` / `when-idle` / `cancel`; when armed it
 *                         re-evaluates on a timer and fires once the busy
 *                         list has been empty for `idleGraceMs`.
 */

/** @typedef {{ kind: 'turn' } | { kind: 'queue', count: number } | { kind: 'jobs', labels: string[] } | { kind: 'subagents', count: number, running: number }} Blocker */
/** @typedef {{ sessionId: string, parentId?: string, blockers: Blocker[] }} BusySession */

/**
 * @param {{ agents: { list(): any[], isOwnedBy(id: string, owner: any): boolean }, jobs?: { list(caller?: any): { status: string, label: string }[] } }} deps
 * @returns {BusySession[]}
 */
export function busySessions(deps) {
  const agents = deps.agents.list()
  const rows = []
  for (const agent of agents) {
    /** @type {Blocker[]} */
    const blockers = []
    if (agent.status === 'running') blockers.push({ kind: 'turn' })
    const queued = Array.isArray(agent.inbox?.nextTurn) ? agent.inbox.nextTurn.length : 0
    if (queued > 0) blockers.push({ kind: 'queue', count: queued })
    if (deps.jobs !== undefined) {
      const labels = deps.jobs.list(agent)
        .filter(job => job.status === 'running' || job.status === 'stopping')
        .map(job => job.label)
      if (labels.length > 0) blockers.push({ kind: 'jobs', labels })
    }
    const children = agents.filter(candidate => candidate !== agent && deps.agents.isOwnedBy(candidate.id, agent))
    if (children.length > 0) {
      blockers.push({ kind: 'subagents', count: children.length, running: children.filter(child => child.status === 'running').length })
    }
    if (blockers.length === 0) continue
    const owner = agents.find(candidate => candidate !== agent && deps.agents.isOwnedBy(agent.id, candidate))
    rows.push({ sessionId: agent.id, ...(owner === undefined ? {} : { parentId: owner.id }), blockers })
  }
  return rows
}

/** One line naming the blockers, for command replies and logs. */
export function describeBlockers(blockers) {
  return blockers.map((blocker) => {
    switch (blocker.kind) {
      case 'turn': return 'a turn is running'
      case 'queue': return `${String(blocker.count)} queued message${blocker.count === 1 ? '' : 's'}`
      case 'jobs': return `${String(blocker.labels.length)} background job${blocker.labels.length === 1 ? '' : 's'} (${blocker.labels.slice(0, 3).join(', ')}${blocker.labels.length > 3 ? ', …' : ''})`
      case 'subagents': return `${String(blocker.count)} subagent${blocker.count === 1 ? '' : 's'} loaded${blocker.running > 0 ? `, ${String(blocker.running)} running` : ''}`
      default: return 'work in flight'
    }
  }).join('; ')
}

/**
 * Arms, cancels and fires the reboot. `fire` is injected (SIGTERM to self in
 * production, a spy in tests); `now` too.
 */
export class RebootController {
  /**
   * @param {{ busy: () => BusySession[], fire: (reason: string) => void, log: (line: string) => void,
   *   now?: () => number, pollMs?: number, idleGraceMs?: number,
   *   setInterval?: typeof globalThis.setInterval, clearInterval?: typeof globalThis.clearInterval }} deps
   */
  constructor(deps) {
    this.deps = deps
    this.now = deps.now ?? (() => Date.now())
    this.pollMs = deps.pollMs ?? 1000
    this.idleGraceMs = deps.idleGraceMs ?? 2000
    /** @type {{ mode: 'when-idle', since: number, by?: string } | undefined} */
    this.armed = undefined
    /** @type {number | undefined} */
    this.idleSince = undefined
    /** @type {ReturnType<typeof setInterval> | undefined} */
    this.timer = undefined
    /** Set once fire() ran: later requests are answered "already rebooting". */
    this.fired = false
    /** @type {Set<() => void>} */
    this.listeners = new Set()
  }

  /** Snapshot for the client and the command reply. */
  status() {
    return {
      busy: this.deps.busy(),
      armed: this.armed === undefined ? undefined : { ...this.armed },
      fired: this.fired,
      now: this.now(),
    }
  }

  /** @param {() => void} listener */
  subscribe(listener) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  notify() { for (const listener of this.listeners) listener() }

  /** Reboot immediately, whatever is running. */
  rebootNow(by) {
    if (this.fired) return { ok: false, message: 'a reboot is already under way' }
    const busy = this.deps.busy()
    this.disarm()
    this.fired = true
    this.deps.log(`reboot-command: rebooting now${by === undefined ? '' : ` (requested from session ${by})`}${busy.length === 0 ? '' : `, interrupting ${String(busy.length)} session${busy.length === 1 ? '' : 's'}`}`)
    this.notify()
    this.deps.fire('now')
    return { ok: true, message: busy.length === 0 ? 'Rebooting DSH now.' : `Rebooting DSH now, interrupting ${String(busy.length)} session${busy.length === 1 ? '' : 's'}.`, interrupted: busy }
  }

  /** Reboot as soon as no session has work in flight (fires at once when idle already). */
  rebootWhenIdle(by) {
    if (this.fired) return { ok: false, message: 'a reboot is already under way' }
    if (this.armed === undefined) {
      this.armed = { mode: 'when-idle', since: this.now(), ...(by === undefined ? {} : { by }) }
      this.idleSince = undefined
      this.timer = (this.deps.setInterval ?? setInterval)(() => { this.evaluate() }, this.pollMs)
      this.deps.log(`reboot-command: armed — will reboot once every session is idle${by === undefined ? '' : ` (requested from session ${by})`}`)
      this.notify()
    }
    this.evaluate()
    const busy = this.deps.busy()
    return { ok: true, message: this.fired ? 'Every session is idle — rebooting DSH now.' : `Armed: DSH reboots as soon as ${String(busy.length)} busy session${busy.length === 1 ? ' finishes' : 's finish'}.`, busy }
  }

  /** Drop an armed when-idle reboot. */
  cancel() {
    if (this.fired) return { ok: false, message: 'too late — the reboot is already under way' }
    const was = this.armed !== undefined
    this.disarm()
    if (was) {
      this.deps.log('reboot-command: armed reboot cancelled')
      this.notify()
    }
    return { ok: true, message: was ? 'Armed reboot cancelled.' : 'No reboot was armed.' }
  }

  /** Called by the timer, by `agent/status` and on arming. */
  evaluate() {
    if (this.armed === undefined || this.fired) return
    const busy = this.deps.busy()
    if (busy.length > 0) {
      this.idleSince = undefined
      return
    }
    const now = this.now()
    if (this.idleSince === undefined) {
      this.idleSince = now
      return
    }
    if (now - this.idleSince < this.idleGraceMs) return
    this.disarm()
    this.fired = true
    this.deps.log('reboot-command: every session idle — rebooting')
    this.notify()
    this.deps.fire('when-idle')
  }

  disarm() {
    this.armed = undefined
    this.idleSince = undefined
    if (this.timer !== undefined) {
      ;(this.deps.clearInterval ?? clearInterval)(this.timer)
      this.timer = undefined
    }
  }

  dispose() { this.disarm(); this.listeners.clear() }
}

/**
 * Parse the free text after `/reboot`.
 * @param {string} rawInput
 * @returns {'now' | 'wait' | 'cancel' | 'status' | { error: string }}
 */
export function parseArgs(rawInput) {
  const word = rawInput.trim().toLowerCase()
  switch (word) {
    case '': case 'status': return 'status'
    case 'now': case 'force': return 'now'
    case 'wait': case 'idle': case 'when-idle': return 'wait'
    case 'cancel': case 'abort': return 'cancel'
    default: return { error: `unknown argument "${rawInput.trim()}" — use /reboot now, /reboot wait, /reboot cancel or bare /reboot for status` }
  }
}
