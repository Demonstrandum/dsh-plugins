import { describe } from './evidence.mjs'
import { installTransport } from './transport.mjs'

export const name = 'anthropic-oauth-audit'
export const inject = ['llm']

/** Deployment settings; only the dedicated OAuth route is audited by default. */
export function resolveConfig(config = {}) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new Error('anthropic-oauth-audit: config must be an object')
  const value = { providers: ['anthropic-oauth'], cliUserAgent: 'claude-cli/2.1.280',
    onUnverified: 'error', maxSessions: 256, ...config }
  if (!Array.isArray(value.providers) || !value.providers.length || value.providers.some(p => typeof p !== 'string' || !p)) {
    throw new Error('anthropic-oauth-audit: providers must be a nonempty list of route ids')
  }
  if (!/^claude-cli\/[0-9]+\.[0-9]+\.[0-9]+$/.test(value.cliUserAgent)) {
    throw new Error('anthropic-oauth-audit: cliUserAgent must be claude-cli/<major.minor.patch>')
  }
  if (!['warn', 'error'].includes(value.onUnverified)) throw new Error('anthropic-oauth-audit: onUnverified must be warn or error')
  if (!Number.isSafeInteger(value.maxSessions) || value.maxSessions < 1) throw new Error('anthropic-oauth-audit: maxSessions must be positive')
  const known = new Set(['providers', 'cliUserAgent', 'onUnverified', 'maxSessions'])
  if (Object.keys(config).some(key => !known.has(key))) throw new Error('anthropic-oauth-audit: unknown configuration key')
  return value
}

/** Dependency-free Standard Schema: Cordis validates this before activation. */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'tali-anthropic-oauth-audit',
    validate(input) {
      try { return { value: resolveConfig(input) } }
      catch (error) { return { issues: [{ message: error.message }] } }
    },
  },
}
/** Host-only plugin: audited streaming calls, redacted logs, and /oauth-audit. */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const providers = new Set(config.providers)
  const latest = new Map()
  let active = true
  const publish = (state, report) => {
    if (!active) return
    const key = state.sessionId
    const previous = key === undefined ? undefined : latest.get(key)
    const utilization = Number(report.evidence?.['overage-utilization'])
    const previousUtilization = previous?.overageUtilization
    const increased = Number.isFinite(utilization) && Number.isFinite(previousUtilization) && utilization > previousUtilization
    const entry = { ...report, provider: state.provider, model: state.model,
      at: new Date().toISOString(),
      ...(Number.isFinite(utilization) ? { overageUtilization: utilization } : {}),
      ...(increased ? { overageIncreased: true } : {}),
    }
    state.report = entry
    if (key !== undefined) {
      latest.delete(key)
      latest.set(key, entry)
      while (latest.size > config.maxSessions) latest.delete(latest.keys().next().value)
    }
    const warning = increased ? ' Account-wide extra-usage utilization increased; concurrent clients may be responsible.' : ''
    const line = `anthropic-oauth-audit: ${JSON.stringify({ sessionId: key, ...entry })} ${describe(entry)}${warning}`
    if (entry.outcome === 'plan-evidence' && !increased) ctx.logger.info(line)
    else ctx.logger.warn(line)
  }
  let transport
  ctx.effect(() => {
    transport = installTransport({ cliUserAgent: config.cliUserAgent, report: publish })
    return () => { active = false; transport.dispose(); latest.clear() }
  }, 'anthropic-oauth-audit: scoped fetch')

  ctx.on('llm/stream', (options, next) => {
    if (!providers.has(options.provider)) return transport.unscoped(next)
    return (async function* () {
      const state = { provider: options.provider, model: options.model, sessionId: options.sessionId }
      const iterator = transport.run(state, () => next()[Symbol.asyncIterator]())
      let done = false
      const failure = () => {
        const report = state.report
        if (report?.outcome === 'blocked' || (config.onUnverified === 'error'
          && report && ['extra-usage', 'unknown', 'unobserved'].includes(report.outcome))) {
          return { type: 'finish', reason: { kind: 'error', failure: {
            code: 'ANTHROPIC_OAUTH_AUDIT', message: `${describe(report)} Check /oauth-audit. This audit did not initiate an API-key fallback.`,
          } } }
        }
      }
      try {
        while (true) {
          let result
          try {
            result = await transport.run(state, () => iterator.next())
          } catch (error) {
            const blocked = active && failure()
            if (blocked) { yield blocked; return }
            throw error
          }
          done = result.done
          // pi-ai emits usage before finish even on auth/network/abort errors.
          // Wait for content or finish before deciding that a transport bypassed us.
          if (active && !state.report && result.value?.type !== 'usage') publish(state, { outcome: 'unobserved' })
          const terminalError = result.value?.type === 'finish' && ['error', 'aborted'].includes(result.value.reason.kind)
          // Keep native auth/network/cancellation errors when no response exists;
          // a pre-dispatch audit refusal still replaces the SDK's opaque wrapper.
          const rejected = active && (!terminalError || state.report?.outcome === 'blocked') && failure()
          if (rejected) { yield rejected; return }
          if (done) return
          yield result.value
          if (result.value.type === 'finish') return
        }
      } finally {
        if (!done) await transport.run(state, () => iterator.return?.())
        if (active && !state.report) publish(state, { outcome: 'unobserved' })
      }
    })()
  }, { global: true })

  ctx.inject(['commands'], (commandsCtx) => {
    commandsCtx.effect(() => commandsCtx.commands.register({
      name: 'oauth-audit',
      description: 'Show this session’s latest Anthropic OAuth request and routing evidence',
      handler: async ({ agent, rawInput }) => {
        if (rawInput.trim()) return { kind: 'error', text: 'Usage: /oauth-audit' }
        const report = latest.get(agent.session.id)
        if (!report) return { kind: 'error', text: 'No OAuth request observed for this session since plugin startup (or the retained report was evicted).' }
        const summary = `${report.at} · ${report.provider}/${report.model}\n${describe(report)}`
        const warning = report.overageIncreased ? '\nAccount-wide extra-usage utilization increased; this session may not be responsible.' : ''
        return { kind: report.outcome === 'plan-evidence' && !report.overageIncreased ? 'success' : 'error',
          text: `${summary}${warning}\n${JSON.stringify(report.evidence ?? report.request?.checks ?? {})}` }
      },
    }), 'anthropic-oauth-audit: status command')
  })
}
