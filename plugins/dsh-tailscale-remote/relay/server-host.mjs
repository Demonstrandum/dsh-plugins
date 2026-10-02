/**
 * The server host: a tiny background-only app bundle the relay LaunchAgent
 * runs in front of Node, so macOS privacy (TCC) treats DSH as an app.
 *
 *   ~/Library/Application Support/dsh-tailscale-remote/DSH Personal Server.app
 *     Contents/MacOS/dsh-server-host   (dock-app/ServerHost/main.swift)
 *     Contents/Info.plist              (bundle id + every privacy usage string)
 *     Contents/Resources/AppIcon.icns  (copied from the instance's Dock app)
 *
 * TCC charges a request to the *responsible* process: for a launchd job, the
 * job's own executable, inherited by everything it spawns. With the bare Node
 * symlink as the job that was Homebrew's ad-hoc `node` — no bundle, no usage
 * strings — so agent subprocesses were refused by policy (authReason 5) with no
 * prompt. With this host as the job the same requests name the bundle, macOS
 * shows its ordinary consent prompts, and Full Disk Access can be granted to
 * it in System Settings (FDA itself never prompts).
 *
 * The bundle is ad-hoc signed, so TCC pins grants to its cdhash. It is only
 * rewritten (and re-signed) when its executable, Info.plist or icon bytes
 * change; an unchanged reinstall keeps every grant.
 */
