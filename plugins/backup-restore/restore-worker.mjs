import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { extractArchive, swapHome } from './archive.mjs'
import { readRestoreStatus, writeRestoreStatus } from './restore-status.mjs'

/** Detached worker: invoked after SIGTERM; the on-disk home must no longer have writers. */
export async function performRestore({ home, backups, name, rollback, id, log = join(backups, 'restore.log') }) {
  const parent = dirname(home)
  let stage
  let swapped = false
  const record = async text => { await appendFile(log, `${new Date().toISOString()} ${text}\n`, { mode: 0o600 }) }
  const report = async value => {
    if (id === undefined) return
    const previous = await readRestoreStatus(backups, id)
    await writeRestoreStatus(backups, id, { ...previous, ...value })
  }
  try {
    stage = await mkdtemp(join(parent, '.dsh-restore-'))
    const extracted = await extractArchive(backups, name, stage)
    await swapHome(home, extracted)
    swapped = true
    await record(`restored ${name}`)
    await report({ state: 'restored' })
    return { restored: name }
  } catch (error) {
    await record(`restore failed: ${String(error?.stack ?? error)}`)
    if (swapped) {
      await report({ state: 'restored', warning: `Home replaced, but result recording failed: ${String(error?.message ?? error)}` })
      return { restored: name }
    }
    if (rollback) {
      let rescue
      try {
        rescue = await mkdtemp(join(parent, '.dsh-rollback-'))
        const extracted = await extractArchive(backups, rollback, rescue)
        await swapHome(home, extracted)
        await record(`rollback restored ${rollback}`)
        await report({ state: 'rolled-back', error: String(error?.message ?? error) })
      } catch (rescueError) {
        await record(`ROLLBACK FAILED: ${String(rescueError?.stack ?? rescueError)}`)
        await report({ state: 'rollback-failed', error: String(error?.message ?? error), rollbackError: String(rescueError?.message ?? rescueError) })
        throw rescueError
      } finally { if (rescue) await rm(rescue, { recursive: true, force: true }) }
    } else await report({ state: 'failed', error: String(error?.message ?? error) })
    throw error
  } finally { if (stage) await rm(stage, { recursive: true, force: true }) }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [home, backups, name, rollback, pid, id] = process.argv.slice(2)
  const alive = () => { try { process.kill(Number(pid), 0); return true } catch { return false } }
  // Never write while the prior DSH process has stores open; fail rather than race a hung shutdown.
  const deadline = Date.now() + 60_000
  while (alive() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
  if (alive()) {
    const error = 'DSH process did not exit within 60 seconds; the current home was not replaced'
    await appendFile(join(backups, 'restore.log'), `${new Date().toISOString()} restore aborted: ${error}\n`, { mode: 0o600 })
    const previous = await readRestoreStatus(backups, id)
    await writeRestoreStatus(backups, id, { ...previous, state: 'failed', error })
    process.exitCode = 1
  } else {
    try { await performRestore({ home, backups, name, rollback, id }); process.exitCode = 0 }
    catch { process.exitCode = 1 }
  }
}
