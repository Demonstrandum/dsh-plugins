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
  if (type.brand === undefined) return badge(type, sizeClass)
  if (type.tint !== undefined) {
    const encoded = encodeURIComponent(svgText(type.brand)).replace(/'/g, '%27')
    const m = `url('data:image/svg+xml;utf8,${encoded}')`
    return `<div class="tintmark ${sizeClass}" style="background-color:${type.tint};`
      + `-webkit-mask-image:${m};mask-image:${m}"></div>`
  }
  const svg = `<div class="svgmark ${sizeClass}">${svgText(type.brand)}</div>`
  if (type.svgBg !== undefined) return `<div class="plate ${sizeClass}" style="background:${type.svgBg}">${svg}</div>`
  return svg
}

/** Framed decoration (self-backgrounded artwork), or a dash. */
function badgeCell(type, sizeClass) {
  if (type.badge === undefined) return '<span class="none">\u2014</span>'
  return `<div class="svgmark ${sizeClass}">${svgText(type.badge)}</div>`
}

/** Unframed decoration: bare glyph, optionally tinted, on its decoBg chip. */
function decoCell(type, sizeClass) {
  if (type.deco === undefined) return '<span class="none">\u2014</span>'
  let glyph
  if (type.decoTint !== undefined) {
    const encoded = encodeURIComponent(svgText(type.deco)).replace(/'/g, '%27')
    const m = `url('data:image/svg+xml;utf8,${encoded}')`
    glyph = `<div class="tintmark ${sizeClass}" style="background-color:${type.decoTint};`
      + `-webkit-mask-image:${m};mask-image:${m}"></div>`
  } else {
    glyph = `<div class="svgmark ${sizeClass}">${svgText(type.deco)}</div>`
  }
  if (type.decoBg === undefined) return glyph
  return `<div class="decochip ${sizeClass}" style="background:${type.decoBg}">${glyph}</div>`
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
  sql: 'database', ini: 'settings', csv: 'table', pdf: 'pdf', diff: 'diff', rb: 'ruby', rs: 'rust', php: 'php',
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

/**
 * Compose the document icon DYNAMICALLY (no static template asset): a rounded
 * solid dark-gray rectangle with the type's decoration flush in the
 * bottom-right corner (badge preferred, else deco on its decoBg chip, else
 * bare deco). The corner wrapper clips itself to the rectangle's own corner
 * radius, so a square badge follows the document's rounding. This function is
 * the reference for what the plugin will do at runtime in React.
 */
function documentIcon(type) {
  let corner = ''
  if (type.badge !== undefined) {
    corner = `<div class="svgmark cornerbadge">${svgText(type.badge)}</div>`
  } else if (type.deco !== undefined) {
    let glyph
    if (type.decoTint !== undefined) {
      const encoded = encodeURIComponent(svgText(type.deco)).replace(/'/g, '%27')
      const m = `url('data:image/svg+xml;utf8,${encoded}')`
      glyph = `<div class="tintmark cornerglyph" style="background-color:${type.decoTint};`
        + `-webkit-mask-image:${m};mask-image:${m}"></div>`
    } else {
      glyph = `<div class="svgmark cornerglyph">${svgText(type.deco)}</div>`
    }
    corner = type.decoBg !== undefined
      ? `<div class="cornerchip" style="background:${type.decoBg}">${glyph}</div>`
      : glyph
  }
  return `<div class="doc">${corner === '' ? '' : `<div class="corner">${corner}</div>`}</div>`
}

const rows = DOC_TYPES.map(type => `<tr>
  <td class="cell"><div class="entry">${mark(type, 'base')}</div></td>
  <td class="cell"><div class="entry">${badge(type, 'small')}</div></td>
  <td class="cell"><div class="entry">${badgeCell(type, 'deco')}</div></td>
  <td class="cell"><div class="entry">${decoCell(type, 'deco')}</div></td>
  <td class="cell"><div class="entry">${documentIcon(type)}</div></td>
  <td class="cell">${materialCell(type)}</td>
  <td class="cell">${deviconCell(type)}</td>
  <td class="lang">${escapeHtml(type.name)} <code>${type.id}</code></td>
  <td class="colors">${type.bg !== undefined ? `<span class="swatch" style="background:${type.bg}"></span><code>${type.bg}</code>` : ''}
    ${type.fg !== undefined ? `<span class="swatch" style="background:${type.fg}"></span><code>${type.fg}</code>` : ''}</td>
  <td class="colors">${type.decoBg !== undefined ? `<span class="swatch" style="background:${type.decoBg}"></span><code>${type.decoBg}</code>` : '<span class="none">\u2014</span>'}</td>
  <td class="explain">${type.badge !== undefined ? `badge <code>${type.badge}</code>` : type.deco !== undefined ? `deco <code>${type.deco}</code>` : 'no decoration'}${type.decoTint !== undefined ? ` &middot; deco tint ${type.decoTint}` : ''}
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
  .svgmark.deco svg, .tintmark.deco { width:24px; height:24px; }
  .decochip { display:flex; align-items:center; justify-content:center; border-radius:6px; }
  .decochip.deco { width:32px; height:32px; }
  .decochip.deco .svgmark svg, .decochip.deco .tintmark { width:20px; height:20px; }
  /* document template: rounded solid dark-gray rectangle, decoration flush
     bottom-right; the corner wrapper clips to the document's own radius */
  .doc { position:relative; width:34px; height:42px; background:#3a3a3f; border-radius:7px; }
  .doc .corner { position:absolute; right:0; bottom:0; display:flex;
                 border-bottom-right-radius:7px; overflow:hidden; }
  .cornerbadge svg { width:20px; height:20px; display:block; }
  .cornerchip { display:flex; align-items:center; justify-content:center; width:20px; height:20px; }
  .cornerchip .svgmark svg, .cornerchip .tintmark { width:14px; height:14px; }
  .cornerglyph svg, .tintmark.cornerglyph { width:17px; height:17px; }
  .svgmark.cornerglyph { margin:0 1px 1px 0; }
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
vanishes on dark), and bg/fg badge colours. Columns: brand mark (reference; mostly unused at runtime) &middot;
small-size fallback pill &middot; BADGE (framed decoration) &middot; DECO (unframed glyph, on its
<code>decoBg</code> chip when one is set) &middot; the document icon (dynamic composition: rounded dark-gray
rectangle, decoration flush bottom-right, corner clipped to the document radius) &middot;
material/devicon comparisons. Assets: pi-web, devicon (MIT),
material-icon-theme (MIT) — see <code>src/client/icons/README.md</code>. Generated by
<code>scripts/gen-doc-icon-gallery.mjs</code>.</p>
<table>
<tr><th>brand</th><th>small</th><th>badge</th><th>deco</th><th>document</th><th>material</th><th>devicon</th><th>type</th><th>bg / fg</th><th>deco-bg</th><th>asset · exts</th></tr>
${rows}
</table>
${browse}
`
writeFileSync('gallery/doc-icon-gallery.html', html)
console.log('wrote gallery/doc-icon-gallery.html')
