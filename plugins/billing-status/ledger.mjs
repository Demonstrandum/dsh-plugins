import { constants } from 'node:fs'
import { mkdir, open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { units, decimal, priceUsage, validateRateCards, catalogCard } from './money.mjs'

const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(value) && !/sk-|bearer|password|secret/i.test(value) ? value : undefined
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
  if (!['reported','estimated'].includes(value.kind) || !['openrouter-account','model-tokens'].includes(value.scope)) return undefined
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
  constructor({ directory, rateCards = [], staleAfterMs = 300_000, now = () => new Date().toISOString(), pricing }) {
    this.directory = directory
    this.cards = validateRateCards(rateCards)
    // DSH's resolved-model list prices (`ctx.llm.resolveModelInfo().pricing`), looked up per route/model.
    this.pricing = pricing
    this.catalog = new Map()
    this.staleAfterMs = staleAfterMs
    this.now = now
    this.rows = new Map()
    this.latest = new Map() // Quota snapshots are deliberately never persisted.
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
          if (row.cost?.kind !== 'reported' && row.authKind !== 'oauth' && !oauth(row.provider)) row.cost = priceUsage(usage, await this.cardFor(row.provider, row.model, row.card))
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
        // The newest started request wins, not a late response from an older concurrent call.
        if (!latest || order >= latest.order) {
          this.latest.set(row.sessionId, { order, requestId: row.requestId, provider: row.provider, model: row.model, at: row.at, startedAt: row.startedAt,
            kind: row.outcome, windows: windowsOf(evidence.windows),
            ...(evidence.kind === 'openai-codex' && typeof evidence.credits?.hasCredits === 'boolean' && typeof evidence.credits?.unlimited === 'boolean'
              ? { credits: { hasCredits: evidence.credits.hasCredits, unlimited: evidence.credits.unlimited,
                ...(units(evidence.credits.balance) !== undefined ? { balance: evidence.credits.balance } : {}) } } : {}) })
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
  async snapshot(sessionId) {
    await this.tail
    const stored = [...this.rows.values()].filter(row => row.sessionId === sessionId)
    // Usage recorded before prices were known (or before this feature) is priced at read time from the
    // same catalog; nothing is written back, so a later receipt or restart never double-counts it.
    const records = []
    for (const row of stored) {
      if (row.cost || !row.usage || row.authKind === 'oauth' || oauth(row.provider) || row.outcome === 'plan') { records.push(row); continue }
      const cost = priceUsage(row.usage, await this.cardFor(row.provider, row.model, row.card))
      records.push(cost && !(row.incomplete && units(cost.amount) === 0n) ? { ...row, cost } : row)
    }
    const totals = new Map(), countedReceipts = new Set()
    const counts = { requests: records.length, pending: 0, unpriced: 0, subscription: 0, incomplete: 0 }
    // Map insertion order is last observation order, reconstructed from the append log.
    // Newer receipt corrections replace older amounts even on a separate request ID.
    for (const row of records.slice().reverse()) {
      if (!row.finished) counts.pending++
      if (row.incomplete) counts.incomplete++
      if (row.outcome === 'plan') counts.subscription++
      if (!row.cost) { if (row.outcome !== 'plan') counts.unpriced++; continue }
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
    const latest = this.latest.get(sessionId)
    const now = this.now()
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
