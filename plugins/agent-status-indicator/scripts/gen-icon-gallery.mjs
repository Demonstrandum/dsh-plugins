/**
 * Generate a static icon gallery (gallery/icon-gallery.html) showing every
 * status/tool icon exactly as the indicator renders it: same background as the
 * GUI chat area, same 48px cell, 40px glyph size, and drop shadow. Reuses the
 * plugin's real rule table + resolver so the gallery cannot drift from the code.
 */
import { build } from 'esbuild'
import { writeFileSync } from 'node:fs'

await build({
  entryPoints: ['src/client/toolIcons.ts'],
  outfile: '/tmp/tali-toolicons-gallery.mjs',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
})
const { TABLE, resolveToolGlyph } = await import('/tmp/tali-toolicons-gallery.mjs')

const TERMINAL_SVG = `<svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
  <rect x="1.5" y="1.5" width="37" height="37" rx="8" fill="#0b0b0d" stroke="#8a8a8e" stroke-width="2"/>
  <path d="M12 13 L21 20 L12 27" fill="none" stroke="#34d399" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`

const icon = token => (token === 'svg:terminal' ? TERMINAL_SVG : escapeHtml(token))
const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** [icon token or html, match criteria, explanation] */
const STATE_ROWS = [
  ['\u{1F642}', 'agent state: waiting', 'No turn running. The idle face at the bottom of the stack.'],
  [TABLE['thinking'], "agent state: thinking (rule key 'thinking')", 'A turn is running with no tool call in flight (pi-web glyph).'],
  ['\u{1F636}', 'agent state: error', "The session's last agent turn reported an error (lastAgentError)."],
  ['badge', 'agent state: blocked on you', 'A pending interaction (tool approval / question) waits on your input: current tool icon (or 🔧) with a ✋ badge.'],
]

const TOOL_EXPLANATIONS = {
  default: 'Fallback for any tool without a matching rule.',
  thinking: 'Reasoning phase (also listed under agent states).',
  bash: 'Shell execution: terminal SVG (gray-bordered black square, green prompt) — replaces pi-web\u2019s off-center "$" text glyph. Compound/control-flow lines (e.g. leading "if") keep this icon.',
  edit: 'File modification (targeted replace).',
  write: 'File creation / full overwrite.',
  read: 'Read a file into context.',
  read_image: 'Read an image file (DSH addition; same eye as read).',
  web_search: 'Web search query.',
  web_fetch: 'Fetch one URL (DSH addition; same globe as web_search).',
  get_search_content: 'Fetch search-result content (pi-web tool).',
  glob: 'Find files by path pattern (DSH addition).',
  grep: 'Search file contents (DSH addition).',
  subagent: 'Delegate a task to a subagent (DSH addition).',
  subagent_fork: 'Delegate with inherited conversation (DSH addition).',
  ctx_execute: 'pi-web code-execution tool (kept for table parity).',
  ctx_execute_file: 'pi-web code-execution tool (kept for table parity).',
  ctx_batch_execute: 'pi-web code-execution tool (kept for table parity).',
}

const BASH_EXPLANATIONS = {
  rg: 'ripgrep — searching (pi-web rule)',
  grep: 'grep — searching (pi-web rule)',
  ag: 'the silver searcher (pi-web rule)',
  fd: 'fd — file find (pi-web rule)',
  find: 'find — file find (pi-web rule)',
  sleep: 'sleep — waiting on a timer (mined from session)',
  pwd: 'pwd — where am I (mined from session)',
  ls: 'ls — listing a directory (mined from session)',
  df: 'df — disk usage (mined from session)',
  echo: 'echo — printing output (mined from session)',
  cal: 'cal — calendar (mined from session)',
  shasum: 'shasum — hashing, the literal hash sign (mined from session)',
  seq: 'seq — number sequences (mined from session)',
  sw_vers: 'sw_vers — macOS version info (mined from session)',
}

function row(iconHtml, criteria, explanation) {
  return `<tr>
    <td class="cell"><div class="entry">${iconHtml}</div></td>
    <td class="criteria"><code>${escapeHtml(criteria)}</code></td>
    <td class="explain">${escapeHtml(explanation)}</td>
  </tr>`
}

const rows = []
rows.push(`<tr class="section"><td colspan="3">Agent states</td></tr>`)
for (const [token, criteria, explanation] of STATE_ROWS) {
  const html = token === 'badge'
    ? `${icon(resolveToolGlyph('default'))}<span class="badge">\u270B</span>`
    : icon(token)
  rows.push(row(html, criteria, explanation))
}
rows.push(`<tr class="section"><td colspan="3">Tools (exact tool-name rules)</td></tr>`)
for (const [key, value] of Object.entries(TABLE)) {
  if (key.includes('?') || key === 'thinking' || key === 'default') continue
  rows.push(row(icon(value), key, TOOL_EXPLANATIONS[key] ?? 'Tool rule.'))
}
rows.push(row(icon(TABLE['default']), 'default', TOOL_EXPLANATIONS['default']))
rows.push(`<tr class="section"><td colspan="3">Bash command rules (basename of the command line's first token)</td></tr>`)
for (const [key, value] of Object.entries(TABLE)) {
  if (!key.startsWith('bash?cmd=')) continue
  const cmd = key.slice('bash?cmd='.length)
  rows.push(row(icon(value), key, BASH_EXPLANATIONS[cmd] ?? 'Command rule.'))
}

const html = `<!doctype html>
<meta charset="utf-8">
<title>agent-status-indicator — icon gallery</title>
<style>
  body {
    background: #151517; /* sampled from the dsh web GUI chat area (dark) */
    color: #d6d6d8;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    margin: 40px auto;
    max-width: 860px;
    padding: 0 20px;
  }
  h1 { font-size: 18px; font-weight: 600; }
  p.note { color: #8a8a8e; }
  table { border-collapse: collapse; width: 100%; }
  td { padding: 8px 14px; border-top: 1px solid #26262a; vertical-align: middle; }
  tr.section td { padding-top: 28px; border: none; color: #8a8a8e; font-weight: 600; }
  td.cell { width: 60px; }
  /* Exactly the indicator's entry styling */
  .entry {
    position: relative;
    width: 48px;
    height: 48px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 40px;
    line-height: 1;
    user-select: none;
    filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.3));
  }
  .badge { position: absolute; right: -4px; top: -8px; font-size: 20px; }
  code { color: #b0c8f8; background: #1e1e22; padding: 1px 6px; border-radius: 5px; }
  td.criteria { width: 240px; }
  td.explain { color: #a8a8ac; }
</style>
<h1>agent-status-indicator — icon gallery</h1>
<p class="note">Rendered as displayed in the GUI: chat-area background #151517, 48px cell, 40px glyph,
drop shadow. Rules resolve exact tool name &gt; argument rules (bash leading command) &gt; prefix; generated
from the live rule table by <code>scripts/gen-icon-gallery.mjs</code>.</p>
<table>${rows.join('\n')}</table>
`
writeFileSync('gallery/icon-gallery.html', html)
console.log('wrote gallery/icon-gallery.html')
