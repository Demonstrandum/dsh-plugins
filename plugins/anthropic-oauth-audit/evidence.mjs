/** Non-secret checks of Anthropic OAuth wire requests and rate-limit evidence. */
export const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."
export const OAUTH_BETAS = ['claude-code-20250219', 'oauth-2025-04-20']
const CANONICAL_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'AskUserQuestion',
  'EnterPlanMode', 'ExitPlanMode', 'KillShell', 'NotebookEdit', 'Skill', 'Task', 'TaskOutput',
  'TodoWrite', 'WebFetch', 'WebSearch']
const TOOL_NAMES = new Map(CANONICAL_TOOLS.map(name => [name.toLowerCase(), name]))
const PREFIX = 'anthropic-ratelimit-unified-'
const CLAIMS = new Set(['five_hour', 'seven_day'])
const HEADER_FIELDS = ['status', 'representative-claim', '5h-status', '7d-status',
  '5h-utilization', '7d-utilization', 'overage-status', 'overage-disabled-reason',
  'overage-utilization', 'fallback-percentage']

/** Inspect the serialized request without returning any prompt, credential, or tool text. */
export function inspectRequest(url, method, headers, body) {
  const checks = {
    endpoint: url.origin === 'https://api.anthropic.com' && url.pathname === '/v1/messages'
      && !url.username && !url.password,
    method: method.toUpperCase() === 'POST',
    oauthBearer: /^Bearer sk-ant-oat[^\s]*$/i.test(headers.get('authorization') ?? ''),
    noApiKey: !headers.has('x-api-key'),
    cliUserAgent: /^claude-cli\/[^\s]+(?:\s|$)/.test(headers.get('user-agent') ?? ''),
    cliApp: headers.get('x-app') === 'cli',
    oauthBetas: OAUTH_BETAS.every(beta => (headers.get('anthropic-beta') ?? '').split(',').map(x => x.trim()).includes(beta)),
    identity: false,
    toolCasing: false,
    jsonBody: false,
  }
  // Bound inspection work without copying or retaining large image payloads.
  if (typeof body === 'string' && Buffer.byteLength(body, 'utf8') <= 32 * 1024 * 1024) {
    try {
      const payload = JSON.parse(body)
      checks.jsonBody = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      checks.identity = Array.isArray(payload?.system) && payload.system[0]?.type === 'text'
        && payload.system[0]?.text === IDENTITY
      checks.toolCasing = payload?.tools === undefined || (Array.isArray(payload.tools) && payload.tools.every(tool =>
        typeof tool?.name === 'string' && (TOOL_NAMES.get(tool.name.toLowerCase()) ?? tool.name) === tool.name))
    } catch { /* Invalid or unsupported body: refuse rather than report a false pass. */ }
  }
  return { checks, failed: Object.keys(checks).filter(key => !checks[key]) }
}

/** Classify response headers as routing evidence, never as a billing receipt. */
export function responseEvidence(status, headers) {
  // Fixed allowlist; no cookies, auth, arbitrary header values, or response bodies.
  const evidence = {}
  for (const field of HEADER_FIELDS) {
    const value = headers.get(PREFIX + field)
    if (value === null) continue
    let recognized = false
    if (field.endsWith('status')) recognized = ['allowed', 'allowed_warning', 'rejected'].includes(value)
    else if (field === 'representative-claim') recognized = CLAIMS.has(value) || value === 'overage'
    else if (field === 'overage-disabled-reason') recognized = value === 'org_spend_cap_reached'
    else recognized = /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && value.length <= 24 && Number.isFinite(Number(value))
    evidence[field] = recognized ? value : '[unrecognized]'
  }
  const claim = evidence['representative-claim']
  let outcome = 'unknown'
  if (status < 200 || status >= 300) outcome = 'rejected'
  else if (claim === 'overage') outcome = 'extra-usage'
  else if (CLAIMS.has(claim) && ['allowed', 'allowed_warning'].includes(evidence.status)) outcome = 'plan-evidence'
  return { status, outcome, evidence }
}

/** Short operator-facing status. Absent headers and rejected calls do not imply API billing. */
export function describe(report) {
  switch (report.outcome) {
    case 'plan-evidence': return 'Anthropic reported a subscription plan claim; this is routing evidence, not a billing guarantee.'
    case 'extra-usage': return 'Anthropic reported extra usage (overage), not a subscription plan claim. Charges may apply.'
    case 'rejected': return `Anthropic rejected the request (HTTP ${report.status}); billing is not established.`
    case 'blocked': return `OAuth request blocked before dispatch: ${report.failed.join(', ')}.`
    case 'unobserved': return 'No Anthropic message response was observed; subscription billing is unverified.'
    default: return 'Anthropic subscription routing is unverified: missing, unfamiliar, or inconclusive response headers. This does not prove API billing.'
  }
}
