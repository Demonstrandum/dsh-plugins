/**
 * tali-chat-title — lets the agent name the chat, and pushes it to do so at
 * the START of the chat, as soon as the conversation carries enough context
 * to say what it is about.
 *
 * Three pieces, all host-side (no client bundle):
 *
 *   rename_chat            tool: `ctx.sessionTitle.rename(session, title)` on
 *                          the calling agent's own top-level session, after
 *                          applying the configured style (slug / natural).
 *                          Refuses in subagent sessions and never overrides a
 *                          title the HUMAN chose (sidebar Rename, `slug:` prefix).
 *   system-prompt section  the standing rule: name the chat right after the
 *                          first message that states the task, before other
 *                          work — a `MUST`, not a suggestion.
 *   runtime-context nudge  while the chat still carries only an automatic
 *                          placeholder title, every request carries a one-line
 *                          "not named yet — do it now" reminder; it disappears
 *                          (one snapshot change) once the agent or the user
 *                          names the chat. Constant text, so it costs one
 *                          cache break per chat, not one per turn.
 *
 * Config (all optional):
 *
 *   toolName: rename_chat   # model-facing tool name
 *   style: slug             # slug (foo-bar-baz) | natural (a short phrase)
 *   maxWords: 5             # word cap for slugs / guidance for phrases
 *   promptHint: true        # the system-prompt section
 *   nudge: true             # the runtime-context reminder while untitled
 */

import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ChatTitleError, META_KEY, agentTitlesOf, classifyTitle, styleGuidance, styleTitle } from './title.mjs'

export const name = 'chat-title'

export const inject = ['tools', 'sessionTitle', 'systemPrompt']

export const Config = Schema.object({
  toolName: Schema.string().default('rename_chat'),
  style: Schema.union(['slug', 'natural']).default('slug'),
  maxWords: Schema.number().min(1).max(12).default(5),
  promptHint: Schema.boolean().default(true),
  nudge: Schema.boolean().default(true),
})

/**
 * The system-prompt section: the standing rule the model works under.
 * @param {{ toolName: string, style: 'slug' | 'natural', maxWords: number }} config
 */
export function promptSection(config) {
  return [
    `Chat title (${config.toolName}): every chat opens under an automatic placeholder title that tells the user nothing. `
    + `You MUST name the chat yourself by calling ${config.toolName} as soon as you have the minimum context to say what the chat is about — `
    + 'normally right after reading the FIRST user message, as your first tool call, before any other work. Do not wait until the task is done, '
    + 'and do not skip it because the task is small. If the opening message is only a greeting or too vague to name, name the chat the moment the '
    + 'goal becomes clear. A chat that ends its first turn still untitled is a failure.',
    `Title style: ${styleGuidance(config)} Name what the chat is ABOUT (the task, the subject), not what you are doing this second.`,
    `Rename again only when the chat's subject changes materially. If the user renames the chat themselves, leave their title alone — ${config.toolName} refuses in that case and that is final.`,
  ].join('\n')
}

/**
 * The runtime-context reminder shown while the chat is still untitled by the agent.
 * @param {{ toolName: string }} config
 */
export function nudgeText(config) {
  return `Chat title: NOT NAMED YET — the sidebar still shows an automatic placeholder. If the conversation so far tells you what this chat is about, call ${config.toolName} now, before anything else.`
}

/**
 * Build the rename tool.
 * @param {any} ctx
 * @param {{ toolName: string, style: 'slug' | 'natural', maxWords: number }} config
 * @param {WeakMap<object, string>} applied - session → last title this process applied
 */
