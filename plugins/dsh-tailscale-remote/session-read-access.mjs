import { randomBytes } from 'node:crypto'

// A capability crosses the Node -> Fetch conversion, not a client-supplied identity.
export const READ_GRANT_HEADER = 'x-dsh-session-read-grant'
// Optional protocol marker shared with billing, without a package/runtime dependency.
export function markSessionReadPolicy(root) {
  const modes = globalThis[Symbol.for('tali-billing-status.access-modes.v1')] ??= new WeakMap()
  const mode = modes.get(root) ?? { ownershipRequired: false }
  mode.ownershipRequired = true
  modes.set(root, mode)
}
const TARGET = '/api/billing-status/snapshot'
function target(method, url) {
  if (method !== 'GET' || typeof url !== 'string' || url.length > 2048) return undefined
  try {
    const parsed = new URL(url, 'http://dsh.invalid')
    if (parsed.pathname !== TARGET) return undefined
    const ids = parsed.searchParams.getAll('sessionId'), routes = parsed.searchParams.getAll('route')
    const keys = [...parsed.searchParams.keys()]
    // Exactly one sessionId, at most one route hint, nothing else; the grant binds the full query.
    if (keys.some(key => key !== 'sessionId' && key !== 'route') || ids.length !== 1 || routes.length > 1
      || !/^session-[a-zA-Z0-9_-]{1,140}$/.test(ids[0]) || (routes.length === 1 && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(routes[0]))) return undefined
    return { sessionId: ids[0], path: parsed.pathname + parsed.search }
  } catch { return undefined }
}
function login(value) {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\x00-\x20\x7f]/.test(value) || ['local','token'].includes(value.toLowerCase())) return undefined
  return value.toLowerCase()
}
const isLoopback = address => ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address)

/** Narrow, expiring, one-use request grants. Never changes DSH's session-access policy. */
export function createSessionReadAccess({ lookupOwner, selfLogin, requestRejection, now = Date.now, maxGrants = 4096, ttlMs = 15000 }) {
  const grants = new Map()
  let disposed = false
  const issue = (method, url, principal) => {
    const identity = login(principal), route = target(method, url)
    if (disposed || !identity || !route) return {}
    const at = now()
    for (const [key, grant] of grants) if (grant.expires <= at) grants.delete(key)
    // Bound memory without granting access based on eviction or a guessed identity.
    if (grants.size >= maxGrants) return {}
    const token = randomBytes(32).toString('base64url')
    grants.set(token, { ...route, login: identity, expires: at + ttlMs })
    return { [READ_GRANT_HEADER]: token }
  }
  return {
    /** Called only by the proxy AFTER its identity/origin admission, never by a browser. */
    proxyHeaders(request, admitted) {
      return admitted?.kind === 'user' ? issue(request.method ?? 'GET', request.url, admitted.login) : {}
    },
    /** Prepend on the host Node server; a direct authenticated local caller is the host user.
     * Forwarded callers must carry a grant minted by the admitting proxy instead.
     */
    localRequest(request) {
      if (disposed || !target(request.method, request.url)) return
      const proxied = request.headers['x-dsh-tailscale-remote'] === '1'
      if (proxied) return // do not replace a proxy grant with the host's own identity
      delete request.headers[READ_GRANT_HEADER]
      if (!isLoopback(request.socket?.remoteAddress)) return
      if (Object.keys(request.headers).some(key => /^(?:x-forwarded-|forwarded$|tailscale-)/i.test(key))) return
      try {
        if (requestRejection(request) !== undefined) return
        Object.assign(request.headers, issue(request.method, request.url, selfLogin()))
      } catch { /* unavailable authentication never mints a grant or breaks the HTTP server */ }
    },
    async canRead(request, sessionId) {
      if (disposed) return false
      const token = request.headers.get(READ_GRANT_HEADER)
      if (!token || token.length !== 43) return false
      const grant = grants.get(token)
      grants.delete(token) // successful and failed reads both consume the grant
      const route = target(request.method, request.url)
      if (!grant || !route || grant.expires <= now() || route.sessionId !== sessionId || route.path !== grant.path) return false
      // This node's own Tailscale identity is the machine operator, who can already read the
      // DSH home on disk; it may read every session. Unknown/tagged self identity grants nothing.
      let operator
      try { operator = login(selfLogin()) } catch { operator = undefined }
      if (operator !== undefined && grant.login === operator) return true
      // Anyone else needs an explicit operator-provided session -> login binding.
      // Legacy attribution records, including first-driving-method labels, are NOT accepted.
      return login(lookupOwner(sessionId)) === grant.login
    },
    dispose() { disposed = true; grants.clear() },
  }
}
