/**
 * The model-facing tool set. Everything here is a plain DSH tool whose
 * implementation forwards to the session's private MCP connections
 * (servers.mjs) through the window registry (windows.mjs). Only these tools
 * exist; the servers' raw tools are never registered. Raw parameter names and
 * schemas: docs/server-tools.json.
 *
 * All window-bound tools take an optional `windowId` (see windows.mjs for the
 * zero-or-one rule when it is omitted).
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { FORMATS } from './reader-pool.mjs'
import { imageOf, parseJsonText } from './servers.mjs'
import { cropBox, cropImage, imageSize, measureScript, parseMeasurement, readPng, rectMoved } from './safari-screenshot.mjs'
import { canonicalWatchUrl, EXTRACT_SCRIPT, renderNotes, shapeNotes } from './youtube-notes.mjs'

const WINDOW_ID = (browser) => ({
  type: 'string',
  description: `Window id (${browser === 'safari' ? 's' : 'c'}:<session>:<window>) from ${browser}_open. Omit when this session has at most one ${browser} window: it is used, or one is opened.`,
})

const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}
const objectOutput = (render) => ({
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: render(value) }],
})

/** Prefix a forwarded result with the window it ran in (always, so the model learns ids). */
const tagged = (id, opened, text) => `${opened ? `Opened ${id}. ` : ''}[${id}]\n${text}`

/**
 * @param {object} deps
 * @param {import('./windows.mjs').BrowserSessions} deps.sessions
 * @param {ReturnType<import('./reader-pool.mjs').createReaderPool> | undefined} deps.readerPool
 * @param {(exec: object, bytes: Uint8Array, name: string) => Promise<{ ref?: object, reason?: string }>} deps.admitImage
 * @param {WeakMap<object, object>} deps.inlineImages
 * @param {(browser: 'safari' | 'chrome') => void} deps.preflight
 * @param {{ maxChars: number }} deps.limits
 * @param {object} fallbackAgent - the agent these tools are registered for (used when an execution carries no agent).
 * @returns {object[]} tool definitions
 */
