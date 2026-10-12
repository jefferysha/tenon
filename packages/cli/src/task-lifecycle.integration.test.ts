/**
 * `tenon task delete|terminate|finish` end to end: real temporary project, real `init`, real git
 * repository, real kernel application. Deletion and termination move or remove whole task directories, so
 * the refusal exit codes are asserted together with the state staying intact. `task archive|unarchive`
 * (the per-user "hide") are retired and only point at `terminate`.
 */
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { freshHarness, rm, type Harness } from './integration-harness.js'

const SLUG = 'tester-at-tenon.test'
const DATED_NAME = /^\d{4}-\d{2}-\d{2}-/u

let h: Harness

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: h.cwd, encoding: 'utf8' })
}

function initGit(): void {
  git('init', '-q')
  git('config', 'user.email', 'tenon-tests@example.invalid')
  git('config', 'user.name', 'Tenon tests')
  git('add', '-A')
  git('commit', '-qm', 'seed')
}

async function init(name: string): Promise<void> {
  expect(await h.run(['init', name, '--track', 'backend', '--preset', 'full'])).toBe(0)
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function lastJson(): unknown {
  return JSON.parse(h.out[h.out.length - 1] ?? 'null')
}

function archiveDir(): string {
  return join(h.cwd, 'openspec', 'changes', 'archive')
}

/** 归档目录里名字（去掉日期前缀）以 `name` 开头的那些，按字典序。 */
async function archivedNamed(name: string): Promise<string[]> {
  const entries = await readdir(archiveDir()).catch(() => [] as string[])
  return entries.filter((entry) => DATED_NAME.test(entry) && entry.replace(DATED_NAME, '').startsWith(name)).sort()
}

/** 归档目录里规范状态（YAML 投影）记着的 task_result；没有这一行 = 没有任务结果。 */
async function resultOf(dir: string): Promise<string | undefined> {
  const text = await readFile(join(archiveDir(), dir, '.pipeline.yaml'), 'utf8')
  return /^task_result: (\S+)$/mu.exec(text)?.[1]
}

beforeEach(async () => {
  h = await freshHarness()
})

afterEach(async () => {
  await rm(h.cwd, { recursive: true, force: true })
})

describe('tenon task delete', () => {
  test('removes the task from the working tree only and reports 未提交删除', async () => {
    await init('feat')
    await init('other')
    initGit()
    const head = git('rev-list', '--count', 'HEAD').trim()

    expect(await h.run(['task', 'delete', 'feat', '--yes'])).toBe(0)
    expect(h.err.join('\n')).toContain('[DELETE] feat')
    expect(h.err.join('\n')).toContain('未提交删除 1')
    expect(await exists(join(h.cwd, 'openspec', 'changes', 'feat'))).toBe(false)

    expect(await h.run(['list', '--json'])).toBe(0)
    expect(JSON.stringify(lastJson())).not.toContain('feat')
    expect(JSON.stringify(lastJson())).toContain('other')

    const status = git('status', '--porcelain')
    expect(status).toMatch(/^ D openspec\/changes\/feat\//mu)
    expect(git('rev-list', '--count', 'HEAD').trim()).toBe(head)
    expect(git('log', '--oneline').trim().split('\n')).toHaveLength(1)
  })

  test('emits the machine shape with --json', async () => {
    await init('feat')
    expect(await h.run(['task', 'delete', 'feat', '--yes', '--json'])).toBe(0)
    expect(lastJson()).toMatchObject({ change: 'feat', uncommitted_deletions: null })
    expect((lastJson() as { removed: string[] }).removed).toContain('openspec/changes/feat')
  })

  test('exits 2 for an unacknowledged confirmation and 0 once confirmed, leaving state intact until then', async () => {
    await init('feat')
    await h.seedArtifact('feat', 'review_gate_status', 'pending')
    const before = await h.read('feat')
    expect(await h.run(['task', 'delete', 'feat'])).toBe(2)
    expect(h.err.join('\n')).toContain('评审待确认')
    expect(h.err.join('\n')).toContain('--yes')
    expect(await h.read('feat')).toBe(before)
    expect(await h.run(['task', 'delete', 'feat', '--yes'])).toBe(0)
    expect(await exists(join(h.cwd, 'openspec', 'changes', 'feat'))).toBe(false)
  })

  test('exits 3 while AFK is running, even with --yes', async () => {
    await init('feat')
    await h.seedArtifact('feat', 'automation', 'running')
    expect(await h.run(['task', 'delete', 'feat', '--yes'])).toBe(3)
    expect(h.err.join('\n')).toContain('AFK 运行中')
    expect(h.err.join('\n')).toContain('tenon afk cancel feat')
    expect(await exists(join(h.cwd, 'openspec', 'changes', 'feat'))).toBe(true)
  })

  test('exits 1 for a bad name and a missing task', async () => {
    await init('feat')
    expect(await h.run(['task', 'delete', 'archive', '--yes'])).toBe(1)
    expect(h.err.join('\n')).toContain('change-name 非法')
    expect(await h.run(['task', 'delete', 'nope', '--yes'])).toBe(1)
    expect(h.err.join('\n')).toContain('任务不存在: nope')
  })

  test('clears the current user selection of the deleted task', async () => {
    await init('feat')
    expect(await h.run(['session', 'activate', 'feat'])).toBe(0)
    const pointer = join(h.cwd, '.tenon', 'users', SLUG, 'local', 'active-change')
    expect(await readFile(pointer, 'utf8')).toBe('feat\n')
    expect(await h.run(['task', 'delete', 'feat', '--yes'])).toBe(0)
    expect(await exists(pointer)).toBe(false)
  })
})

describe('tenon task terminate', () => {
  test('records 已终止, moves the task into archive/ and commits only the moved task directory', async () => {
    await init('x')
    await init('other-task')
    initGit()
    await writeFile(join(h.cwd, 'other.txt'), 'someone else is working on this\n', 'utf8')
    await writeFile(join(h.cwd, 'openspec', 'changes', 'other-task', 'notes.md'), 'in flight\n', 'utf8')
    const head = git('rev-list', '--count', 'HEAD').trim()

    expect(await h.run(['task', 'terminate', 'x'])).toBe(0)
    expect(h.err.join('\n')).toContain('[TERMINATE] x')
    expect(h.err.join('\n')).toContain('[COMMIT] chore(tenon): terminate x')

    const [dated] = await archivedNamed('x')
    expect(dated).toBeDefined()
    expect(await resultOf(dated as string)).toBe('terminated')
    expect(await exists(join(h.cwd, 'openspec', 'changes', 'x'))).toBe(false)
    // 任务结果是任务状态的一部分，随任务目录进了这次提交；没有单独的结果文件。
    expect(git('show', `HEAD:openspec/changes/archive/${dated as string}/.pipeline.yaml`)).toContain('task_result: terminated')
    expect(await exists(join(archiveDir(), dated as string, 'task-result.json'))).toBe(false)

    expect(git('rev-list', '--count', 'HEAD').trim()).toBe(String(Number(head) + 1))
    expect(git('log', '-1', '--format=%s').trim()).toBe('chore(tenon): terminate x')
    const committed = git('show', '--name-only', '--format=', 'HEAD').split('\n').filter((line) => line !== '')
    expect(committed.length).toBeGreaterThan(0)
    for (const path of committed) {
      expect(path.startsWith('openspec/changes/x/') || path.startsWith(`openspec/changes/archive/${dated as string}/`), path).toBe(true)
    }

    const status = git('status', '--short', '--untracked-files=all')
    expect(status).toContain('?? other.txt')
    expect(status).toContain('?? openspec/changes/other-task/notes.md')
    expect(status).not.toMatch(/openspec\/changes\/x\//u)
    expect(status).not.toMatch(/archive\//u)
  })

  test('the task disappears from list and appears in the finished list; status says 已终止', async () => {
    await init('x')
    expect(await h.run(['task', 'terminate', 'x'])).toBe(0)
    expect(await h.run(['list', '--json'])).toBe(0)
    expect(JSON.stringify(lastJson())).not.toContain('"x"')
    expect(await h.run(['list', '--finished', '--json'])).toBe(0)
    expect(JSON.stringify(lastJson())).toContain('"name":"x"')
    expect(await h.run(['status', 'x', '--json'])).toBe(0)
    const payload = lastJson() as { step?: { next: readonly { action: string; message?: string }[] } }
    expect(payload.step?.next[0]).toMatchObject({ action: 'stop' })
    expect(JSON.stringify(payload.step?.next)).toContain('已终止')
  })

  test('emits the machine shape with --json', async () => {
    await init('x')
    expect(await h.run(['task', 'terminate', 'x', '--json'])).toBe(0)
    expect(lastJson()).toMatchObject({
      change: 'x', result: 'terminated', commit: 'skipped',
      archived_dir: expect.stringMatching(/^openspec\/changes\/archive\/\d{4}-\d{2}-\d{2}-x$/u),
      ended_at: expect.any(String),
    })
  })

  test('stays exit 0 when the audit row cannot be written after the move, and says so as a WARN', async () => {
    await init('x')
    // A directory where the personal audit file belongs: the append fails once the task is already archived.
    await mkdir(join(h.cwd, '.tenon', 'users', SLUG, 'local', 'audit.jsonl'), { recursive: true })
    expect(await h.run(['task', 'terminate', 'x'])).toBe(0)
    expect(h.err.join('\n')).toMatch(/WARN: 审计记录没写进去.*EISDIR/su)
    expect(await archivedNamed('x')).toHaveLength(1)
    expect(await exists(join(h.cwd, 'openspec', 'changes', 'x'))).toBe(false)
  })

  test('same-day, same-name tasks never overwrite each other in archive/', async () => {
    await init('x')
    expect(await h.run(['task', 'terminate', 'x'])).toBe(0)
    await init('x')
    expect(await h.run(['task', 'terminate', 'x'])).toBe(0)
    const names = await archivedNamed('x')
    expect(names).toHaveLength(2)
    expect(names[0]).toMatch(/-x$/u)
    expect(names[1]).toMatch(/-x-2$/u)
    expect(await resultOf(names[0] as string)).toBe('terminated')
    expect(await resultOf(names[1] as string)).toBe('terminated')
  })

  test('exits 3 while AFK is running or queued, even with --yes, and 2 until a confirmation is acknowledged', async () => {
    await init('feat')
    await h.seedArtifact('feat', 'automation', 'queued')
    expect(await h.run(['task', 'terminate', 'feat', '--yes'])).toBe(3)
    expect(h.err.join('\n')).toContain('AFK 排队')
    expect(h.err.join('\n')).toContain('tenon cas feat automation queued off')
    await h.seedArtifact('feat', 'automation', 'running')
    expect(await h.run(['task', 'terminate', 'feat', '--yes'])).toBe(3)
    expect(h.err.join('\n')).toContain('tenon afk cancel feat')
    await h.seedArtifact('feat', 'automation', 'null')
    await h.seedArtifact('feat', 'review_gate_status', 'pending')
    const before = await h.read('feat')
    expect(await h.run(['task', 'terminate', 'feat'])).toBe(2)
    expect(await h.read('feat')).toBe(before)
    expect(await exists(join(h.cwd, 'openspec', 'changes', 'feat'))).toBe(true)
    expect(await h.run(['task', 'terminate', 'feat', '--yes'])).toBe(0)
    expect(await exists(join(h.cwd, 'openspec', 'changes', 'feat'))).toBe(false)
  })

  test('refuses a task whose state machine already finished and points at finish', async () => {
    await init('feat')
    await h.seedPhase('feat', 'archive')
    await h.seedArtifact('feat', 'archived', 'true')
    expect(await h.run(['task', 'terminate', 'feat'])).toBe(1)
    expect(h.err.join('\n')).toContain('tenon task finish feat')
    expect(await exists(join(h.cwd, 'openspec', 'changes', 'feat'))).toBe(true)
  })

  test('exits 1 for a bad name and a missing task', async () => {
    expect(await h.run(['task', 'terminate', 'archive'])).toBe(1)
    expect(h.err.join('\n')).toContain('change-name 非法')
    expect(await h.run(['task', 'terminate', 'nope'])).toBe(1)
    expect(h.err.join('\n')).toContain('任务不存在: nope')
  })
})

describe('tenon task finish', () => {
  test('moves a finished OpenSpec-governed task into archive/ and records 完结', async () => {
    await init('feat')
    await h.seedPhase('feat', 'archive')
    await h.seedArtifact('feat', 'archived', 'true')
    expect(await h.run(['task', 'finish', 'feat'])).toBe(0)
    expect(h.err.join('\n')).toContain('[FINISH] feat 完结')
    const [dated] = await archivedNamed('feat')
    expect(dated).toBeDefined()
    expect(await resultOf(dated as string)).toBe('finished')
    expect(await exists(join(h.cwd, 'openspec', 'changes', 'feat'))).toBe(false)

    expect(await h.run(['status', 'feat', '--json'])).toBe(0)
    const payload = lastJson() as { finished_changes?: { name: string }[]; step?: { next: readonly { action: string }[] } }
    expect(payload.finished_changes?.map((row) => row.name)).toEqual(['feat'])
    expect(payload.step?.next).toEqual([expect.objectContaining({ action: 'stop', code: 'finished' })])
  })

  test('records 已升级 when the task stopped at the escalated step, and does not commit', async () => {
    await init('feat')
    initGit()
    await h.seedPhase('feat', 'escalated')
    await h.seedArtifact('feat', 'archived', 'true')
    const head = git('rev-list', '--count', 'HEAD').trim()
    expect(await h.run(['task', 'finish', 'feat', '--json'])).toBe(0)
    expect(lastJson()).toMatchObject({ change: 'feat', result: 'escalated' })
    const [dated] = await archivedNamed('feat')
    expect(await resultOf(dated as string)).toBe('escalated')
    expect(git('rev-list', '--count', 'HEAD').trim()).toBe(head)
  })

  test('refuses a task that has not reached a terminal step and points at terminate', async () => {
    await init('feat')
    const before = await h.read('feat')
    expect(await h.run(['task', 'finish', 'feat'])).toBe(1)
    expect(h.err.join('\n')).toContain('tenon task terminate feat')
    expect(await h.read('feat')).toBe(before)
    expect(await exists(join(h.cwd, 'openspec', 'changes', 'feat'))).toBe(true)
    expect(await exists(archiveDir())).toBe(false)
  })

  test('exits 1 for a bad name and a missing task', async () => {
    expect(await h.run(['task', 'finish', 'archive'])).toBe(1)
    expect(h.err.join('\n')).toContain('change-name 非法')
    expect(await h.run(['task', 'finish', 'nope'])).toBe(1)
    expect(h.err.join('\n')).toContain('任务不存在: nope')
  })
})

describe('task_result 只由 tenon task finish / terminate 写入', () => {
  test('set / set-many / cas 都被拒，状态一个字节不变，文案说明只由 finish / terminate 写', async () => {
    await init('feat')
    const before = await h.read('feat')
    for (const argv of [
      ['set', 'feat', 'task_result', 'terminated'],
      ['set-many', 'feat', 'task_result=finished', 'branch=feat/x'],
      ['cas', 'feat', 'task_result', 'null', 'terminated'],
      ['cas', 'feat', 'task_result', '', 'escalated'],
    ]) {
      expect(await h.run(argv), argv.join(' ')).toBe(1)
      const err = h.err.join('\n')
      expect(err, argv.join(' ')).toContain('task_result')
      expect(err, argv.join(' ')).toContain('tenon task finish')
      expect(err, argv.join(' ')).toContain('tenon task terminate')
    }
    expect(await h.read('feat')).toBe(before)
    expect(await h.run(['get', 'feat', 'task_result'])).toBe(0)
    expect(h.out.join('')).toBe('')
  })

  test('终止之后归档目录里 task_result=terminated，tenon get 读得到；终止的任务不能被改回', async () => {
    await init('feat')
    expect(await h.run(['task', 'terminate', 'feat'])).toBe(0)
    expect(await h.run(['get', 'feat', 'task_result'])).toBe(0)
    expect(h.out.join('')).toBe('terminated')
    expect(await h.run(['set', 'feat', 'task_result', ''])).toBe(1)
    const [dated] = await archivedNamed('feat')
    expect(await resultOf(dated as string)).toBe('terminated')
  })

  test('完结 / 已升级之后同样记着各自的结果', async () => {
    await init('done-one')
    await h.seedPhase('done-one', 'archive')
    await h.seedArtifact('done-one', 'archived', 'true')
    await init('gave-up')
    await h.seedPhase('gave-up', 'escalated')
    await h.seedArtifact('gave-up', 'archived', 'true')
    expect(await h.run(['task', 'finish', 'done-one'])).toBe(0)
    expect(await h.run(['task', 'finish', 'gave-up'])).toBe(0)
    expect(await h.run(['get', 'done-one', 'task_result'])).toBe(0)
    expect(h.out.join('')).toBe('finished')
    expect(await h.run(['get', 'gave-up', 'task_result'])).toBe(0)
    expect(h.out.join('')).toBe('escalated')
  })
})

describe('tenon task archive / unarchive 已退役', () => {
  test('exit 1 and name terminate / finish as the way to end a task; nothing is written', async () => {
    await init('feat')
    const before = await h.read('feat')
    for (const sub of ['archive', 'unarchive']) {
      expect(await h.run(['task', sub, 'feat'])).toBe(1)
      const err = h.err.join('\n')
      expect(err).toContain(`tenon task ${sub} 已退役`)
      expect(err).toContain('tenon task terminate feat')
      expect(err).toContain('tenon task finish feat')
    }
    expect(await h.read('feat')).toBe(before)
    expect(await exists(archiveDir())).toBe(false)
    expect(await exists(join(h.cwd, '.tenon', 'users', SLUG, 'local', 'archived.json'))).toBe(false)
  })

  test('list --archived no longer exists', async () => {
    await init('feat')
    await expect(h.run(['list', '--archived'])).rejects.toThrow("unknown option '--archived'")
  })

  test('reports an unknown task sub-command with the new verbs', async () => {
    expect(await h.run(['task', 'nope', 'feat'])).toBe(1)
    expect(h.err.join('\n')).toContain('delete terminate finish')
  })
})

describe('已终止任务拒绝推进', () => {
  test('transition / advance / review request / document record / artifact register 全部 exit 1 并指向新建任务', async () => {
    await init('feat')
    expect(await h.run(['task', 'terminate', 'feat'])).toBe(0)

    for (const argv of [
      ['transition', 'feat', 'open-complete'],
      ['advance', 'feat'],
      ['review', 'request', 'feat'],
      ['document', 'record', 'feat', 'proposal', 'openspec/changes/feat/proposal.md', '--producer', 'tenon-open'],
      ['artifact', 'register', 'feat', 'design_doc', 'docs/x.md', '--producer', 'tenon-explore'],
      ['set', 'feat', 'branch', 'feat/x'],
      ['set-many', 'feat', 'branch=feat/x'],
      ['cas', 'feat', 'branch', 'null', 'feat/x'],
    ]) {
      expect(await h.run(argv), argv.join(' ')).toBe(1)
      expect(h.err.join('\n')).toContain("任务 'feat' 已终止")
      expect(h.err.join('\n')).toContain('depends_on feat')
    }
  })

  test('get 仍然读得到终止任务的状态', async () => {
    await init('feat')
    expect(await h.run(['task', 'terminate', 'feat'])).toBe(0)
    expect(await h.run(['get', 'feat', 'phase'])).toBe(0)
    expect(h.out.join('')).toBe('open')
  })
})

/**
 * 真机实测的 P0（acceptance run）：`openspec archive` 抢在 `tenon transition <c> archived` 前面
 * 跑过——两条命令的先后此前没有任何地方说过。change 目录被搬进 `openspec/changes/archive/`，
 * `archived` 还是 false，于是每条写入路径都在活跃路径上开锁，抛出
 * `ENOENT ... mkdir '.../.pipeline.lock.claim-<uuid>'`：一个只会出现在锁实现里的字符串，既不说
 * 发生了什么也不说怎么办，任务再也无法被标成完结，只能手工把目录搬回去。
 */
describe('openspec archive 抢跑：目录已搬走而任务还没完结', () => {
  const DATED = '2026-01-02-feat'

  async function relocate(): Promise<void> {
    await mkdir(join(h.cwd, 'openspec', 'changes', 'archive'), { recursive: true })
    await rename(
      join(h.cwd, 'openspec', 'changes', 'feat'),
      join(h.cwd, 'openspec', 'changes', 'archive', DATED),
    )
  }

  test('写入口说清楚发生了什么、为什么、怎么恢复，而不是抛锁的 ENOENT', async () => {
    await init('feat')
    await relocate()
    for (const argv of [
      ['transition', 'feat', 'archived'],
      ['set', 'feat', 'branch', 'feat/x'],
      ['document', 'read', 'feat', 'all'],
      ['review', 'request', 'feat'],
    ]) {
      expect(await h.run(argv)).toBe(1)
      const err = h.err.join('\n')
      expect(err).toContain(`openspec/changes/archive/${DATED}`)
      expect(err).toContain('archived=false')
      expect(err).toContain(`mv openspec/changes/archive/${DATED} openspec/changes/feat`)
      expect(err).toContain('tenon transition feat archived')
      expect(err).toContain('tenon task finish feat')
      expect(err).not.toContain('ENOENT')
      expect(err).not.toContain('.pipeline.lock.claim')
    }
  })

  test('照提示搬回去之后命令照常工作', async () => {
    await init('feat')
    await relocate()
    expect(await h.run(['set', 'feat', 'branch', 'feat/x'])).toBe(1)
    await rename(
      join(h.cwd, 'openspec', 'changes', 'archive', DATED),
      join(h.cwd, 'openspec', 'changes', 'feat'),
    )
    expect(await h.run(['set', 'feat', 'branch', 'feat/x'])).toBe(0)
    expect(await h.run(['get', 'feat', 'branch'])).toBe(0)
    expect(h.out.join('')).toBe('feat/x')
  })

  test('搬走的 change 仍然查得到，只是不给继续改', async () => {
    await init('feat')
    await relocate()
    expect(await h.run(['status', 'feat'])).toBe(0)
    expect(h.out.join('\n')).toContain('feat')
    expect(await h.run(['get', 'feat', 'phase'])).toBe(0)
    expect(h.out.join('')).toBe('open')
  })
})
