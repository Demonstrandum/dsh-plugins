/**
 * tali-browser-automation — one browser per chat, started on demand.
 *
 * WHY A PLUGIN. DSH's generic MCP client (`@deepseek-ai/dsh-mcp-client`) is
 * normally configured in a profile's patch layer, which is the HOST
 * composition: one server process for the whole host, shared by every session.
 * Browser MCP servers keep per-connection state (Chrome's page list and
 * "selected page", Safari's tab list and "active tab"), so two concurrent chats
 * on one connection clobber each other. Agent presets do not help either: a
 * preset is a standing mount that sessions join, not a per-session instance.
 * The only per-session composition point the Web GUI offers is the agent
 * itself, so this plugin mounts the MCP client INTO THE AGENT'S OWN SCOPE
 * (`agent.ctx.plugin(McpClient, …)`) — the same move `dsh-acp` makes for
 * `session/new` `mcpServers`.
 *
 * WHY LAZY. Web sessions are never disposed by the session controller (a live
 * agent lives until the host exits) and continuable subagents stay resident, so
 * spawning servers eagerly on `agent/created` accumulates one `safaridriver`
 * and one `chrome-devtools-mcp` process per session for the host's lifetime.
 * Instead every eligible agent gets two tiny scoped tools:
 *
 *   browser_open  { browser: 'safari' | 'chrome' }  → mounts that server into
 *       the agent's scope and waits for tool discovery; the model sees
 *       `mcp__safari__*` / `mcp__chrome__*` on its next step.
 *   browser_close { browser?: … }                   → disposes the mount(s).
 *
 * An idle timer (reset on every `mcp__<server>__*` call by that agent) closes
 * a mount after `idleMinutes` and injects a notice so the model knows to call
 * `browser_open` again. Agent disposal unwinds everything with the scope.
 *
 * SERVERS.
 * - Safari: Apple's Safari MCP server, `safaridriver --mcp`, shipped with Safari
 *   Technology Preview 247+ / Safari 27 (stable Safari 26's driver has no
 *   `--mcp`). Requires STP running with Develop ▸ Developer Settings ▸ Allow
 *   Remote Automation. Every `--mcp` process is its own automation session;
 *   concurrent instances coexist. Model note: `evaluate_javascript` takes
 *   `expression` as a FUNCTION BODY — use `return`.
 * - Chrome: Google's `chrome-devtools-mcp` (npm). Always started with
 *   `--isolated` (a fresh temporary profile per instance, deleted on close),
 *   because Chrome refuses to share one user-data-dir between instances; logins
 *   therefore do not persist across sessions. Chrome itself only launches on the
 *   first navigation call.
 *
 * Config (all optional):
 *
 *   safari:
 *     enabled: true
 *     driver: /Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver
 *   chrome:
 *     enabled: true
 *     command: /opt/homebrew/bin/chrome-devtools-mcp   # absolute path; npm i -g chrome-devtools-mcp
 *     headless: false                                  # true = no visible window
 *     hideAutomationBanner: true                       # no "controlled by automated test software" bar
 *     args: []                                         # extra chrome-devtools-mcp flags
 *   subagents: true           # also offer browser_open to delegated child agents (each gets its own browser)
 *   idleMinutes: 30           # close a browser after this long without an mcp__ call (0 = never)
 *   toolCallTimeoutMs: 60000  # per MCP tool call
 *   traceFile: ''             # append JSON lifecycle lines here (debugging; '' = off)
 */

import { appendFileSync } from 'node:fs'
import Schema from '@deepseek-ai/schemastery'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'browser-automation'

export const inject = ['agents', 'tools']

export const Config = Schema.object({
  safari: Schema.object({
    enabled: Schema.boolean().default(true),
    driver: Schema.string().default('/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver'),
  }).default({}),
  chrome: Schema.object({
    enabled: Schema.boolean().default(true),
    command: Schema.string().default('/opt/homebrew/bin/chrome-devtools-mcp'),
    headless: Schema.boolean().default(false),
    // Drops Puppeteer's --enable-automation switch, which is what makes Chrome
    // show the "Chrome is being controlled by automated test software" bar.
    hideAutomationBanner: Schema.boolean().default(true),
    args: Schema.array(String).default([]),
  }).default({}),
  subagents: Schema.boolean().default(true),
  idleMinutes: Schema.number().min(0).default(30),
  toolCallTimeoutMs: Schema.number().default(60_000),
  traceFile: Schema.string().default(''),
})

const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'browser-automation' }

