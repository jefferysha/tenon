/** endedTasks —— 真 fs：只读摘要、倒序、按「目录名 + mtime」缓存，损坏的目录跳过而不是让整个列表失败。 */
import { describe, expect, it } from 'vitest'
import { cp, mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { archivedDocumentPath, createEndedTaskCache, listEndedTasks, MAX_ENDED_TASKS, resolveArchivedTaskDir } from './endedTasks.js'
import { copyArchivedTaskState, initChange, makeProject, newStore, seedArchivedTasks } from './test-support.js'

const archiveOf = (root: string): string => join(root, 'openspec', 'changes', 'archive')
const endedOf = async (root: string, cache = createEndedTaskCache()) => (await listEndedTasks(root, cache)).tasks

describe('listEndedTasks', () => {
  it('没有 archive/ 时是空列表', async () => {
    expect(await listEndedTasks(await makeProject(), createEndedTaskCache())).toEqual({ tasks: [], total: 0 })
  })

  it('活跃目录里的任务，状态里带着被打断的归档留下的 task_result，也不是已结束任务：只扫 archive/', async () => {
    const root = await makeProject()
    const store = newStore()
    await initChange(store, root, 'feat')
    await store.set(join(root, 'openspec', 'changes', 'feat'), 'task_result', 'terminated')
    expect(await listEndedTasks(root, createEndedTaskCache())).toEqual({ tasks: [], total: 0 })
  })

  it('60 个归档任务全部列出，按结束时间倒序', async () => {
    const root = await makeProject()
    // 目录名顺序与结束时间顺序相反：排序只能来自状态里最后一次修订的时间。
    const seeds = Array.from({ length: 60 }, (_, index) => ({
      dir: `2026-09-${String(30 - (index % 30)).padStart(2, '0')}-task-${String(index).padStart(2, '0')}`,
      observedAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString().replace('.000Z', 'Z'),
      fields: { task_result: 'finished' } as const,
    }))
    await seedArchivedTasks(root, seeds)

    const ended = await endedOf(root)

    expect(ended).toHaveLength(60)
    expect(ended.map((task) => task.endedAt)).toEqual(seeds.map((seed) => seed.observedAt).reverse())
    expect(ended[0]?.archivedDir).toBe('openspec/changes/archive/2026-09-01-task-59')
  })

  it('结束时间相同按目录名倒序', async () => {
    const root = await makeProject()
    await seedArchivedTasks(root, ['2026-10-01-b', '2026-10-01-c', '2026-10-01-a'].map((dir) => ({ dir, observedAt: '2026-10-01T10:00:00Z' })))

    const ended = await endedOf(root)

    expect(ended.map((task) => task.archivedDir)).toEqual([
      'openspec/changes/archive/2026-10-01-c',
      'openspec/changes/archive/2026-10-01-b',
      'openspec/changes/archive/2026-10-01-a',
    ])
  })

  it('只读摘要字段：名称去掉日期前缀，带工作流、轨道、负责人与有效的 PR 链接', async () => {
    const root = await makeProject()
    await seedArchivedTasks(root, [{
      dir: '2026-10-05-fix-login-2',
      observedAt: '2026-10-05T08:30:00Z',
      fields: { task_result: 'terminated', pr_url: 'https://github.com/o/r/pull/7', assignee: 'Alice <alice@x.io>' },
    }])

    const [task] = await endedOf(root)

    expect(task).toEqual({
      name: 'fix-login-2',
      workflow: 'default',
      track: 'backend',
      result: 'terminated',
      endedAt: '2026-10-05T08:30:00Z',
      prUrl: 'https://github.com/o/r/pull/7',
      owner: 'Alice',
      archivedDir: 'openspec/changes/archive/2026-10-05-fix-login-2',
    })
  })

  it('任务结果取自状态；没有该字段的旧归档与取值不认识的都是 unknown', async () => {
    const root = await makeProject()
    await seedArchivedTasks(root, [
      { dir: '2026-10-01-done', observedAt: '2026-10-01T01:00:00Z', fields: { task_result: 'finished' } },
      { dir: '2026-10-01-up', observedAt: '2026-10-01T02:00:00Z', fields: { task_result: 'escalated' } },
      { dir: '2026-10-01-old', observedAt: '2026-10-01T03:00:00Z' },
      { dir: '2026-10-01-odd', observedAt: '2026-10-01T04:00:00Z', fields: { task_result: 'abandoned' } },
    ])

    const ended = await endedOf(root)

    expect(Object.fromEntries(ended.map((task) => [task.name, task.result]))).toEqual({
      done: 'finished', up: 'escalated', old: 'unknown', odd: 'unknown',
    })
  })

  it('PR 链接只接受 http(s) 地址，其余字段值不进摘要', async () => {
    const root = await makeProject()
    await seedArchivedTasks(root, [
      { dir: '2026-10-01-script', observedAt: '2026-10-01T01:00:00Z', fields: { pr_url: 'javascript:alert(1)' } },
      { dir: '2026-10-01-null', observedAt: '2026-10-01T02:00:00Z', fields: { pr_url: 'null' } },
    ])

    const ended = await endedOf(root)

    expect(ended.map((task) => task.prUrl)).toEqual([undefined, undefined])
  })

  it('.hidden、普通文件与指向目录的符号链接都被忽略', async () => {
    const root = await makeProject()
    const [real] = await seedArchivedTasks(root, [{ dir: '2026-10-01-real', observedAt: '2026-10-01T01:00:00Z' }])
    if (real === undefined) throw new Error('seed failed')
    await cp(real, join(archiveOf(root), '.2026-10-01-hidden'), { recursive: true })
    await writeFile(join(archiveOf(root), 'notes.md'), 'x', 'utf8')
    await symlink(real, join(archiveOf(root), '2026-10-02-link'), 'dir')

    const ended = await endedOf(root)

    expect(ended.map((task) => task.name)).toEqual(['real'])
  })

  it('archive 本身是符号链接时不读它', async () => {
    const root = await makeProject()
    const outside = await makeProject()
    await seedArchivedTasks(outside, [{ dir: '2026-10-01-elsewhere', observedAt: '2026-10-01T01:00:00Z' }])
    await mkdir(join(root, 'openspec', 'changes'), { recursive: true })
    await symlink(archiveOf(outside), archiveOf(root), 'dir')

    expect(await endedOf(root)).toEqual([])
  })

  it('损坏的目录被跳过，其余照常列出', async () => {
    const root = await makeProject()
    const dirs = await seedArchivedTasks(root, [
      { dir: '2026-10-01-garbage', observedAt: '2026-10-01T01:00:00Z' },
      { dir: '2026-10-01-oversized', observedAt: '2026-10-01T02:00:00Z' },
      { dir: '2026-10-01-linked-state', observedAt: '2026-10-01T03:00:00Z' },
      { dir: '2026-10-01-fine', observedAt: '2026-10-01T04:00:00Z' },
    ])
    const [garbage, oversized, linkedState] = dirs
    if (garbage === undefined || oversized === undefined || linkedState === undefined) throw new Error('seed failed')
    // 有 current.json 就以它为准：它坏了不能退回 YAML 投影去掩盖。
    await writeFile(join(garbage, '.pipeline-run', 'current.json'), '{ not json', 'utf8')
    // 内容本身有效、只是超过读取上限：不读，而不是读完再解析。
    const validState = await readFile(join(oversized, '.pipeline-run', 'current.json'), 'utf8')
    await writeFile(join(oversized, '.pipeline-run', 'current.json'), `${validState}${' '.repeat(2 * 1024 * 1024)}`, 'utf8')
    const elsewhere = join(root, 'detached-run')
    await cp(join(linkedState, '.pipeline-run'), elsewhere, { recursive: true })
    await rm(join(linkedState, '.pipeline-run'), { recursive: true })
    await symlink(elsewhere, join(linkedState, '.pipeline-run'), 'dir')

    const ended = await endedOf(root)

    expect(ended.map((task) => task.name)).toEqual(['fine'])
  })

  it('只有旧版 .pipeline.yaml 的归档照样列出：结果 unknown，结束时间取目录名里的日期', async () => {
    const root = await makeProject()
    const [dir] = await seedArchivedTasks(root, [{ dir: '2026-08-09-legacy', observedAt: '2026-10-01T01:00:00Z' }])
    if (dir === undefined) throw new Error('seed failed')
    await rm(join(dir, '.pipeline-run'), { recursive: true })

    const [task] = await endedOf(root)

    expect(task).toMatchObject({ name: 'legacy', result: 'unknown', endedAt: '2026-08-09T00:00:00Z' })
  })

  it('没有任何任务状态的目录不是任务，不列出', async () => {
    const root = await makeProject()
    await mkdir(join(archiveOf(root), '2026-10-01-plain-openspec'), { recursive: true })

    expect(await endedOf(root)).toEqual([])
  })
})

describe('listEndedTasks 的缓存', () => {
  it('目录名与 mtime 不变就不再读状态文件；mtime 变了才重读', async () => {
    const root = await makeProject()
    const [dir] = await seedArchivedTasks(root, [{ dir: '2026-10-01-cached', observedAt: '2026-10-01T01:00:00Z', fields: { task_result: 'finished' } }])
    if (dir === undefined) throw new Error('seed failed')
    const cache = createEndedTaskCache()
    const first = await endedOf(root, cache)
    expect(first[0]?.result).toBe('finished')

    // 嵌套文件的改动不改变归档目录自己的 mtime；第二次调用若还在读文件，下面的损坏内容会让这一项消失。
    await writeFile(join(dir, '.pipeline-run', 'current.json'), '{ not json', 'utf8')
    expect(await endedOf(root, cache)).toEqual(first)

    const later = new Date(Date.now() + 60_000)
    await utimes(dir, later, later)
    expect(await endedOf(root, cache)).toEqual([])
  })

  it('损坏的目录同样记住，mtime 不变就不反复去读', async () => {
    const root = await makeProject()
    const [dir] = await seedArchivedTasks(root, [{ dir: '2026-10-01-broken', observedAt: '2026-10-01T01:00:00Z' }])
    if (dir === undefined) throw new Error('seed failed')
    const current = join(dir, '.pipeline-run', 'current.json')
    const original = await readFile(current, 'utf8')
    await writeFile(current, '{ not json', 'utf8')
    const cache = createEndedTaskCache()
    expect(await endedOf(root, cache)).toEqual([])

    await writeFile(current, original, 'utf8')
    expect(await endedOf(root, cache)).toEqual([])

    const later = new Date(Date.now() + 60_000)
    await utimes(dir, later, later)
    expect((await endedOf(root, cache)).map((task) => task.name)).toEqual(['broken'])
  })

  it('目录被移走后，它的缓存项随下一次列表一起清掉', async () => {
    const root = await makeProject()
    const [first, second] = await seedArchivedTasks(root, [
      { dir: '2026-10-01-a', observedAt: '2026-10-01T01:00:00Z' },
      { dir: '2026-10-01-b', observedAt: '2026-10-01T02:00:00Z' },
    ])
    if (first === undefined || second === undefined) throw new Error('seed failed')
    const cache = createEndedTaskCache()
    await endedOf(root, cache)
    expect(cache.entries.size).toBe(2)

    await rm(first, { recursive: true })
    await endedOf(root, cache)

    expect(cache.entries.size).toBe(1)
  })
})

describe('listEndedTasks 的数量上限与总数', () => {
  const copyNames = (count: number): string[] => Array.from({ length: count }, (_, index) => `2026-02-01-copy-${String(index).padStart(4, '0')}`)

  it('1001 个归档任务：只给最新的 MAX_ENDED_TASKS 个，total 仍是 1001', async () => {
    const root = await makeProject()
    // 名字最新（12 月）的那个结束得最早：按目录名截断会留下它、丢掉别的，按结束时间截断才对。
    const [, template] = await seedArchivedTasks(root, [
      { dir: '2026-12-31-ended-long-ago', observedAt: '2020-01-01T00:00:00Z' },
      { dir: '2026-01-01-template', observedAt: '2026-06-01T00:00:00Z' },
    ])
    if (template === undefined) throw new Error('seed failed')
    await copyArchivedTaskState(template, root, copyNames(MAX_ENDED_TASKS - 1))

    const { tasks, total } = await listEndedTasks(root, createEndedTaskCache())

    expect(total).toBe(MAX_ENDED_TASKS + 1)
    expect(tasks).toHaveLength(MAX_ENDED_TASKS)
    expect(tasks.some((task) => task.name === 'ended-long-ago')).toBe(false)
    expect(tasks.every((task) => task.endedAt === '2026-06-01T00:00:00Z')).toBe(true)
  })

  it('恰好 MAX_ENDED_TASKS 个：不截断，total 与列表一样长', async () => {
    const root = await makeProject()
    const [template] = await seedArchivedTasks(root, [{ dir: '2026-01-01-template', observedAt: '2026-06-01T00:00:00Z' }])
    if (template === undefined) throw new Error('seed failed')
    await copyArchivedTaskState(template, root, copyNames(MAX_ENDED_TASKS - 1))

    const { tasks, total } = await listEndedTasks(root, createEndedTaskCache())

    expect(total).toBe(MAX_ENDED_TASKS)
    expect(tasks).toHaveLength(MAX_ENDED_TASKS)
  })

  it('total 只数读得出来的任务：损坏的目录和普通文件不算', async () => {
    const root = await makeProject()
    const [good, broken] = await seedArchivedTasks(root, [
      { dir: '2026-10-01-good', observedAt: '2026-10-01T01:00:00Z' },
      { dir: '2026-10-01-broken', observedAt: '2026-10-01T02:00:00Z' },
    ])
    if (good === undefined || broken === undefined) throw new Error('seed failed')
    await writeFile(join(broken, '.pipeline-run', 'current.json'), '{ not json', 'utf8')
    await writeFile(join(archiveOf(root), 'notes.md'), 'x', 'utf8')

    const { tasks, total } = await listEndedTasks(root, createEndedTaskCache())

    expect(tasks.map((task) => task.name)).toEqual(['good'])
    expect(total).toBe(1)
  })
})

/** 单任务只读详情接口共用的归档目录解析：列表读得出来的目录，详情就读得出来；列表跳过的，详情也拒绝。 */
describe('resolveArchivedTaskDir', () => {
  it('归档目录名解析成盘上的目录', async () => {
    const root = await makeProject()
    const [dir] = await seedArchivedTasks(root, [{ dir: '2026-10-01-fine', observedAt: '2026-10-01T01:00:00Z' }])

    expect(await resolveArchivedTaskDir(root, '2026-10-01-fine')).toBe(dir)
  })

  it('不是单段目录名的一律拒绝：空串、..、含分隔符、含点、绝对路径', async () => {
    const root = await makeProject()
    await seedArchivedTasks(root, [{ dir: '2026-10-01-fine', observedAt: '2026-10-01T01:00:00Z' }])

    for (const name of ['', '.', '..', '../x', 'a/b', '2026-10-01-fine/..', '/etc', 'a\\b', '.hidden', 'x.y', 'a b', '2026-10-01-fine\0']) {
      expect([name, await resolveArchivedTaskDir(root, name)]).toEqual([name, undefined])
    }
  })

  it('不存在的目录、普通文件都是 undefined', async () => {
    const root = await makeProject()
    await seedArchivedTasks(root, [{ dir: '2026-10-01-fine', observedAt: '2026-10-01T01:00:00Z' }])
    await writeFile(join(archiveOf(root), 'notes'), 'x', 'utf8')

    expect(await resolveArchivedTaskDir(root, '2026-10-09-ghost')).toBeUndefined()
    expect(await resolveArchivedTaskDir(root, 'notes')).toBeUndefined()
  })

  it('任务目录是指向 archive 之外的符号链接时拒绝（列表同样不列它）', async () => {
    const root = await makeProject()
    const outside = await makeProject()
    const [elsewhere] = await seedArchivedTasks(outside, [{ dir: '2026-10-01-elsewhere', observedAt: '2026-10-01T01:00:00Z' }])
    if (elsewhere === undefined) throw new Error('seed failed')
    await seedArchivedTasks(root, [{ dir: '2026-10-01-fine', observedAt: '2026-10-01T01:00:00Z' }])
    await symlink(elsewhere, join(archiveOf(root), '2026-10-02-link'), 'dir')

    expect(await resolveArchivedTaskDir(root, '2026-10-02-link')).toBeUndefined()
    expect((await endedOf(root)).map((task) => task.name)).toEqual(['fine'])
  })

  it('archive 本身、changes 或 openspec 是符号链接时拒绝', async () => {
    const outside = await makeProject()
    await seedArchivedTasks(outside, [{ dir: '2026-10-01-elsewhere', observedAt: '2026-10-01T01:00:00Z' }])

    const viaArchive = await makeProject()
    await mkdir(join(viaArchive, 'openspec', 'changes'), { recursive: true })
    await symlink(archiveOf(outside), archiveOf(viaArchive), 'dir')
    expect(await resolveArchivedTaskDir(viaArchive, '2026-10-01-elsewhere')).toBeUndefined()

    const viaChanges = await makeProject()
    await rm(join(viaChanges, 'openspec', 'changes'), { recursive: true, force: true })
    await mkdir(join(viaChanges, 'openspec'), { recursive: true })
    await symlink(join(outside, 'openspec', 'changes'), join(viaChanges, 'openspec', 'changes'), 'dir')
    expect(await resolveArchivedTaskDir(viaChanges, '2026-10-01-elsewhere')).toBeUndefined()

    const viaOpenspec = await makeProject()
    await rm(join(viaOpenspec, 'openspec'), { recursive: true, force: true })
    await symlink(join(outside, 'openspec'), join(viaOpenspec, 'openspec'), 'dir')
    expect(await resolveArchivedTaskDir(viaOpenspec, '2026-10-01-elsewhere')).toBeUndefined()
  })

  it('没有 archive/ 时是 undefined', async () => {
    expect(await resolveArchivedTaskDir(await makeProject(), '2026-10-01-fine')).toBeUndefined()
  })
})

/** 任务结束时整个目录移进 archive/<日期>-<名>/，文档台账里登记的仍是移动前的路径。 */
describe('archivedDocumentPath', () => {
  it('任务目录里的文档改成归档后的位置，同日同名的 -2 后缀照样对得上', () => {
    expect(archivedDocumentPath('openspec/changes/fix-login/proposal.md', '2026-10-05-fix-login')).toBe('openspec/changes/archive/2026-10-05-fix-login/proposal.md')
    expect(archivedDocumentPath('openspec/changes/fix-login/specs/auth/spec.md', '2026-10-05-fix-login-2')).toBe('openspec/changes/archive/2026-10-05-fix-login-2/specs/auth/spec.md')
  })

  it('别的任务的目录、docs/ 下的文档、已在 archive/ 下的路径都不动', () => {
    for (const path of [
      'openspec/changes/other-task/proposal.md',
      'openspec/changes/fix-login-extra/proposal.md',
      'docs/superpowers/specs/fix-login-design.md',
      'openspec/changes/archive/2026-10-05-fix-login/proposal.md',
      'openspec/changes/fix-login',
      'openspec/specs/auth/spec.md',
    ]) {
      expect([path, archivedDocumentPath(path, '2026-10-05-fix-login')]).toEqual([path, path])
    }
  })

  it('任务目录之后带 ..、.、空段、反斜杠或空字符的路径不映射：映射结果不会走出这个任务的归档目录', () => {
    for (const path of [
      'openspec/changes/fix-login/../other-task/proposal.md',
      'openspec/changes/fix-login/specs/../../../../../etc/passwd',
      'openspec/changes/fix-login/./proposal.md',
      'openspec/changes/fix-login/specs//spec.md',
      'openspec/changes/fix-login/specs\\spec.md',
      'openspec/changes/fix-login/proposal.md\0',
    ]) {
      expect([path, archivedDocumentPath(path, '2026-10-05-fix-login')]).toEqual([path, path])
    }
  })

  it('归档目录名本身不是单段合法名字时不映射', () => {
    for (const dir of ['2026-10-05-fix-login/..', '2026-10-05-fix-login/x', '2026-10-05-fix.login', '']) {
      expect([dir, archivedDocumentPath('openspec/changes/fix-login/proposal.md', dir)]).toEqual([dir, 'openspec/changes/fix-login/proposal.md'])
    }
  })

  it('目录名没有日期前缀时不改', () => {
    expect(archivedDocumentPath('openspec/changes/fix-login/proposal.md', 'fix-login')).toBe('openspec/changes/fix-login/proposal.md')
  })
})
