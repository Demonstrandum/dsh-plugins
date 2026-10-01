import { constants } from 'node:fs'
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { units, decimal, priceUsage, validateRateCards, catalogCard } from './money.mjs'

const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_.:/~-]{1,160}$/.test(value) && !/sk-|bearer|password|secret/i.test(value) ? value : undefined
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined
const oauth = provider => provider?.endsWith('-oauth') || provider === 'openai-codex'
const USAGE_KEYS = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
function usageOf(value) {
  if (!value || !Number.isSafeInteger(value.inputTokens) || !Number.isSafeInteger(value.outputTokens)) return undefined
  const result = {}
  for (const key of USAGE_KEYS) {
    if (value[key] !== undefined) {
      if (!Number.isSafeInteger(value[key]) || value[key] < 0) return undefined
      result[key] = value[key]
    }
  }
  return result
}
function costOf(value) {
  if (!value || units(value.amount) === undefined || !/^[A-Z]{3}$/.test(value.currency ?? '')) return undefined
  if (!['reported','estimated'].includes(value.kind) || !['openrouter-account','model-tokens','openrouter-tokens'].includes(value.scope)) return undefined
  return { kind: value.kind, amount: value.amount, currency: value.currency, scope: value.scope,
    ...(identifier(value.pricingVersion) ? { pricingVersion: value.pricingVersion } : {}) }
}
function windowsOf(value) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 8).flatMap(window => {
    if (typeof window?.label !== 'string' || !/^[a-zA-Z0-9 _.-]{1,32}$/.test(window.label) || !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100) return []
    return [{ label: window.label, usedPercent: window.usedPercent,
      ...(Number.isFinite(window.windowMinutes) && window.windowMinutes >= 0 && window.windowMinutes <= 5256000 ? { windowMinutes: window.windowMinutes } : {}),
      ...(timestamp(window.resetAt) ? { resetAt: timestamp(window.resetAt) } : {}) }]
  })
}
function cleanRow(row) {
  const sessionId = identifier(row?.sessionId), requestId = identifier(row?.requestId)
  const provider = identifier(row?.provider), model = identifier(row?.model), at = timestamp(row?.at)
  if (!sessionId || !requestId || !provider || !model || !at) return undefined
  return { sessionId, requestId, provider, model, at,
    startedAt: timestamp(row.startedAt) ?? at,
    ...(identifier(row.purpose) ? { purpose: row.purpose } : {}),
    ...(identifier(row.responseId) ? { responseId: row.responseId } : {}),
    finished: row.finished === true,
    incomplete: row.incomplete === true,
    ...(usageOf(row.usage) ? { usage: usageOf(row.usage) } : {}),
    ...(costOf(row.cost) ? { cost: costOf(row.cost) } : {}),
    outcome: ['plan','quota','extra','unknown','unobserved','rejected'].includes(row.outcome) ? row.outcome : 'unobserved',
    ...(row.authKind === 'oauth' ? { authKind: 'oauth' } : {}),
    ...(row.card ? { card: validateRateCards([row.card])[0] } : {}),
  }
}

