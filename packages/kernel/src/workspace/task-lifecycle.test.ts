/**
 * 删除 / 终止 / 完结 against a real temporary checkout: reasons, the zero-write refusals, the full
 * reference cleanup, the audit split and the path-limited terminate commit. Deletion is destructive, so
 * the refusal paths are asserted to leave every byte in place.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LOCK_DIR_NAME } from '../state/lock.js'
import { formatReviewMarker, INTERACTION_MARKER_SESSION_PREFIX, REVIEW_MARKER_FILE } from '../state/markers.js'
import { emptyFields, serializePipeline } from '../state/parse.js'
import { createStateStore } from '../state/store.js'
import { GATE_MARKERS } from '../types.js'
import type { FieldName, PipelineState, StateStore } from '../types.js'
import { ensureUserLocalDir, TENON_PROJECT_DIR, userProjectPaths } from '../users/user-paths.js'
import type { TenonUser } from '../users/user.js'
import { readTaskResult } from './archive-task.js'
import { TERMINAL_ACTIVITY_FILE, TERMINAL_SESSION_BINDINGS_DIR, TERMINAL_SESSION_PROTOCOL } from './terminal-activity.js'
import { createTaskLifecycleApplication, taskLifecycleUnlockHint } from './task-lifecycle.js'
import type {
  TaskLifecycleApplication, TaskLifecycleCommand, TaskLifecycleDeps, TaskLifecycleOutcome, TaskLifecycleReasonCode,
} from './task-lifecycle.js'
import { gitStatusRunner } from './uncommitted-deletions.js'

const NOW_MS = 1_789_000_000_000
const NOW = new Date(NOW_MS).toISOString()
const DAY = NOW.slice(0, 10)
const alice: TenonUser = { id: 'a@x.io', name: 'A', slug: 'a-at-x.io', source: 'env', trust: 'declared' }
const bob: TenonUser = { id: 'b@x.io', name: 'B', slug: 'b-at-x.io', source: 'env', trust: 'declared' }

let repo: string

function lifecycle(overrides: Partial<TaskLifecycleDeps> = {}): TaskLifecycleApplication {
  return createTaskLifecycleApplication({
    store: createStateStore(),
    clock: () => NOW,
    nowMs: () => NOW_MS,
    git: async () => ({ code: 128, stdout: '' }),
    runOpenspecArchive: async () => { throw new Error('测试里不得跑真实 openspec') },
    ...overrides,
  })
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
}

function initGit(): void {
  git('init', '-q')
  git('config', 'user.email', 'tenon-tests@example.invalid')
  git('config', 'user.name', 'Tenon tests')
  git('add', '-A')
  git('commit', '-qm', 'seed')
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

interface StoreProbe {
  readonly op: 'read' | 'lock'
  readonly dir: string
  readonly archiveLockHeld: boolean
  readonly taskLockHeld: boolean
}

/**
 * A real store that reports, on every read of a task and every `withLock` of it, which lock directories exist on
 * disk at that moment. `afterRead` runs right after a read finished and before its result is handed back, which
 * is where a racing writer is started from.
 */
