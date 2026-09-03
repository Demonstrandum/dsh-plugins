/**
 * Tool -> emoji resolution, ported from ~/github/pi-web
 * (src/client/src/toolIcons.ts + toolIcons.json), emoji rules only (the pi-web
 * `svg:` asset rules have no equivalent here and are skipped).
 *
 * Rule-key grammar (same as pi-web):
 *   - "tool"            exact tool name
 *   - "prefix_"         prefix rule (key ends with `_`)
 *   - "tool?arg=value"  fires only when the named argument matches
 * Matchable arguments: `language`, and `cmd` (basename of the first token of a
 * shell `command` argument). Scoring: an argument match beats a plain tool
 * rule; an exact tool beats a prefix; longer prefixes win.
 */

/** Emoji rules: pi-web's table verbatim, plus DSH tool names (marked). */
const TABLE: Readonly<Record<string, string>> = {
  // ── pi-web toolIcons.json ──────────────────────────────────────────────
  default: '\u{1F527}', // 🔧
  thinking: '\u{1F928}', // 🤨
  bash: '$',
  edit: '\u270F\uFE0F', // ✏️
  write: '\u270F\uFE0F', // ✏️
  read: '\u{1F441}\uFE0F', // 👁️
  web_search: '\u{1F310}', // 🌐
  get_search_content: '\u{1F50D}', // 🔍
  ctx_execute: '\u{1F527}', // 🔧
  ctx_execute_file: '\u{1F527}', // 🔧
  ctx_batch_execute: '\u{1F527}', // 🔧
  'bash?cmd=rg': '\u{1F50D}', // 🔍
  'bash?cmd=grep': '\u{1F50D}',
  'bash?cmd=ag': '\u{1F50D}',
  'bash?cmd=fd': '\u{1F50D}',
  'bash?cmd=find': '\u{1F50D}',
  // ── DSH tool names (same spirit as the pi-web rows above) ──────────────
  read_image: '\u{1F441}\uFE0F', // 👁️  (read)
  glob: '\u{1F50D}', // 🔍 (file search)
  grep: '\u{1F50D}', // 🔍
  web_fetch: '\u{1F310}', // 🌐
  subagent: '\u{1F916}', // 🤖
  subagent_fork: '\u{1F916}',
}

const DEFAULT_FALLBACK = '\u{1F527}' // 🔧

interface IconRule {
  readonly tool: string
  readonly prefix: boolean
  readonly argName?: string
  readonly argValue?: string
  readonly value: string
}

function parseRule(key: string, value: string): IconRule {
  const q = key.indexOf('?')
  if (q < 0) return { tool: key, prefix: key.endsWith('_'), value }
  const tool = key.slice(0, q)
  const argExpr = key.slice(q + 1)
  const eq = argExpr.indexOf('=')
  if (eq < 0) return { tool, prefix: tool.endsWith('_'), argName: argExpr, value }
  return {
    tool,
    prefix: tool.endsWith('_'),
    argName: argExpr.slice(0, eq),
    argValue: argExpr.slice(eq + 1),
    value,
  }
}

const RULES: readonly IconRule[] = Object.entries(TABLE)
  .map(([key, value]) => parseRule(key, value))

/** The leading command name of a shell command line (basename of first token). */
export function leadingCommand(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? ''
  const segments = first.split('/')
  return segments[segments.length - 1] ?? first
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The argument values an icon rule can match against (`language`, `cmd`). */
function matchValues(args: unknown): Record<string, string> {
  const values: Record<string, string> = {}
  if (!isRecord(args)) return values
  const language = args['language']
  if (typeof language === 'string' && language !== '') values['language'] = language
  const command = args['command']
  if (typeof command === 'string' && command.trim() !== '') values['cmd'] = leadingCommand(command)
  return values
}

function ruleMatches(rule: IconRule, toolName: string, values: Record<string, string>): boolean {
  const toolOk = rule.prefix ? toolName.startsWith(rule.tool) : toolName === rule.tool
  if (!toolOk) return false
  if (rule.argName === undefined) return true
  const actual = values[rule.argName]
  if (actual === undefined) return false
  return rule.argValue === undefined || actual === rule.argValue
}

/** An argument match beats a plain tool; an exact tool beats a prefix; longer prefixes win. */
function ruleScore(rule: IconRule): number {
  const argScore = rule.argName === undefined ? 0 : rule.argValue === undefined ? 60 : 100
  return argScore + (rule.prefix ? rule.tool.length : 50)
}

/**
 * The emoji for one tool call.
 * @param toolName - tool name from the tool/call event.
 * @param argsRaw - raw JSON argument string (DSH's RunningToolCall.argsRaw).
 * @returns the matched glyph, or the spanner fallback.
 */
export function resolveToolGlyph(toolName: string, argsRaw?: string): string {
  let args: unknown
  if (argsRaw !== undefined && argsRaw !== '') {
    try {
      args = JSON.parse(argsRaw)
    } catch {
      args = undefined // streaming/partial or non-JSON args: match on name only
    }
  }
  const values = matchValues(args)
  let best: string | undefined
  let bestScore = -1
  for (const rule of RULES) {
    const score = ruleScore(rule)
    if (score <= bestScore) continue
    if (!ruleMatches(rule, toolName, values)) continue
    best = rule.value
    bestScore = score
  }
  return best ?? DEFAULT_FALLBACK
}

/** The glyph for a reasoning (thinking) phase. */
export function thinkingGlyph(): string {
  return resolveToolGlyph('thinking')
}
