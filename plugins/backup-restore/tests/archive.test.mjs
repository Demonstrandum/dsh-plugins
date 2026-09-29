import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, readlink, symlink, writeFile, stat } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { archiveName, extractArchive, listBackups, locations, makeBackup, validateArchive } from '../archive.mjs'
import { performRestore } from '../restore-worker.mjs'
import { readRestoreStatus, restoreId, writeRestoreStatus } from '../restore-status.mjs'

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-backup-test-'))
  const home = join(root, 'home')
  const backups = join(root, 'backups')
  await mkdir(join(home, 'sessions', 'ws', 'one'), { recursive: true })
  await writeFile(join(home, 'settings.yaml'), 'original')
  await writeFile(join(home, 'sessions', 'ws', 'one', 'session.jsonl'), 'session')
  return { root, home, backups }
}

test('names have timestamp, machine, revision, counts and distinct rollback suffix', () => {
  const data = { date: new Date(2026, 8, 28, 14, 3, 4), host: 'example', commit: 'abc123', plugins: 5, workspaces: 1, sessions: 3 }
  assert.equal(archiveName({ ...data, kind: 'backup' }), 'y2026m09d28h14m03s04.hexample.fabc123.p5.w1.s3.backup.dsh.zip')
  assert.equal(archiveName({ ...data, kind: 'rollback' }), 'hexample--y2026-m09-d28-h14-m03-s04--cabc123-p5-w1-s3.rollback.dsh.zip')
})

test('backup captures state and restore replaces home, with rollback archive retained', async () => {
  const { home, backups } = await fixture()
  const backup = await makeBackup({ home, backups, commit: 'test' })
  assert.equal(backup.counts.sessions, 1)
  assert.equal((await listBackups(backups)).length, 1)
  await validateArchive(backups, backup.name)
  const rollback = await makeBackup({ home, backups, kind: 'rollback', commit: 'test' })
  await writeFile(join(home, 'settings.yaml'), 'changed')
  await writeFile(join(home, 'new.txt'), 'remove this')
  await performRestore({ home, backups, name: backup.name, rollback: rollback.name })
  assert.equal(await readFile(join(home, 'settings.yaml'), 'utf8'), 'original')
  assert.equal((await readdir(home)).includes('new.txt'), false)
  assert.equal((await listBackups(backups)).length, 2)
})

test('failed restore falls back to rollback without discarding current state before validation', async () => {
  const { home, backups } = await fixture()
  const rollback = await makeBackup({ home, backups, kind: 'rollback', commit: 'test' })
  await writeFile(join(home, 'settings.yaml'), 'interim')
  await assert.rejects(performRestore({ home, backups, name: 'missing.backup.dsh.zip', rollback: rollback.name }))
  assert.equal(await readFile(join(home, 'settings.yaml'), 'utf8'), 'original')
})

test('path traversal is refused and symlinks are retained without following targets', async () => {
  const { home, backups, root } = await fixture()
  await mkdir(backups)
  await assert.rejects(validateArchive(backups, '../other.backup.dsh.zip'), /choose a backup/)
  await symlink(join(home, 'settings.yaml'), join(home, 'alias'))
  const saved = await makeBackup({ home, backups, commit: 'test' })
  const stage = await mkdtemp(join(root, 'extract-'))
  const extracted = await extractArchive(backups, saved.name, stage)
  assert.equal(await readlink(join(extracted, 'alias')), join(home, 'settings.yaml'))
  assert.equal((await listBackups(backups)).length, 1)
})

