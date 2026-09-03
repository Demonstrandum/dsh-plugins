/**
 * Generate gallery/doc-icon-gallery.html from the document-type registry
 * (src/client/docTypes.ts) and the assets in src/client/icons/. Section 1
 * shows, per type: the standard SVG (with tint silhouette or plate backdrop
 * when the artwork needs it), the small-size fallback pill from bg/fg, and
 * the composed document icon. Sections 2-3 browse the full material-icon-theme
 * and devicon sets (lazy remote images; hover for the key). Gallery-only; the
 * app does not import the registry yet.
 */
import { build } from 'esbuild'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

await build({
  entryPoints: ['src/client/docTypes.ts'],
  outfile: '/tmp/tali-doctypes-gallery.mjs',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
})
const { DOC_TYPES } = await import('/tmp/tali-doctypes-gallery.mjs')

const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const svgText = file => readFileSync(`src/client/icons/${file}`, 'utf8').replace(/^<\?xml[^>]*\?>\s*/, '')

/**
 * Inline mark. tint -> silhouette via CSS mask (NOTE: the data URL must use
 * single quotes inside the double-quoted style attribute, and encodeURIComponent
 * leaves apostrophes alone, so escape them manually). svgBg -> rounded plate.
 */
function mark(type, sizeClass) {
  if (type.svg === undefined) return badge(type, sizeClass)
  if (type.tint !== undefined) {
    const encoded = encodeURIComponent(svgText(type.svg)).replace(/'/g, '%27')
    const m = `url('data:image/svg+xml;utf8,${encoded}')`
    return `<div class="tintmark ${sizeClass}" style="background-color:${type.tint};`
      + `-webkit-mask-image:${m};mask-image:${m}"></div>`
  }
  const svg = `<div class="svgmark ${sizeClass}">${svgText(type.svg)}</div>`
  if (type.svgBg !== undefined) return `<div class="plate ${sizeClass}" style="background:${type.svgBg}">${svg}</div>`
  return svg
}

/** The bg/fg monogram pill (small-size / no-svg fallback); text auto-fits. */
function badge(type, sizeClass) {
  const text = type.badgeText ?? type.id
  const size = text.length >= 4 ? 10 : text.length === 3 ? 11 : 12
  return `<div class="badgemark ${sizeClass}" style="background:${type.bg ?? '#55565b'};color:${type.fg ?? '#fff'};`
    + `font-size:${sizeClass === 'base' ? size + 5 : size}px">${escapeHtml(text)}</div>`
}

/** Matching material-icon-theme key per type (validated against the index). */
const MATERIAL_KEY = {
  py: 'python', js: 'javascript', ts: 'typescript', go: 'go', html: 'html', css: 'css',
  json: 'json', toml: 'toml', yaml: 'yaml', md: 'markdown', svg: 'svg', sh: 'console',
  txt: 'document', log: 'log', exe: 'exe', tex: 'tex', img: 'image', xml: 'xml',
  sql: 'database', ini: 'settings', csv: 'table', rb: 'ruby', rs: 'rust', php: 'php',
  java: 'java', c: 'c', cpp: 'cpp', kt: 'kotlin', swift: 'swift', lua: 'lua',
  cs: 'csharp', perl: 'perl', r: 'r', elixir: 'elixir',
}

/** Matching devicon technology name per type (only true brand matches). */
const DEVICON_NAME = {
  py: 'python', js: 'javascript', ts: 'typescript', go: 'go', html: 'html5', css: 'css3',
  json: 'json', yaml: 'yaml', md: 'markdown', sh: 'bash', xml: 'xml', tex: 'latex',
  rb: 'ruby', rs: 'rust', php: 'php', java: 'java', c: 'c', cpp: 'cplusplus',
  kt: 'kotlin', swift: 'swift', lua: 'lua', cs: 'csharp', perl: 'perl', r: 'r', elixir: 'elixir',
}

const MATERIAL_SET = new Set(existsSync('scripts/data/material-index.json')
  ? JSON.parse(readFileSync('scripts/data/material-index.json', 'utf8')) : [])
const DEVICON_FILES = new Map((existsSync('scripts/data/devicon-index.json')
  ? JSON.parse(readFileSync('scripts/data/devicon-index.json', 'utf8')) : []).map(e => [e.name, e.file]))

/** Comparison cell: the third-party icon as-is (lazy remote img), or a dash. */
function materialCell(type) {
  const key = MATERIAL_KEY[type.id]
  if (key === undefined || !MATERIAL_SET.has(`${key}.svg`)) return '<span class="none">\u2014</span>'
  const url = `https://raw.githubusercontent.com/material-extensions/vscode-material-icon-theme/main/icons/${key}.svg`
  return `<span class="chip" title="${key}"><img loading="lazy" src="${url}" alt="${key}"></span>`
}

function deviconCell(type) {
  const name = DEVICON_NAME[type.id]
  const file = name === undefined ? undefined : DEVICON_FILES.get(name)
  if (file === undefined) return '<span class="none">\u2014</span>'
  const url = `https://raw.githubusercontent.com/devicons/devicon/master/icons/${name}/${file}`
  return `<span class="chip" title="${name}"><img loading="lazy" src="${url}" alt="${name}"></span>`
}

const PAGE_SVG = `<svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
  <path d="M9 3 h14 l8 8 v26 h-22 z" fill="#0b0b0d" stroke="#8a8a8e" stroke-width="2" stroke-linejoin="round"/>
  <path d="M23 3 v8 h8" fill="none" stroke="#8a8a8e" stroke-width="2" stroke-linejoin="round"/>
</svg>`

const rows = DOC_TYPES.map(type => `<tr>
  <td class="cell"><div class="entry">${mark(type, 'base')}</div></td>
  <td class="cell"><div class="entry">${type.svgSmall !== undefined ? mark({ ...type, svg: type.svgSmall }, 'small') : badge(type, 'small')}</div></td>
  <td class="cell"><div class="entry"><div class="doc">${PAGE_SVG}<div class="dochole">${mark(type, 'indoc')}</div></div></div></td>
  <td class="cell">${materialCell(type)}</td>
  <td class="cell">${deviconCell(type)}</td>
  <td class="lang">${escapeHtml(type.name)} <code>${type.id}</code></td>
  <td class="colors">${type.bg !== undefined ? `<span class="swatch" style="background:${type.bg}"></span><code>${type.bg}</code>` : ''}
    ${type.fg !== undefined ? `<span class="swatch" style="background:${type.fg}"></span><code>${type.fg}</code>` : ''}</td>
  <td class="explain">${type.svg !== undefined ? `<code>${type.svg}</code>` : 'badge only'}${type.tint !== undefined ? ` &middot; tint ${type.tint}` : ''}${type.svgBg !== undefined ? ` &middot; plate ${type.svgBg}` : ''}
    &middot; ${escapeHtml(type.exts.join(' '))}</td>
</tr>`).join('\n')

/** Browse strip of one remote icon set: filter input + lazy imgs, key in tooltip. */
function browseSection(title, note, items) {
  const chips = items.map(({ key, url }) =>
    `<span class="chip" title="${escapeHtml(key)}"><img loading="lazy" src="${url}" alt="${escapeHtml(key)}"></span>`).join('')
  return `<section><h2>${escapeHtml(title)}</h2><p class="note">${note}</p>
<p><input class="filter" type="search" placeholder="filter by key, e.g. python" oninput="filterStrip(this)"></p>
<div class="strip">${chips}</div></section>`
}

let browse = ''
if (existsSync('scripts/data/material-index.json')) {
  const names = JSON.parse(readFileSync('scripts/data/material-index.json', 'utf8'))
  browse += browseSection(
    `material-icon-theme — all file icons (${names.length})`,
    'MIT; folder-* variants filtered out. Hover an icon for its key; use it as <code>https://raw.githubusercontent.com/material-extensions/vscode-material-icon-theme/main/icons/&lt;key&gt;</code>.',
    names.map(name => ({
      key: name.replace(/\.svg$/, ''),
      url: `https://raw.githubusercontent.com/material-extensions/vscode-material-icon-theme/main/icons/${name}`,
    })))
}
if (existsSync('scripts/data/devicon-index.json')) {
  const entries = JSON.parse(readFileSync('scripts/data/devicon-index.json', 'utf8'))
  browse += browseSection(
    `devicon — all technologies (${entries.length}, preferred variant)`,
    'MIT; the <code>-original</code> (or first available) SVG variant per technology. Hover for the key.',
    entries.map(({ name, file }) => ({
      key: `${name} (${file})`,
      url: `https://raw.githubusercontent.com/devicons/devicon/master/icons/${name}/${file}`,
    })))
}

const html = `<!doctype html>
<meta charset="utf-8">
<title>document-type registry — icon gallery</title>
<style>
  body { background:#151517; color:#d6d6d8; font:14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         margin:40px auto; max-width:980px; padding:0 20px; }
  h1 { font-size:18px; font-weight:600; }
  h2 { font-size:15px; font-weight:600; margin-top:40px; color:#c8c8cc; }
  p.note { color:#8a8a8e; }
  table { border-collapse:collapse; width:100%; }
  td { padding:8px 12px; border-top:1px solid #26262a; vertical-align:middle; }
  th { text-align:left; color:#8a8a8e; font-weight:600; padding:8px 12px; }
  td.cell { width:56px; }
  .entry { position:relative; width:48px; height:48px; display:flex; align-items:center; justify-content:center;
           filter:drop-shadow(0 2px 6px rgba(0,0,0,0.3)); }
  .svgmark { display:flex; align-items:center; justify-content:center; }
  .svgmark.base svg, .tintmark.base { width:36px; height:36px; }
  .svgmark.small svg, .tintmark.small { width:20px; height:20px; }
  .svgmark.indoc svg, .tintmark.indoc { width:17px; height:17px; }
  .plate { display:flex; align-items:center; justify-content:center; }
  .plate.base { width:38px; height:38px; border-radius:9px; }
  .plate.base .svgmark svg { width:30px; height:30px; }
  .plate.small { width:22px; height:22px; border-radius:5px; }
  .plate.small .svgmark svg { width:17px; height:17px; }
  .plate.indoc { width:19px; height:19px; border-radius:4px; }
  .plate.indoc .svgmark svg { width:15px; height:15px; }
  .tintmark { -webkit-mask-size:contain; mask-size:contain; -webkit-mask-repeat:no-repeat; mask-repeat:no-repeat;
              -webkit-mask-position:center; mask-position:center; }
  .badgemark { display:inline-flex; align-items:center; justify-content:center;
               font-family:'SF Mono', Menlo, monospace; font-weight:700; }
  .badgemark.base { height:30px; border-radius:8px; padding:0 7px; }
  .badgemark.small { height:19px; border-radius:5px; padding:0 4px; }
  .badgemark.indoc { height:16px; border-radius:4px; padding:0 3px; }
  .doc { position:relative; width:40px; height:40px; }
  .dochole { position:absolute; left:0; right:0; top:14px; bottom:5px; display:flex; align-items:center; justify-content:center; }
  td.lang { width:150px; white-space:nowrap; }
  td.colors { width:210px; white-space:nowrap; }
  .swatch { display:inline-block; width:12px; height:12px; border-radius:3px; margin:0 4px 0 8px;
            vertical-align:-1px; border:1px solid #3a3a3e; }
  td.explain { color:#a8a8ac; }
  code { color:#b0c8f8; background:#1e1e22; padding:1px 5px; border-radius:5px; }
  .strip { display:flex; flex-wrap:wrap; gap:6px; }
  .chip { display:inline-flex; align-items:center; justify-content:center; width:30px; height:30px;
          background:#232327; border-radius:6px; }
  .chip img { width:22px; height:22px; }
  .none { color:#4a4a4e; }
  input.filter { background:#1e1e22; color:#d6d6d8; border:1px solid #3a3a3e; border-radius:6px;
                 padding:5px 10px; font:13px 'SF Mono', Menlo, monospace; width:280px; outline:none; }
  input.filter:focus { border-color:#4d93f8; }
</style>
<script>
function filterStrip(input) {
  const strip = input.closest('section').querySelector('.strip')
  const q = input.value.trim().toLowerCase()
  for (const chip of strip.children) {
    chip.style.display = q === '' || chip.title.toLowerCase().includes(q) ? '' : 'none'
  }
}
</script>
<h1>document-type registry — icon gallery</h1>
<p class="note">From <code>src/client/docTypes.ts</code>: long/short name, optional standard/small SVG,
optional <code>tint</code> (silhouette for mono artwork), <code>svgBg</code> (backdrop plate for artwork that
vanishes on dark), and bg/fg badge colours. Columns: standard mark &middot; small-size fallback pill
(a <code>svgSmall</code> would replace it) &middot; composed document icon. Assets: pi-web, devicon (MIT),
material-icon-theme (MIT) — see <code>src/client/icons/README.md</code>. Generated by
<code>scripts/gen-doc-icon-gallery.mjs</code>.</p>
<table>
<tr><th>standard</th><th>small</th><th>document</th><th>material</th><th>devicon</th><th>type</th><th>bg / fg</th><th>asset · exts</th></tr>
${rows}
</table>
${browse}
`
writeFileSync('gallery/doc-icon-gallery.html', html)
console.log('wrote gallery/doc-icon-gallery.html')