function spyStore(probes: StoreProbe[], afterRead?: (changeDir: string) => void): StateStore {
  const real = createStateStore()
  const probe = (op: StoreProbe['op'], dir: string): StoreProbe => ({
    op,
    dir,
    archiveLockHeld: existsSync(join(repo, TENON_PROJECT_DIR, LOCK_DIR_NAME)),
    taskLockHeld: existsSync(join(dir, LOCK_DIR_NAME)),
  })
  return new Proxy(real, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      if (property === 'read') {
        return async (changeDir: string): Promise<PipelineState> => {
          probes.push(probe('read', changeDir))
          const state: PipelineState = await Reflect.apply(value, target, [changeDir])
          afterRead?.(changeDir)
          return state
        }
      }
      if (property === 'withLock') {
        return (changeDir: string, fn: () => Promise<unknown>): Promise<unknown> => {
          probes.push(probe('lock', changeDir))
          return Reflect.apply(value, target, [changeDir, fn])
        }
      }
      return (...args: unknown[]): unknown => Reflect.apply(value, target, args)
    },
  })
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
    expect(await lifecycle().assess({ repoRoot: repo, change: 'a b', action: 'terminate', user: alice }))
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
      for (const action of ['delete', 'terminate'] as const) {
        const assessment = await lifecycle().assess({ repoRoot: repo, change: 'add-login', action, user: alice })
        expect(assessment).toMatchObject({ blockers: [{ code: 'afk-running' }], confirmations: [] })
      }
    }
    expect(taskLifecycleUnlockHint('afk-running', 'add-login')).toBe('tenon afk cancel add-login')
  })

  it('confirms a queued AFK task for 删除 and blocks it for 终止', async () => {
    await writeChange('add-login', { automation: 'queued' })
    expect(await lifecycle().assess({ repoRoot: repo, change: 'add-login', action: 'delete', user: alice }))
      .toMatchObject({ blockers: [], confirmations: [{ code: 'afk-queued' }] })
    expect(await lifecycle().assess({ repoRoot: repo, change: 'add-login', action: 'terminate', user: alice }))
      .toMatchObject({ blockers: [{ code: 'afk-queued' }], confirmations: [] })
    expect(taskLifecycleUnlockHint('afk-queued', 'add-login')).toBe('tenon cas add-login automation queued off')
  })

  it('confirms a pending review and a live host session for both actions', async () => {
    await writeChange('add-login', { review_gate_status: 'pending' })
    await liveSidecar('add-login')
    for (const action of ['delete', 'terminate'] as const) {
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
    expect(await lifecycle().assess({ repoRoot: repo, change: 'add-login', action: 'terminate', user: alice }))
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
    const before = await treeBytes(repo)
    expect(await lifecycle().delete(command('add-login', 'all'))).toEqual({ kind: 'blocked', reasons: [{ code: 'afk-running' }] })
    expect(await lifecycle().terminate(command('add-login', 'all'))).toEqual({ kind: 'blocked', reasons: [{ code: 'afk-running' }] })
    expect(await treeBytes(repo)).toEqual(before)

    await writeChange('needs-confirm', { review_gate_status: 'pending' })
    await sessionBinding('sess', 'needs-confirm')
    const staged = await treeBytes(repo)
    expect(await lifecycle().delete(command('needs-confirm')))
      .toEqual({ kind: 'confirmation-required', reasons: [{ code: 'review-pending' }] })
    expect(await lifecycle().terminate(command('needs-confirm')))
      .toEqual({ kind: 'confirmation-required', reasons: [{ code: 'review-pending' }] })
    expect(await treeBytes(repo)).toEqual(staged)
    expect(await exists(userProjectPaths(repo, alice.slug).audit)).toBe(false)
  })

  it('refuses a bad name, a missing Change and a missing identity before any lock', async () => {
    await writeChange('add-login')
    const before = await treeBytes(repo)
    expect(await lifecycle().delete(command('archive'))).toEqual({ kind: 'invalid-name', change: 'archive' })
    expect(await lifecycle().terminate(command('archive'))).toEqual({ kind: 'invalid-name', change: 'archive' })
    expect(await lifecycle().finish({ repoRoot: repo, change: 'archive' })).toEqual({ kind: 'invalid-name', change: 'archive' })
    expect(await lifecycle().delete(command('missing'))).toEqual({ kind: 'not-found', change: 'missing' })
    expect(await lifecycle().finish({ repoRoot: repo, change: 'missing' })).toEqual({ kind: 'not-found', change: 'missing' })
    expect(await lifecycle().terminate({ ...command('add-login'), user: { missing: true } }))
      .toEqual({ kind: 'identity-missing' })
    expect(await treeBytes(repo)).toEqual(before)
  })
})

interface LockCase {
  readonly action: string
  readonly fields: Partial<Record<FieldName, string>>
  readonly run: (app: TaskLifecycleApplication) => Promise<TaskLifecycleOutcome>
  readonly done: TaskLifecycleOutcome['kind']
}

