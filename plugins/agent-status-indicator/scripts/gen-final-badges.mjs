/**
 * Generate the FINAL annotation-badge set: for each document type, the icon
 * that will annotate activity marks (the edit pencil, the read eyeball, ...).
 *
 * Rule: `badge` wins when present and passes through UNTOUCHED — framed
 * artwork needs no added rectangle, that is what makes it a badge (a
 * badgeTint renders as a bare silhouette). An unframed `deco` is composed
 * onto a rounded rectangle: `decoBg`-coloured, dark gray by default, with
 * modest rounding and tight packing. `decoTint` silhouettes use an
 * alpha-type mask so the composed file stands alone.
 *
 * Outputs gallery/final/<id>.svg (one standalone file per type; every
 * internal id namespaced by type so any subset can be inlined into one HTML
 * document) and gallery/final-badges.html for review.
 */
import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

await build({
  entryPoints: ['src/client/docTypes.ts'],
  outfile: '/tmp/tali-doctypes-final.mjs',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
})
const { DOC_TYPES } = await import('/tmp/tali-doctypes-final.mjs')

/** Default dark-gray deco background when the type declares no decoBg. */
const NEUTRAL_BG = '#4a4a4f'
/** Deco box: devicon-style inset, modest rounding. */
const BOX = { inset: 1.5, size: 125, radius: 10 }
/** Tight packing: the deco glyph occupies 84% of the canvas, centred. */
const GLYPH_SCALE = 0.84

const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const readIcon = file => readFileSync(`src/client/icons/${file}`, 'utf8').replace(/^<\?xml[^>]*\?>\s*/, '')

/** Suffix every internal id (and its references) with the type id. */
function namespaceIds(content, key) {
  const ids = [...content.matchAll(/\sid="([^"]+)"/g)].map(m => m[1])
  let out = content
  for (const id of ids) {
    out = out
      .replaceAll(` id="${id}"`, ` id="${id}-${key}"`)
      .replaceAll(`url(#${id})`, `url(#${id}-${key})`)
      .replaceAll(`href="#${id}"`, `href="#${id}-${key}"`)
  }
  return out
}

/** Strip the outer <svg> wrapper, returning inner content and viewBox box. */
function unwrap(content) {
  const vb = content.match(/viewBox="(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+)"/)
  if (vb === null) throw new Error('icon without viewBox')
  const inner = content.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
  return { inner, x: Number(vb[1]), y: Number(vb[2]), size: Math.max(Number(vb[3]), Number(vb[4])) }
}

/** Transform placing an unwrapped icon centred at GLYPH_SCALE on the 128 canvas. */
function fitTransform(box) {
  const s = (128 * GLYPH_SCALE) / box.size
  const offset = (128 - 128 * GLYPH_SCALE) / 2
  return `translate(${(offset - box.x * s).toFixed(2)},${(offset - box.y * s).toFixed(2)}) scale(${s.toFixed(4)})`
}