/** Model-facing guidance per server, appended to the browser_open result. */
const USAGE = {
  safari: 'Safari tools are now in your tool list as mcp__safari__* (navigate_to_url, get_page_content, evaluate_javascript, screenshot, list_tabs, page_interactions, …). This is a real Safari Technology Preview session: it runs JavaScript and can read pages web_fetch cannot (e.g. YouTube). evaluate_javascript takes `expression` as a FUNCTION BODY — use an explicit `return`. Prefer get_page_content over screenshots for reading.',
  chrome: 'Chrome tools are now in your tool list as mcp__chrome__* (new_page, navigate_page, take_snapshot, take_screenshot, evaluate_script, click, fill_form, list_network_requests, lighthouse_audit, …). This is an isolated Chrome profile (no saved logins). Chrome launches on your first navigation. For screenshots omit filePath so the image is returned inline.',
}

/**
 * Build the per-server MCP client configs (minus `cwd`, filled per agent).
 * @param {ReturnType<typeof Config>} config - validated plugin config.
 * @returns {Record<string, object>} server name → stdio config.
 */
export function resolveServers(config) {
  const servers = {}
  if (config.safari.enabled) {
    servers.safari = {
      transport: 'stdio',
      serverName: 'safari',
      command: config.safari.driver,
      args: ['--mcp'],
      toolCallTimeoutMs: config.toolCallTimeoutMs,
      // Surface a failed start to the model instead of a silent reconnect loop.
      failOnStartupError: true,
      reconnect: { enabled: false },
    }
  }
  if (config.chrome.enabled) {
    servers.chrome = {
      transport: 'stdio',
      serverName: 'chrome',
      command: config.chrome.command,
      args: [
        '--isolated',
        '--no-usage-statistics',
        ...(config.chrome.headless ? ['--headless'] : []),
        ...(config.chrome.hideAutomationBanner ? ['--ignoreDefaultChromeArg=--enable-automation'] : []),
        ...config.chrome.args,
      ],
      toolCallTimeoutMs: config.toolCallTimeoutMs,
      failOnStartupError: true,
      reconnect: { enabled: false },
    }
  }
  return servers
}