/** Append-only request states, separate from DSH history: rewind is not a refund. */
export class BillingLedger {
  constructor({ directory, rateCards = [], staleAfterMs = 300_000, now = () => new Date().toISOString(), pricing, usage, usageRetryMs = 300_000, history, responseCost }) {
    // Session-log reader (`sessionQuery.readSession`) and provider receipt lookup (`ctx.llm.responseCost`)
    // for requests that predate the ledger; each session is backfilled at most once per process.
    this.history = history
    this.responseCost = responseCost
    this.backfilled = new Set()
    this.directory = directory
    this.cards = validateRateCards(rateCards)
    // DSH's resolved-model list prices (`ctx.llm.resolveModelInfo().pricing`), looked up per route/model.
    this.pricing = pricing
    this.catalog = new Map()
    this.staleAfterMs = staleAfterMs
    this.now = now
    this.rows = new Map()
    // Latest subscription reading per session and per account (route). Persisted to quota.json so a
    // restart shows the previous reading (stale) instead of nothing; quota is account-wide.
    this.latest = new Map()
    this.accounts = new Map()
    // `ctx.llm.subscriptionUsage(route)`: asked at most once per account per process when a displayed
    // session has no fresh reading; afterwards each response's headers keep the reading current.
    this.usage = usage
    this.usageRetryMs = usageRetryMs
    this.usageAttempts = new Map()
    this.startOrders = new Map()
    this.sequence = 0
    this.recovered = new Set()
    this.persistence = 'ok'
    this.queueDepth = 0
    this.closed = false
    this.ready = this.load().catch(() => { this.persistence = 'error' })
    this.tail = this.ready
  }
  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    try {
      this.lock = await open(join(this.directory, 'writer.lock'), 'wx', 0o600)
      await this.lock.writeFile(`${process.pid}\n`)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      // Never steal a writer's lock. Existing history remains readable after a crash.
      this.persistence = 'error'
    }
    const flags = this.lock ? constants.O_CREAT | constants.O_RDWR | constants.O_APPEND : constants.O_RDONLY
    this.file = await open(join(this.directory, 'ledger.jsonl'), flags | constants.O_NOFOLLOW, 0o600)
    if (this.lock) await this.file.chmod(0o600)
    const info = await this.file.stat()
    if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error('Ledger needs offline maintenance')
    if (info.size > 0) {
      const last = Buffer.alloc(1)
      await this.file.read(last, 0, 1, info.size - 1)
      if (last[0] !== 10) this.persistence = 'error' // never append after a torn final line
    }
    const stream = this.file.createReadStream({ autoClose: false, start: 0 })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        if (line.length > 65536 || !line) throw new Error('Invalid ledger line')
        const event = JSON.parse(line)
        if (event.version !== 1) throw new Error('Unsupported ledger version')
        const row = cleanRow(event.row)
        if (!row) throw new Error('Invalid ledger row')
        // A previous process's in-flight attempt is no longer live; retain any known cost.
        if (!row.finished) row.incomplete = true
        row.finished = true
        this.rows.delete(`${row.sessionId}/${row.requestId}`)
        this.rows.set(`${row.sessionId}/${row.requestId}`, row)
        this.recovered.add(row.sessionId)
      }
    } catch {
      // Preserve the valid prefix, but never append to a damaged log or claim complete totals.
      this.persistence = 'error'
    } finally { lines.close() }
    await this.loadQuota()
  }
  /** Restore remembered readings; a corrupt or missing file just means none. */
  async loadQuota() {
    let data
    try { data = JSON.parse(await readFile(join(this.directory, 'quota.json'), 'utf8')) } catch { return }
    if (data?.version !== 1) return
    const entry = value => {
      const provider = identifier(value?.provider), model = identifier(value?.model), at = timestamp(value?.at)
      if (!provider || !model || !at || !oauth(provider) || !['plan', 'quota', 'extra'].includes(value.kind)) return undefined
      return { order: 0, provider, model, at, startedAt: at, kind: value.kind, windows: windowsOf(value.windows),
        ...(value.source === 'usage-endpoint' ? { source: 'usage-endpoint' } : {}) }
    }
    for (const [sessionId, value] of Object.entries(data.sessions ?? {})) {
      const restored = identifier(sessionId) && entry(value)
      if (restored && !this.latest.has(sessionId)) this.latest.set(sessionId, restored)
    }
    for (const value of Object.values(data.accounts ?? {})) {
      const restored = entry(value)
      if (restored && !this.accounts.has(restored.provider)) this.accounts.set(restored.provider, restored)
    }
  }
  /** Atomic rewrite of the remembered readings (writer only), bounded to the 512 newest sessions. */
  async saveQuota() {
    if (!this.lock) return
    const keep = value => ({ provider: value.provider, model: value.model, at: value.at, kind: value.kind, windows: value.windows,
      ...(value.source ? { source: value.source } : {}) })
    const sessions = [...this.latest].filter(([, v]) => ['plan', 'quota', 'extra'].includes(v.kind) && oauth(v.provider))
      .sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at)).slice(0, 512)
    const body = JSON.stringify({ version: 1, sessions: Object.fromEntries(sessions.map(([id, v]) => [id, keep(v)])),
      accounts: Object.fromEntries([...this.accounts].map(([route, v]) => [route, keep(v)])) })
    const path = join(this.directory, 'quota.json'), temp = `${path}.${process.pid}.tmp`
    try { await writeFile(temp, body, { mode: 0o600 }); await rename(temp, path) } catch { /* memory still serves this process */ }
  }
  /** Remember an account reading if it is newer than the one held. */
  rememberAccount(entry) {
    if (!oauth(entry.provider) || !['plan', 'quota', 'extra'].includes(entry.kind)) return false
    const held = this.accounts.get(entry.provider)
    if (held && Date.parse(held.at) > Date.parse(entry.at)) return false
    this.accounts.set(entry.provider, { ...entry, order: 0 })
    return true
  }
  /** One background usage read per account per process; failures retry after usageRetryMs. */
  requestUsage(route, model) {
    if (!this.usage || this.closed) return
    const attempt = this.usageAttempts.get(route)
    if (attempt && (attempt.state !== 'failed' || Date.now() < attempt.retryAt)) return
    this.usageAttempts.set(route, { state: 'pending' })
    Promise.resolve().then(() => this.usage(route)).then(async result => {
      if (!result || !Array.isArray(result.windows) || result.windows.length === 0) { this.usageAttempts.set(route, { state: 'done' }); return }
      const at = timestamp(result.observedAt) ?? this.now()
      const entry = { order: 0, provider: route, model: identifier(model) ?? 'account', at, startedAt: at, kind: 'plan', windows: windowsOf(result.windows), source: 'usage-endpoint' }
      this.usageAttempts.set(route, { state: 'done' })
      if (this.rememberAccount(entry)) await this.saveQuota()
    }).catch(error => {
      const seconds = /retry after (\d+)s/.exec(String(error?.message))?.[1]
      this.usageAttempts.set(route, { state: 'failed', retryAt: Date.now() + Math.max(this.usageRetryMs, Number(seconds ?? 0) * 1000) })
    })
  }
  /** Catalog estimate for one usage; OpenRouter estimates keep their route so the pill shows its glyph. */
  async estimate(provider, models, usage, configured) {
    for (const model of models) {
      if (!model) continue
      const cost = priceUsage(usage, await this.cardFor(provider, model, configured))
      if (cost) return provider === 'openrouter' ? { ...cost, scope: 'openrouter-tokens' } : cost
    }
    return undefined
  }
  /**
   * Price requests recorded in the session log before this ledger saw the session: OpenRouter
   * generations by their receipt (one lookup each), falling back to the catalog estimate; other
   * per-token routes by the catalog. Results are appended as `history:<seq>` rows, so this happens
   * once per session ever; subscription routes and fork-inherited events are skipped.
   */
  requestBackfill(sessionId) {
    if (!this.history || this.closed || this.backfilled.has(sessionId)) return
    this.backfilled.add(sessionId)
    void (async () => {
      const log = await this.history(sessionId)
      const events = Array.isArray(log?.events) ? log.events.slice(Number.isSafeInteger(log.inheritedEventCount) ? log.inheritedEventCount : 0) : []
      const rows = [...this.rows.values()].filter(row => row.sessionId === sessionId)
      const live = rows.filter(row => !row.requestId.startsWith('history:'))
      const cutoff = live.length ? Math.min(...live.map(row => Date.parse(row.startedAt))) : Infinity
      const have = new Set(rows.map(row => row.requestId)), receipts = new Set(rows.map(row => row.responseId).filter(Boolean))
      const items = []
      for (const event of events) {
        if (event?.type !== 'assistant/message' || !(event.time < cutoff)) continue
        const source = event.data?.message?.source
        const provider = identifier(source?.provider), model = identifier(source?.model), usage = usageOf(event.data?.usage)
        if (source?.kind !== 'model' || !provider || !model || !usage || oauth(provider)) continue
        const requestId = `history:${event.seq}`, responseId = identifier(source.replayState?.response?.responseId)
        if (have.has(requestId) || (responseId && receipts.has(responseId))) continue
        items.push({ requestId, provider, model, usage, responseId, responseModel: identifier(source.replayState?.response?.responseModel), at: new Date(event.time).toISOString() })
      }
      let lookups = 0, lookupsStopped = false
      const price = async item => {
        if (item.provider === 'openrouter' && item.responseId && this.responseCost && !lookupsStopped && lookups < 500) {
          lookups++
          try {
            const receipt = await this.responseCost(item.provider, item.responseId)
            const cost = receipt && costOf({ kind: 'reported', amount: receipt.amount, currency: receipt.currency, scope: 'openrouter-account' })
            if (cost) return cost
          } catch (error) {
            // Rate limits or auth failures stop further lookups; the rest use the catalog.
            if (/RATE_LIMIT|AUTH/.test(String(error?.code))) lookupsStopped = true
          }
        }
        return this.estimate(item.provider, [item.model, item.responseModel], item.usage)
      }
      for (let index = 0; index < items.length; index += 4) {
        const batch = items.slice(index, index + 4)
        const costs = await Promise.all(batch.map(price))
        await (this.tail = this.tail.then(async () => {
          for (const [i, item] of batch.entries()) {
            const row = cleanRow({ sessionId, requestId: item.requestId, provider: item.provider, model: item.model, at: item.at, startedAt: item.at,
              purpose: 'history', ...(item.responseId ? { responseId: item.responseId } : {}), finished: true, usage: item.usage, cost: costs[i], outcome: 'unknown' })
            if (!row || this.rows.has(`${sessionId}/${row.requestId}`)) continue
            this.rows.set(`${sessionId}/${row.requestId}`, row)
            if (this.persistence === 'ok' && this.file) await this.file.write(`${JSON.stringify({ version: 1, row })}\n`)
          }
          if (this.persistence === 'ok' && this.file) await this.file.sync()
        }).catch(() => { this.persistence = 'error' }))
      }
    })().catch(() => { /* history unavailable: nothing to backfill */ })
  }
  /** Configured card first, then DSH's catalog list prices; cached for ten minutes per route/model. */
  async cardFor(provider, model, configured) {
    if (configured) return configured
    if (!this.pricing || oauth(provider)) return undefined
    const key = `${provider}/${model}`, hit = this.catalog.get(key)
    if (hit && Date.now() - hit.at < 600_000) return hit.card
    let card
    try { card = catalogCard(provider, model, await this.pricing(provider, model)) } catch { card = undefined }
    this.catalog.set(key, { card, at: Date.now() })
    return card
  }
  record(observation) {
    if (this.closed) return Promise.resolve()
    if (this.queueDepth >= 2048) { this.persistence = 'error'; return Promise.resolve() }
    this.queueDepth++
    this.tail = this.tail.then(async () => {
      const base = cleanRow(observation)
      if (!base) return
      const key = `${base.sessionId}/${base.requestId}`
      const previous = this.rows.get(key)
      if (!this.startOrders.has(key)) this.startOrders.set(key, ++this.sequence)
      const order = this.startOrders.get(key)
      const row = previous ? { ...previous, at: base.at } : { ...base, card: this.cards.find(card => card.provider === base.provider && card.model === base.model) }
      // Never reattribute a request ID to another route/model after recording it.
      if (row.provider !== base.provider || row.model !== base.model) return
      if (observation.phase === 'usage') {
        const usage = usageOf(observation.usage)
        if (usage) {
          row.usage = usage // cumulative sample replaces; never add successive samples
          if (row.cost?.kind !== 'reported' && row.authKind !== 'oauth' && !oauth(row.provider)) row.cost = await this.estimate(row.provider, [row.model], usage, row.card)
        }
      }
      if (observation.phase === 'evidence') {
        const evidence = observation.evidence ?? {}
        if (evidence.authKind === 'oauth' || ['anthropic-oauth','openai-codex'].includes(evidence.kind)) {
          row.authKind = 'oauth'
          if (row.cost?.kind === 'estimated') delete row.cost
        }
        const kinds = { 'plan-evidence': 'plan', 'extra-usage': 'extra', plan: 'plan', 'quota-observed': 'quota', extra: 'extra', unknown: 'unknown', rejected: 'rejected', unobserved: 'unobserved' }
        row.outcome = kinds[evidence.outcome] ?? 'unknown'
        if (evidence.kind === 'openrouter' && evidence.reportedCost) {
          const cost = costOf({ ...evidence.reportedCost, kind: 'reported' })
          if (cost?.scope === 'openrouter-account') row.cost = cost
        }
        if (identifier(evidence.responseId)) row.responseId = evidence.responseId
        const latest = this.latest.get(row.sessionId)
        const reading = { order, requestId: row.requestId, provider: row.provider, model: row.model, at: row.at, startedAt: row.startedAt,
          kind: row.outcome, windows: windowsOf(evidence.windows),
          ...(evidence.kind === 'openai-codex' && typeof evidence.credits?.hasCredits === 'boolean' && typeof evidence.credits?.unlimited === 'boolean'
            ? { credits: { hasCredits: evidence.credits.hasCredits, unlimited: evidence.credits.unlimited,
              ...(units(evidence.credits.balance) !== undefined ? { balance: evidence.credits.balance } : {}) } } : {}) }
        // The newest started request wins, not a late response from an older concurrent call.
        // A late response from a superseded request updates neither the session nor its account.
        if (!latest || order >= latest.order) {
          this.latest.set(row.sessionId, reading)
          this.rememberAccount(reading)
          if (['plan', 'quota', 'extra'].includes(reading.kind)) await this.saveQuota()
        }
      }
      if (observation.phase === 'start') {
        const latest = this.latest.get(row.sessionId)
        if (!latest || order >= latest.order) {
          this.latest.set(row.sessionId, { order, requestId: row.requestId, provider: row.provider, model: row.model, at: row.at, startedAt: row.startedAt, kind: 'unobserved', windows: [] })
        }
      }
      if (observation.phase === 'finish') {
        row.finished = true
        if (['error','aborted','cancelled','incomplete','superseded','returned'].includes(observation.finishReason)) {
          row.incomplete = true
          // pi-ai emits a zero usage placeholder even when no provider usage arrived.
          if (row.cost?.kind === 'estimated' && units(row.cost.amount) === 0n) delete row.cost
        }
      }
      const clean = cleanRow(row)
      this.rows.delete(key)
      this.rows.set(key, clean)
      if (this.persistence === 'ok' && this.file) {
        await this.file.write(`${JSON.stringify({ version: 1, row: clean })}\n`)
        if (row.finished || row.cost?.kind === 'reported') await this.file.sync()
      }
    }).catch(() => { this.persistence = 'error' }).finally(() => { this.queueDepth-- })
    return this.tail
  }
  /**
   * The reading to show for a session: its own, or its subscription account's when newer (quota is
   * account-wide), or a bare route marker so the pill shows the right kind of glyph. Asks DSH for
   * the account's usage once when nothing fresh is known.
   */
  subscriptionReading(sessionId, stored, now, routeHint) {
    let latest = this.latest.get(sessionId)
    const last = stored[stored.length - 1]
    // Observed traffic wins; the selected route only covers sessions with nothing recorded yet.
    const route = latest?.provider ?? last?.provider ?? identifier(routeHint)
    if (!route || !oauth(route)) return latest
    const account = this.accounts.get(route)
    const known = ['plan', 'quota', 'extra']
    if (account && (!latest || !known.includes(latest.kind) || Date.parse(account.at) > Date.parse(latest.at))) {
      const { requestId: _request, ...shared } = account
      latest = { ...shared, order: latest?.order ?? 0, ...(latest?.requestId ? { requestId: latest.requestId } : {}) }
    }
    latest ??= { order: 0, provider: route, model: last?.model ?? 'account', at: last?.at ?? now, startedAt: last?.startedAt ?? now, kind: 'unobserved', windows: [] }
    const fresh = known.includes(latest.kind) && Date.parse(now) - Date.parse(latest.at) <= this.staleAfterMs
    if (!fresh) this.requestUsage(route, latest.model)
    return latest
  }
  async snapshot(sessionId, routeHint) {
    await this.tail
    this.requestBackfill(sessionId)
    const stored = [...this.rows.values()].filter(row => row.sessionId === sessionId)
    // Usage recorded before prices were known (or before this feature) is priced at read time from the
    // same catalog; nothing is written back, so a later receipt or restart never double-counts it.
    const records = []
    for (const row of stored) {
      if (row.cost || !row.usage || row.authKind === 'oauth' || oauth(row.provider) || row.outcome === 'plan') { records.push(row); continue }
      const cost = await this.estimate(row.provider, [row.model], row.usage, row.card)
      records.push(cost && !(row.incomplete && units(cost.amount) === 0n) ? { ...row, cost } : row)
    }
    const totals = new Map(), countedReceipts = new Set()
    const counts = { requests: records.length, pending: 0, unpriced: 0, subscription: 0, incomplete: 0, failed: 0 }
    // Map insertion order is last observation order, reconstructed from the append log.
    // Newer receipt corrections replace older amounts even on a separate request ID.
    for (const row of records.slice().reverse()) {
      if (!row.finished) counts.pending++
      if (row.incomplete) counts.incomplete++
      if (row.outcome === 'plan') counts.subscription++
      if (!row.cost) {
        // In flight: counted as pending until its usage arrives. Failed before any usage (e.g. a
        // rejected request): nothing was processed, so it is not an unknown cost.
        // Subscription requests are covered by the plan, not unknown spend.
        if (row.outcome === 'plan' || !row.finished || row.authKind === 'oauth' || oauth(row.provider)) continue
        if (row.incomplete && !row.usage) counts.failed++
        else counts.unpriced++
        continue
      }
      // Reconciliation of the same provider response is not another charge.
      if (row.cost.kind === 'reported' && row.responseId) {
        const receipt = `${row.provider}/${row.responseId}`
        if (countedReceipts.has(receipt)) continue
        countedReceipts.add(receipt)
      }
      const key = `${row.cost.kind}/${row.cost.currency}/${row.cost.scope}`
      const total = totals.get(key) ?? { kind: row.cost.kind, currency: row.cost.currency, scope: row.cost.scope, units: 0n, sources: new Set() }
      total.units += units(row.cost.amount)
      if (row.cost.kind === 'estimated' && row.cost.pricingVersion) total.sources.add(row.cost.pricingVersion)
      totals.set(key, total)
    }
    const now = this.now()
    const latest = this.subscriptionReading(sessionId, stored, now, routeHint)
    return { version: 1, sessionId, totals: [...totals.values()].map(({ units: amount, sources, ...rest }) => ({ ...rest, amount: decimal(amount), ...(sources.size === 1 ? { source: [...sources][0] } : {}) })), counts,
      ...(latest ? { latest: { ...latest, stale: Date.parse(now) - Date.parse(latest.at) > this.staleAfterMs || Date.parse(now) < Date.parse(latest.at) } } : {}),
      persistence: this.persistence, staleAfterMs: this.staleAfterMs,
      ...(records.length ? { coverageSince: records.reduce((a, row) => a < row.startedAt ? a : row.startedAt, records[0].startedAt) } : {}),
      recovered: this.recovered.has(sessionId), now }
  }
  close() {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.closePromise = (async () => {
      await this.tail
      if (this.file) { await this.file.sync().catch(() => {}); await this.file.close() }
      if (this.lock) { await this.lock.close(); await unlink(join(this.directory, 'writer.lock')).catch(error => { if (error.code !== 'ENOENT') throw error }) }
    })()
    return this.closePromise
  }
}