/** Compose one final annotation badge as a standalone 128-canvas SVG. */
function finalSvg(type) {
  if (type.badge !== undefined) {
    // Framed artwork is already a complete badge; pass through (namespaced).
    // badgeTint types render as silhouette on the neutral chip.
    if (type.badgeTint === undefined) return namespaceIds(readIcon(type.badge), type.id)
    // Tinted badge: bare silhouette at full size — no added rectangle.
    const box = unwrap(namespaceIds(readIcon(type.badge), type.id))
    const s = 128 / box.size
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
<defs><mask id="tintm-${type.id}" maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128" style="mask-type:alpha">
<g transform="translate(${(-box.x * s).toFixed(2)},${(-box.y * s).toFixed(2)}) scale(${s.toFixed(4)})">${box.inner}</g>
</mask></defs>
<rect width="128" height="128" fill="${type.badgeTint}" mask="url(#tintm-${type.id})"/>
</svg>
`
  }
  if (type.deco === undefined) return undefined
  const box = unwrap(namespaceIds(readIcon(type.deco), type.id))
  const bgRect = `<rect x="${BOX.inset}" y="${BOX.inset}" width="${BOX.size}" height="${BOX.size}" rx="${BOX.radius}" fill="${type.decoBg ?? NEUTRAL_BG}"/>`
  if (type.decoTint !== undefined) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
${bgRect}
<defs><mask id="tintm-${type.id}" maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128" style="mask-type:alpha">
<g transform="${fitTransform(box)}">${box.inner}</g>
</mask></defs>
<rect width="128" height="128" fill="${type.decoTint}" mask="url(#tintm-${type.id})"/>
</svg>
`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
${bgRect}
<g transform="${fitTransform(box)}">${box.inner}</g>
</svg>
`
}

mkdirSync('gallery/final', { recursive: true })
const rows = []
for (const type of DOC_TYPES) {
  const svg = finalSvg(type)
  const rule = type.badge !== undefined
    ? `badge <code>${type.badge}</code>${type.badgeTint !== undefined ? ` (tint ${type.badgeTint})` : ''}`
    : type.deco !== undefined
      ? `deco <code>${type.deco}</code> on ${type.decoBg !== undefined ? `<code>${type.decoBg}</code>` : `neutral gray <code>${NEUTRAL_BG}</code>`}`
      : 'none'
  if (svg === undefined) {
    rows.push(`<tr><td class="cell"><span class="none">\u2014</span></td><td class="cell"><span class="none">\u2014</span></td>
      <td class="lang">${escapeHtml(type.name)} <code>${type.id}</code></td><td class="explain">${rule}</td></tr>`)
    continue
  }
  writeFileSync(`gallery/final/${type.id}.svg`, svg)
  rows.push(`<tr>
  <td class="cell"><div class="fin">${svg}</div></td>
  <td class="cell"><div class="fin small">${svg}</div></td>
  <td class="lang">${escapeHtml(type.name)} <code>${type.id}</code></td>
  <td class="explain">${rule} &middot; <code>final/${type.id}.svg</code> &middot; ${escapeHtml(type.exts.join(' '))}</td>
</tr>`)
}

const html = `<!doctype html>
<meta charset="utf-8">
<title>final annotation badges</title>
<style>
  body { background:#151517; color:#d6d6d8; font:14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         margin:40px auto; max-width:820px; padding:0 20px; }
  h1 { font-size:18px; font-weight:600; }
  p.note { color:#8a8a8e; }
  table { border-collapse:collapse; width:100%; }
  td { padding:8px 12px; border-top:1px solid #26262a; vertical-align:middle; }
  th { text-align:left; color:#8a8a8e; font-weight:600; padding:8px 12px; }
  td.cell { width:56px; }
  .fin { width:40px; height:40px; display:flex; filter:drop-shadow(0 2px 6px rgba(0,0,0,0.3)); }
  .fin.small { width:20px; height:20px; }
  .fin svg { width:100%; height:100%; }
  td.lang { width:170px; white-space:nowrap; }
  td.explain { color:#a8a8ac; }
  .none { color:#4a4a4e; }
  code { color:#b0c8f8; background:#1e1e22; padding:1px 5px; border-radius:5px; }
</style>
<h1>final annotation badges</h1>
<p class="note">The set that will annotate activity icons (edit pencil, read eyeball, ...).
Rule: <b>badge</b> when present (as-is, no added frame), else the <b>deco</b> packed tight on a
modestly-rounded rectangle — <code>decoBg</code>-coloured, dark gray <code>${NEUTRAL_BG}</code> by default. Shown at 40px and at annotation size (20px).
Standalone files in <code>gallery/final/</code>; generated by <code>scripts/gen-final-badges.mjs</code>.</p>
<table>
<tr><th>final</th><th>20px</th><th>type</th><th>rule · file · exts</th></tr>
${rows.join('\n')}
</table>
`
writeFileSync('gallery/final-badges.html', html)
console.log(`wrote gallery/final-badges.html + ${DOC_TYPES.filter(t => t.badge !== undefined || t.deco !== undefined).length} final svgs`)
