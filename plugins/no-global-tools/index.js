// no-global-tools — a preset row that hides every deployment-global tool from
// the agents composed under it. Host plugins register their tools globally
// (ctx.tools.register in the web profile), so a "no tools" preset that merely
// omits the in-tree tool groups still ships all of them — 62 schemas / 62 KB on
// a 4K-window on-device model, which then answers one token and stops with
// `length`. `ctx.tools.restrict` is the sanctioned per-agent-scope mask; an
// empty allow-list keeps nothing inherited, while rows registered inside the
// same preset (scoped tools) stay visible. Must be mounted from a preset
// (agent scope): restrict() refuses a context-global call by design.
export const name = 'no-global-tools'
export const inject = ['tools']
export function apply(ctx) {
  ctx.tools.restrict({ allow: [] })
}
