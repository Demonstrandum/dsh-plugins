const OAUTH = 'anthropic-oauth'
const STATUS = 'Response-header evidence · not billing receipts'
const LABELS = new Map([
  ['plan-evidence', 'subscription claim'], ['extra-usage', 'extra usage'],
  ['unknown', 'unknown'], ['rejected', 'rejected'], ['unobserved', 'unobserved'],
  ['blocked', 'blocked'],
])
const UTILIZATION = [['5h-utilization', '5h'], ['7d-utilization', '7d'], ['overage-utilization', 'overage']]

// Identifiers are not free-form text. Keep ordinary full session IDs, but never
// let control characters, Markdown, or pathological lengths create report rows.
function identifier(value) {
  if (typeof value !== 'string' || !value) return undefined
  if (/sk-(?:ant-|proj-|[a-z0-9]{20})|bearer\s|(?:api[-_]?key|token|password|secret)\s*[:=]/i.test(value)) return '[redacted]'
  const normalized = value.slice(0, 160).replace(/[^a-zA-Z0-9._:/@-]/g, '_')
  return normalized + (value.length > 160 ? '…' : '')
}

function configuration(agent) {
  try { return agent?.session?.requestHeader?.()?.config ?? {} }
  catch { return {} }
}

function percentage(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined
  if (typeof value === 'string' && (value.length > 24 || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))) return undefined
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0 || !Number.isFinite(number * 100)) return undefined
  return `${Number((number * 100).toFixed(1))}%`
}

function observedAt(at, now, staleAfterMs) {
  // Re-serialize validated dates rather than printing any raw timestamp text.
  const time = typeof at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(at) ? Date.parse(at) : NaN
  if (!Number.isFinite(time)) return 'time unknown'
  const stale = Number.isFinite(now) && now - time > staleAfterMs
  return `${new Date(time).toISOString()}${stale ? ' · stale' : ''}`
}

function row(id, report, config, currentId, now, staleAfterMs) {
  const cells = [`${identifier(id) ?? '[unknown session]'}${id === currentId ? ' (current)' : ''}`]
  cells.push(report ? (LABELS.get(report.outcome) ?? 'unknown') : 'unobserved')
  const provider = identifier(report ? report.provider : config?.provider)
  const model = identifier(report ? report.model : config?.model)
  const source = report ? 'last observed ' : ''
  if (provider) cells.push(`${source}provider=${provider}`)
  if (model) cells.push(`${source}model=${model}`)
  if (Number.isInteger(report?.status) && report.status >= 100 && report.status <= 599) cells.push(`HTTP ${report.status}`)
  cells.push(report ? observedAt(report.at, now, staleAfterMs) : 'no observation')
  for (const [key, label] of UTILIZATION) {
    const percent = percentage(report?.evidence?.[key])
    if (percent !== undefined) cells.push(`${label}=${percent}`)
  }
  if (report?.overageIncreased === true) cells.push('Warning: account-wide overage increased; this session may not be responsible')
  return cells.join(' · ')
}

/** Pure, allowlisted presentation of the last observation; never an invoice. */
export function billingResult({ latest = new Map(), agents, agent, rawInput = '', now = Date.now(), canSeeSession, staleAfterMs = 300_000 } = {}) {
  if (typeof rawInput !== 'string' || !['', 'current', 'recent'].includes(rawInput.trim())) {
    return { kind: 'error', text: 'Usage: /oauth-billing [current|recent]' }
  }
  const mode = rawInput.trim()
  const retained = latest instanceof Map ? latest : new Map()
  const currentId = typeof agent?.session?.id === 'string' && agent.session.id ? agent.session.id : undefined
  const currentConfig = configuration(agent)
  if (mode === 'current' && !currentId) return { kind: 'error', text: 'Current session unavailable.' }
  const relevant = (id, config) => config?.provider === OAUTH || retained.get(id)?.provider === OAUTH
  const selected = new Map()
  let scope
  if (mode === 'current') {
    scope = 'Current session'
    selected.set(currentId, currentConfig)
  } else {
    let loaded
    if (mode !== 'recent') {
      try {
        const result = agents?.list?.()
        if (Array.isArray(result)) loaded = result
      } catch { /* Registry unavailable: report retained scope, never claim active. */ }
    }
    scope = loaded ? 'Loaded sessions' : 'Retained sessions'
    if (currentId && relevant(currentId, currentConfig)) selected.set(currentId, currentConfig)
    if (loaded) {
      for (const candidate of loaded) {
        const id = candidate?.session?.id
        if (typeof id !== 'string' || !id || selected.has(id)) continue
        const config = configuration(candidate)
        if (relevant(id, config)) selected.set(id, config)
      }
    } else {
      for (const id of retained.keys()) {
        if (typeof id === 'string' && id && !selected.has(id)) selected.set(id, {})
      }
    }
  }
  const lines = [scope, STATUS]
  for (const [id, config] of selected) {
    if (canSeeSession !== undefined) {
      // An explicit visibility policy must positively authorize a row; never
      // stringify policy errors or ownership data into a command result.
      try { if (canSeeSession(id) !== true) continue }
      catch { continue }
    }
    lines.push(row(id, retained.get(id), config, currentId, now, staleAfterMs))
  }
  if (lines.length === 2) lines.push('No Anthropic OAuth sessions observed in this scope.')
  return { kind: 'success', text: lines.join('\n') }
}