import { execFile } from 'node:child_process'
import { chmod, cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const SOURCE = join(PLUGIN_DIR, 'dock-app', 'ServerHost', 'main.swift')
const BUILD_DIR = join(PLUGIN_DIR, 'dock-app', 'build')
export const HOST_EXECUTABLE = 'dsh-server-host'
export const HOST_BUNDLE_ID = 'io.github.taliesinb.dsh-server-host'

export function hostBundleIdFor(instance = '') {
  return instance === '' ? HOST_BUNDLE_ID : `${HOST_BUNDLE_ID}.${instance}`
}

/** "DSH Server", "DSH Personal Server", "DSH Preview Server". */
export function hostNameFor(instance = '') {
  const label = instance.split(/[-_.\s]+/).filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(' ')
  return label === '' ? 'DSH Server' : `DSH ${label} Server`
}

export function hostBundlePath(supportDir, instance = '') {
  return join(supportDir, `${hostNameFor(instance)}.app`)
}

export function hostExecutablePath(bundle) {
  return join(bundle, 'Contents', 'MacOS', HOST_EXECUTABLE)
}

const PURPOSE = 'An agent running in DSH is asking for this.'
/** Every Info.plist purpose string macOS may require before it will prompt for a service. */
export const USAGE_KEYS = [
  'NSAppleEventsUsageDescription',
  'NSAppleMusicUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSCalendarsUsageDescription',
  'NSCalendarsFullAccessUsageDescription',
  'NSCameraUsageDescription',
  'NSContactsUsageDescription',
  'NSDesktopFolderUsageDescription',
  'NSDocumentsFolderUsageDescription',
  'NSDownloadsFolderUsageDescription',
  'NSFileProviderDomainUsageDescription',
  'NSLocalNetworkUsageDescription',
  'NSLocationUsageDescription',
  'NSLocationWhenInUseUsageDescription',
  'NSMicrophoneUsageDescription',
  'NSNetworkVolumesUsageDescription',
  'NSPhotoLibraryUsageDescription',
  'NSRemindersUsageDescription',
  'NSRemindersFullAccessUsageDescription',
  'NSRemovableVolumesUsageDescription',
  'NSSpeechRecognitionUsageDescription',
  'NSSystemAdministrationUsageDescription',
]

function xml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** @param {{ instance?: string, icon?: boolean }} spec */
export function hostInfoPlist(spec = {}) {
  const name = xml(hostNameFor(spec.instance ?? ''))
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>${name}</string>
  <key>CFBundleExecutable</key><string>${HOST_EXECUTABLE}</string>
${spec.icon ? '  <key>CFBundleIconFile</key><string>AppIcon</string>\n' : ''}  <key>CFBundleIdentifier</key><string>${xml(hostBundleIdFor(spec.instance ?? ''))}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>${name}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSBackgroundOnly</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
${USAGE_KEYS.map(key => `  <key>${key}</key><string>${PURPOSE}</string>`).join('\n')}
</dict>
</plist>
`
}

async function mtime(path) {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return 0
  }
}

async function bytes(path) {
  try {
    return await readFile(path)
  } catch {
    return undefined
  }
}

function same(a, b) {
  return a === undefined ? b === undefined : b !== undefined && a.equals(b)
}

/** Compile the host (cached by mtime). Returns the executable, or undefined without swiftc. */
export async function buildServerHost({ log = () => {}, force = false } = {}) {
  const executable = join(BUILD_DIR, HOST_EXECUTABLE)
  if (!force && (await mtime(executable)) >= (await mtime(SOURCE))) return executable
  try {
    await execFileAsync('/usr/bin/xcrun', ['--find', 'swiftc'])
  } catch {
    return undefined
  }
  await mkdir(BUILD_DIR, { recursive: true })
  log('relay: compiling the server host')
  const target = `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13.0`
  await execFileAsync('/usr/bin/xcrun', ['swiftc', '-O', '-target', target, '-o', executable, SOURCE], { maxBuffer: 8 * 1024 * 1024 })
  return executable
}

/**
 * Build the host if needed and make `bundle` match it, re-signing only on a change.
 * @param {{ supportDir: string, instance?: string, icon?: string, log?: (line: string) => void }} spec
 *   `icon`: an .icns to copy in (the instance's Dock app icon).
 * @returns {Promise<{ bundle: string, executable: string, changed: boolean } | undefined>} undefined without swiftc
 */
export async function ensureServerHost(spec) {
  const log = spec.log ?? (() => {})
  const instance = spec.instance ?? ''
  const built = await buildServerHost({ log })
  if (built === undefined) return undefined
  const bundle = hostBundlePath(spec.supportDir, instance)
  const contents = join(bundle, 'Contents')
  const wanted = {
    executable: await readFile(built),
    plist: Buffer.from(hostInfoPlist({ instance, icon: spec.icon !== undefined })),
    icon: spec.icon === undefined ? undefined : await bytes(spec.icon),
  }
  const current = {
    executable: await bytes(join(contents, 'MacOS', HOST_EXECUTABLE)),
    plist: await bytes(join(contents, 'Info.plist')),
    icon: await bytes(join(contents, 'Resources', 'AppIcon.icns')),
  }
  let signed = false
  try {
    await execFileAsync('/usr/bin/codesign', ['--verify', bundle])
    signed = true
  } catch {
    signed = false
  }
  if (signed && same(wanted.executable, current.executable) && same(wanted.plist, current.plist) && same(wanted.icon, current.icon)) {
    return { bundle, executable: hostExecutablePath(bundle), changed: false }
  }
  const staging = `${bundle}.staging-${String(process.pid)}`
  await rm(staging, { recursive: true, force: true })
  await mkdir(join(staging, 'Contents', 'MacOS'), { recursive: true })
  await writeFile(join(staging, 'Contents', 'Info.plist'), wanted.plist)
  await writeFile(join(staging, 'Contents', 'PkgInfo'), 'APPL????')
  await cp(built, join(staging, 'Contents', 'MacOS', HOST_EXECUTABLE))
  await chmod(join(staging, 'Contents', 'MacOS', HOST_EXECUTABLE), 0o755)
  if (wanted.icon !== undefined) {
    await mkdir(join(staging, 'Contents', 'Resources'), { recursive: true })
    await writeFile(join(staging, 'Contents', 'Resources', 'AppIcon.icns'), wanted.icon)
  }
  await execFileAsync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', hostBundleIdFor(instance), staging])
  // Replacing the bundle under a running job is fine: the process keeps its mapped image.
  await rm(bundle, { recursive: true, force: true })
  await rename(staging, bundle)
  log(`relay: server host ${bundle} ${current.executable === undefined ? 'created' : 'rewritten (privacy grants for it must be given again)'}`)
  return { bundle, executable: hostExecutablePath(bundle), changed: true }
}

export async function removeServerHost(supportDir, instance = '') {
  await rm(hostBundlePath(supportDir, instance), { recursive: true, force: true })
}
