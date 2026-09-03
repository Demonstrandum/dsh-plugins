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
 *   safari_get_screenshot { querySelector?, scrollTo?, fullPage? } → inline
 *       image of this chat's Safari page (or of one element: scroll into view,
 *       wait to settle, measure, capture, re-measure, crop). Auto-opens Safari.
 *   safari_save_screenshot { path, … }              → same, written to disk.
 *   safari_get_youtube_notes { url }                 → title/author/chapters/
 *       description (show notes) of a YouTube video via an isolated reader.
 *   safari_get_page_content { url, format?, … }      → reads a page in an
 *       ISOLATED reader (see reader-pool.mjs): never the chat's own browsing
 *       session, so a page the agent is working on is never changed under it.
 *       Readers are pooled host-wide: first read spawns one; concurrent reads
 *       (e.g. subagents) each get their own; one stays warm afterwards.
 *
 * An idle timer (reset on every `mcp__<server>__*` call by that agent) closes
 * a mount after `idleMinutes` and injects a notice so the model knows to call
 * `browser_open` again. Agent disposal unwinds everything with the scope.
 *
 * SERVERS.
 * - Safari: Apple's Safari MCP server, `safaridriver --mcp`, shipped with Safari
 *   Technology Preview 247+ / Safari 27 (stable Safari 26's driver has no
 *   `--mcp`). Requires STP running with Develop ▸ Developer Settings ▸ Allow
 *   Remote Automation. Every `--mcp` process is its own automation session
 *   with its OWN STP WINDOW (all opened at the same screen position, so they
 *   stack); tabs and "active tab" are per session; the window closes when the
 *   session ends cleanly (stdin EOF — the driver exits in ~20 ms, inside the
 *   MCP SDK's 2 s grace before SIGTERM, which would leak the window). The first
 *   session launches STP if needed; STP quits when the last session ends. The
 *   banner names the session's MCP clientInfo.name, which the shim sets per
 *   chat. Model note: `evaluate_javascript` takes `expression` as a FUNCTION
 *   BODY — use `return`.
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
 *     labelWindows: true       # banner "This window is controlled by DSH: <chat title>."
 *     labelPrefix: 'DSH: '
 *     reader:                  # safari_get_page_content's isolated reader pool
 *       enabled: true
 *       maxIdle: 1             # readers kept warm after a read
 *       idleMinutes: 30        # close warm readers after this long unused (0 = never)
 *       maxChars: 120000       # truncate returned content beyond this (full text saved to a file)
 *   chrome:
 *     enabled: true
 *     command: /opt/homebrew/bin/chrome-devtools-mcp   # absolute path; npm i -g chrome-devtools-mcp
 *     headless: false                                  # true = no visible window
 *     hideAutomationBanner: true                       # no "controlled by automated test software" bar
 *     disableCategories: [performance, emulation]      # drop chrome-devtools-mcp tool categories
 *     args: []                                         # extra chrome-devtools-mcp flags
 *   subagents: true           # also offer browser_open to delegated child agents (each gets its own browser)
 *   idleMinutes: 30           # close a browser after this long without an mcp__ call (0 = never)
 *   toolCallTimeoutMs: 60000  # per MCP tool call
 *   traceFile: ''             # append JSON lifecycle lines here (debugging; '' = off)
 */

import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createReaderPool, FORMATS } from './reader-pool.mjs'
import { canonicalWatchUrl, EXTRACT_SCRIPT, renderNotes, shapeNotes } from './youtube-notes.mjs'
import { cropBox, cropImage, imageSize, measureScript, parseMeasurement, readPng, rectMoved } from './safari-screenshot.mjs'

export const name = 'browser-automation'

export const inject = ['agents', 'tools']