export function createRenameTool(ctx, config, applied) {
  return defineTool({
    name: config.toolName,
    description: `Rename this chat (the session title shown in the sidebar). Call it as soon as you know what the chat is about — normally right after the first user message, before other tools. `
      + `Title: ${styleGuidance(config)} Returns the applied title. Refuses when the user has renamed the chat themselves or when called from a subagent.`,
    parameters: {
      title: { type: 'string', required: true, description: 'The new chat title — what this chat is about.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderResult(value, config) }],
      presentationMeta: (_args, value) => ({ [META_KEY]: value.applied ? value.title : null }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const session = exec?.agent?.session
      if (session === undefined) throw new ChatTitleError('no live session is attached to this call; the chat cannot be renamed from here.', 'CHAT_TITLE_NO_SESSION')
      if (session.header?.parentSession !== undefined) {
        throw new ChatTitleError('this is a subagent session, not the chat the user sees; only the top-level agent names the chat. Do nothing further about the title.', 'CHAT_TITLE_SUBAGENT')
      }
      const raw = typeof args.title === 'string' ? args.title : ''
      const title = styleTitle(raw, config)
      if (title.length === 0) throw new ChatTitleError(`title "${raw}" is empty after normalization; pass a few descriptive words.`, 'CHAT_TITLE_EMPTY')

      const current = ctx.sessionTitle.get(session)
      const kind = classifyTitle(current, agentTitlesOf(session.snapshotEvents()), applied.get(session))
      if (kind === 'user') {
        return { applied: false, reason: 'user-titled', title: current.title, requested: title }
      }
      if (current !== undefined && current.title === title && kind === 'agent') {
        return { applied: false, reason: 'unchanged', title, requested: title }
      }
      const snapshot = ctx.sessionTitle.rename(session, title)
      applied.set(session, snapshot.title)
      return { applied: true, title: snapshot.title, requested: title, previous: current?.title ?? null, previousKind: kind }
    },
    presentCall: (args) => ({ card: 'generic', title: `Rename chat: ${String(args?.title ?? '')}`, kind: 'write' }),
  })
}

/**
 * @param {any} value
 * @param {{ toolName: string }} config
 */
function renderResult(value, config) {
  if (value.applied) {
    const was = value.previous === null ? '' : ` (was the automatic placeholder "${value.previous}")`
    return `Chat renamed to "${value.title}"${was}. Do not rename it again unless the subject of the chat changes materially.`
  }
  if (value.reason === 'user-titled') {
    return `Not renamed: the user named this chat "${value.title}" themselves, and their choice stands. Do not call ${config.toolName} again in this chat.`
  }
  return `Chat is already named "${value.title}"; nothing to do.`
}

export function apply(ctx, config) {
  /** session → the title this process last applied there (supplements the durable tool/result meta). */
  const applied = new WeakMap()
  const tool = createRenameTool(ctx, config, applied)
  ctx.tools.register(tool)

  /** Only the top-level agent of a chat sees the title rule; subagents cannot rename and must not be nagged. */
  const isTopLevel = (context) => {
    const session = context?.agent?.session
    return session !== undefined && session.header?.parentSession === undefined
  }

  if (config.promptHint) {
    ctx.systemPrompt.section({
      name: 'tool:chat-title',
      order: ctx.systemPrompt.getSectionOrder('TOOL_SESSION_QUERY') + 50,
      text: (context) => (isTopLevel(context) && ctx.tools.get(config.toolName, context.scope) !== undefined ? promptSection(config) : ''),
    })
  }

  if (config.nudge) {
    const nudge = nudgeText(config)
    ctx.systemPrompt.context({
      name: 'chat-title:nudge',
      order: ctx.systemPrompt.getContextOrder('APPROVAL_POLICY') + 20,
      text: (context) => {
        if (!isTopLevel(context)) return ''
        const session = context.agent.session
        const kind = classifyTitle(ctx.sessionTitle.get(session), agentTitlesOf(session.snapshotEvents()), applied.get(session))
        return kind === 'none' || kind === 'automatic' ? nudge : ''
      },
    })
  }

  ctx.logger.info(`chat-title: registered ${config.toolName} (style ${config.style}, promptHint ${config.promptHint}, nudge ${config.nudge})`)
}
