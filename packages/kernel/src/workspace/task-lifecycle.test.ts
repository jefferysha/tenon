/**
 * 删除 / 归档 / 取消归档 against a real temporary checkout: reasons, the zero-write refusals, the full
 * reference cleanup and the audit split. Deletion is destructive, so the refusal paths are asserted to
 * leave every byte in place.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formatReviewMarker, REVIEW_MARKER_FILE } from '../state/markers.js'
import { emptyFields, serializePipeline } from '../state/parse.js'
import { createStateStore } from '../state/store.js'
import { GATE_MARKERS } from '../types.js'
import type { FieldName } from '../types.js'
import { ensureUserLocalDir, userProjectPaths } from '../users/user-paths.js'
import type { TenonUser } from '../users/user.js'
import { readTaskArchiveOf, serializeTaskArchive } from './task-archive.js'
import { TERMINAL_ACTIVITY_FILE, TERMINAL_SESSION_BINDINGS_DIR, TERMINAL_SESSION_PROTOCOL } from './terminal-activity.js'
import { createTaskLifecycleApplication, taskLifecycleUnlockHint } from './task-lifecycle.js'
import type { TaskLifecycleApplication, TaskLifecycleCommand, TaskLifecycleDeps, TaskLifecycleReasonCode } from './task-lifecycle.js'

const NOW_MS = 1_789_000_000_000
const NOW = new Date(NOW_MS).toISOString()
const alice: TenonUser = { id: 'a@x.io', name: 'A', slug: 'a-at-x.io', source: 'env', trust: 'declared' }
const bob: TenonUser = { id: 'b@x.io', name: 'B', slug: 'b-at-x.io', source: 'env', trust: 'declared' }

let repo: string

function lifecycle(overrides: Partial<TaskLifecycleDeps> = {}): TaskLifecycleApplication {
  return createTaskLifecycleApplication({
    store: createStateStore(),
    clock: () => NOW,
    nowMs: () => NOW_MS,
    git: async () => ({ code: 128, stdout: '' }),
    ...overrides,
  })
}

function command(change: string, acknowledged: readonly TaskLifecycleReasonCode[] | 'all' = []): TaskLifecycleCommand {
  return { repoRoot: repo, change, user: alice, channel: 'terminal', acknowledged }
}

async function writeChange(name: string, fields: Partial<Record<FieldName, string | string[]>> = {}): Promise<string> {
  const dir = join(repo, 'openspec', 'changes', name)
  await mkdir(dir, { recursive: true })
  const base = emptyFields()
  base.phase = 'build'
  Object.assign(base, fields)
  await writeFile(join(dir, '.pipeline.yaml'), serializePipeline({ fields: base, opaqueTail: '' }), 'utf8')
  return dir
}

async function liveSidecar(name: string): Promise<void> {
  await writeFile(
    join(repo, 'openspec', 'changes', name, TERMINAL_ACTIVITY_FILE),
    `${JSON.stringify({ protocol: 'pipeline-terminal-activity-v1', change: name, session_id: 'sess', heartbeat_at: NOW })}\n`,
    'utf8',
  )
}

async function sessionBinding(id: string, change: string): Promise<string> {
  const dir = join(repo, TERMINAL_SESSION_BINDINGS_DIR)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${id}.json`)
  await writeFile(path, `${JSON.stringify({ protocol: TERMINAL_SESSION_PROTOCOL, session_id: id, change })}\n`, 'utf8')
  return path
}

async function archiveOf(user: TenonUser, ...names: string[]): Promise<void> {
  const paths = await ensureUserLocalDir(repo, user.slug)
  const changes = Object.fromEntries(names.map((name) => [name, {
    archivedAt: NOW, phase: 'build', actor: { id: user.id, name: user.name, trust: 'declared' as const },
  }]))
  await writeFile(paths.archived, serializeTaskArchive({ version: 1, changes }), 'utf8')
}

/** Every regular file under the checkout with its bytes, so a refusal can be proven to write nothing. */
async function treeBytes(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    out[relative(dir, path)] = await readFile(path, 'utf8')
  }
  return out
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function auditRows(path: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(path, 'utf8')
  return text.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, unknown>)
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'tenon-task-lifecycle-'))
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

