import { homedir } from 'node:os'
import { join } from 'node:path'
import { BillingLedger } from './ledger.mjs'
import { validateRateCards } from './money.mjs'
import { installCollector } from './collector.mjs'

export const name = 'billing-status'
export const inject = ['llm']
export const SNAPSHOT_PATH = '/api/billing-status/snapshot'
export function resolveConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['directory','rateCards','staleAfterMs'].includes(key))) throw new TypeError('Invalid billing-status configuration')
  const directory = input.directory ?? join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'billing-status')
  if (typeof directory !== 'string' || !directory || directory.includes('\0')) throw new TypeError('Invalid billing ledger directory')
  const staleAfterMs = input.staleAfterMs ?? 300_000
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 1000 || staleAfterMs > 86_400_000) throw new TypeError('Invalid billing freshness interval')
  return { directory, staleAfterMs, rateCards: validateRateCards(input.rateCards) }
}
export const Config = { '~standard': { version: 1, vendor: 'tali-billing-status', validate(input) {
  try { return { value: resolveConfig(input) } }
  catch (error) { return { issues: [{ message: error.message }] } }
} } }
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'vary': 'Cookie' } })

/** DSH authenticates /api before this handler. Never treat arbitrary headers as identities. */
export function snapshotHandler(ctx, ledger) {
  return async request => {
    const sessionId = new URL(request.url).searchParams.get('sessionId') ?? ''
    if (!/^session-[a-zA-Z0-9_-]{1,140}$/.test(sessionId)) return json({ error: 'Invalid session' }, 400)
    try {
      const access = ctx.get('billingAccess')
      if (access !== undefined) {
        if (typeof access.canRead !== 'function' || await access.canRead(request, sessionId) !== true) return json({ error: 'Billing unavailable' }, 403)
      } else if (ctx.get('sessionOwners') !== undefined) {
        // Attribution is not authorization. Multi-user compositions need a verified principal seam.
        return json({ error: 'Billing unavailable' }, 403)
      }
      return json(await ledger.snapshot(sessionId))
    } catch { return json({ error: 'Billing unavailable' }, 503) }
  }
}
export function apply(ctx, input) {
  const config = resolveConfig(input)
  const ledger = new BillingLedger(config)
  ctx.effect(() => () => ledger.close(), 'billing-status: durable ledger')
  ctx.provide('billingStatus', {
    // Trusted in-process extension point; there is deliberately no HTTP ingestion endpoint.
    observe: observation => ledger.record(observation),
    snapshot: sessionId => ledger.snapshot(sessionId),
  })
  installCollector(ctx, observation => { void ledger.record(observation) })
  ctx.inject(['connection'], web => {
    web.effect(() => web.connection.fetch.register({ path: SNAPSHOT_PATH, methods: ['GET'], requestBody: 'buffered', fetch: snapshotHandler(ctx, ledger) }), 'billing-status: snapshot route')
  })
  ctx.inject(['commands'], commands => {
    commands.effect(() => commands.commands.register({
      name: 'billing', description: 'Show this session’s observed billing and token-cost estimates', recordInput: false,
      handler: async ({ agent, rawInput }) => {
        if (rawInput.trim()) return { kind: 'error', text: 'Usage: /billing' }
        const snapshot = await ledger.snapshot(agent.session.id)
        const lines = snapshot.totals.map(total => `${total.kind === 'reported' ? 'Reported' : 'Estimated'}: ${total.currency} ${total.amount} (${total.scope})`)
        if (!lines.length) lines.push('Cost: unknown')
        lines.push(`Requests: ${snapshot.counts.requests} · Unpriced: ${snapshot.counts.unpriced} · Pending: ${snapshot.counts.pending}`)
        if (snapshot.latest) {
          const latest = snapshot.latest
          lines.push(`Last observation: ${latest.provider}/${latest.model} · ${latest.stale ? 'stale' : latest.kind}`)
          if (!latest.stale) for (const window of latest.windows) lines.push(`${window.label}: ${window.usedPercent}%`)
        }
        lines.push(`Storage: ${snapshot.persistence}`)
        return { kind: snapshot.persistence === 'ok' ? 'success' : 'error', text: lines.join('\n') }
      },
    }), 'billing-status: command')
  })
}
