#!/usr/bin/env node
/**
 * Assemble the self-contained macOS app and its DMG from the staged pieces:
 *
 *   dist/bundle/stage/     tools/bundle/stage-dsh.mjs   (fork + plugins, production closure)
 *   dist/bundle/node/      tools/bundle/fetch-node.mjs  (official Node LTS build)
 *   dock-app/build/DSH     dsh-tailscale-remote's Swift wrapper (compiled here if stale)
 *
 *   node tools/bundle/build-app.mjs [--name DSH] [--port 3090] [--sign IDENTITY] [--no-dmg]
 *                                   [--version X.Y.Z] [--out dist/bundle]
 *
 * Layout (Contents/Resources): node/ (bin/node only), dsh/ (package.json +
 * node_modules), profile-template/ (package.json listing every bundled
 * plugin as a profile bundle + an empty cordis.patch.yml), dsh-dock-app.json
 * with the `embedded` block EmbeddedServer.swift reads, AppIcon.icns.
 *
 * Signing: `--sign -` (default) is ad-hoc — Gatekeeper shows "cannot verify"
 * on a downloaded DMG until the user right-clicks → Open once; pass a
 * `Developer ID Application: …` identity to sign for real (notarization is a
 * separate `xcrun notarytool submit` step this script does not run).
 * Node addons (.node) and the node binary are signed too: a deep signature
 * over a bundle with unsigned Mach-O files is rejected at launch by the
 * hardened runtime when a real identity is used.
 */
import { execFile } from 'node:child_process'
import { chmod, cp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const args = process.argv.slice(2)
const opt = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1] }
const OUT = resolve(opt('--out', join(REPO, 'dist', 'bundle')))
const STAGE = join(OUT, 'stage')
const NAME = opt('--name', 'DSH')
const PORT = Number(opt('--port', '3090'))
const SIGN = opt('--sign', '-')
const DMG = !args.includes('--no-dmg')
const BUNDLE_ID = 'io.github.taliesinb.dsh-app'

const dockApp = await import(pathToFileURL(join(REPO, 'plugins', 'dsh-tailscale-remote', 'dock-app.mjs')).href)

function log(msg) { process.stderr.write(`[build-app] ${msg}\n`) }
const readJson = async p => JSON.parse(await readFile(p, 'utf8'))

async function version() {
  if (opt('--version')) return opt('--version')
  const stage = await readJson(join(STAGE, 'package.json'))
  // CFBundleShortVersionString wants digits and dots; the fork's prerelease tag and the
  // repo's short SHA go into the marketing string only.
  const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO })
  return { short: stage.version.replace(/-.*$/, ''), full: `${stage.version}+${stdout.trim()}` }
}

/** Every Mach-O inside the resources that must carry a signature of its own. */
async function machOFiles(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) out.push(...await machOFiles(path))
    else if (entry.name.endsWith('.node') || entry.name.endsWith('.dylib') || path.endsWith('/bin/node')
      || path.endsWith('/rg') || path.endsWith('/spawn-helper') || path.endsWith('/landlock-run')) out.push(path)
  }
  return out
}