/** Human hint for the most common start failures. */
function startHint(browser, error) {
  const text = String(error?.cause ?? error)
  if (browser === 'safari') {
    return `Safari MCP server failed to start (${text}). Check that Safari Technology Preview is installed and running with Develop ▸ Developer Settings ▸ "Allow Remote Automation" enabled.`
  }
  return `Chrome MCP server failed to start (${text}). Check that chrome-devtools-mcp is installed at the configured path (npm i -g chrome-devtools-mcp) and Google Chrome is installed.`
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - host-plane plugin context.
 * @param {ReturnType<typeof Config>} config - validated plugin config.
 */
export function apply(ctx, config) {
  const servers = resolveServers(config)
  const available = Object.keys(servers)
  if (available.length === 0) {
    ctx.logger.warn('browser-automation: no browser enabled; plugin is inert')
    return
  }
  const trace = (record) => {
    if (config.traceFile === '') return
    try {
      appendFileSync(config.traceFile, `${JSON.stringify({ t: new Date().toISOString(), ...record })}\n`)
    } catch {
      // Trace is best-effort debugging output; a missing directory or
      // permission error must never affect the session.
    }
  }

  /** @type {Map<object, { mounts: Map<string, { dispose(): Promise<void> }>, timer?: ReturnType<typeof setTimeout> }>} */
  const states = new Map()

  const stateOf = (agent) => {
    let state = states.get(agent)
    if (state === undefined) {
      state = { mounts: new Map(), timer: undefined }
      states.set(agent, state)
    }
    return state
  }

  async function closeMounts(agent, browsers, reason) {
    const state = states.get(agent)
    if (state === undefined) return []
    const closed = []
    for (const browser of browsers) {
      const fiber = state.mounts.get(browser)
      if (fiber === undefined) continue
      state.mounts.delete(browser)
      closed.push(browser)
      try {
        await fiber.dispose()
      } catch (error) {
        ctx.logger.warn(`browser-automation: agent "${agent.id}" ${browser} dispose failed: ${String(error)}`)
      }
    }
    if (closed.length > 0) trace({ event: 'close', id: agent.id, browsers: closed, reason })
    if (state.mounts.size === 0) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
    return closed
  }

  function touch(agent) {
    const state = states.get(agent)
    if (state === undefined || state.mounts.size === 0 || config.idleMinutes === 0) return
    clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      const browsers = [...state.mounts.keys()]
      void closeMounts(agent, browsers, 'idle').then((closed) => {
        if (closed.length === 0) return
        try {
          agent.inject({
            content: `[browser-automation] Closed idle browser(s) ${closed.join(', ')} after ${config.idleMinutes} min without use; the mcp__ tools are gone. Call browser_open again if you need a browser.`,
            source: PLUGIN_SOURCE,
          })
        } catch {
          // The agent may be disposed or not accepting injections; the
          // browser is closed either way.
        }
      })
    }, config.idleMinutes * 60_000)
    state.timer.unref?.()
  }

  /** Mount one server into the agent's scope and wait for tool discovery. */
  async function open(agent, browser) {
    const state = stateOf(agent)
    if (state.mounts.has(browser)) {
      touch(agent)
      return `${browser} is already open in this session. ${USAGE[browser]}`
    }
    const cwd = agent.session.header?.cwd ?? process.cwd()
    const fiber = agent.ctx.plugin(McpClient, { ...servers[browser], cwd })
    try {
      await fiber
    } catch (error) {
      await fiber.dispose().catch(() => undefined)
      trace({ event: 'open-failed', id: agent.id, browser, error: String(error) })
      throw new Error(startHint(browser, error))
    }
    state.mounts.set(browser, fiber)
    touch(agent)
    const count = ctx.tools.schemas(agent).filter(schema => schema.name.startsWith(`mcp__${browser}__`)).length
    trace({ event: 'open', id: agent.id, browser, tools: count })
    const idle = config.idleMinutes === 0 ? '' : ` It closes automatically after ${config.idleMinutes} min without use.`
    return `${browser} is open for this session (${count} tools).${idle} ${USAGE[browser]}`
  }

  const browserParam = (required) => ({
    type: 'string',
    ...(required ? { required: true } : {}),
    enum: available,
    description: `Which browser: ${available.join(' | ')}.`,
  })

  /** Plugin-owned disposer of each attached agent's scoped tool registrations. */
  const attached = new Map()

  /**
   * Register browser_open / browser_close into one agent's scope. The
   * registrations are owned by BOTH lifetimes: they unwind with the agent's
   * scope, and this plugin's own effect removes them on plugin unload/reload
   * (effect disposers are idempotent, so whichever side goes first is fine).
   */
  function attach(agent) {
    if (attached.has(agent)) return
    const depth = agent.session.header?.delegationDepth ?? 0
    if (depth > 0 && !config.subagents) return
    const dispose = ctx.effect(() => {
      const disposers = [
        agent.ctx.tools.register(defineTool({
          name: 'browser_open',
          description: `Start a browser automation session private to this chat (${available.join(' or ')}). On success the browser's MCP tools appear in your tool list on your NEXT step as mcp__safari__* / mcp__chrome__*. Use a browser when a page needs JavaScript or a real browser (YouTube, SPAs, login walls, screenshots, DOM inspection, DevTools/network/performance, driving the DSH web GUI); web_fetch is cheaper for plain pages. Safari is a real Safari Technology Preview session with WebKit text extraction; Chrome is an isolated Chrome with the DevTools tool set (snapshots, screenshots, network, Lighthouse). Idempotent: calling it again for an open browser just returns the usage notes.`,
          parameters: { browser: browserParam(true) },
          output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
          },
          async execute(args, exec) {
            return open(exec.agent ?? agent, args.browser)
          },
        })),
        agent.ctx.tools.register(defineTool({
          name: 'browser_close',
          description: 'Close this chat\'s browser automation session(s) opened with browser_open, freeing the browser process; the matching mcp__ tools disappear from your tool list. Omit `browser` to close all. Call it when you are done browsing.',
          parameters: { browser: browserParam(false) },
          output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
          },
          async execute(args, exec) {
            const target = exec.agent ?? agent
            const browsers = args.browser === undefined ? available : [args.browser]
            const closed = await closeMounts(target, browsers, 'tool')
            return closed.length === 0 ? 'No browser was open.' : `Closed ${closed.join(', ')}.`
          },
        })),
      ]
      return () => { for (const dispose of disposers) dispose() }
    }, 'browser-automation.tools')
    attached.set(agent, dispose)
    trace({ event: 'attach', id: agent.id, depth })
  }

  // Agents that already exist when this plugin (re)loads, then every new one.
  for (const agent of ctx.agents.list()) attach(agent)
  ctx.on('agent/created', ({ agent }) => { attach(agent) })

  ctx.on('agent/disposed', ({ agent }) => {
    // The scope unwind already disposed the mounts and tool registrations;
    // release our wrapper effect and bookkeeping.
    const dispose = attached.get(agent)
    if (dispose !== undefined) {
      attached.delete(agent)
      void dispose()
    }
    const state = states.get(agent)
    if (state === undefined) return
    clearTimeout(state.timer)
    states.delete(agent)
    trace({ event: 'agent/disposed', id: agent.id, hadMounts: state.mounts.size })
  })

  // Any browser tool call by an agent counts as activity for its idle timer.
  ctx.on('tools/result', (exec) => {
    if (exec.agent === undefined || !exec.name.startsWith('mcp__')) return
    const state = states.get(exec.agent)
    if (state === undefined) return
    for (const browser of state.mounts.keys()) {
      if (exec.name.startsWith(`mcp__${browser}__`)) {
        touch(exec.agent)
        return
      }
    }
  })

  // Plugin unload: close every mount we own (agents outlive this plugin).
  ctx.effect(() => async () => {
    for (const [agent, state] of states) {
      clearTimeout(state.timer)
      await closeMounts(agent, [...state.mounts.keys()], 'unload')
    }
    states.clear()
  }, 'browser-automation.mounts')
}