describe('assess', () => {
  it('refuses a bad name and a Change without state', async () => {
    expect(await lifecycle().assess({ repoRoot: repo, change: 'archive', action: 'delete', user: alice }))
      .toEqual({ kind: 'invalid-name', change: 'archive' })
    expect(await lifecycle().assess({ repoRoot: repo, change: 'a b', action: 'archive', user: alice }))
      .toEqual({ kind: 'invalid-name', change: 'a b' })
    await mkdir(join(repo, 'openspec', 'changes', 'ghost'), { recursive: true })
    expect(await lifecycle().assess({ repoRoot: repo, change: 'ghost', action: 'delete', user: alice }))
      .toEqual({ kind: 'not-found', change: 'ghost' })
  })

  it('reports no reason for an idle Change and carries its phase', async () => {
    await writeChange('add-login', { phase: 'spec' })
    expect(await lifecycle().assess({ repoRoot: repo, change: 'add-login', action: 'delete', user: alice }))
      .toEqual({ action: 'delete', change: 'add-login', phase: 'spec', blockers: [], confirmations: [] })
  })

  it('blocks a running AFK task for both actions', async () => {
    for (const automation of ['scheduled', 'running']) {
      await writeChange('add-login', { automation })
      for (const action of ['delete', 'archive'] as const) {
        const assessment = await lifecycle().assess({ repoRoot: repo, change: 'add-login', action, user: alice })
        expect(assessment).toMatchObject({ blockers: [{ code: 'afk-running' }], confirmations: [] })
      }
    }
    expect(taskLifecycleUnlockHint('afk-running', 'add-login')).toBe('tenon afk cancel add-login')
  })

  it('confirms a queued AFK task for 删除 and blocks it for 归档', async () => {
    await writeChange('add-login', { automation: 'queued' })
    expect(await lifecycle().assess({ repoRoot: repo, change: 'add-login', action: 'delete', user: alice }))
      .toMatchObject({ blockers: [], confirmations: [{ code: 'afk-queued' }] })
    expect(await lifecycle().assess({ repoRoot: repo, change: 'add-login', action: 'archive', user: alice }))
      .toMatchObject({ blockers: [{ code: 'afk-queued' }], confirmations: [] })
    expect(taskLifecycleUnlockHint('afk-queued', 'add-login')).toBe('tenon cas add-login automation queued off')
  })

  it('confirms a pending review and a live host session for both actions', async () => {
    await writeChange('add-login', { review_gate_status: 'pending' })
    await liveSidecar('add-login')
    for (const action of ['delete', 'archive'] as const) {
      expect(await lifecycle().assess({ repoRoot: repo, change: 'add-login', action, user: alice }))
        .toMatchObject({ confirmations: [{ code: 'review-pending' }, { code: 'host-session-live' }] })
    }
    expect(taskLifecycleUnlockHint('review-pending', 'add-login')).toBeUndefined()
  })

  it('confirms dependents and another owner for 删除 only', async () => {
    await writeChange('add-login', { assignee: 'B <b@x.io>' })
    await writeChange('needs-login', { depends_on: ['add-login'] })
    await writeChange('archived-child', { depends_on: ['add-login'] })
    await rm(join(repo, 'openspec', 'changes', 'archived-child'), { recursive: true })
    await writeChange(join('archive', 'archived-child'), { depends_on: ['add-login'] })
    expect(await lifecycle().assess({ repoRoot: repo, change: 'add-login', action: 'delete', user: alice }))
      .toMatchObject({
        confirmations: [
          { code: 'has-dependents', detail: 'needs-login' },
          { code: 'owned-by-other', detail: 'B <b@x.io>' },
        ],
      })
    expect(await lifecycle().assess({ repoRoot: repo, change: 'add-login', action: 'archive', user: alice }))
      .toMatchObject({ blockers: [], confirmations: [] })
    expect(await lifecycle().assess({ repoRoot: repo, change: 'add-login', action: 'delete', user: alice }))
      .toMatchObject({ confirmations: [{ code: 'has-dependents' }, { code: 'owned-by-other' }] })
  })

  it('treats the acting owner as no reason', async () => {
    await writeChange('add-login', { assignee: 'A <a@x.io>' })
    expect(await lifecycle().assess({ repoRoot: repo, change: 'add-login', action: 'delete', user: alice }))
      .toMatchObject({ confirmations: [] })
  })
})

