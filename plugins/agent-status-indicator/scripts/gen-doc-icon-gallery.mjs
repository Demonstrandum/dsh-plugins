/**
 * Generate gallery/doc-icon-gallery.html from the document-type registry
 * (src/client/docTypes.ts) and the assets in src/client/icons/. Shows, per
 * type: the standard SVG, the small/badge fallback built from bg/fg, and the
 * composed document icon (page outline + mark). Indicator display constants:
 * chat bg #151517, 48px cell, drop shadow. Gallery-only; the app does not
 * import the registry yet.
 */
import { build } from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'

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

/** Inline mark: plain svg, or silhouette tint via CSS mask when `tint` set. */
function mark(type, sizeClass) {
  if (type.svg === undefined) return badge(type, sizeClass)
  if (type.tint !== undefined) {
    const m = `url("data:image/svg+xml;utf8,${encodeURIComponent(svgText(type.svg))}")`
    return `<div class="tintmark ${sizeClass}" style="background-color:${type.tint};`
      + `-webkit-mask-image:${m};mask-image:${m}"></div>`
  }
  return `<div class="svgmark ${sizeClass}">${svgText(type.svg)}</div>`
}

/** The bg/fg monogram badge (used as the small-size / no-svg fallback). */
function badge(type, sizeClass) {
  return `<div class="badgemark ${sizeClass}" style="background:${type.bg ?? '#55565b'};color:${type.fg ?? '#fff'}">`
    + `${escapeHtml(type.id)}</div>`
}

const PAGE_SVG = `<svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
  <path d="M9 3 h14 l8 8 v26 h-22 z" fill="#0b0b0d" stroke="#8a8a8e" stroke-width="2" stroke-linejoin="round"/>
  <path d="M23 3 v8 h8" fill="none" stroke="#8a8a8e" stroke-width="2" stroke-linejoin="round"/>
</svg>`

const rows = DOC_TYPES.map(type => `<tr>
  <td class="cell"><div class="entry">${mark(type, 'base')}</div></td>
  <td class="cell"><div class="entry">${type.svgSmall !== undefined ? mark({ ...type, svg: type.svgSmall }, 'small') : badge(type, 'small')}</div></td>
  <td class="cell"><div class="entry"><div class="doc">${PAGE_SVG}<div class="dochole">${mark(type, 'indoc')}</div></div></div></td>
  <td class="lang">${escapeHtml(type.name)} <code>${type.id}</code></td>
  <td class="colors">${type.bg !== undefined ? `<span class="swatch" style="background:${type.bg}"></span><code>${type.bg}</code>` : ''}
    ${type.fg !== undefined ? `<span class="swatch" style="background:${type.fg}"></span><code>${type.fg}</code>` : ''}</td>
  <td class="explain">${type.svg !== undefined ? `<code>${type.svg}</code>` : 'badge only'}${type.tint !== undefined ? ` &middot; tint ${type.tint}` : ''}
    &middot; ${escapeHtml(type.exts.join(' '))}</td>
</tr>`).join('\n')

const html = `<!doctype html>
<meta charset="utf-8">
<title>document-type registry — icon gallery</title>
<style>
  body { background:#151517; color:#d6d6d8; font:14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         margin:40px auto; max-width:980px; padding:0 20px; }
  h1 { font-size:18px; font-weight:600; }
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
  .tintmark { -webkit-mask-size:contain; mask-size:contain; -webkit-mask-repeat:no-repeat; mask-repeat:no-repeat;
              -webkit-mask-position:center; mask-position:center; }
  .badgemark { border-radius:6px; display:flex; align-items:center; justify-content:center;
               font:700 12px/1 'SF Mono', Menlo, monospace; }
  .badgemark.base { width:36px; height:36px; font-size:15px; border-radius:8px; }
  .badgemark.small { width:22px; height:22px; }
  .doc { position:relative; width:40px; height:40px; }
  .dochole { position:absolute; left:0; right:0; top:14px; bottom:5px; display:flex; align-items:center; justify-content:center; }
  td.lang { width:160px; white-space:nowrap; }
  td.colors { width:210px; white-space:nowrap; }
  .swatch { display:inline-block; width:12px; height:12px; border-radius:3px; margin:0 4px 0 8px;
            vertical-align:-1px; border:1px solid #3a3a3e; }
  td.explain { color:#a8a8ac; }
  code { color:#b0c8f8; background:#1e1e22; padding:1px 5px; border-radius:5px; }
</style>
<h1>document-type registry — icon gallery</h1>
<p class="note">From <code>src/client/docTypes.ts</code>: long/short name, optional standard/small SVG
(pi-web assets, plus devicon &amp; material-icon-theme, both MIT — see <code>src/client/icons/README.md</code>),
optional bg/fg badge colours. Columns: standard mark &middot; small-size fallback (bg/fg badge; a
<code>svgSmall</code> would replace it) &middot; composed document icon. Mono/dark artwork (rust, perl, json,
markdown) is silhouette-tinted. Generated by <code>scripts/gen-doc-icon-gallery.mjs</code>.</p>
<table>
<tr><th>standard</th><th>small</th><th>document</th><th>type</th><th>bg / fg</th><th>asset · exts</th></tr>
${rows}
</table>
`
writeFileSync('gallery/doc-icon-gallery.html', html)
console.log('wrote gallery/doc-icon-gallery.html')