const LOCK_CASES: readonly LockCase[] = [
  { action: 'delete', fields: {}, run: (app) => app.delete(command('add-login', 'all')), done: 'deleted' },
  { action: 'terminate', fields: {}, run: (app) => app.terminate(command('add-login')), done: 'terminated' },
  {
    action: 'finish',
    fields: { phase: 'done', archived: 'true' },
    run: (app) => app.finish({ repoRoot: repo, change: 'add-login' }),
    done: 'finished',
  },
]

describe('locking: project archive lock first, task lock second, evaluation inside both', () => {
  it.each(LOCK_CASES)('$action takes the task lock while the archive lock is held and reads the task only inside both', async ({ fields, run, done }) => {
    const dir = await writeChange('add-login', fields)
    const probes: StoreProbe[] = []
    const outcome = await run(lifecycle({ store: spyStore(probes) }))
    expect(outcome.kind).toBe(done)
    const own = probes.filter((probe) => probe.dir === dir)
    expect(own.filter((probe) => probe.op === 'lock')).toEqual([expect.objectContaining({ archiveLockHeld: true })])
    const reads = own.filter((probe) => probe.op === 'read')
    expect(reads.length).toBeGreaterThan(0)
    for (const read of reads) expect(read).toMatchObject({ archiveLockHeld: true, taskLockHeld: true })
  })

  it('a writer racing the AFK check of terminate is held out until the task is archived', async () => {
    const dir = await writeChange('add-login')
    const real = createStateStore()
    let racer: Promise<'wrote' | 'rejected'> | undefined
    const store = spyStore([], (changeDir) => {
      racer ??= real.setMany(changeDir, { automation: 'running' }).then(() => 'wrote' as const, () => 'rejected' as const)
    })
    const outcome = await lifecycle({ store }).terminate(command('add-login'))
    expect(outcome).toMatchObject({ kind: 'terminated' })
    expect(await racer).toBe('rejected')
    expect(await exists(dir)).toBe(false)
    expect((await real.read(join(repo, 'openspec', 'changes', 'archive', `${DAY}-add-login`))).fields.automation).not.toBe('running')
  })

  it('delete and terminate of the same task exclude each other: one wins, the other finds it gone', async () => {
    await writeChange('add-login')
    const app = lifecycle()
    const outcomes = await Promise.all([app.delete(command('add-login', 'all')), app.terminate(command('add-login'))])
    const kinds = outcomes.map((outcome) => outcome.kind).sort()
    expect([['deleted', 'not-found'], ['not-found', 'terminated']]).toContainEqual(kinds)
    expect(await exists(join(repo, 'openspec', 'changes', 'add-login'))).toBe(false)
  })

  it('delete shares the archive lock check: a project lock directory that is a symlink refuses it and removes nothing', async () => {
    const dir = await writeChange('add-login')
    const outside = await mkdtemp(join(tmpdir(), 'tenon-lock-outside-'))
    try {
      await symlink(outside, join(repo, TENON_PROJECT_DIR))
      expect(await lifecycle().delete(command('add-login', 'all'))).toMatchObject({ kind: 'archive-failed', code: 'unsafe-path' })
      expect(await exists(dir)).toBe(true)
      expect(await readdir(outside)).toEqual([])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('a second ending of an already archived task answers not-found instead of failing', async () => {
    await writeChange('add-login', { phase: 'done', archived: 'true' })
    const app = lifecycle()
    const outcomes = await Promise.all([
      app.finish({ repoRoot: repo, change: 'add-login' }),
      app.finish({ repoRoot: repo, change: 'add-login' }),
      app.delete(command('add-login', 'all')),
    ])
    expect(outcomes.map((outcome) => outcome.kind).filter((kind) => kind !== 'not-found')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.kind === 'not-found')).toHaveLength(2)
  })

  it.each([
    { action: 'terminate', fields: {} as Partial<Record<FieldName, string>>, run: (app: TaskLifecycleApplication) => app.terminate(command('add-login')) },
    { action: 'finish', fields: { phase: 'done', archived: 'true' } as Partial<Record<FieldName, string>>, run: (app: TaskLifecycleApplication) => app.finish({ repoRoot: repo, change: 'add-login' }) },
  ])('$action leaves no lock directory inside the archived task, whoever moves it', async ({ fields, run }) => {
    for (const spec of ['none', 'openspec'] as const) {
      await writeChange('add-login', fields)
      const calls: string[] = []
      const outcome = await run(lifecycle({ specOf: () => spec, runOpenspecArchive: openspecMove(calls) }))
      const archivedDir = outcome.kind === 'terminated' || outcome.kind === 'finished' ? outcome.archived.archivedDir : ''
      expect(archivedDir, spec).not.toBe('')
      expect(await exists(join(repo, archivedDir, '.pipeline.yaml')), spec).toBe(true)
      expect(await exists(join(repo, archivedDir, LOCK_DIR_NAME)), spec).toBe(false)
    }
  })
})

describe('a task_result left on an active task by an interrupted archive', () => {
  async function leftover(fields: Partial<Record<FieldName, string>>, value = 'terminated'): Promise<string> {
    const dir = await writeChange('add-login', fields)
    await createStateStore().set(dir, 'task_result', value)
    return dir
  }

  it('is not an ended task: assess reports it like any active task', async () => {
    await leftover({ phase: 'build' })
    expect(await lifecycle().assess({ repoRoot: repo, change: 'add-login', action: 'terminate', user: alice }))
      .toMatchObject({ phase: 'build', blockers: [], confirmations: [] })
  })

  it('is cleared before a refused terminate decides anything', async () => {
    const dir = await leftover({ automation: 'running' })
    expect(await lifecycle().terminate(command('add-login'))).toMatchObject({ kind: 'blocked' })
    expect((await createStateStore().read(dir)).fields.task_result).toBe('')
  })

  it('is cleared before finish refuses a task that has not reached a terminal step', async () => {
    const dir = await leftover({ phase: 'verify' }, 'finished')
    expect(await lifecycle().finish({ repoRoot: repo, change: 'add-login' }))
      .toEqual({ kind: 'not-terminal', change: 'add-login', phase: 'verify' })
    expect((await createStateStore().read(dir)).fields.task_result).toBe('')
  })

  it('is cleared before terminate refuses a task whose state machine finished', async () => {
    const dir = await leftover({ phase: 'done', archived: 'true' })
    expect(await lifecycle().terminate(command('add-login')))
      .toEqual({ kind: 'already-terminal', change: 'add-login', result: 'finished' })
    expect((await createStateStore().read(dir)).fields.task_result).toBe('')
  })

  it('does not stop finish from archiving a finished task with its own result', async () => {
    await leftover({ phase: 'done', archived: 'true' }, 'terminated')
    const outcome = await lifecycle().finish({ repoRoot: repo, change: 'add-login' })
    expect(outcome).toMatchObject({ kind: 'finished', archived: { result: 'finished' } })
    expect(await readTaskResult(join(repo, `openspec/changes/archive/${DAY}-add-login`))).toBe('finished')
  })

  it('does not stop terminate from archiving an unfinished task with its own result', async () => {
    await leftover({ phase: 'build' }, 'finished')
    const outcome = await lifecycle().terminate(command('add-login'))
    expect(outcome).toMatchObject({ kind: 'terminated', archived: { result: 'terminated' } })
    expect(await readTaskResult(join(repo, `openspec/changes/archive/${DAY}-add-login`))).toBe('terminated')
  })
})

/** 模拟 `openspec archive <c>`：把活跃目录移进 archive/<日期>-<c>/。 */
function openspecMove(calls: string[]): NonNullable<TaskLifecycleDeps['runOpenspecArchive']> {
  return async (root, change) => {
    calls.push(change)
    await mkdir(join(root, 'openspec', 'changes', 'archive'), { recursive: true })
    await rename(join(root, 'openspec', 'changes', change), join(root, 'openspec', 'changes', 'archive', `${DAY}-${change}`))
  }
}

describe('terminate', () => {
  it('records 已终止, moves the task under archive/ and writes only the personal audit', async () => {
    await writeChange('add-login', { phase: 'build' })
    const outcome = await lifecycle().terminate(command('add-login'))
    const archivedDir = `openspec/changes/archive/${DAY}-add-login`
    expect(outcome).toMatchObject({
      kind: 'terminated', change: 'add-login',
      archived: { change: 'add-login', result: 'terminated', archivedDir, endedAt: NOW },
    })
    expect(await exists(join(repo, 'openspec', 'changes', 'add-login'))).toBe(false)
    expect(await exists(join(repo, archivedDir, '.pipeline.yaml'))).toBe(true)
    expect(await readTaskResult(join(repo, archivedDir))).toBe('terminated')
    expect((await createStateStore().read(join(repo, archivedDir))).fields.task_result).toBe('terminated')
    const paths = userProjectPaths(repo, alice.slug)
    expect(await auditRows(paths.localAudit)).toEqual([{
      ts: NOW, action: 'terminate', change: 'add-login', phase: 'build',
      actor: { id: 'a@x.io', name: 'A', trust: 'declared' }, channel: 'terminal', acknowledged: [],
    }])
    expect(await exists(paths.audit)).toBe(false)
  })

  it('records the acknowledged codes', async () => {
    await writeChange('add-login', { review_gate_status: 'pending' })
    expect(await lifecycle().terminate(command('add-login', ['review-pending']))).toMatchObject({ kind: 'terminated' })
    expect((await auditRows(userProjectPaths(repo, alice.slug).localAudit))[0]).toMatchObject({ acknowledged: ['review-pending'] })
  })

  it('refuses a task whose state machine already finished and leaves it in place', async () => {
    await writeChange('add-login', { phase: 'done', archived: 'true' })
    const before = await treeBytes(repo)
    expect(await lifecycle().terminate(command('add-login')))
      .toEqual({ kind: 'already-terminal', change: 'add-login', result: 'finished' })
    expect(await treeBytes(repo)).toEqual(before)
  })

  it('delegates to openspec archive when the task is governed by OpenSpec', async () => {
    await writeChange('add-login')
    const calls: string[] = []
    const outcome = await lifecycle({ specOf: () => 'openspec', runOpenspecArchive: openspecMove(calls) })
      .terminate(command('add-login'))
    expect(calls).toEqual(['add-login'])
    expect(outcome).toMatchObject({ kind: 'terminated', archived: { archivedDir: `openspec/changes/archive/${DAY}-add-login` } })
    expect(await readTaskResult(join(repo, `openspec/changes/archive/${DAY}-add-login`))).toBe('terminated')
  })

  it('reports archive-failed when openspec fails: the task stays active, task_result is cleared and nothing else is written', async () => {
    const dir = await writeChange('add-login')
    const outcome = await lifecycle({
      specOf: () => 'openspec',
      runOpenspecArchive: async () => { throw new Error('archive_validation_failed') },
    }).terminate(command('add-login'))
    expect(outcome).toMatchObject({ kind: 'archive-failed', code: 'openspec-failed' })
    expect(outcome.kind === 'archive-failed' && outcome.cause).toContain('archive_validation_failed')
    expect(await exists(dir)).toBe(true)
    expect((await createStateStore().read(dir)).fields.task_result).toBe('')
    expect(await readTaskResult(dir)).toBeUndefined()
    expect(await exists(join(repo, 'openspec', 'changes', 'archive'))).toBe(false)
    // 失败的终止不留审计行。
    expect(await exists(userProjectPaths(repo, alice.slug).localAudit)).toBe(false)
    // 失败路径也把两把锁都放掉：任务锁还在原目录里被释放，项目归档锁不残留。
    expect(await exists(join(dir, LOCK_DIR_NAME))).toBe(false)
    expect(await exists(join(repo, TENON_PROJECT_DIR, LOCK_DIR_NAME))).toBe(false)
  })

  // 文件系统自己的错误（这里是 archive/ 不可写的 EACCES）也是 archive-failed 结果，不是冲出去的异常。
  it.skipIf(process.getuid?.() === 0)('reports archive-failed move-failed when the filesystem refuses the rename, instead of throwing', async () => {
    const dir = await writeChange('add-login')
    const archive = join(repo, 'openspec', 'changes', 'archive')
    await mkdir(archive, { recursive: true })
    await chmod(archive, 0o500)
    try {
      const outcome = await lifecycle().terminate(command('add-login'))
      expect(outcome).toMatchObject({ kind: 'archive-failed', code: 'move-failed' })
      expect(outcome.kind === 'archive-failed' && outcome.cause).toContain('EACCES')
      expect(await exists(dir)).toBe(true)
      expect((await createStateStore().read(dir)).fields.task_result).toBe('')
      expect(await exists(join(dir, LOCK_DIR_NAME))).toBe(false)
      expect(await exists(join(repo, TENON_PROJECT_DIR, LOCK_DIR_NAME))).toBe(false)
    } finally {
      await chmod(archive, 0o700)
    }
  })

  it('skips the commit outside a git repository', async () => {
    await writeChange('add-login')
    expect(await lifecycle().terminate(command('add-login')))
      .toMatchObject({ kind: 'terminated', commit: { kind: 'skipped' } })
  })

  it('stays a success when the audit row cannot be written after the move, and names the failure as a warning', async () => {
    await writeChange('add-login')
    // A directory where the audit file belongs: the append fails after the task has already been archived.
    await mkdir(userProjectPaths(repo, alice.slug).localAudit, { recursive: true })
    const outcome = await lifecycle().terminate(command('add-login'))
    const archivedDir = `openspec/changes/archive/${DAY}-add-login`
    expect(outcome).toMatchObject({ kind: 'terminated', archived: { archivedDir } })
    expect(outcome.kind === 'terminated' ? outcome.warnings : []).toEqual([expect.stringMatching(/审计.*EISDIR/su)])
    expect(await readTaskResult(join(repo, archivedDir))).toBe('terminated')
    expect(await exists(join(repo, 'openspec', 'changes', 'add-login'))).toBe(false)
  })

  it('has no warnings when everything was written', async () => {
    await writeChange('add-login')
    expect(await lifecycle().terminate(command('add-login'))).toMatchObject({ kind: 'terminated', warnings: [] })
  })

  describe('commit', () => {
    async function seedRepo(): Promise<void> {
      await ensureUserLocalDir(repo, alice.slug)
      await writeChange('add-login', { phase: 'build' })
      await writeChange('other-task', { phase: 'build' })
      initGit()
    }

    it('commits only the moved task directory and leaves every other change in the checkout alone', async () => {
      await seedRepo()
      await writeFile(join(repo, 'other.txt'), 'untracked\n', 'utf8')
      await writeFile(join(repo, 'openspec', 'changes', 'other-task', 'notes.md'), 'in flight\n', 'utf8')
      await writeFile(join(repo, 'staged.txt'), 'staged\n', 'utf8')
      git('add', 'staged.txt')
      const head = git('rev-list', '--count', 'HEAD').trim()

      const outcome = await lifecycle({ git: gitStatusRunner }).terminate(command('add-login'))
      expect(outcome).toMatchObject({ kind: 'terminated', commit: { kind: 'committed' } })

      expect(git('rev-list', '--count', 'HEAD').trim()).toBe(String(Number(head) + 1))
      expect(git('log', '-1', '--format=%s').trim()).toBe('chore(tenon): terminate add-login')
      const files = git('show', '--name-only', '--format=', 'HEAD').split('\n').filter((line) => line !== '')
      expect(files.length).toBeGreaterThan(0)
      for (const file of files) {
        expect(file.startsWith('openspec/changes/add-login/') || file.startsWith(`openspec/changes/archive/${DAY}-add-login/`)).toBe(true)
      }
      // 任务结果是状态的一部分，随任务目录一起进了这次提交。
      expect(files).toContain(`openspec/changes/archive/${DAY}-add-login/.pipeline.yaml`)
      expect(git('show', `HEAD:openspec/changes/archive/${DAY}-add-login/.pipeline.yaml`)).toContain('task_result: terminated')

      const status = git('status', '--porcelain', '--untracked-files=all')
      expect(status).toContain('?? other.txt')
      expect(status).toContain('?? openspec/changes/other-task/notes.md')
      expect(status).toContain('A  staged.txt')
      expect(status).not.toContain('add-login')
      expect(status).not.toContain('.pipeline.lock')
    })

    it('commits only the archive directory when the task was never tracked', async () => {
      await seedRepo()
      await writeChange('fresh-task', { phase: 'spec' })
      const outcome = await lifecycle({ git: gitStatusRunner }).terminate(command('fresh-task'))
      expect(outcome).toMatchObject({ kind: 'terminated', commit: { kind: 'committed' } })
      const files = git('show', '--name-only', '--format=', 'HEAD').split('\n').filter((line) => line !== '')
      expect(files.length).toBeGreaterThan(0)
      expect(files.every((file) => file.startsWith(`openspec/changes/archive/${DAY}-fresh-task/`))).toBe(true)
    })

    it('reports a git runner that throws as a failed commit and keeps the move', async () => {
      await seedRepo()
      const outcome = await lifecycle({ git: async () => { throw new Error('git exploded') } }).terminate(command('add-login'))
      expect(outcome).toMatchObject({ kind: 'terminated', commit: { kind: 'failed', detail: expect.stringContaining('git exploded') } })
      expect(await exists(join(repo, 'openspec', 'changes', 'archive', `${DAY}-add-login`))).toBe(true)
    })

    it('reports a failed commit without undoing the move', async () => {
      await seedRepo()
      writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho blocked >&2\nexit 1\n', { mode: 0o755 })
      const outcome = await lifecycle({ git: gitStatusRunner }).terminate(command('add-login'))
      expect(outcome).toMatchObject({ kind: 'terminated', commit: { kind: 'failed' } })
      expect(await exists(join(repo, 'openspec', 'changes', 'add-login'))).toBe(false)
      expect(await exists(join(repo, 'openspec', 'changes', 'archive', `${DAY}-add-login`))).toBe(true)
    })
  })
})

describe('finish', () => {
  it('moves a task whose state machine finished and records 完结', async () => {
    await writeChange('add-login', { phase: 'done', archived: 'true' })
    const outcome = await lifecycle().finish({ repoRoot: repo, change: 'add-login' })
    const archivedDir = `openspec/changes/archive/${DAY}-add-login`
    expect(outcome).toEqual({
      kind: 'finished', change: 'add-login',
      archived: { change: 'add-login', result: 'finished', archivedDir, endedAt: NOW },
    })
    expect(await exists(join(repo, 'openspec', 'changes', 'add-login'))).toBe(false)
    expect(await readTaskResult(join(repo, archivedDir))).toBe('finished')
  })

  it('records 已升级 when the terminal step is escalated', async () => {
    await writeChange('add-login', { phase: 'escalated', archived: 'true' })
    const outcome = await lifecycle().finish({ repoRoot: repo, change: 'add-login' })
    expect(outcome).toMatchObject({ kind: 'finished', archived: { result: 'escalated' } })
    const moved = join(repo, outcome.kind === 'finished' ? outcome.archived.archivedDir : '')
    expect((await createStateStore().read(moved)).fields.task_result).toBe('escalated')
  })

  it('leaves the task active with an empty task_result when openspec fails', async () => {
    const dir = await writeChange('add-login', { phase: 'archive', archived: 'true' })
    const outcome = await lifecycle({
      specOf: () => 'openspec',
      runOpenspecArchive: async () => { throw new Error('archive_validation_failed') },
    }).finish({ repoRoot: repo, change: 'add-login' })
    expect(outcome).toMatchObject({ kind: 'archive-failed', code: 'openspec-failed' })
    expect(await exists(dir)).toBe(true)
    expect((await createStateStore().read(dir)).fields.task_result).toBe('')
  })

  it('refuses a task that has not reached a terminal step and writes nothing', async () => {
    await writeChange('add-login', { phase: 'verify' })
    const before = await treeBytes(repo)
    expect(await lifecycle().finish({ repoRoot: repo, change: 'add-login' }))
      .toEqual({ kind: 'not-terminal', change: 'add-login', phase: 'verify' })
    expect(await treeBytes(repo)).toEqual(before)
  })

  it('delegates to openspec archive when the task is governed by OpenSpec', async () => {
    await writeChange('add-login', { phase: 'archive', archived: 'true' })
    const calls: string[] = []
    const outcome = await lifecycle({ specOf: () => 'openspec', runOpenspecArchive: openspecMove(calls) })
      .finish({ repoRoot: repo, change: 'add-login' })
    expect(calls).toEqual(['add-login'])
    expect(outcome).toMatchObject({ kind: 'finished', archived: { result: 'finished' } })
  })

  it('archives a second same-day task of the same name under a numbered directory', async () => {
    await writeChange('add-login', { phase: 'done', archived: 'true' })
    await lifecycle().finish({ repoRoot: repo, change: 'add-login' })
    await writeChange('add-login', { phase: 'done', archived: 'true' })
    expect(await lifecycle().finish({ repoRoot: repo, change: 'add-login' }))
      .toMatchObject({ kind: 'finished', archived: { archivedDir: `openspec/changes/archive/${DAY}-add-login-2` } })
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
    // 交互标记按会话分文件：被删任务的会话随绑定一起走，别的会话的标记不动。
    await writeFile(join(repo, `${INTERACTION_MARKER_SESSION_PREFIX}sess-a`), 'pipeline-interaction-v2\n', 'utf8')
    await writeFile(join(repo, `${INTERACTION_MARKER_SESSION_PREFIX}sess-keep`), 'pipeline-interaction-v2\n', 'utf8')
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
    expect(removed).toContain(`${INTERACTION_MARKER_SESSION_PREFIX}sess-a`)
    expect(await exists(join(repo, `${INTERACTION_MARKER_SESSION_PREFIX}sess-a`))).toBe(false)
    expect(await exists(join(repo, `${INTERACTION_MARKER_SESSION_PREFIX}sess-keep`))).toBe(true)
    const aPaths = userProjectPaths(repo, alice.slug)
    expect(await exists(join(aPaths.testsDir, 'keep-me', 'run.json'))).toBe(true)
    expect(await exists(userProjectPaths(repo, bob.slug).authority)).toBe(true)
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

  it('stays a success when the tracked audit row cannot be written after the staging, and names the failure', async () => {
    await writeChange('add-login')
    await mkdir(userProjectPaths(repo, alice.slug).audit, { recursive: true })
    const outcome = await lifecycle().delete(command('add-login', 'all'))
    expect(outcome).toMatchObject({ kind: 'deleted', change: 'add-login' })
    expect(outcome.kind === 'deleted' ? outcome.warnings : []).toEqual([expect.stringMatching(/审计.*EISDIR/su)])
    expect(await exists(join(repo, 'openspec', 'changes', 'add-login'))).toBe(false)
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

  it('fails a writer that waits for the lock of the deleted Change and never recreates it', async () => {
    await writeChange('add-login')
    const real = createStateStore()
    const changeDir = join(repo, 'openspec', 'changes', 'add-login')
    // The writer queues up while the deletion holds the task lock, i.e. from inside its first read.
    let waiter: Promise<unknown> | undefined
    const store = spyStore([], (dir) => {
      waiter ??= real.withLock(dir, async () => 'ran').catch((error: unknown) => error)
    })
    expect(await lifecycle({ store }).delete(command('add-login', 'all'))).toMatchObject({ kind: 'deleted' })
    expect(await waiter).toBeInstanceOf(Error)
    expect(await exists(changeDir)).toBe(false)
  })
})