async function main() {
  const stagePkg = await readJson(join(STAGE, 'package.json'))
  const nodeInfo = await readJson(join(OUT, 'node', 'current.json'))
  const ver = await version()
  const app = join(OUT, `${NAME}.app`)
  const contents = join(app, 'Contents')
  const resources = join(contents, 'Resources')
  log(`building ${app} (dsh ${ver.full}, node ${nodeInfo.version}, ${stagePkg.dshBundle.plugins.length} plugins)`)

  const { executable, icns } = await dockApp.buildDockApp({ log })

  await rm(app, { recursive: true, force: true })
  await mkdir(join(contents, 'MacOS'), { recursive: true })
  await mkdir(resources, { recursive: true })
  await cp(executable, join(contents, 'MacOS', 'DSH'))
  await chmod(join(contents, 'MacOS', 'DSH'), 0o755)
  await cp(icns, join(resources, 'AppIcon.icns'))

  log('copying node')
  await mkdir(join(resources, 'node', 'bin'), { recursive: true })
  await cp(join(OUT, 'node', nodeInfo.dir, 'bin', 'node'), join(resources, 'node', 'bin', 'node'))
  await cp(join(OUT, 'node', nodeInfo.dir, 'LICENSE'), join(resources, 'node', 'LICENSE'))

  log('copying the staged installation')
  await mkdir(join(resources, 'dsh'), { recursive: true })
  await cp(join(STAGE, 'package.json'), join(resources, 'dsh', 'package.json'))
  // node_modules is hoisted (no links out of the tree); copy dereferences the few pnpm-internal symlinks.
  await cp(join(STAGE, 'node_modules'), join(resources, 'dsh', 'node_modules'), { recursive: true, dereference: true, verbatimSymlinks: false })

  const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...stagePkg.dshBundle.plugins.map(p => p.name)]
  await mkdir(join(resources, 'profile-template'), { recursive: true })
  await writeFile(join(resources, 'profile-template', 'package.json'), JSON.stringify({
    name: 'dsh-profile-app', private: true, dependencies: {}, dsh: { profile: { bundles } },
  }, null, 2) + '\n')
  await writeFile(join(resources, 'profile-template', 'cordis.patch.yml'), '# Your overrides for the bundled DSH app (applied after every bundle layer).\n[]\n')

  const config = {
    name: NAME,
    url: `http://127.0.0.1:${PORT}/`,
    glyphColor: null,
    embedded: {
      node: 'node/bin/node',
      dsh: 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',
      profile: 'app',
      port: PORT,
      profileTemplate: 'profile-template',
      dshHome: null,
    },
  }
  await writeFile(join(resources, 'dsh-dock-app.json'), JSON.stringify(config, null, 2) + '\n')
  await writeFile(join(resources, 'dsh-app-release.json'), JSON.stringify({
    version: ver.full, dsh: stagePkg.version, node: nodeInfo.version, plugins: stagePkg.dshBundle.plugins, builtAt: new Date().toISOString(),
  }, null, 2) + '\n')

  let plist = dockApp.infoPlist({ name: NAME, version: ver.short, bundleId: BUNDLE_ID })
  plist = plist.replace('<key>NSHighResolutionCapable</key>',
    `<key>LSMultipleInstancesProhibited</key><true/>\n  <key>CFBundleGetInfoString</key><string>${ver.full}</string>\n  <key>NSHighResolutionCapable</key>`)
  await writeFile(join(contents, 'Info.plist'), plist)
  await writeFile(join(contents, 'PkgInfo'), 'APPL????')

  log(`signing (${SIGN === '-' ? 'ad-hoc' : SIGN})`)
  const inner = await machOFiles(resources)
  for (const file of inner) {
    await execFileAsync('/usr/bin/codesign', ['--force', '--sign', SIGN, ...(SIGN === '-' ? [] : ['--options', 'runtime', '--timestamp']), file])
  }
  await execFileAsync('/usr/bin/codesign', ['--force', '--sign', SIGN, '--identifier', BUNDLE_ID, ...(SIGN === '-' ? [] : ['--options', 'runtime', '--timestamp']), app])
  await execFileAsync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
  const size = (await execFileAsync('du', ['-sh', app])).stdout.split('\t')[0]
  log(`app ready: ${app} (${size}, ${inner.length} inner Mach-O files signed)`)

  if (DMG) {
    const dmg = join(OUT, `${NAME}-${ver.full.replace(/\+/g, '-')}.dmg`)
    const staging = join(OUT, 'dmg-root')
    await rm(staging, { recursive: true, force: true })
    await rm(dmg, { force: true })
    await mkdir(staging, { recursive: true })
    await cp(app, join(staging, `${NAME}.app`), { recursive: true, verbatimSymlinks: true })
    await symlink('/Applications', join(staging, 'Applications'))
    log('creating the DMG')
    await execFileAsync('/usr/bin/hdiutil', ['create', '-volname', NAME, '-srcfolder', staging, '-ov', '-format', 'ULMO', '-fs', 'APFS', dmg], { maxBuffer: 16 * 1024 * 1024 })
    await rm(staging, { recursive: true, force: true })
    const dmgSize = (await stat(dmg)).size
    log(`dmg ready: ${dmg} (${(dmgSize / 1024 / 1024).toFixed(0)} MB)`)
    process.stdout.write(dmg + '\n')
  } else {
    process.stdout.write(app + '\n')
  }
}

main().catch(err => { console.error(err); process.exit(1) })
