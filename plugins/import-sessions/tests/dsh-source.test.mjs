import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFile, mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareDshSelection, samePath, scanDshSelection } from '../host/dsh-source.mjs'

const fixtureSession = '/Users/tali/.dsh/sessions/--Users-tali-github-deepseek-harness--/session-d580c48e-9327-457a-95eb-012efcdbd4f5'
const fixtureWorkspace = '/Users/tali/.dsh/sessions/--Users-tali-github-deepseek-harness--'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-source-fixture-'))
  const workspace = join(root, 'sessions', '--Users-tali-github-deepseek-harness--')
  const session = join(workspace, 'session-d580c48e-9327-457a-95eb-012efcdbd4f5')
  await mkdir(session, { recursive: true })
  await copyFile(join(fixtureSession, 'session.v3.jsonl.zstd'), join(session, 'session.v3.jsonl.zstd'))
  return { root, workspace, session }
}

test('DSH classifier distinguishes one session from a workspace and preserves semantic bulk', async () => {
  const source = await fixture()
  try {
    const session = await prepareDshSelection(source.session, '/tmp/not-active')
    assert.equal(session.kind, 'session')
    const workspace = await prepareDshSelection(source.workspace, '/tmp/not-active')
    assert.equal(workspace.kind, 'workspace')
    const scan = await scanDshSelection(source.workspace, '/tmp/not-active')
    assert.equal(scan.kind, 'workspace')
    assert.equal(scan.workspaces.flatMap(group => group.sessions).length, 1)
    await scan.selection.cleanup()
  } finally { await rm(source.root, { recursive: true, force: true }) }
})

test('active DSH_HOME and aliases resolve to the same identity and are rejected', async () => {
  assert.equal(await samePath('/Users/tali/.dsh', '/Users/tali/.dsh/.'), true)
  await assert.rejects(prepareDshSelection('/Users/tali/.dsh', '/Users/tali/.dsh/.'), /active DSH_HOME/)
})

test('empty unrelated directories are rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-import-test-'))
  try {
    await mkdir(join(root, 'sessions'))
    await assert.rejects(prepareDshSelection(root, '/tmp/not-active'), /not a DSH home/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
