/**
 * tali-browser-automation — per-chat Safari and Chrome, curated tools only.
 *
 * The plugin owns the MCP forwarding: it holds private MCP SDK connections to
 * Apple's Safari MCP server (`safaridriver --mcp`, Safari Technology Preview)
 * and Google's `chrome-devtools-mcp`, and registers exactly the tools in
 * curated-tools.mjs (`mcp__safari__*`, `mcp__chrome__*`) into each eligible agent's scope.
 * Nothing else reaches the model: no `mcp__server__tool` names, no raw tools,
 * no dsh-mcp-client. Per-session behavior needs no dynamic registration — the
 * tool set is static and every call reads `exec.agent` to find the caller's
 * windows (windows.mjs).
 *
 * WINDOWS. `mcp__safari__open` / `mcp__chrome__open` return ids like `s:0:2` / `c:0:0`
 * (session index, then window index within that session). Every window tool
 * takes an optional `windowId`; omitted, the browser must have zero or one
 * window in the session (zero opens one). A Safari window is its own
 * `safaridriver --mcp` process (own STP window, banner labeled with the chat
 * and the id); Chrome windows are pages of one isolated Chrome instance per
 * session. Ids are validated against the caller's session.
 *
 * LIFECYCLE. Nothing is spawned until a tool needs it. A per-session idle timer
 * (`idleMinutes`, reset by every tool call) closes all of a session's windows
 * and injects a notice; agent disposal and plugin unload close everything.
 * Web sessions are never disposed by DSH itself, hence the timer.
 *
 * READERS. `mcp__safari__get_page_content` with a url (and no windowId) and
 * `mcp__safari__get_youtube_notes` read in a host-wide pool of isolated Safari
 * readers (reader-pool.mjs), never in a chat's own window.
 *
 * Config (all optional):
 *
 *   safari:
 *     enabled: true
 *     driver: /Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver
 *     labelPrefix: 'DSH: '    # STP banner: "This window is controlled by DSH: <chat title> · s:0:0."
 *     reader:                 # isolated reader pool
 *       enabled: true
 *       maxIdle: 1            # readers kept warm after a read
 *       idleMinutes: 30       # close warm readers after this long unused (0 = never)
 *       maxChars: 120000      # truncate returned page content beyond this (full text saved to a file)
 *   chrome:
 *     enabled: true
 *     command: /opt/homebrew/bin/chrome-devtools-mcp   # npm i -g chrome-devtools-mcp
 *     headless: false
 *     hideAutomationBanner: true                       # drop --enable-automation (no infobar)
 *     args: []                                         # extra chrome-devtools-mcp flags
 *   subagents: true           # also give delegated child agents the tools (each its own session)
 *   idleMinutes: 30           # close a session's windows after this long without a tool call (0 = never)
 *   toolCallTimeoutMs: 60000  # per MCP call
 *   traceFile: ''             # append JSON lifecycle lines here (debugging; '' = off)
 */

import { appendFileSync, existsSync } from 'node:fs'
import Schema from '@deepseek-ai/schemastery'
import { createTools } from './curated-tools.mjs'
import { createReaderPool } from './reader-pool.mjs'
import { safariInstance } from './servers.mjs'
import { BrowserSessions } from './windows.mjs'

export const name = 'browser-automation'

export const inject = ['agents', 'tools']

export const Config = Schema.object({
  safari: Schema.object({
    enabled: Schema.boolean().default(true),
    driver: Schema.string().default('/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver'),
    labelPrefix: Schema.string().default('DSH: '),
    reader: Schema.object({
      enabled: Schema.boolean().default(true),
      maxIdle: Schema.number().min(0).default(1),
      idleMinutes: Schema.number().min(0).default(30),
      maxChars: Schema.number().min(1000).default(120_000),
    }).default({}),
  }).default({}),
  chrome: Schema.object({
    enabled: Schema.boolean().default(true),
    command: Schema.string().default('/opt/homebrew/bin/chrome-devtools-mcp'),
    headless: Schema.boolean().default(false),
    hideAutomationBanner: Schema.boolean().default(true),
    args: Schema.array(String).default([]),
  }).default({}),
  subagents: Schema.boolean().default(true),
  idleMinutes: Schema.number().min(0).default(30),
  toolCallTimeoutMs: Schema.number().default(60_000),
  traceFile: Schema.string().default(''),
})