test('live WAL writes are captured via SQLite backup, without WAL/SHM sidecars', async () => {
  const { home, backups, root } = await fixture()
  const path = join(home, 'state.db')
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE records (n INTEGER); INSERT INTO records VALUES (1);')
    assert.ok((await stat(`${path}-wal`)).size > 0)
    const saved = await makeBackup({ home, backups, commit: 'test' })
    const manifest = (await validateArchive(backups, saved.name)).manifest
    assert.equal(manifest.files.find(file => file.name === 'state.db')?.sqlite, true)
    assert.equal(manifest.files.some(file => /^state\.db-(?:wal|shm)$/.test(file.name)), false)
    const staging = await mkdtemp(join(root, 'sqlite-restore-'))
    const extracted = await extractArchive(backups, saved.name, staging)
    const restored = new DatabaseSync(join(extracted, 'state.db'))
    try { assert.deepEqual(restored.prepare('SELECT n FROM records ORDER BY n').all().map(row => row.n), [1]) }
    finally { restored.close() }
    db.exec('INSERT INTO records VALUES (2)')
    await performRestore({ home, backups, name: saved.name })
    const after = new DatabaseSync(join(home, 'state.db'))
    try { assert.deepEqual(after.prepare('SELECT n FROM records ORDER BY n').all().map(row => row.n), [1]) }
    finally { after.close() }
  } finally { db.close() }
})

test('corrupt SQLite and orphan WAL abort backup without publishing an archive', async () => {
  const { home, backups } = await fixture()
  await writeFile(join(home, 'broken.sqlite'), 'not sqlite')
  await assert.rejects(makeBackup({ home, backups, commit: 'test' }), /no valid header/)
  assert.equal((await listBackups(backups)).length, 0)
})

test('preview home defaults to its own sibling backups directory', () => {
  const previousHome = process.env.DSH_HOME
  const previousBackups = process.env.DSH_BACKUPS_HOME
  try {
    delete process.env.DSH_BACKUPS_HOME
    process.env.DSH_HOME = join(tmpdir(), '.dsh-preview')
    assert.equal(locations().backups, join(tmpdir(), '.dsh-preview-backups'))
    process.env.DSH_BACKUPS_HOME = join(tmpdir(), 'custom-backups')
    assert.equal(locations().backups, join(tmpdir(), 'custom-backups'))
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousBackups === undefined) delete process.env.DSH_BACKUPS_HOME
    else process.env.DSH_BACKUPS_HOME = previousBackups
  }
})

test('restore reports selected ZIP and rollback metadata across the home swap', async () => {
  const { home, backups } = await fixture()
  const selected = await makeBackup({ home, backups, commit: 'test' })
  const rollback = await makeBackup({ home, backups, kind: 'rollback', commit: 'test' })
  const id = restoreId()
  await writeRestoreStatus(backups, id, {
    state: 'pending', selected: { name: selected.name, counts: selected.counts, bytes: selected.bytes },
    rollback: { name: rollback.name, counts: rollback.counts, bytes: rollback.bytes },
  })
  await writeFile(join(home, 'settings.yaml'), 'changed')
  await performRestore({ home, backups, name: selected.name, rollback: rollback.name, id })
  const result = await readRestoreStatus(backups, id)
  assert.equal(result.state, 'restored')
  assert.equal(result.selected.name, selected.name)
  assert.equal(result.selected.bytes, selected.bytes)
  assert.equal(result.rollback.name, rollback.name)
  assert.equal(await readFile(join(home, 'settings.yaml'), 'utf8'), 'original')
})

test('restore failure reports rollback recovery without claiming selected backup was restored', async () => {
  const { home, backups } = await fixture()
  const rollback = await makeBackup({ home, backups, kind: 'rollback', commit: 'test' })
  const id = restoreId()
  await writeRestoreStatus(backups, id, { state: 'pending', selected: { name: 'missing.backup.dsh.zip', counts: {}, bytes: 0 }, rollback: { name: rollback.name, counts: rollback.counts, bytes: rollback.bytes } })
  await writeFile(join(home, 'settings.yaml'), 'changed')
  await assert.rejects(performRestore({ home, backups, name: 'missing.backup.dsh.zip', rollback: rollback.name, id }))
  const result = await readRestoreStatus(backups, id)
  assert.equal(result.state, 'rolled-back')
  assert.match(result.error, /ENOENT/)
  assert.equal(await readFile(join(home, 'settings.yaml'), 'utf8'), 'original')
})