describe('refusals write nothing', () => {
  it('leaves the checkout byte-identical when blocked or unconfirmed', async () => {
    await writeChange('add-login', { automation: 'running' })
    await archiveOf(alice, 'add-login')
    const before = await treeBytes(repo)
    expect(await lifecycle().delete(command('add-login', 'all'))).toEqual({ kind: 'blocked', reasons: [{ code: 'afk-running' }] })
    expect(await lifecycle().archive(command('add-login', 'all'))).toMatchObject({ kind: 'archived', changed: false })
    expect(await treeBytes(repo)).toEqual(before)

    await writeChange('needs-confirm', { review_gate_status: 'pending' })
    await sessionBinding('sess', 'needs-confirm')
    const staged = await treeBytes(repo)
    expect(await lifecycle().delete(command('needs-confirm')))
      .toEqual({ kind: 'confirmation-required', reasons: [{ code: 'review-pending' }] })
    expect(await lifecycle().archive(command('needs-confirm')))
      .toEqual({ kind: 'confirmation-required', reasons: [{ code: 'review-pending' }] })
    expect(await treeBytes(repo)).toEqual(staged)
    expect(await exists(userProjectPaths(repo, alice.slug).audit)).toBe(false)
  })

  it('refuses a bad name, a missing Change and a missing identity before any lock', async () => {
    await writeChange('add-login')
    const before = await treeBytes(repo)
    expect(await lifecycle().delete(command('archive'))).toEqual({ kind: 'invalid-name', change: 'archive' })
    expect(await lifecycle().archive(command('archive'))).toEqual({ kind: 'invalid-name', change: 'archive' })
    expect(await lifecycle().unarchive({ ...command('archive') })).toEqual({ kind: 'invalid-name', change: 'archive' })
    expect(await lifecycle().delete(command('missing'))).toEqual({ kind: 'not-found', change: 'missing' })
    expect(await lifecycle().archive({ ...command('add-login'), user: { missing: true } }))
      .toEqual({ kind: 'identity-missing' })
    expect(await treeBytes(repo)).toEqual(before)
  })

  it('refuses a corrupt archive store on 归档 and 取消归档 without overwriting it', async () => {
    await writeChange('add-login')
    const paths = await ensureUserLocalDir(repo, alice.slug)
    await writeFile(paths.archived, 'not json', 'utf8')
    expect(await lifecycle().archive(command('add-login', 'all'))).toEqual({ kind: 'archive-store-corrupt', path: paths.archived })
    expect(await lifecycle().unarchive(command('add-login'))).toEqual({ kind: 'archive-store-corrupt', path: paths.archived })
    expect(await readFile(paths.archived, 'utf8')).toBe('not json')
  })
})

describe('archive / unarchive', () => {
  it('records the phase and actor, is idempotent and writes only the personal audit', async () => {
    await writeChange('add-login', { phase: 'build' })
    const entry = { archivedAt: NOW, phase: 'build', actor: { id: 'a@x.io', name: 'A', trust: 'declared' } }
    expect(await lifecycle().archive(command('add-login')))
      .toEqual({ kind: 'archived', change: 'add-login', changed: true, entry })
    const paths = userProjectPaths(repo, alice.slug)
    expect(await readTaskArchiveOf(repo, alice.slug)).toEqual({ kind: 'ok', archive: { version: 1, changes: { 'add-login': entry } } })
    expect(await auditRows(paths.localAudit)).toEqual([{
      ts: NOW, action: 'archive', change: 'add-login', phase: 'build',
      actor: { id: 'a@x.io', name: 'A', trust: 'declared' }, channel: 'terminal', acknowledged: [],
    }])
    expect(await exists(paths.audit)).toBe(false)

    expect(await lifecycle().archive(command('add-login'))).toEqual({ kind: 'archived', change: 'add-login', changed: false, entry })
    expect(await auditRows(paths.localAudit)).toHaveLength(1)

    expect(await lifecycle().unarchive(command('add-login'))).toEqual({ kind: 'unarchived', change: 'add-login', changed: true })
    expect(await readTaskArchiveOf(repo, alice.slug)).toEqual({ kind: 'ok', archive: { version: 1, changes: {} } })
    expect(await lifecycle().unarchive(command('add-login'))).toEqual({ kind: 'unarchived', change: 'add-login', changed: false })
    expect(await auditRows(paths.localAudit)).toHaveLength(2)
  })

  it('records the acknowledged codes and hides only for the acting user', async () => {
    await writeChange('add-login', { review_gate_status: 'pending' })
    expect(await lifecycle().archive(command('add-login', ['review-pending']))).toMatchObject({ changed: true })
    expect((await auditRows(userProjectPaths(repo, alice.slug).localAudit))[0]).toMatchObject({ acknowledged: ['review-pending'] })
    expect(await readTaskArchiveOf(repo, bob.slug)).toEqual({ kind: 'ok', archive: { version: 1, changes: {} } })
  })
})