const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'browser-automation' }

/** Chrome server arguments derived from config (always an isolated profile). */
export function chromeArgs(config) {
  return [
    '--isolated',
    '--no-usage-statistics',
    ...(config.chrome.headless ? ['--headless'] : []),
    ...(config.chrome.hideAutomationBanner ? ['--ignoreDefaultChromeArg=--enable-automation'] : []),
    ...config.chrome.args,
  ]
}

/**
 * Reject before spawning when a server executable is absent, with the exact
 * remedy. Classic Safari cannot substitute for STP: stable Safari's
 * /usr/bin/safaridriver has no --mcp mode, so there is no server to fall back to.
 */
export function preflightFor(config) {
  return (browser) => {
    if (browser === 'safari') {
      if (!config.safari.enabled) throw new Error('Safari automation is disabled in this deployment (safari.enabled=false).')
      if (!existsSync(config.safari.driver)) {
        throw new Error(`Safari automation is unavailable: no safaridriver at "${config.safari.driver}". Safari tools (including screenshots) require Safari Technology Preview 247+ (https://developer.apple.com/safari/technology-preview/) with Develop ▸ Developer Settings ▸ "Allow Remote Automation"; the stable Safari driver has no --mcp mode, so classic Safari cannot be used instead. Use the mcp__chrome__* tools if a browser is still needed.`)
      }
      return
    }
    if (!config.chrome.enabled) throw new Error('Chrome automation is disabled in this deployment (chrome.enabled=false).')
    if (!existsSync(config.chrome.command)) {
      throw new Error(`Chrome automation is unavailable: no chrome-devtools-mcp at "${config.chrome.command}". Install it with \`npm i -g chrome-devtools-mcp\` (and Google Chrome), or use the mcp__safari__* tools.`)
    }
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - host-plane plugin context.
 * @param {ReturnType<typeof Config>} config - validated plugin config.
 */
export function apply(ctx, config) {
  if (!config.safari.enabled && !config.chrome.enabled) {
    ctx.logger.warn('browser-automation: no browser enabled; plugin is inert')
    return
  }
  const trace = (record) => {
    if (config.traceFile === '') return
    try {
      appendFileSync(config.traceFile, `${JSON.stringify({ t: new Date().toISOString(), ...record })}\n`)
    } catch {
      // Best-effort debugging output; never affects the session.
    }
  }
  const preflight = preflightFor(config)

  /** Banner label for one chat: prefix + session title (when logged) or short id. */
  function chatLabel(agent) {
    let title
    try {
      title = ctx.get('sessionProjections')?.stateOf(agent.session, 'title')
    } catch {
      // Projection absent for this session shape; fall back to the id.
    }
    const text = typeof title === 'string' && title.trim() !== '' ? title.trim() : `chat ${agent.id.slice(-8)}`
    return `${config.safari.labelPrefix}${text}`.replace(/\s+/g, ' ').slice(0, 70)
  }

  const sessions = new BrowserSessions({
    safariSpec: (session, windowIndex) => ({
      command: config.safari.driver,
      args: ['--mcp'],
      clientName: `${chatLabel(session.agent)} · s:${session.index}:${windowIndex}`,
      cwd: session.agent.session.header?.cwd,
    }),
    chromeSpec: (session) => ({
      command: config.chrome.command,
      args: chromeArgs(config),
      clientName: `${chatLabel(session.agent)} · c:${session.index}`,
      cwd: session.agent.session.header?.cwd,
    }),
    timeoutMs: config.toolCallTimeoutMs,
    idleMs: config.idleMinutes * 60_000,
    onIdleClose: (agent, closed) => {
      try {
        agent.inject({
          content: `[browser-automation] Closed idle browser window(s) ${closed.join(', ')} after ${config.idleMinutes} min without use. Any mcp__safari__*/mcp__chrome__* call opens a fresh window.`,
          source: PLUGIN_SOURCE,
        })
      } catch {
        // The agent may be disposed or not accepting injections; the windows are closed either way.
      }
    },
    trace,
    logger: ctx.logger,
  })

  const readerPool = config.safari.enabled && config.safari.reader.enabled
    ? createReaderPool({
      driver: config.safari.driver,
      labelPrefix: config.safari.labelPrefix,
      maxIdle: config.safari.reader.maxIdle,
      idleMs: config.safari.reader.idleMinutes * 60_000,
      readTimeoutMs: config.toolCallTimeoutMs,
      trace,
      logger: ctx.logger,
    })
    : undefined

  /** Same admission rule as dsh-mcp-client: store the image only when the current model declares image input. */
  async function admitImage(exec, bytes, name, mediaType = 'image/png') {
    const attachments = ctx.get('attachments')
    if (attachments === undefined) return { reason: 'no attachment store is mounted' }
    const routed = exec.agent?.session.requestHeader?.()?.config
    const provider = routed?.provider ?? exec.agent?.options?.provider
    const model = routed?.model ?? exec.agent?.options?.model
    const llm = ctx.get('llm')
    if (provider === undefined || model === undefined || llm === undefined) return { reason: 'the current model route could not be resolved' }
    let info
    try { info = await llm.resolveModelInfo(provider, model, exec.signal) } catch { return { reason: 'the current model route could not be verified' } }
    if (!info.inputModalities?.includes('image')) return { reason: `model "${model}" does not declare image input` }
    const [ref] = await attachments.saveImages([{ data: bytes, mediaType, name }])
    return { ref }
  }

  /** Admitted inline screenshots awaiting finalizeContent, keyed by execution. */
  const inlineImages = new WeakMap()
  const deps = { sessions, readerPool, admitImage, inlineImages, preflight, limits: { maxChars: config.safari.reader.maxChars } }

  /** Plugin-owned disposer of each attached agent's scoped tool registrations. */
  const attached = new Map()

  /**
   * Register the curated tools into one agent's scope. Owned by BOTH lifetimes:
   * they unwind with the agent's scope, and this plugin's effect removes them
   * on unload/reload (effect disposers are idempotent).
   */
  function attach(agent) {
    if (attached.has(agent)) return
    const depth = agent.session.header?.delegationDepth ?? 0
    if (depth > 0 && !config.subagents) return
    const dispose = ctx.effect(() => {
      const disposers = createTools(deps, agent)
        .filter(tool => (tool.name.startsWith('mcp__safari__') ? config.safari.enabled : config.chrome.enabled))
        .map(tool => agent.ctx.tools.register(tool))
      return () => { for (const dispose of disposers) dispose() }
    }, 'browser-automation.tools')
    attached.set(agent, dispose)
    trace({ event: 'attach', id: agent.id, depth })
  }

  for (const agent of ctx.agents.list()) attach(agent)
  ctx.on('agent/created', ({ agent }) => { attach(agent) })

  ctx.on('agent/disposed', ({ agent }) => {
    const dispose = attached.get(agent)
    if (dispose !== undefined) {
      attached.delete(agent)
      void dispose()
    }
    void sessions.forget(agent, 'agent-disposed').catch((error) => {
      ctx.logger.warn(`browser-automation: closing windows of disposed agent "${agent.id}" failed: ${String(error)}`)
    })
  })

  // Plugin unload: every session's windows and the reader pool.
  ctx.effect(() => async () => {
    await sessions.dispose()
    await readerPool?.dispose()
    await safariInstance.dispose()
  }, 'browser-automation.mounts')
}
