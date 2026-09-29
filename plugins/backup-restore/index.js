import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { locations, listBackups, makeBackup, validateArchive } from './archive.mjs'
import { readRestoreStatus, restoreId, writeRestoreStatus } from './restore-status.mjs'

export const name = 'backup-restore'
export const inject = ['commands', 'webServer', 'connection']
export const CHANNEL = '/backup-restore'

/** The worker waits for shutdown before replacing state; the relay starts the restored home on the next connection. */
export function apply(ctx) {
  const { home, backups } = locations()
  const shownBackups = backups.startsWith(homedir() + '/') ? `~/${backups.slice(homedir().length + 1)}` : backups
  let restoring = false
  const backup = () => makeBackup({ home, backups })
  const restore = async filename => {
    if (restoring) throw new Error('restore is already pending')
    restoring = true
    let pendingId
    try {
      const selected = await validateArchive(backups, filename)
      const rollback = await makeBackup({ home, backups, kind: 'rollback' })
      const id = restoreId()
      pendingId = id
      const input = { name: filename, counts: selected.manifest.counts, bytes: selected.bytes }
      const rescue = { name: rollback.name, counts: rollback.counts, bytes: rollback.bytes }
      await writeRestoreStatus(backups, id, { state: 'pending', selected: input, rollback: rescue })
      const child = spawn(process.execPath, [fileURLToPath(new URL('./restore-worker.mjs', import.meta.url)), home, backups, filename, rollback.name, String(process.pid), id], { detached: true, stdio: 'ignore', env: process.env })
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      })
      child.unref()
      const result = { id, rollback: rescue, selected: input, shownBackups }
      setTimeout(() => { process.kill(process.pid, 'SIGTERM') }, 400)
      return result
    } catch (error) {
      restoring = false
      if (pendingId) {
        const previous = await readRestoreStatus(backups, pendingId)
        await writeRestoreStatus(backups, pendingId, { ...previous, state: 'failed', error: `Restore aborted before shutdown: ${String(error?.message ?? error)}` })
      }
      throw error
    }
  }
  ctx.effect(() => ctx.commands.register({
    name: 'backup', description: `Back up this DSH home to a ZIP under ${shownBackups}`,
    handler: async ({ rawInput }) => {
      if (rawInput.trim()) return { kind: 'error', text: 'Usage: /backup' }
      try {
        const saved = await backup()
        return { kind: 'success', text: `Wrote ${saved.counts.workspaces} workspaces and ${saved.counts.sessions} sessions to:\n\`${shownBackups}/${saved.name}\` (${(saved.bytes / 1_000_000).toFixed(1)} megabytes).` }
      }
      catch (error) { return { kind: 'error', text: `Backup failed: ${String(error?.message ?? error)}` } }
    },
  }), 'backup-restore: /backup')
  ctx.effect(() => ctx.commands.register({
    name: 'restore', description: 'Restore a complete DSH backup; bare /restore opens the backup chooser in the web GUI', input: { hint: 'backup filename' },
    handler: async ({ rawInput }) => {
      const filename = rawInput.trim()
      if (!filename) return { kind: 'success', text: `Available backups: ${(await listBackups(backups)).map(item => item.name).join(', ') || '(none)'}. Use /restore <filename> to restore.` }
      try { const result = await restore(filename); return { kind: 'success', text: `Restoring ${result.selected} after shutdown; rollback saved as ${result.rollback}. Reconnect to restart DSH.` } }
      catch (error) { return { kind: 'error', text: `Restore aborted: ${String(error?.message ?? error)}` } }
    },
  }), 'backup-restore: /restore')

  const fail = message => ({ ok: false, error: { code: 'backup-restore/error', message, details: {} } })
  const dispatch = async (endpoint, args) => {
    try {
      switch (endpoint) {
        case 'list': return { ok: true, value: { home, backups, shownBackups, archives: await listBackups(backups), restoring } }
        case 'backup': {
          const saved = await backup()
          return { ok: true, value: { ...saved, displayPath: `${shownBackups}/${saved.name}` } }
        }
        case 'restore': return { ok: true, value: await restore(args.name) }
        case 'status': {
          const status = await readRestoreStatus(backups, args.id)
          return status === undefined ? fail('Restore status not found') : { ok: true, value: status }
        }
        default: return fail('Unknown action')
      }
    } catch (error) { return fail(String(error?.message ?? error)) }
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: CHANNEL,
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) { res.writeHead(rejection); res.end('forbidden'); return }
      const endpoint = new URL(req.url ?? '/', 'http://localhost').pathname.slice(CHANNEL.length + 1)
      if (req.method !== 'POST' || !['list', 'backup', 'restore', 'status'].includes(endpoint)) { res.writeHead(404); res.end('not found'); return }
      try {
        const chunks = []
        let size = 0
        for await (const chunk of req) { size += chunk.length; if (size > 16 * 1024) throw new Error('request too large'); chunks.push(chunk) }
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (message?.type !== 'client-request' || typeof message.rpcId !== 'string' || message.method !== endpoint) throw new Error('invalid client-request')
        const result = await dispatch(endpoint, message.payload?.args ?? {})
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result }))
      } catch (error) { if (!res.headersSent) { res.writeHead(400); res.end(String(error?.message ?? error)) } }
    },
  }), 'backup-restore: control channel')
}