export const Config = Schema.object({
  safari: Schema.object({
    enabled: Schema.boolean().default(true),
    driver: Schema.string().default('/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver'),
    // Label each chat's STP window banner ("This window is controlled by
    // <label>.") via safari-mcp-shim.mjs, which rewrites the MCP handshake's
    // clientInfo.name; false connects the driver directly (banner says
    // "dsh-mcp-client").
    labelWindows: Schema.boolean().default(true),
    labelPrefix: Schema.string().default('DSH: '),
    // safari_get_page_content: isolated page readers (own STP windows), pooled
    // host-wide. `maxIdle` readers stay warm after use; all are closed after
    // `idleMinutes` without a read (0 = never).
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
    // Drops Puppeteer's --enable-automation switch, which is what makes Chrome
    // show the "Chrome is being controlled by automated test software" bar.
    hideAutomationBanner: Schema.boolean().default(true),
    // chrome-devtools-mcp tool categories to leave out (--no-category-<name>):
    // performance | emulation | network | pwa | extensions. Fewer tools = fewer
    // schema tokens per request.
    disableCategories: Schema.array(String).default(['performance', 'emulation']),
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
  safari: 'Safari tools are now in your tool list as mcp__safari__* (navigate_to_url, get_page_content, evaluate_javascript, screenshot, list_tabs, page_interactions, …). This is a real Safari Technology Preview session in its own STP window, opened in the background and labeled with this chat in its banner (never the user\'s regular Safari): it runs JavaScript and can read pages web_fetch cannot (e.g. YouTube). evaluate_javascript takes `expression` as a FUNCTION BODY — use an explicit `return`. Prefer get_page_content over screenshots for reading. For screenshots use safari_get_screenshot (inline image, optional querySelector crop) or safari_save_screenshot rather than the raw mcp__safari__screenshot (whole viewport, file path only).',
  chrome: 'Chrome tools are now in your tool list as mcp__chrome__* (new_page, navigate_page, take_snapshot, take_screenshot, evaluate_script, click, fill_form, list_network_requests, lighthouse_audit, …). This is an isolated Chrome profile (no saved logins). Chrome launches on your first navigation. For screenshots omit filePath so the image is returned inline.',
}

/**
 * Build the per-server MCP client configs (minus `cwd`, filled per agent).
 * @param {ReturnType<typeof Config>} config - validated plugin config.
 * @returns {Record<string, object>} server name → stdio config.
 */
const SHIM = fileURLToPath(new URL('./safari-mcp-shim.mjs', import.meta.url))

export function resolveServers(config) {
  const servers = {}
  if (config.safari.enabled) {
    servers.safari = {
      transport: 'stdio',
      serverName: 'safari',
      // `command`/`args` here are the bare driver; `open()` wraps them in the
      // shim with the per-chat label when labelWindows is on. `preflight`
      // checks the driver path either way.
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
        ...config.chrome.disableCategories.map(category => `--no-category-${category}`),
        ...config.chrome.args,
      ],
      toolCallTimeoutMs: config.toolCallTimeoutMs,
      failOnStartupError: true,
      reconnect: { enabled: false },
    }
  }
  return servers
}

/**
 * Reject before spawning when the server executable is absent, with the exact
 * remedy. Classic Safari cannot substitute for STP: stable Safari's
 * /usr/bin/safaridriver has no --mcp mode, so there is no server to fall back to.
 */
function preflight(browser, server) {
  if (existsSync(server.command)) return
  if (browser === 'safari') {
    throw new Error(`Safari automation is unavailable: no safaridriver at "${server.command}". Safari MCP (including screenshots) requires Safari Technology Preview 247+ (https://developer.apple.com/safari/technology-preview/); the stable Safari driver has no --mcp mode, so classic Safari cannot be used instead. Use browser_open with "chrome" if a browser is still needed.`)
  }
  throw new Error(`Chrome automation is unavailable: no chrome-devtools-mcp at "${server.command}". Install it with \`npm i -g chrome-devtools-mcp\` (and Google Chrome), or use browser_open with "safari".`)
}

/** Truncate a reader result to maxChars, saving the full text to a temp file when cut. */
function clampRead(result, maxChars) {
  if (result.content.length <= maxChars) return result
  const file = join(tmpdir(), `dsh-safari-read-${Date.now()}-${process.pid}.${result.format === 'html' ? 'html' : result.format === 'json' ? 'json' : 'txt'}`)
  writeFileSync(file, result.content)
  return { ...result, content: result.content.slice(0, maxChars), truncated: true, totalChars: result.content.length, fullTextPath: file }
}

/** Model-facing text for a safari_get_page_content result. */
function renderRead(value) {
  const head = [
    value.title !== undefined ? `Title: ${value.title}` : undefined,
    `URL: ${value.url ?? ''}`,
    `Format: ${value.format}`,
    value.truncated ? `NOTE: content truncated to ${value.content.length} of ${value.totalChars} chars; full text saved to ${value.fullTextPath} (use read).` : undefined,
  ].filter(Boolean).join('\n')
  const script = 'scriptResult' in value ? `\n\n--- scriptResult ---\n${typeof value.scriptResult === 'string' ? value.scriptResult : JSON.stringify(value.scriptResult, null, 1)}` : ''
  return `${head}\n\n${value.content}${script}`
}

/** Human hint for the most common start failures. */
function startHint(browser, error) {
  const text = String(error?.cause ?? error)
  if (browser === 'safari') {
    return `Safari MCP server failed to start (${text}). Safari Technology Preview is installed but did not accept the automation session: enable Develop ▸ Developer Settings ▸ "Allow Remote Automation" in STP, then retry. Classic Safari cannot be used instead (its driver has no --mcp mode).`
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

  const readerPool = config.safari.enabled && config.safari.reader.enabled
    ? createReaderPool({
      driver: config.safari.driver,
      shim: SHIM,
      labelPrefix: config.safari.labelPrefix,
      maxIdle: config.safari.reader.maxIdle,
      idleMs: config.safari.reader.idleMinutes * 60_000,
      readTimeoutMs: config.toolCallTimeoutMs,
      trace,
      logger: ctx.logger,
    })
    : undefined

  /** @type {Map<object, { mounts: Map<string, { dispose(): Promise<void> }>, timer?: ReturnType<typeof setTimeout> }>} */
  const states = new Map()
  /** Admitted inline screenshots awaiting finalizeContent, keyed by execution. */
  const inlineImages = new WeakMap()

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

  /** Banner label for one chat: prefix + session title (when logged) or short id. */
  function windowLabel(agent) {
    let title
    try {
      title = ctx.get('sessionProjections')?.stateOf(agent.session, 'title')
    } catch {
      // Projection absent for this session shape; fall back to the id.
    }
    const text = typeof title === 'string' && title.trim() !== '' ? title.trim() : `chat ${agent.id.slice(-8)}`
    return `${config.safari.labelPrefix}${text}`.replace(/\s+/g, ' ').slice(0, 80)
  }

  /** Mount one server into the agent's scope and wait for tool discovery. */
  async function open(agent, browser) {
    const state = stateOf(agent)
    if (state.mounts.has(browser)) {
      touch(agent)
      return `${browser} is already open in this session. ${USAGE[browser]}`
    }
    preflight(browser, servers[browser])
    const cwd = agent.session.header?.cwd ?? process.cwd()
    let row = { ...servers[browser], cwd }
    if (browser === 'safari' && config.safari.labelWindows) {
      row = {
        ...row,
        command: process.execPath,
        args: [SHIM, '--name', windowLabel(agent), '--', servers.safari.command, ...servers.safari.args],
      }
    }
    const fiber = agent.ctx.plugin(McpClient, row)
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

  /**
   * Dispatch one MCP tool of the agent's mounted server as a NESTED execution
   * of the composite tool: same root call, this call as parent, same agent and
   * cancellation — the pattern run_code uses for its sub-calls. Returns the
   * result's text.
   */
  let nestedCalls = 0
  async function nested(exec, name, args) {
    const result = await ctx.tools.execute({
      callId: `${String(exec.callId)}:ba:${++nestedCalls}`,
      rootCallId: exec.rootCallId,
      name,
      arguments: args,
      ...(exec.agent ? { agent: exec.agent } : {}),
      parent: exec.token,
      signal: exec.signal,
    })
    const blocks = (result.value && typeof result.value === 'object' && Array.isArray(result.value.content))
      ? result.value.content
      : (result.content ?? [])
    const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('\n')
    if (result.isError) throw new Error(`${name}: ${text || 'failed'}`)
    return text
  }

  /**
   * Take a screenshot of the agent's Safari page; with `querySelector`, crop to
   * that element. Returns PNG bytes plus geometry; `viewportPath` is the
   * uncropped capture file.
   */
  async function captureSafari(agent, exec, { querySelector, scrollTo, fullPage }) {
    await open(agent, 'safari')
    const viewportPath = join(tmpdir(), `dsh-safari-shot-${Date.now()}-${process.pid}-${++nestedCalls}.png`)
    if (querySelector === undefined || querySelector === '') {
      await nested(exec, 'mcp__safari__screenshot', { savePath: viewportPath, full_page: fullPage === true })
      const size = await imageSize(viewportPath)
      return { bytes: await readPng(viewportPath), width: size.width, height: size.height, fullPage: fullPage === true, viewportPath }
    }
    const measure = async (scroll) => parseMeasurement(await nested(exec, 'mcp__safari__evaluate_javascript', { expression: measureScript(querySelector, scroll) }))
    const before = await measure(scrollTo !== false)
    await nested(exec, 'mcp__safari__screenshot', { savePath: viewportPath })
    let after = await measure(false)
    let unstable = false
    if (rectMoved(before.rect, after.rect)) {
      // The element moved between measurement and capture (animation, lazy
      // layout): retake once against the new position.
      await nested(exec, 'mcp__safari__screenshot', { savePath: viewportPath })
      const again = await measure(false)
      unstable = rectMoved(after.rect, again.rect)
      after = again
    }
    const size = await imageSize(viewportPath)
    const box = cropBox(after.rect, after.viewport, size)
    return {
      bytes: await cropImage(viewportPath, box),
      width: box.width,
      height: box.height,
      querySelector,
      rect: { x: Math.round(after.rect.x), y: Math.round(after.rect.y), width: Math.round(after.rect.width), height: Math.round(after.rect.height) },
      viewport: after.viewport,
      scale: Number(box.scale.toFixed(3)),
      clipped: box.clipped,
      settled: before.settled,
      unstable,
      viewportPath,
    }
  }

  /** Same admission rule as dsh-mcp-client: store the image only when the current model declares image input. */
  async function admitImage(exec, bytes, name) {
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
    const [ref] = await attachments.saveImages([{ data: bytes, mediaType: 'image/png', name }])
    return { ref }
  }

  /** Text summary of a capture's geometry. */
  function describeCapture(shot) {
    const parts = [`${shot.width}×${shot.height} px`]
    if (shot.querySelector !== undefined) {
      parts.push(`element ${JSON.stringify(shot.querySelector)} at CSS rect x=${shot.rect.x} y=${shot.rect.y} ${shot.rect.width}×${shot.rect.height} (viewport ${shot.viewport.width}×${shot.viewport.height}, scale ${shot.scale})`)
      if (shot.clipped) parts.push('NOTE: element extends beyond the viewport; crop is clipped to the visible part')
      if (shot.unstable) parts.push('NOTE: element kept moving during capture; crop may be off')
      if (!shot.settled) parts.push('NOTE: scrolling had not fully settled before capture')
    } else if (shot.fullPage) parts.push('full page')
    else parts.push('viewport')
    return parts.join('; ')
  }

  const screenshotParams = {
    querySelector: { type: 'string', description: 'CSS selector of one element to capture (document.querySelector). Omit for the whole viewport.' },
    scrollTo: { type: 'boolean', description: 'With querySelector: scroll the element into view (centered) and wait for scrolling to settle before capturing (default true).' },
    fullPage: { type: 'boolean', description: 'Without querySelector: capture the entire scrollable page instead of the viewport (default false).' },
  }

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
        ...(servers.safari === undefined ? [] : [
          agent.ctx.tools.register(defineTool({
            name: 'safari_get_screenshot',
            description: 'Screenshot of this chat\'s Safari page, returned INLINE as an image (opens Safari via browser_open if needed). With querySelector, captures just that element: it is scrolled into view (scrollTo, default true), the page is allowed to settle, its client rect is measured, the viewport is captured, the rect is re-measured (re-capturing once if the element moved), and the element\'s sub-rectangle is cropped at device-pixel precision. Without querySelector: the viewport, or the whole page with fullPage. Use this instead of mcp__safari__screenshot.',
            parameters: screenshotParams,
            output: {
              schema: { type: 'object', additionalProperties: true },
              render: (_args, value) => [{ type: 'text', text: value.fallbackPath !== undefined
                ? `Screenshot saved to ${value.fallbackPath} (${describeCapture(value)}); not shown inline: ${value.inlineUnavailable}. View it with read_image.`
                : `Screenshot: ${describeCapture(value)}.` }],
            },
            async execute(args, exec) {
              const shot = await captureSafari(exec.agent ?? agent, exec, args)
              const { bytes, ...meta } = shot
              const admitted = await admitImage(exec, bytes, `safari-${Date.now()}.png`)
              if (admitted.ref === undefined) {
                const fallbackPath = join(tmpdir(), `dsh-safari-screenshot-${Date.now()}.png`)
                await writeFile(fallbackPath, bytes)
                return { ...meta, fallbackPath, inlineUnavailable: admitted.reason }
              }
              inlineImages.set(exec, admitted.ref)
              return meta
            },
            finalizeContent(exec, result) {
              const ref = inlineImages.get(exec)
              if (ref === undefined) return undefined
              inlineImages.delete(exec)
              if (result.isError) return undefined
              return [{ type: 'image', attachment: ref }, ...result.content]
            },
          })),
          agent.ctx.tools.register(defineTool({
            name: 'safari_save_screenshot',
            description: 'Screenshot of this chat\'s Safari page written to a PNG file (opens Safari via browser_open if needed). Same element capture as safari_get_screenshot (querySelector, scrollTo, fullPage). Returns the path and pixel size; nothing is shown inline.',
            parameters: {
              path: { type: 'string', required: true, description: 'Destination .png path (absolute, or relative to the session workspace). Parent directories are created.' },
              ...screenshotParams,
            },
            output: {
              schema: { type: 'object', additionalProperties: true },
              render: (_args, value) => [{ type: 'text', text: `Saved ${value.path} (${describeCapture(value)}).` }],
            },
            async execute(args, exec) {
              const target = exec.agent ?? agent
              const shot = await captureSafari(target, exec, args)
              const { bytes, ...meta } = shot
              const path = resolvePath(target.session.header?.cwd ?? process.cwd(), args.path)
              await mkdir(dirname(path), { recursive: true })
              await writeFile(path, bytes)
              return { ...meta, path }
            },
          })),
        ]),
        ...(readerPool === undefined ? [] : [agent.ctx.tools.register(defineTool({
          name: 'safari_get_page_content',
          description: `Read one web page with a real Safari (Technology Preview) engine and return its content — use this instead of web_fetch for JavaScript-rendered pages (SPAs, dashboards) or when web_fetch returns empty/blocked content. Runs in an ISOLATED reader window shared by no one: it never touches this chat's own browser_open session, so a page you are working on is not changed. No browser_open needed. Formats (extraction is done by WebKit itself): ${FORMATS.join(' | ')}; default markdown. For pages that render lazily set waitMs (2000–5000). For structured data that is not in the rendered text, pass \`script\`: a JS FUNCTION BODY evaluated in the loaded page (use \`return\`); its return value comes back as scriptResult. For YouTube videos use safari_get_youtube_notes instead. Reads are pooled host-wide, so concurrent reads (also from subagents) each get their own window and a warm reader is reused.`,
          parameters: {
            url: { type: 'string', required: true, description: 'Absolute http(s) URL to read.' },
            format: { type: 'string', enum: FORMATS, description: 'Extraction format (default markdown). plainText is smallest; textTree/json carry structure and node UIDs; html is the rendered DOM.' },
            waitMs: { type: 'number', description: 'Extra wait after load completes before extracting, for lazily rendered pages (default 0).' },
            maxWordsPerParagraph: { type: 'number', description: 'Truncate paragraphs beyond this many words (default 2000, i.e. effectively no truncation).' },
            includeURLs: { type: 'boolean', description: 'Include link/image URLs (default true).' },
            script: { type: 'string', description: 'Optional JS function body run in the page after load; use `return`. Returned as scriptResult (JSON-decoded when possible).' },
          },
          output: {
            // Loose object: fields vary (title/url may be absent, scriptResult
            // optional, truncation metadata when clamped).
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: renderRead(value) }],
          },
          async execute(args) {
            preflight('safari', servers.safari)
            const result = await readerPool.read({
              url: args.url,
              format: args.format ?? 'markdown',
              waitMs: args.waitMs ?? 0,
              maxWordsPerParagraph: args.maxWordsPerParagraph ?? 2000,
              includeURLs: args.includeURLs ?? true,
              script: args.script,
            })
            return clampRead(result, config.safari.reader.maxChars)
          },
        })), agent.ctx.tools.register(defineTool({
          name: 'safari_get_youtube_notes',
          description: 'Get a YouTube video\'s show notes: title, channel, duration, publish date, chapters (parsed from timestamps), links, and the FULL description — which is never in the rendered page text (YouTube collapses it). Reads the watch page in an isolated Safari reader; no browser_open needed and this chat\'s own browser session is untouched. Accepts watch/youtu.be/shorts/embed URLs or a bare 11-character video id.',
          parameters: {
            url: { type: 'string', required: true, description: 'YouTube video URL (any form) or video id.' },
          },
          output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: renderNotes(value) }],
          },
          async execute(args) {
            preflight('safari', servers.safari)
            const { url } = canonicalWatchUrl(args.url)
            const result = await readerPool.read({
              url,
              format: 'plainText',
              waitMs: 0,
              maxWordsPerParagraph: 0,
              includeURLs: false,
              script: EXTRACT_SCRIPT,
              skipContent: true,
            })
            return shapeNotes(result.scriptResult, url)
          },
        }))]),
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

  // Plugin unload: close every mount we own (agents outlive this plugin) and
  // the reader pool.
  ctx.effect(() => async () => {
    for (const [agent, state] of states) {
      clearTimeout(state.timer)
      await closeMounts(agent, [...state.mounts.keys()], 'unload')
    }
    states.clear()
    await readerPool?.dispose()
  }, 'browser-automation.mounts')
}