export function createTools(deps, fallbackAgent) {
  const { sessions, readerPool, admitImage, inlineImages, preflight, limits } = deps
  const tools = []

  /** The calling agent: from the execution, else the agent these tools were registered for. */
  const agentOf = (exec) => exec.agent ?? fallbackAgent

  // ---------------------------------------------------------------- Safari

  async function safari(exec, windowId) {
    preflight('safari')
    return sessions.resolveSafari(agentOf(exec), windowId)
  }

  tools.push(defineTool({
    name: 'safari_open',
    description: 'Open a NEW Safari (Technology Preview) window private to this chat and return its windowId (s:<session>:<window>). Each window is an independent automation session (own tabs, cookies, JS state) in its own STP window, labeled with this chat in its banner; the user\'s regular Safari is never touched. Call again for additional independent windows. Optionally navigate to url immediately. Other safari_* tools auto-open a window when this session has none, so this is only needed for a second window or to get the id explicitly.',
    parameters: { url: { type: 'string', description: 'Optional URL to load in the new window.' } },
    output: objectOutput(value => `Opened Safari window ${value.windowId}${value.url ? ` at ${value.url}${value.title ? ` — "${value.title}"` : ''}` : ''}.`),
    async execute(args, exec) {
      preflight('safari')
      const window = await sessions.openSafari(agentOf(exec))
      if (args.url === undefined || args.url === '') return { windowId: window.id }
      const nav = parseJsonText(await window.conn.callText('navigate_to_url', { url: args.url }))
      return { windowId: window.id, url: nav?.url ?? args.url, title: nav?.title }
    },
  }))

  tools.push(defineTool({
    name: 'safari_close',
    description: 'Close one Safari window of this chat (windowId) or all of them (omit). Frees the STP window and its process.',
    parameters: { windowId: WINDOW_ID('safari') },
    output: textOutput,
    async execute(args, exec) {
      const closed = await sessions.closeSafari(agentOf(exec), args.windowId)
      return closed.length === 0 ? 'No Safari window was open.' : `Closed ${closed.join(', ')}.`
    },
  }))

  tools.push(defineTool({
    name: 'safari_navigate',
    description: 'Load a URL in this chat\'s Safari window and wait for the navigation to finish. Returns the loaded page\'s title and URL; read the page with safari_get_page_content.',
    parameters: { url: { type: 'string', required: true, description: 'URL to load.' }, windowId: WINDOW_ID('safari') },
    output: objectOutput(value => `[${value.windowId}] Loaded ${value.url}${value.title ? ` — "${value.title}"` : ''}.`),
    async execute(args, exec) {
      const { id, conn } = await safari(exec, args.windowId)
      const nav = parseJsonText(await conn.callText('navigate_to_url', { url: args.url }))
      return { windowId: id, url: nav?.url ?? args.url, title: nav?.title }
    },
  }))

  tools.push(defineTool({
    name: 'safari_get_page_content',
    description: `Read a web page with Safari's engine and return its content. TWO MODES. (1) With url and no windowId: reads in an ISOLATED pooled reader window, never this chat's own window, so a page you are working on is not disturbed — the default for "read this URL" (use instead of web_fetch for JavaScript-rendered pages or when web_fetch returns nothing). (2) With windowId, or with no url: reads the current page of this chat's Safari window (url, if also given, is loaded there first); node UIDs in the result can be used with safari_interact. Formats (WebKit's own extraction): ${FORMATS.join(' | ')}, default markdown. waitMs helps lazily rendered pages; script (a JS FUNCTION BODY, use \`return\`) runs in the page and its value is returned as scriptResult. For YouTube videos use safari_get_youtube_notes.`,
    parameters: {
      url: { type: 'string', description: 'URL to read. Without windowId this uses an isolated reader.' },
      windowId: { type: 'string', description: 'Read this chat\'s Safari window (s:<session>:<window>) instead of an isolated reader. Omit windowId AND url to read this session\'s single open window.' },
      format: { type: 'string', enum: FORMATS, description: 'Extraction format (default markdown). plainText is smallest; textTree/json carry structure and node UIDs; html is the rendered DOM.' },
      waitMs: { type: 'number', description: 'Extra wait after load before extracting, for lazily rendered pages (default 0).' },
      maxWordsPerParagraph: { type: 'number', description: 'Truncate paragraphs beyond this many words (default 2000 = effectively none).' },
      includeURLs: { type: 'boolean', description: 'Include link/image URLs (default true).' },
      nodeIds: { type: 'string', enum: ['none', 'editable', 'interactive', 'allContainers'], description: 'Which nodes get UIDs for safari_interact (window mode; default interactive).' },
      script: { type: 'string', description: 'Optional JS function body run in the page after load; use `return`. Returned as scriptResult.' },
    },
    output: objectOutput(renderRead),
    async execute(args, exec) {
      preflight('safari')
      const format = args.format ?? 'markdown'
      const maxWords = args.maxWordsPerParagraph ?? 2000
      const isolated = args.windowId === undefined && args.url !== undefined && args.url !== ''
      if (isolated) {
        if (readerPool === undefined) throw new Error('isolated reads are disabled (safari.reader.enabled=false); pass windowId to read a window')
        const result = await readerPool.read({ url: args.url, format, waitMs: args.waitMs ?? 0, maxWordsPerParagraph: maxWords, includeURLs: args.includeURLs ?? true, script: args.script })
        return clamp({ ...result, mode: 'isolated' }, limits.maxChars)
      }
      const { id, conn, opened } = await safari(exec, args.windowId)
      if (args.url !== undefined && args.url !== '') await conn.callText('navigate_to_url', { url: args.url })
      if ((args.waitMs ?? 0) > 0) await new Promise(resolve => setTimeout(resolve, args.waitMs))
      const raw = parseJsonText(await conn.callText('get_page_content', {
        format, region: 'entire_page', maxWordsPerParagraph: maxWords, includeURLs: args.includeURLs ?? true, shortenURLs: false, nodeIds: args.nodeIds ?? 'interactive',
      }))
      const result = typeof raw === 'object' && raw !== null && typeof raw.content === 'string'
        ? { url: raw.url, title: raw.title, content: raw.content }
        : { url: undefined, title: undefined, content: String(raw) }
      let scriptResult
      if (args.script !== undefined && args.script.trim() !== '') scriptResult = parseJsonText(await conn.callText('evaluate_javascript', { expression: args.script }))
      return clamp({ ...result, format, mode: 'window', windowId: id, opened, ...(args.script !== undefined ? { scriptResult } : {}) }, limits.maxChars)
    },
  }))

  tools.push(defineTool({
    name: 'safari_evaluate_expression',
    description: 'Run JavaScript statements in this chat\'s Safari window. `expression` is a FUNCTION BODY: use an explicit `return` for a value (await is allowed). `$uid(N)` references a node UID from safari_get_page_content. Returns the JSON-encoded result. (safari_evaluate_function takes a function + args instead.)',
    parameters: {
      expression: { type: 'string', required: true, description: 'JavaScript function body; `return` the value you want.' },
      windowId: WINDOW_ID('safari'),
      frameId: { type: 'string', description: 'Node UID of an iframe (or a node inside one) to run in that subframe.' },
    },
    output: textOutput,
    async execute(args, exec) {
      const { id, conn, opened } = await safari(exec, args.windowId)
      return tagged(id, opened, await conn.callText('evaluate_javascript', { expression: args.expression, ...(args.frameId ? { frameId: args.frameId } : {}) }))
    },
  }))

  tools.push(defineTool({
    name: 'safari_evaluate_function',
    description: 'Call a JavaScript FUNCTION in this chat\'s Safari window, e.g. `() => document.title` or `(el) => el.innerText` with args naming node UIDs from safari_get_page_content (each resolves to that element). Async functions are awaited. Returns the JSON-encoded result.',
    parameters: {
      function: { type: 'string', required: true, description: 'A function expression (arrow or function), called with args.' },
      args: { type: 'array', description: 'Node UIDs (strings) passed as element arguments, in order.', items: { type: 'string' } },
      windowId: WINDOW_ID('safari'),
      frameId: { type: 'string', description: 'Node UID of an iframe to run in that subframe.' },
    },
    output: textOutput,
    async execute(args, exec) {
      const { id, conn, opened } = await safari(exec, args.windowId)
      const refs = (args.args ?? []).map(uid => `$uid(${/^\d+$/.test(uid) ? uid : JSON.stringify(uid)})`)
      const expression = `return await (${args.function})(${refs.join(', ')});`
      return tagged(id, opened, await conn.callText('evaluate_javascript', { expression, ...(args.frameId ? { frameId: args.frameId } : {}) }))
    },
  }))

  tools.push(defineTool({
    name: 'safari_interact',
    description: 'Perform DOM interactions in this chat\'s Safari window, in sequence (400 ms settle between each): click, type, keyPress, scroll, selectText, selectMenuItem, hover, highlightText. Target by node UID (from safari_get_page_content), by find-in-page text, or by viewport point. Batch related steps in ONE call. Returns a diff of the page text (or the full loaded page if a click navigated).',
    parameters: {
      interactions: {
        type: 'array', required: true, description: 'Steps, executed in order.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            type: { type: 'string', required: true, enum: ['click', 'type', 'keyPress', 'scroll', 'selectText', 'selectMenuItem', 'hover', 'highlightText'], description: 'Interaction kind.' },
            purpose: { type: 'string', required: true, description: 'Short description of the intended outcome.' },
            node: { type: 'string', description: 'Node UID. Omit to target by `text` (find-in-page).' },
            text: { type: 'string', description: 'Find-in-page query, scroll search term, or menu item label.' },
            value: { type: 'string', description: 'For type: text to type; for keyPress: key name.' },
            pressReturn: { type: 'boolean', description: 'For type: press Return afterwards (default false).' },
            replaceAll: { type: 'boolean', description: 'For type: replace existing field text (default false).' },
            scrollToVisible: { type: 'boolean', description: 'Scroll the target into view first (default false).' },
            point: { type: 'object', additionalProperties: false, description: 'Viewport coordinates, last resort.', properties: { x: { type: 'number', required: true }, y: { type: 'number', required: true } } },
            scrollDelta: { type: 'object', additionalProperties: false, description: 'For scroll: pixel delta.', properties: { x: { type: 'number' }, y: { type: 'number' } } },
          },
        },
      },
      fullText: { type: 'boolean', description: 'Return the full page text instead of a diff (default false).' },
      windowId: WINDOW_ID('safari'),
    },
    output: textOutput,
    async execute(args, exec) {
      const { id, conn, opened } = await safari(exec, args.windowId)
      return tagged(id, opened, await conn.callText('page_interactions', { interactions: args.interactions, ...(args.fullText ? { fullText: true } : {}) }))
    },
  }))

  /** One page_interactions step from the simple-tool arguments. */
  function step(type, purpose, args, extra = {}) {
    if (!args.node && !args.text && !args.point) throw new Error(`${purpose}: give node (UID from safari_get_page_content), text (find-in-page), or point`)
    return {
      type, purpose,
      ...(args.node ? { node: args.node } : {}),
      ...(args.text ? { text: args.text } : {}),
      ...(args.point ? { point: args.point } : {}),
      ...(args.scrollToVisible !== undefined ? { scrollToVisible: args.scrollToVisible } : { scrollToVisible: true }),
      ...extra,
    }
  }
  const TARGET = {
    node: { type: 'string', description: 'Node UID from safari_get_page_content (preferred).' },
    text: { type: 'string', description: 'Find-in-page text identifying the element when no node is known.' },
    point: { type: 'object', additionalProperties: false, description: 'Viewport coordinates, last resort.', properties: { x: { type: 'number', required: true }, y: { type: 'number', required: true } } },
    scrollToVisible: { type: 'boolean', description: 'Scroll the target into view first (default true).' },
  }
  async function interactOnce(exec, args, interaction) {
    const { id, conn, opened } = await safari(exec, args.windowId)
    return tagged(id, opened, await conn.callText('page_interactions', { interactions: [interaction] }))
  }

  tools.push(defineTool({
    name: 'safari_click',
    description: 'Click an element in this chat\'s Safari window (by node UID, find-in-page text, or point). Waits for a triggered navigation. Returns the page diff. For several steps use safari_interact.',
    parameters: { ...TARGET, windowId: WINDOW_ID('safari') },
    output: textOutput,
    async execute(args, exec) { return interactOnce(exec, args, step('click', 'click', args)) },
  }))

  tools.push(defineTool({
    name: 'safari_hover',
    description: 'Hover an element in this chat\'s Safari window (by node UID, text, or point). Returns the page diff.',
    parameters: { ...TARGET, windowId: WINDOW_ID('safari') },
    output: textOutput,
    async execute(args, exec) { return interactOnce(exec, args, step('hover', 'hover', args)) },
  }))

  tools.push(defineTool({
    name: 'safari_press_key',
    description: 'Press a key in this chat\'s Safari window (e.g. "Enter", "Escape", "Tab", "ArrowDown"), optionally on a target element. Returns the page diff.',
    parameters: { key: { type: 'string', required: true, description: 'Key name.' }, ...TARGET, windowId: WINDOW_ID('safari') },
    output: textOutput,
    async execute(args, exec) {
      const interaction = { type: 'keyPress', purpose: `press ${args.key}`, value: args.key, ...(args.node ? { node: args.node } : {}), ...(args.text ? { text: args.text } : {}), ...(args.point ? { point: args.point } : {}) }
      return interactOnce(exec, args, interaction)
    },
  }))

  tools.push(defineTool({
    name: 'safari_type_text',
    description: 'Type text into a field in this chat\'s Safari window (target by node UID or find-in-page text), optionally replacing existing text and/or pressing Return to submit. Returns the page diff.',
    parameters: {
      text: { type: 'string', required: true, description: 'Text to type.' },
      node: TARGET.node,
      target: { type: 'string', description: 'Find-in-page text identifying the field when no node is known.' },
      replaceAll: { type: 'boolean', description: 'Replace existing field text (default false).' },
      pressReturn: { type: 'boolean', description: 'Press Return after typing (default false).' },
      windowId: WINDOW_ID('safari'),
    },
    output: textOutput,
    async execute(args, exec) {
      const targetArgs = { node: args.node, text: args.target }
      const interaction = step('type', 'type text', targetArgs, { value: args.text, ...(args.replaceAll ? { replaceAll: true } : {}), ...(args.pressReturn ? { pressReturn: true } : {}) })
      return interactOnce(exec, args, interaction)
    },
  }))

  tools.push(defineTool({
    name: 'safari_wait_for',
    description: 'Wait until any of the given texts appears in this chat\'s Safari page (polls the page text). Returns which text matched, or a timeout notice.',
    parameters: {
      text: { type: 'array', required: true, description: 'Texts; resolves when any appears.', items: { type: 'string' } },
      timeout: { type: 'number', description: 'Milliseconds to wait (default 10000).' },
      windowId: WINDOW_ID('safari'),
    },
    output: textOutput,
    async execute(args, exec) {
      const { id, conn, opened } = await safari(exec, args.windowId)
      const total = Math.max(0, args.timeout ?? 10_000)
      const deadline = Date.now() + total
      do {
        const slice = Math.min(20_000, Math.max(50, deadline - Date.now()))
        const expression = `const texts = ${JSON.stringify(args.text)}; const deadline = Date.now() + ${slice};
while (true) { const t = document.body ? document.body.innerText : ''; const hit = texts.find(x => t.includes(x)); if (hit !== undefined) return { found: hit }; if (Date.now() >= deadline) return { found: null }; await new Promise(r => setTimeout(r, 100)); }`
        const result = parseJsonText(await conn.callText('evaluate_javascript', { expression }))
        if (result && result.found) return tagged(id, opened, `Found ${JSON.stringify(result.found)}.`)
      } while (Date.now() < deadline)
      return tagged(id, opened, `Timed out after ${total} ms waiting for ${args.text.map(t => JSON.stringify(t)).join(' / ')}.`)
    },
  }))

  tools.push(defineTool({
    name: 'safari_console_messages',
    description: 'Console messages (log/info/warn/error) captured in this chat\'s Safari window.',
    parameters: {
      windowId: WINDOW_ID('safari'),
      limit: { type: 'number', description: 'Maximum number of messages (newest last).' },
      clear: { type: 'boolean', description: 'Clear the buffer after reading.' },
      level_filter: { type: 'array', description: 'Only these levels.', items: { type: 'string', enum: ['log', 'info', 'warn', 'error', 'debug'] } },
    },
    output: textOutput,
    async execute(args, exec) {
      const { id, conn, opened } = await safari(exec, args.windowId)
      const { windowId: _w, ...rest } = args
      return tagged(id, opened, await conn.callText('browser_console_messages', rest))
    },
  }))

  tools.push(defineTool({
    name: 'safari_network_requests',
    description: 'Network requests recorded in this chat\'s Safari window (method, URL, status, type, timing).',
    parameters: {
      windowId: WINDOW_ID('safari'),
      clear: { type: 'boolean', description: 'Clear the recorded list after reading.' },
      since: { type: 'string', description: 'Only requests after this ISO timestamp.' },
    },
    output: textOutput,
    async execute(args, exec) {
      const { id, conn, opened } = await safari(exec, args.windowId)
      const { windowId: _w, ...rest } = args
      return tagged(id, opened, await conn.callText('list_network_requests', rest))
    },
  }))

  tools.push(defineTool({
    name: 'safari_set_viewport_size',
    description: 'Resize this chat\'s Safari window viewport (CSS pixels).',
    parameters: {
      width: { type: 'number', required: true, description: 'Viewport width in CSS px.' },
      height: { type: 'number', required: true, description: 'Viewport height in CSS px.' },
      windowId: WINDOW_ID('safari'),
    },
    output: textOutput,
    async execute(args, exec) {
      const { id, conn, opened } = await safari(exec, args.windowId)
      return tagged(id, opened, await conn.callText('set_viewport_size', { width: args.width, height: args.height }))
    },
  }))

  // Screenshots (element-aware; see safari-screenshot.mjs).
  async function captureSafari(exec, args) {
    const { id, conn, opened } = await safari(exec, args.windowId)
    const viewportPath = join(tmpdir(), `dsh-safari-shot-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.png`)
    const shot = async () => { await conn.callText('screenshot', { savePath: viewportPath, ...(args.querySelector ? {} : { full_page: args.fullPage === true }) }) }
    if (args.querySelector === undefined || args.querySelector === '') {
      await shot()
      const size = await imageSize(viewportPath)
      return { windowId: id, opened, bytes: await readPng(viewportPath), width: size.width, height: size.height, fullPage: args.fullPage === true }
    }
    const measure = async (scroll) => parseMeasurement(await conn.callText('evaluate_javascript', { expression: measureScript(args.querySelector, scroll) }))
    const before = await measure(args.scrollTo !== false)
    await shot()
    let after = await measure(false)
    let unstable = false
    if (rectMoved(before.rect, after.rect)) {
      await shot()
      const again = await measure(false)
      unstable = rectMoved(after.rect, again.rect)
      after = again
    }
    const size = await imageSize(viewportPath)
    const box = cropBox(after.rect, after.viewport, size)
    return {
      windowId: id, opened, bytes: await cropImage(viewportPath, box), width: box.width, height: box.height, querySelector: args.querySelector,
      rect: { x: Math.round(after.rect.x), y: Math.round(after.rect.y), width: Math.round(after.rect.width), height: Math.round(after.rect.height) },
      viewport: after.viewport, scale: Number(box.scale.toFixed(3)), clipped: box.clipped, settled: before.settled, unstable,
    }
  }

  const safariShotParams = {
    windowId: WINDOW_ID('safari'),
    querySelector: { type: 'string', description: 'CSS selector of one element to capture (document.querySelector). Omit for the whole viewport.' },
    scrollTo: { type: 'boolean', description: 'With querySelector: scroll the element into view (centered) and wait for scrolling to settle first (default true).' },
    fullPage: { type: 'boolean', description: 'Without querySelector: capture the entire scrollable page instead of the viewport (default false).' },
  }

  tools.push(defineTool({
    name: 'safari_get_screenshot',
    description: 'Screenshot of this chat\'s Safari window, returned INLINE as an image. With querySelector, only that element: scrolled into view (scrollTo), settled, measured, captured, re-measured (re-captured once if it moved) and cropped at device-pixel precision. Without: the viewport, or the whole page with fullPage.',
    parameters: safariShotParams,
    output: objectOutput(describeShot),
    async execute(args, exec) {
      const { bytes, ...meta } = await captureSafari(exec, args)
      return inlineOrFile(exec, bytes, meta, 'safari')
    },
    finalizeContent: inlineFinalizer,
  }))

  tools.push(defineTool({
    name: 'safari_save_screenshot',
    description: 'Screenshot of this chat\'s Safari window written to a PNG file (same element capture options as safari_get_screenshot). Returns path and pixel size.',
    parameters: { path: { type: 'string', required: true, description: 'Destination .png path (absolute, or relative to the session workspace).' }, ...safariShotParams },
    output: objectOutput(value => `Saved ${value.path} (${describeShot(value)})`),
    async execute(args, exec) {
      const { bytes, ...meta } = await captureSafari(exec, args)
      const path = await writeShot(agentOf(exec), args.path, bytes)
      return { ...meta, path }
    },
  }))

  tools.push(defineTool({
    name: 'safari_get_youtube_notes',
    description: 'Show notes of a YouTube video: title, channel, duration, views, publish date, chapters (parsed from timestamps), links and the FULL description (which the rendered page never shows). Reads the watch page in an isolated Safari reader; this chat\'s windows are untouched. Accepts watch / youtu.be / shorts / embed URLs or a bare 11-character id.',
    parameters: { url: { type: 'string', required: true, description: 'YouTube video URL (any form) or video id.' } },
    output: objectOutput(renderNotes),
    async execute(args) {
      preflight('safari')
      if (readerPool === undefined) throw new Error('isolated reads are disabled (safari.reader.enabled=false)')
      const { url } = canonicalWatchUrl(args.url)
      const result = await readerPool.read({ url, format: 'plainText', waitMs: 0, maxWordsPerParagraph: 0, includeURLs: false, script: EXTRACT_SCRIPT, skipContent: true })
      return shapeNotes(result.scriptResult, url)
    },
  }))

  // ---------------------------------------------------------------- Chrome

  async function chrome(exec, windowId) {
    preflight('chrome')
    return sessions.resolveChrome(agentOf(exec), windowId)
  }
  /** Forward one page-scoped Chrome tool with pageId injected. */
  async function chromeCall(exec, args, rawName, mapArgs = (rest) => rest) {
    const { id, pageId, conn, opened } = await chrome(exec, args.windowId)
    const { windowId: _w, ...rest } = args
    return { id, opened, text: await conn.callText(rawName, { ...mapArgs(rest), pageId }) }
  }
  const forwardChrome = (rawName, mapArgs) => async function execute(args, exec) {
    const { id, opened, text } = await chromeCall(exec, args, rawName, mapArgs)
    return tagged(id, opened, text)
  }

  tools.push(defineTool({
    name: 'chrome_open',
    description: 'Open a NEW Chrome page (window) private to this chat and return its windowId (c:<session>:<window>). All Chrome windows of this chat share one isolated Chrome instance (fresh temporary profile: no saved logins; cookies shared between this chat\'s windows). Other chrome_* tools auto-open a window when this session has none.',
    parameters: { url: { type: 'string', description: 'URL to load (default about:blank).' } },
    output: objectOutput(value => `Opened Chrome window ${value.windowId}${value.url ? ` at ${value.url}` : ''}.`),
    async execute(args, exec) {
      preflight('chrome')
      const page = await sessions.openChrome(agentOf(exec), args.url)
      return { windowId: page.id, url: args.url }
    },
  }))

  tools.push(defineTool({
    name: 'chrome_close',
    description: 'Close one Chrome window of this chat (windowId) or all of them (omit). Chrome itself quits when the chat\'s last window closes.',
    parameters: { windowId: WINDOW_ID('chrome') },
    output: textOutput,
    async execute(args, exec) {
      const closed = await sessions.closeChrome(agentOf(exec), args.windowId)
      return closed.length === 0 ? 'No Chrome window was open.' : `Closed ${closed.join(', ')}.`
    },
  }))

  tools.push(defineTool({
    name: 'chrome_navigate',
    description: 'Navigate this chat\'s Chrome window: load a url, or go back / forward / reload. Waits for the navigation to complete.',
    parameters: {
      url: { type: 'string', description: 'URL to load (type url).' },
      type: { type: 'string', enum: ['url', 'back', 'forward', 'reload'], description: 'Navigation kind (default url).' },
      ignoreCache: { type: 'boolean', description: 'For reload: bypass the cache.' },
      timeout: { type: 'number', description: 'Milliseconds to wait for the navigation (0 = no timeout).' },
      windowId: WINDOW_ID('chrome'),
    },
    output: textOutput,
    execute: forwardChrome('navigate_page', (rest) => ({ type: rest.url && !rest.type ? 'url' : rest.type, ...rest })),
  }))

  tools.push(defineTool({
    name: 'chrome_snapshot',
    description: 'Text snapshot of this chat\'s Chrome page from the accessibility tree, listing elements with their uid. Prefer this over screenshots for reading and for finding elements; use the uids with chrome_click / chrome_fill / chrome_hover / chrome_get_screenshot. Always take a fresh snapshot after the page changes.',
    parameters: { verbose: { type: 'boolean', description: 'Include all accessibility properties (default false).' }, windowId: WINDOW_ID('chrome') },
    output: textOutput,
    execute: forwardChrome('take_snapshot'),
  }))

  const chromeShotParams = {
    windowId: WINDOW_ID('chrome'),
    uid: { type: 'string', description: 'Element uid from chrome_snapshot to capture just that element.' },
    fullPage: { type: 'boolean', description: 'Capture the whole scrollable page (default false).' },
    format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'Image format (default png).' },
    quality: { type: 'number', description: 'jpeg/webp quality 0–100.' },
  }
  async function captureChrome(exec, args) {
    const { id, pageId, conn, opened } = await chrome(exec, args.windowId)
    const { windowId: _w, path: _p, ...rest } = args
    const result = await conn.callRaw('take_screenshot', { ...rest, pageId })
    const image = imageOf(result)
    if (result.isError || image === undefined) throw new Error(`chrome screenshot failed: ${result.content?.map(b => b.text ?? '').join(' ') || 'no image returned'}`)
    return { windowId: id, opened, bytes: image.data, mediaType: image.mediaType, uid: args.uid, fullPage: args.fullPage === true }
  }

  tools.push(defineTool({
    name: 'chrome_get_screenshot',
    description: 'Screenshot of this chat\'s Chrome page, returned INLINE as an image: the viewport, the whole page (fullPage), or one element (uid from chrome_snapshot).',
    parameters: chromeShotParams,
    output: objectOutput(describeShot),
    async execute(args, exec) {
      const { bytes, mediaType, ...meta } = await captureChrome(exec, args)
      return inlineOrFile(exec, bytes, meta, 'chrome', mediaType)
    },
    finalizeContent: inlineFinalizer,
  }))

  tools.push(defineTool({
    name: 'chrome_save_screenshot',
    description: 'Screenshot of this chat\'s Chrome page written to a file (viewport, fullPage, or element uid). Returns the path.',
    parameters: { path: { type: 'string', required: true, description: 'Destination path (absolute, or relative to the session workspace); extension should match format.' }, ...chromeShotParams },
    output: objectOutput(value => `Saved ${value.path} (${describeShot(value)})`),
    async execute(args, exec) {
      const { bytes, mediaType: _m, ...meta } = await captureChrome(exec, args)
      const path = await writeShot(agentOf(exec), args.path, bytes)
      return { ...meta, path }
    },
  }))

  tools.push(defineTool({
    name: 'chrome_evaluate_function',
    description: 'Call a JavaScript FUNCTION in this chat\'s Chrome page, e.g. `() => document.title` or `(el) => el.innerText` with args naming snapshot uids (each resolves to that element). Async functions are awaited. The return value must be JSON-serializable.',
    parameters: {
      function: { type: 'string', required: true, description: 'A function expression (arrow or function), called with args.' },
      args: { type: 'array', description: 'Snapshot uids (strings) passed as element arguments, in order.', items: { type: 'string' } },
      windowId: WINDOW_ID('chrome'),
    },
    output: textOutput,
    execute: forwardChrome('evaluate_script'),
  }))

  tools.push(defineTool({
    name: 'chrome_evaluate_expression',
    description: 'Run JavaScript statements in this chat\'s Chrome page. `expression` is a FUNCTION BODY: use an explicit `return` for a value (await is allowed). Returns the JSON-encoded result. (chrome_evaluate_function takes a function + uid args instead.)',
    parameters: {
      expression: { type: 'string', required: true, description: 'JavaScript function body; `return` the value you want.' },
      windowId: WINDOW_ID('chrome'),
    },
    output: textOutput,
    async execute(args, exec) {
      const { id, opened, text } = await chromeCall(exec, { windowId: args.windowId }, 'evaluate_script', () => ({ function: `async () => { ${args.expression}\n }` }))
      return tagged(id, opened, text)
    },
  }))

  tools.push(defineTool({
    name: 'chrome_click',
    description: 'Click an element (uid from chrome_snapshot) in this chat\'s Chrome page.',
    parameters: { uid: { type: 'string', required: true, description: 'Element uid.' }, dblClick: { type: 'boolean', description: 'Double-click.' }, includeSnapshot: { type: 'boolean', description: 'Return a fresh snapshot afterwards.' }, windowId: WINDOW_ID('chrome') },
    output: textOutput,
    execute: forwardChrome('click'),
  }))

  tools.push(defineTool({
    name: 'chrome_fill',
    description: 'Type into an input / textarea / contenteditable or choose a select option (uid from chrome_snapshot).',
    parameters: { uid: { type: 'string', required: true, description: 'Element uid.' }, value: { type: 'string', required: true, description: 'Value to fill.' }, includeSnapshot: { type: 'boolean' }, windowId: WINDOW_ID('chrome') },
    output: textOutput,
    execute: forwardChrome('fill'),
  }))

  tools.push(defineTool({
    name: 'chrome_fill_form',
    description: 'Fill several form fields at once (uids from chrome_snapshot).',
    parameters: {
      elements: { type: 'array', required: true, description: 'Fields to fill.', items: { type: 'object', additionalProperties: false, properties: { uid: { type: 'string', required: true }, value: { type: 'string', required: true, description: '"true"/"false" for checkboxes and toggles.' } } } },
      includeSnapshot: { type: 'boolean' },
      windowId: WINDOW_ID('chrome'),
    },
    output: textOutput,
    execute: forwardChrome('fill_form'),
  }))

  tools.push(defineTool({
    name: 'chrome_hover',
    description: 'Hover an element (uid from chrome_snapshot).',
    parameters: { uid: { type: 'string', required: true }, includeSnapshot: { type: 'boolean' }, windowId: WINDOW_ID('chrome') },
    output: textOutput,
    execute: forwardChrome('hover'),
  }))

  tools.push(defineTool({
    name: 'chrome_press_key',
    description: 'Press a key or combination in this chat\'s Chrome page, e.g. "Enter", "Escape", "Control+a".',
    parameters: { key: { type: 'string', required: true, description: 'Key or combination.' }, includeSnapshot: { type: 'boolean' }, windowId: WINDOW_ID('chrome') },
    output: textOutput,
    execute: forwardChrome('press_key'),
  }))

  tools.push(defineTool({
    name: 'chrome_type_text',
    description: 'Type text at the current focus in this chat\'s Chrome page (focus an element first with chrome_click), optionally followed by a key such as Enter.',
    parameters: { text: { type: 'string', required: true }, submitKey: { type: 'string', description: 'Key to press after typing, e.g. Enter.' }, windowId: WINDOW_ID('chrome') },
    output: textOutput,
    execute: forwardChrome('type_text'),
  }))

  tools.push(defineTool({
    name: 'chrome_wait_for',
    description: 'Wait until any of the given texts appears on this chat\'s Chrome page.',
    parameters: { text: { type: 'array', required: true, description: 'Texts; resolves when any appears.', items: { type: 'string' } }, timeout: { type: 'number', description: 'Milliseconds (0 = no timeout).' }, windowId: WINDOW_ID('chrome') },
    output: textOutput,
    execute: forwardChrome('wait_for'),
  }))

  /** JS (inlined text) that returns the deepest visible element whose text contains `needle`. */
  const FIND_BY_TEXT = (needle) => `(() => { const needle = ${JSON.stringify(needle)}; let best = null; const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT); while (walk.nextNode()) { const el = walk.currentNode; if (!(el.innerText || '').includes(needle)) continue; const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue; best = el; } return best; })()`

  tools.push(defineTool({
    name: 'chrome_interact',
    description: 'Perform DOM interactions in this chat\'s Chrome page in sequence, mirroring safari_interact: click, type, keyPress, scroll, hover, selectMenuItem (selectText/highlightText and point targets are not supported in Chrome and are reported as failed steps). Target by snapshot uid (`node`) or by page text (`text`). Steps continue after a failed step; the result reports each step\'s outcome.',
    parameters: {
      interactions: {
        type: 'array', required: true, description: 'Steps, executed in order.',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            type: { type: 'string', required: true, enum: ['click', 'type', 'keyPress', 'scroll', 'selectText', 'selectMenuItem', 'hover', 'highlightText'], description: 'Interaction kind.' },
            purpose: { type: 'string', required: true, description: 'Short description of the intended outcome.' },
            node: { type: 'string', description: 'Snapshot uid of the target.' },
            text: { type: 'string', description: 'Page text identifying the target (for selectMenuItem: the option label).' },
            value: { type: 'string', description: 'For type: text to type; for keyPress: key or combination.' },
            pressReturn: { type: 'boolean', description: 'For type: press Enter afterwards.' },
            replaceAll: { type: 'boolean', description: 'For type: replace the field\'s existing text (default: fill replaces when a uid is given).' },
            scrollToVisible: { type: 'boolean', description: 'Scroll the target into view first.' },
            scrollDelta: { type: 'object', additionalProperties: false, description: 'For scroll: pixel delta.', properties: { x: { type: 'number' }, y: { type: 'number' } } },
          },
        },
      },
      includeSnapshot: { type: 'boolean', description: 'Append a fresh snapshot after the batch (default false).' },
      windowId: WINDOW_ID('chrome'),
    },
    output: textOutput,
    async execute(args, exec) {
      const { id, pageId, conn, opened } = await chrome(exec, args.windowId)
      const call = (name, a) => conn.callText(name, { ...a, pageId })
      const js = (fn) => call('evaluate_script', { function: fn })
      const byText = (needle, action) => js(`() => { const el = ${FIND_BY_TEXT(needle)}; if (!el) throw new Error('no element with text ' + ${JSON.stringify(needle)}); ${action} return 'ok'; }`)
      const report = []
      for (const [index, stepArgs] of args.interactions.entries()) {
        const label = `#${index + 1} ${stepArgs.type} (${stepArgs.purpose})`
        try {
          if (stepArgs.scrollToVisible && stepArgs.node) await call('evaluate_script', { function: '(el) => el.scrollIntoView({ block: "center", inline: "center" })', args: [stepArgs.node] })
          switch (stepArgs.type) {
            case 'click':
              if (stepArgs.node) await call('click', { uid: stepArgs.node })
              else if (stepArgs.text) await byText(stepArgs.text, 'el.scrollIntoView({ block: "center" }); el.click();')
              else throw new Error('click needs node or text')
              break
            case 'hover':
              if (stepArgs.node) await call('hover', { uid: stepArgs.node })
              else if (stepArgs.text) await byText(stepArgs.text, 'el.scrollIntoView({ block: "center" }); el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); el.dispatchEvent(new MouseEvent("mouseenter"));')
              else throw new Error('hover needs node or text')
              break
            case 'type':
              if (stepArgs.value === undefined) throw new Error('type needs value')
              if (stepArgs.node) {
                await call('fill', { uid: stepArgs.node, value: stepArgs.value })
                if (stepArgs.pressReturn) await call('press_key', { key: 'Enter' })
              } else {
                if (stepArgs.text) await byText(stepArgs.text, 'el.scrollIntoView({ block: "center" }); el.click(); el.focus && el.focus();')
                if (stepArgs.replaceAll) await call('press_key', { key: 'Meta+a' })
                await call('type_text', { text: stepArgs.value, ...(stepArgs.pressReturn ? { submitKey: 'Enter' } : {}) })
              }
              break
            case 'keyPress':
              if (!stepArgs.value) throw new Error('keyPress needs value (key name)')
              if (stepArgs.node) await call('click', { uid: stepArgs.node })
              await call('press_key', { key: stepArgs.value })
              break
            case 'scroll':
              if (stepArgs.scrollDelta) await js(`() => { window.scrollBy(${Number(stepArgs.scrollDelta.x) || 0}, ${Number(stepArgs.scrollDelta.y) || 0}); return 'ok'; }`)
              else if (stepArgs.node) await call('evaluate_script', { function: '(el) => { el.scrollIntoView({ block: "center", inline: "center" }); return "ok"; }', args: [stepArgs.node] })
              else if (stepArgs.text) await byText(stepArgs.text, 'el.scrollIntoView({ block: "center" });')
              else throw new Error('scroll needs scrollDelta, node, or text')
              break
            case 'selectMenuItem':
              if (stepArgs.node && (stepArgs.text || stepArgs.value)) await call('fill', { uid: stepArgs.node, value: stepArgs.text ?? stepArgs.value })
              else throw new Error('selectMenuItem needs node (the <select>) and text (the option label)')
              break
            default:
              throw new Error(`${stepArgs.type} is not supported in Chrome`)
          }
          report.push(`${label} → ok`)
        } catch (error) {
          report.push(`${label} → FAILED: ${String(error).replace(/^Error: /, '')}`)
        }
      }
      let text = report.join('\n')
      if (args.includeSnapshot) text += `\n\n${await call('take_snapshot', {})}`
      return tagged(id, opened, text)
    },
  }))

  tools.push(defineTool({
    name: 'chrome_console_messages',
    description: 'Console messages of this chat\'s Chrome page (paginated).',
    parameters: {
      types: { type: 'array', description: 'Only these message types.', items: { type: 'string', enum: ['log', 'debug', 'info', 'error', 'warn', 'dir', 'dirxml', 'table', 'trace', 'clear', 'startGroup', 'startGroupCollapsed', 'endGroup', 'assert', 'profile', 'profileEnd', 'count', 'timeEnd', 'issue'] } },
      pageSize: { type: 'number' }, pageIdx: { type: 'number' }, includeStackTraces: { type: 'boolean' },
      windowId: WINDOW_ID('chrome'),
    },
    output: textOutput,
    execute: forwardChrome('list_console_messages'),
  }))

  tools.push(defineTool({
    name: 'chrome_network_requests',
    description: 'Network requests of this chat\'s Chrome page (paginated; filter by resource type).',
    parameters: {
      resourceTypes: { type: 'array', description: 'Only these resource types (e.g. document, xhr, fetch, script, image).', items: { type: 'string' } },
      pageSize: { type: 'number' }, pageIdx: { type: 'number' },
      windowId: WINDOW_ID('chrome'),
    },
    output: textOutput,
    execute: forwardChrome('list_network_requests'),
  }))

  return tools

  // ---------------------------------------------------------------- helpers

  async function inlineOrFile(exec, bytes, meta, browser, mediaType = 'image/png') {
    const admitted = await admitImage(exec, bytes, `${browser}-${Date.now()}.${mediaType === 'image/jpeg' ? 'jpg' : mediaType === 'image/webp' ? 'webp' : 'png'}`, mediaType)
    if (admitted.ref === undefined) {
      const fallbackPath = join(tmpdir(), `dsh-${browser}-screenshot-${Date.now()}.${mediaType === 'image/jpeg' ? 'jpg' : mediaType === 'image/webp' ? 'webp' : 'png'}`)
      await writeFile(fallbackPath, bytes)
      return { ...meta, fallbackPath, inlineUnavailable: admitted.reason }
    }
    inlineImages.set(exec, admitted.ref)
    return meta
  }

  function inlineFinalizer(exec, result) {
    const ref = inlineImages.get(exec)
    if (ref === undefined) return undefined
    inlineImages.delete(exec)
    if (result.isError) return undefined
    return [{ type: 'image', attachment: ref }, ...result.content]
  }

  async function writeShot(agent, requested, bytes) {
    const path = resolvePath(agent.session?.header?.cwd ?? process.cwd(), requested)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
    return path
  }
}

