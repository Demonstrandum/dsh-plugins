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
// Survives connection and plugin remounts, but never leaks policy across independent Cordis roots.
const ACCESS_MODES = Symbol.for('tali-billing-status.access-modes.v1')
const accessModes = globalThis[ACCESS_MODES] ??= new WeakMap()
export function snapshotHandler(ctx, ledger) {
  const root = ctx.root ?? ctx
  let mode = accessModes.get(root)
  if (!mode) { mode = { ownershipRequired: false }; accessModes.set(root, mode) }
  const ownershipServices = ['billingAccess', 'sessionRequestAccess', 'sessionOwners']
  if (ownershipServices.some(name => ctx.get(name) !== undefined)) mode.ownershipRequired = true
  for (const name of ownershipServices) ctx.inject?.([name], () => { mode.ownershipRequired = true })
  return async request => {
    const params = new URL(request.url).searchParams
    const sessionId = params.get('sessionId') ?? ''
    if (!/^session-[a-zA-Z0-9_-]{1,140}$/.test(sessionId)) return json({ error: 'Invalid session' }, 400)
    // Optional selected route: only chooses which subscription account reading a ledger-less session shows.
    const route = params.get('route') ?? undefined
    if (route !== undefined && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(route)) return json({ error: 'Invalid route' }, 400)
    try {
      const access = ctx.get('billingAccess') ?? ctx.get('sessionRequestAccess')
      if (access !== undefined || ctx.get('sessionOwners') !== undefined) mode.ownershipRequired = true
      if (access !== undefined) {
        if (typeof access.canRead !== 'function' || await access.canRead(request, sessionId) !== true) return json({ error: 'Billing unavailable' }, 403)
      } else if (mode.ownershipRequired) {
        // Attribution is not authorization. Multi-user compositions need a verified principal seam.
        return json({ error: 'Billing unavailable' }, 403)
      }
      return json(await ledger.snapshot(sessionId, route))
    } catch { return json({ error: 'Billing unavailable' }, 503) }
  }
}
export function apply(ctx, input) {
  const config = resolveConfig(input)
  // List prices come from DSH's model catalog (`pricing` on resolved model info); absent on older DSH.
  // Subscription usage comes from `ctx.llm.subscriptionUsage` (custom fork); absent on older DSH.
  const ledger = new BillingLedger({ ...config,
    pricing: async (provider, model) => (await ctx.llm.resolveModelInfo(provider, model)).pricing,
    usage: typeof ctx.llm?.subscriptionUsage === 'function' ? provider => ctx.llm.subscriptionUsage(provider) : undefined })
  ctx.effect(() => () => ledger.close(), 'billing-status: durable ledger')
  ctx.provide('billingStatus', {
    // Trusted in-process extension point; there is deliberately no HTTP ingestion endpoint.
    observe: observation => ledger.record(observation),
    snapshot: sessionId => ledger.snapshot(sessionId),
  })
  installCollector(ctx, observation => { void ledger.record(observation) })
  ctx.inject(['connection'], web => {
    web.effect(() => web.connection.fetch.register({ path: SNAPSHOT_PATH, methods: ['GET'], requestBody: 'buffered', fetch: snapshotHandler(web, ledger) }), 'billing-status: snapshot route')
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