describe('delete', () => {
  async function seedForDelete(activeChange = 'add-login'): Promise<void> {
    await writeChange('add-login')
    await writeChange('keep-me')
    const aPaths = await ensureUserLocalDir(repo, alice.slug)
    const bPaths = await ensureUserLocalDir(repo, bob.slug)
    await writeFile(aPaths.activeChange, `${activeChange}\n`, 'utf8')
    await writeFile(bPaths.activeChange, 'add-login\n', 'utf8')
    await writeFile(aPaths.authority, `pipeline-interaction-authority-v2\nchange=add-login\nhost_session=s\n`, 'utf8')
    await writeFile(bPaths.authority, `pipeline-interaction-authority-v2\nchange=keep-me\nhost_session=s\n`, 'utf8')
    await mkdir(join(aPaths.testsDir, 'add-login'), { recursive: true })
    await writeFile(join(aPaths.testsDir, 'add-login', 'run.json'), '{}\n', 'utf8')
    await mkdir(join(aPaths.testsDir, 'keep-me'), { recursive: true })
    await writeFile(join(aPaths.testsDir, 'keep-me', 'run.json'), '{}\n', 'utf8')
    await mkdir(join(aPaths.artifactsDir, 'add-login'), { recursive: true })
    await writeFile(join(aPaths.artifactsDir, 'add-login', 'log.txt'), 'x\n', 'utf8')
    await archiveOf(alice, 'add-login', 'keep-me')
    await archiveOf(bob, 'add-login')
    await writeFile(
      join(repo, REVIEW_MARKER_FILE),
      formatReviewMarker({ phase: 'build', changeName: 'add-login', event: 'build-pass', requestedAt: NOW }),
      'utf8',
    )
    for (const marker of GATE_MARKERS.filter((name) => name !== REVIEW_MARKER_FILE)) {
      await writeFile(join(repo, marker), 'pending\n', 'utf8')
    }
    await sessionBinding('sess-a', 'add-login')
    await sessionBinding('sess-keep', 'keep-me')
  }

  it('removes the Change and every reference to it while a second Change survives', async () => {
    await seedForDelete()
    const outcome = await lifecycle().delete(command('add-login', 'all'))
    expect(outcome).toMatchObject({ kind: 'deleted', change: 'add-login', uncommittedDeletions: null, warnings: [] })
    const removed = outcome.kind === 'deleted' ? outcome.removed : []
    expect(removed).toContain('openspec/changes/add-login')
    expect(removed).toContain(join('.tenon', 'users', alice.slug, 'local', 'active-change'))
    expect(removed).toContain(join('.tenon', 'users', bob.slug, 'local', 'active-change'))
    expect(removed).toContain(join('.tenon', 'users', alice.slug, 'local', 'authority'))
    expect(removed).not.toContain(join('.tenon', 'users', bob.slug, 'local', 'authority'))
    expect(removed).toContain(join('.tenon', 'users', alice.slug, 'tests', 'add-login'))
    expect(removed).toContain(join('.tenon', 'users', alice.slug, 'local', 'artifacts', 'add-login'))
    expect(removed).toContain(REVIEW_MARKER_FILE)
    expect(removed).toContain(join(TERMINAL_SESSION_BINDINGS_DIR, 'sess-a.json'))

    expect(await exists(join(repo, 'openspec', 'changes', 'add-login'))).toBe(false)
    expect(await exists(join(repo, 'openspec', 'changes', 'keep-me'))).toBe(true)
    expect(await exists(join(repo, REVIEW_MARKER_FILE))).toBe(false)
    for (const marker of GATE_MARKERS.filter((name) => name !== REVIEW_MARKER_FILE)) {
      expect(await exists(join(repo, marker))).toBe(false)
    }
    expect(await exists(join(repo, TERMINAL_SESSION_BINDINGS_DIR, 'sess-a.json'))).toBe(false)
    expect(await exists(join(repo, TERMINAL_SESSION_BINDINGS_DIR, 'sess-keep.json'))).toBe(true)
    const aPaths = userProjectPaths(repo, alice.slug)
    expect(await exists(join(aPaths.testsDir, 'keep-me', 'run.json'))).toBe(true)
    expect(await exists(userProjectPaths(repo, bob.slug).authority)).toBe(true)
    expect(await readTaskArchiveOf(repo, alice.slug))
      .toMatchObject({ kind: 'ok', archive: { changes: { 'keep-me': { phase: 'build' } } } })
    expect(await readTaskArchiveOf(repo, bob.slug)).toEqual({ kind: 'ok', archive: { version: 1, changes: {} } })
    expect(await readdir(aPaths.deletingDir)).toEqual([])
  })

  it('keeps the session markers when the deleted Change was not the acting selection', async () => {
    await seedForDelete('keep-me')
    expect(await lifecycle().delete(command('add-login', 'all'))).toMatchObject({ kind: 'deleted' })
    for (const marker of GATE_MARKERS.filter((name) => name !== REVIEW_MARKER_FILE)) {
      expect(await exists(join(repo, marker))).toBe(true)
    }
    expect(await readFile(userProjectPaths(repo, alice.slug).activeChange, 'utf8')).toBe('keep-me\n')
  })

  it('writes the tracked audit row with the removed paths and the acknowledged codes', async () => {
    await writeChange('add-login', { phase: 'verify', review_gate_status: 'pending' })
    expect(await lifecycle().delete({ ...command('add-login', ['review-pending']), channel: 'dashboard' }))
      .toMatchObject({ kind: 'deleted' })
    const paths = userProjectPaths(repo, alice.slug)
    const rows = await auditRows(paths.audit)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      ts: NOW, action: 'delete', change: 'add-login', phase: 'verify', channel: 'dashboard',
      actor: { id: 'a@x.io', name: 'A', trust: 'declared' }, acknowledged: ['review-pending'],
      removed: ['openspec/changes/add-login'],
    })
    expect(await exists(paths.localAudit)).toBe(false)
  })

  it('sweeps a tombstone left by an interrupted delete', async () => {
    await writeChange('add-login')
    const paths = await ensureUserLocalDir(repo, alice.slug)
    await mkdir(join(paths.deletingDir, 'stale-1'), { recursive: true })
    await writeFile(join(paths.deletingDir, 'stale-1', 'x'), 'x\n', 'utf8')
    expect(await lifecycle().delete(command('add-login', 'all'))).toMatchObject({ kind: 'deleted' })
    expect(await readdir(paths.deletingDir)).toEqual([])
  })

  it('reports delete-failed and writes nothing when staging cannot rename', async () => {
    await writeChange('add-login')
    const paths = await ensureUserLocalDir(repo, alice.slug)
    await writeFile(paths.deletingDir, 'not a directory\n', 'utf8')
    const before = await treeBytes(repo)
    expect(await lifecycle().delete(command('add-login', 'all'))).toMatchObject({ kind: 'delete-failed' })
    expect(await treeBytes(repo)).toEqual(before)
    expect(await exists(join(repo, 'openspec', 'changes', 'add-login'))).toBe(true)
  })

  it('leaves the archive entry and warns when another user store is corrupt', async () => {
    await writeChange('add-login')
    const bPaths = await ensureUserLocalDir(repo, bob.slug)
    await writeFile(bPaths.archived, '{', 'utf8')
    const outcome = await lifecycle().delete(command('add-login', 'all'))
    expect(outcome).toMatchObject({ kind: 'deleted' })
    expect(outcome.kind === 'deleted' && outcome.warnings).toEqual([`归档记录未清理: ${bPaths.archived}`])
    expect(await readFile(bPaths.archived, 'utf8')).toBe('{')
  })

  it('fails a writer that waits for the lock of the deleted Change and never recreates it', async () => {
    await writeChange('add-login')
    const store = createStateStore()
    const changeDir = join(repo, 'openspec', 'changes', 'add-login')
    const deletion = lifecycle({ store }).delete(command('add-login', 'all'))
    const waiter = store.withLock(changeDir, async () => 'ran')
    expect(await deletion).toMatchObject({ kind: 'deleted' })
    await expect(waiter).rejects.toBeDefined()
    expect(await exists(changeDir)).toBe(false)
  })
})