/** Text summary of a capture. */
function describeShot(value) {
  const parts = [`[${value.windowId}]${value.opened ? ' (opened)' : ''}`]
  if (value.width !== undefined) parts.push(`${value.width}×${value.height} px`)
  if (value.querySelector !== undefined) {
    parts.push(`element ${JSON.stringify(value.querySelector)} at CSS rect x=${value.rect.x} y=${value.rect.y} ${value.rect.width}×${value.rect.height} (viewport ${value.viewport.width}×${value.viewport.height}, scale ${value.scale})`)
    if (value.clipped) parts.push('NOTE: element extends beyond the viewport; crop clipped to the visible part')
    if (value.unstable) parts.push('NOTE: element kept moving during capture; crop may be off')
    if (!value.settled) parts.push('NOTE: scrolling had not fully settled before capture')
  } else if (value.uid !== undefined) parts.push(`element uid ${value.uid}`)
  else if (value.fullPage) parts.push('full page')
  else parts.push('viewport')
  if (value.fallbackPath !== undefined) parts.push(`saved to ${value.fallbackPath}; not shown inline: ${value.inlineUnavailable}. View it with read_image`)
  return parts.join('; ')
}

/** Truncate a page read to maxChars, saving the full text to a temp file when cut. */
function clamp(result, maxChars) {
  if (result.content.length <= maxChars) return result
  const file = join(tmpdir(), `dsh-safari-read-${Date.now()}-${process.pid}.${result.format === 'html' ? 'html' : result.format === 'json' ? 'json' : 'txt'}`)
  void writeFile(file, result.content)
  return { ...result, content: result.content.slice(0, maxChars), truncated: true, totalChars: result.content.length, fullTextPath: file }
}

/** Model-facing text for a page read. */
function renderRead(value) {
  const head = [
    value.mode === 'window' ? `[${value.windowId}]${value.opened ? ' (opened)' : ''}` : '[isolated reader]',
    value.title !== undefined ? `Title: ${value.title}` : undefined,
    `URL: ${value.url ?? ''}`,
    `Format: ${value.format}`,
    value.truncated ? `NOTE: content truncated to ${value.content.length} of ${value.totalChars} chars; full text saved to ${value.fullTextPath} (use read).` : undefined,
  ].filter(Boolean).join('\n')
  const script = 'scriptResult' in value ? `\n\n--- scriptResult ---\n${typeof value.scriptResult === 'string' ? value.scriptResult : JSON.stringify(value.scriptResult, null, 1)}` : ''
  return `${head}\n\n${value.content}${script}`
}
