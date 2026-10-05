#!/usr/bin/env node
/**
 * download-page — one self-contained HTML page: an icon per app variant, click
 * to download the newest release of that variant. Host it anywhere (it is a
 * single file, icons inlined).
 *
 *   node tools/bundle/download-page.mjs --out downloads.html \
 *     --app "DSH|taliesinb/dsh-plugins|canary|#000000" \
 *     --app "DSH Office|org/private-repo|remote-node-example-ts-net|#0090FF" \
 *     [--title "DSH downloads"]
 *
 * Each --app is `name|repo|channel|glyph-color`. The newest non-draft release
 * whose tag starts with `<channel>-` and whose DMG is named `<Name-with-dashes>-…dmg`
 * (the Updater's own two locks) is resolved NOW through `gh api`, and its
 * `browser_download_url` is written into the page — GitHub has no stable
 * "latest of this channel" URL, so the page is regenerated at release time
 * (the release scripts do). Private repos: the link works in a browser signed
 * in to GitHub with access to the repo; a release that cannot be read (no
 * access, or no release yet) renders the tile greyed out, without a link.
 *
 * Icons: rendered with the Dock app's own make-icon (the same tile every app
 * shows in the Dock), 256 px PNG, inlined as data URLs.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import * as dockApp from '../../plugins/dsh-tailscale-remote/dock-app.mjs'

const execFileAsync = promisify(execFile)
const args = process.argv.slice(2)
const opt = (flag, fallback) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : fallback }
const apps = args.flatMap((a, i) => (a === '--app' ? [args[i + 1]] : [])).map(parseApp)
const OUT = resolve(opt('--out', 'downloads.html'))
const TITLE = opt('--title', 'DSH')
if (!apps.length) { console.error('usage: download-page.mjs --out FILE --app "Name|owner/repo|channel|#glyph" [--app …]'); process.exit(2) }

function parseApp(spec) {
  const [name, repo, channel, glyph] = spec.split('|').map(s => s.trim())
  if (!name || !repo || !channel) throw new Error(`--app needs "Name|owner/repo|channel[|#glyph]", got ${JSON.stringify(spec)}`)
  return { name, repo, channel, glyph: glyph || '#000000' }
}

/** Mirror of Updater.parse: newest non-draft, non-prerelease release of the channel with a DMG named for the app. */
async function latest({ name, repo, channel }) {
  let releases
  try {
    const { stdout } = await execFileAsync('gh', ['api', `repos/${repo}/releases?per_page=50`], { maxBuffer: 16 * 1024 * 1024 })
    releases = JSON.parse(stdout)
  } catch (e) {
    return { error: `cannot read ${repo}: ${String(e.stderr || e.message).trim().split('\n')[0]}` }
  }
  const prefix = `${channel}-`, dmgPrefix = `${name.replace(/ /g, '-')}-`
  let best = null
  for (const r of releases) {
    if (!r.tag_name?.startsWith(prefix) || r.draft || r.prerelease) continue
    const build = Number(r.tag_name.slice(prefix.length))
    if (!Number.isInteger(build)) continue
    const dmg = (r.assets ?? []).find(a => a.name.endsWith('.dmg') && a.name.startsWith(dmgPrefix))
    if (!dmg) continue
    if (!best || build > best.build) best = { build, version: r.name, url: dmg.browser_download_url, size: dmg.size, published: r.published_at }
  }
  return best ?? { error: `no ${channel} release with a ${dmgPrefix}*.dmg in ${repo}` }
}

/** The Dock tile for this variant, 256 px PNG as a data URL. */
async function iconDataUrl(glyph) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-dl-icon-'))
  try {
    const iconset = join(dir, 'app.iconset')
    const tool = await iconToolPath()
    await execFileAsync(tool, [join(dockApp.DOCK_APP_DIR, 'icon.svg'), iconset, '--glyph-color', glyph])
    const files = await readdir(iconset)
    const pick = files.find(f => /256x256\.png$/.test(f) && !/@2x/.test(f)) ?? files.find(f => f.endsWith('.png'))
    const png = await readFile(join(iconset, pick))
    return `data:image/png;base64,${png.toString('base64')}`
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** make-icon compiled on demand, like buildDockApp does. */
async function iconToolPath() {
  const build = join(dockApp.DOCK_APP_DIR, 'build')
  const tool = join(build, 'make-icon')
  const src = join(dockApp.DOCK_APP_DIR, 'Tools', 'make-icon.swift')
  try { await readFile(tool) } catch {
    await execFileAsync('mkdir', ['-p', build])
    await execFileAsync('/usr/bin/xcrun', ['swiftc', '-O', '-o', tool, src, '-framework', 'Cocoa'], { maxBuffer: 8 * 1024 * 1024 })
  }
  return tool
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const mb = n => `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`

const tiles = []
for (const app of apps) {
  const [rel, icon] = await Promise.all([latest(app), iconDataUrl(app.glyph)])
  if (rel.error) console.error(`${app.name}: ${rel.error}`)
  else console.error(`${app.name}: ${rel.version} (build ${rel.build}, ${mb(rel.size)})`)
  tiles.push({ ...app, rel, icon })
}

const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(TITLE)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-content: center; gap: 48px;
         font: 15px/1.4 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
         background: #f5f5f4; color: #1c1c1e; }
  @media (prefers-color-scheme: dark) { body { background: #1c1c1e; color: #f5f5f4; } }
  .apps { display: flex; flex-wrap: wrap; justify-content: center; gap: 40px 56px; padding: 32px; }
  a.app, .app { display: flex; flex-direction: column; align-items: center; gap: 10px; width: 164px;
                text-decoration: none; color: inherit; }
  .app img { width: 128px; height: 128px; transition: transform .12s ease; }
  a.app:hover img { transform: scale(1.06); }
  a.app:active img { transform: scale(.98); }
  .name { font-weight: 600; font-size: 16px; }
  .ver { font-size: 12px; opacity: .55; font-variant-numeric: tabular-nums; }
  .app.off { opacity: .35; filter: grayscale(1); }
</style>
<div class="apps">
${tiles.map(t => t.rel.error
    ? `  <div class="app off" title="${esc(t.rel.error)}"><img src="${t.icon}" alt=""><div class="name">${esc(t.name)}</div><div class="ver">—</div></div>`
    : `  <a class="app" href="${esc(t.rel.url)}" download><img src="${t.icon}" alt=""><div class="name">${esc(t.name)}</div><div class="ver">${esc(t.rel.version.replace(new RegExp(`^${t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`), ''))} · ${mb(t.rel.size)}</div></a>`,
  ).join('\n')}
</div>
`
await writeFile(OUT, html)
console.error(`wrote ${OUT} (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB, ${tiles.length} apps)`)
