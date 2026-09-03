/**
 * Generate gallery/doc-icon-gallery.html: candidate per-language icons for
 * file-touching activity (edit/write/read), shown two ways per language:
 *   1. the BASE language mark (pi-web `lang-*.svg` asset where one exists,
 *      inlined from ~/github/pi-web; otherwise a derived monogram badge), and
 *   2. the composed DOCUMENT icon: a simple page outline (same gray-border /
 *      black-fill family as the indicator's terminal icon) with the language
 *      mark rendered inside it.
 *
 * DSH itself ships no per-language icons (checked packages/client/ui-primitives:
 * only generic file/folder glyphs) but owns the path->language codepath we will
 * later reuse for matching: `langFromPath` + LANG_BY_EXTENSION in
 * <checkout>/packages/fs/tool-fs/src/read-render.ts. The `exts` lists below
 * mirror that table.
 *
 * Same display constants as the live indicator: chat bg #151517, 48px cell,
 * 40px icon, drop shadow. Iterating on looks only; no activity rules yet.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const PI_ICONS = '/Users/USER/github/pi-web/src/client/src/icons'

/** pi-web's TINT: mono/dark logos re-coloured to stay legible on dark. */
const TINT = { 'lang-rust': '#f0863b', 'lang-perl': '#9aa7d8' }

/**
 * One language row.
 * svg: pi-web asset name. badge: derived monogram {text, mark, bg, fg}.
 * mark is the compact form drawn inside the document icon.
 * exts mirror DSH LANG_BY_EXTENSION (read-render.ts); '+' marks additions.
 */
const LANGUAGES = [
  { id: 'py', name: 'Python', svg: 'lang-python', exts: 'py' },
  { id: 'html', name: 'HTML', badge: { text: '<>', mark: '<>', bg: '#e34f26', fg: '#fff' }, exts: 'html htm' },
  { id: 'svg', name: 'SVG', badge: { text: 'SVG', mark: 'S', bg: '#ffb13b', fg: '#1b1b1d' }, exts: 'svg (+; DSH maps it via xml only)' },
  { id: 'js', name: 'JavaScript', svg: 'lang-javascript', exts: 'js jsx mjs cjs' },
  { id: 'ts', name: 'TypeScript', svg: 'lang-typescript', exts: 'ts tsx mts cts' },
  { id: 'go', name: 'Go', svg: 'lang-go', exts: 'go' },
  { id: 'json', name: 'JSON', badge: { text: '{}', mark: '{}', bg: '#55565b', fg: '#f5de19' }, exts: 'json jsonc' },
  { id: 'toml', name: 'TOML', badge: { text: 'TOML', mark: 'T', bg: '#9c4121', fg: '#fff', small: true }, exts: 'toml' },
  { id: 'md', name: 'Markdown', badge: { text: 'M\u2193', mark: 'M\u2193', bg: '#519aba', fg: '#fff' }, exts: 'md markdown (mdx)' },
  { id: 'yaml', name: 'YAML', badge: { text: 'Y:', mark: 'Y', bg: '#cb171e', fg: '#fff' }, exts: 'yaml yml' },
  { id: 'css', name: 'CSS', badge: { text: 'CSS', mark: 'C', bg: '#264de4', fg: '#fff', small: true }, exts: 'css (scss less have own ids)' },
  { id: 'sh', name: 'Shell', svg: 'lang-shell', exts: 'sh bash zsh' },
  { id: 'rb', name: 'Ruby', svg: 'lang-ruby', exts: 'rb' },
  { id: 'rs', name: 'Rust', svg: 'lang-rust', exts: 'rs' },
  { id: 'php', name: 'PHP', svg: 'lang-php', exts: 'php' },
  { id: 'cs', name: 'C#', svg: 'lang-csharp', exts: 'cs' },
  { id: 'perl', name: 'Perl', svg: 'lang-perl', exts: 'pl pm (+; not in DSH map)' },
  { id: 'r', name: 'R', svg: 'lang-r', exts: 'r (+; not in DSH map)' },
  { id: 'elixir', name: 'Elixir', svg: 'lang-elixir', exts: 'ex exs (+; not in DSH map)' },
]

/** Inline one pi-web SVG (XML prolog stripped); CSS controls its box size. */
function inlineSvg(name) {
  const raw = readFileSync(`${PI_ICONS}/${name}.svg`, 'utf8')
  return raw.replace(/^<\?xml[^>]*\?>\s*/, '')
}

/** Silhouette-tint a mono logo via CSS mask (pi-web 'tinted' equivalent). */
function tinted(name, color, sizeClass) {
  const encoded = encodeURIComponent(inlineSvg(name))
  const mask = `url("data:image/svg+xml;utf8,${encoded}")`
  return `<div class="tintmark ${sizeClass}" style="background-color:${color};`
    + `-webkit-mask-image:${mask};mask-image:${mask}"></div>`
}

/** The base (standalone) mark at 40px. */
function baseMark(lang) {
  if (lang.svg !== undefined) {
    const tint = TINT[lang.svg]
    if (tint !== undefined) return tinted(lang.svg, tint, 'base')
    return `<div class="svgmark base">${inlineSvg(lang.svg)}</div>`
  }
  const b = lang.badge
  return `<div class="badgemark base${b.small === true ? ' small' : ''}"`
    + ` style="background:${b.bg};color:${b.fg}">${escapeHtml(b.text)}</div>`
}

/** The mark shrunk into the document page (~17px). */
function docMark(lang) {
  if (lang.svg !== undefined) {
    const tint = TINT[lang.svg]
    if (tint !== undefined) return tinted(lang.svg, tint, 'indoc')
    return `<div class="svgmark indoc">${inlineSvg(lang.svg)}</div>`
  }
  const b = lang.badge
  return `<div class="textmark" style="color:${b.bg === '#55565b' ? b.fg : b.bg}">${escapeHtml(b.mark)}</div>`
}

/** Page outline: same gray-border/black-fill family as the terminal icon. */
const PAGE_SVG = `<svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
  <path d="M9 3 h14 l8 8 v26 h-22 z" fill="#0b0b0d" stroke="#8a8a8e" stroke-width="2" stroke-linejoin="round"/>
  <path d="M23 3 v8 h8" fill="none" stroke="#8a8a8e" stroke-width="2" stroke-linejoin="round"/>
</svg>`

const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const rows = LANGUAGES.map(lang => `<tr>
  <td class="cell"><div class="entry">${baseMark(lang)}</div></td>
  <td class="cell"><div class="entry"><div class="doc">${PAGE_SVG}<div class="dochole">${docMark(lang)}</div></div></div></td>
  <td class="lang"><code>${lang.id}</code> ${escapeHtml(lang.name)}</td>
  <td class="explain">${lang.svg !== undefined
    ? `pi-web asset <code>${lang.svg}.svg</code>${TINT[lang.svg] !== undefined ? ` (tinted ${TINT[lang.svg]}, as in pi-web)` : ''}`
    : 'derived monogram (no pi-web asset)'} &middot; ext: <code>${escapeHtml(lang.exts)}</code></td>
</tr>`).join('\n')

const html = `<!doctype html>
<meta charset="utf-8">
<title>document / language icons — candidates</title>
<style>
  body { background:#151517; color:#d6d6d8; font:14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         margin:40px auto; max-width:920px; padding:0 20px; }
  h1 { font-size:18px; font-weight:600; }
  p.note { color:#8a8a8e; }
  table { border-collapse:collapse; width:100%; }
  td { padding:8px 14px; border-top:1px solid #26262a; vertical-align:middle; }
  td.cell { width:60px; }
  th { text-align:left; color:#8a8a8e; font-weight:600; padding:8px 14px; }
  .entry { position:relative; width:48px; height:48px; display:flex; align-items:center; justify-content:center;
           filter:drop-shadow(0 2px 6px rgba(0,0,0,0.3)); }
  .svgmark.base svg, .tintmark.base { width:36px; height:36px; }
  .tintmark { -webkit-mask-size:contain; mask-size:contain; -webkit-mask-repeat:no-repeat; mask-repeat:no-repeat;
              -webkit-mask-position:center; mask-position:center; }
  .badgemark { width:36px; height:36px; border-radius:8px; display:flex; align-items:center; justify-content:center;
               font:700 17px/1 'SF Mono', Menlo, monospace; }
  .badgemark.small { font-size:11px; letter-spacing:0.5px; }
  .doc { position:relative; width:40px; height:40px; }
  .dochole { position:absolute; left:0; right:0; top:14px; bottom:5px; display:flex; align-items:center; justify-content:center; }
  .svgmark.indoc svg, .tintmark.indoc { width:17px; height:17px; }
  .svgmark { display:flex; align-items:center; justify-content:center; }
  .textmark { font:700 14px/1 'SF Mono', Menlo, monospace; }
  td.lang { width:150px; white-space:nowrap; }
  td.explain { color:#a8a8ac; }
  code { color:#b0c8f8; background:#1e1e22; padding:1px 6px; border-radius:5px; }
</style>
<h1>document / language icons — candidates</h1>
<p class="note">Column 1: base language mark (pi-web <code>lang-*.svg</code> inlined, or derived monogram).
Column 2: the composed document icon — page outline in the terminal-icon family with the mark inside.
Rendered at indicator scale on the chat background (#151517). DSH has no per-language icons of its own;
extension lists mirror <code>LANG_BY_EXTENSION</code> in <code>packages/fs/tool-fs/src/read-render.ts</code>.
Generated by <code>scripts/gen-doc-icon-gallery.mjs</code>.</p>
<table>
<tr><th>base</th><th>document</th><th>language</th><th>source / extensions</th></tr>
${rows}
</table>
`
writeFileSync('gallery/doc-icon-gallery.html', html)
console.log('wrote gallery/doc-icon-gallery.html')
