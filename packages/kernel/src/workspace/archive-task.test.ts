/**
 * 任务归档（M6）：三种任务结果都把任务目录移进 `openspec/changes/archive/<日期>-<名字>/`。
 * 全部走真文件系统（临时仓库）；OpenSpec 命令经注入的 `runOpenspecArchive` 替身，测试里不跑真实 openspec。
 */
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  archiveTask, ArchiveTaskError, clearStaleTaskResult, fieldText, isTaskLifecycleName, openspecArchiveRunner,
  readTaskResult, taskArchiveSpec, taskChangeDir, terminalTaskResult,
} from './archive-task.js'
import type { ArchiveDeps, TaskResult } from './archive-task.js'
import { emptyFields, serializePipeline } from '../state/parse.js'
import { createStateStore } from '../state/store.js'
import type { FieldName, PipelineState, StateStore, StateWriteIntent } from '../types.js'
import type { WorkflowPlanSnapshot } from '../workflow/effective-plan.js'

let repo: string
let store: StateStore

function tmpDeps(date: string, over: Partial<ArchiveDeps> = {}): ArchiveDeps {
  return {
    repoRoot: repo,
    store,
    now: () => new Date(`${date}T08:30:00.000Z`),
    runOpenspecArchive: async () => { throw new Error('测试里不得跑真实 openspec') },
    ...over,
  }
}

/** 一个有真实状态的活跃任务（和 `tenon init` 留下的同形：规范状态可读写）。 */
async function recreateChange(name: string): Promise<string> {
  const dir = taskChangeDir(repo, name)
  await mkdir(dir, { recursive: true })
  const fields = emptyFields()
  fields.phase = 'build'
  await writeFile(join(dir, '.pipeline.yaml'), serializePipeline({ fields, opaqueTail: '' }), 'utf8')
  await writeFile(join(dir, 'notes.md'), `${name}\n`, 'utf8')
  return dir
}

/** 模拟 `openspec archive <c>`：把目录移进 archive/<日期>-<c>/，不看目标是否已存在以外的任何事。 */
async function simulateOpenspecMove(name: string, date = '2026-10-11'): Promise<void> {
  await mkdir(join(repo, 'openspec', 'changes', 'archive'), { recursive: true })
  await rename(taskChangeDir(repo, name), join(repo, 'openspec', 'changes', 'archive', `${date}-${name}`))
}

/** 归档目录里规范状态记着的任务结果。 */
async function readResult(archivedDir: string): Promise<TaskResult | undefined> {
  return readTaskResult(join(repo, archivedDir))
}

/** A store whose state write fails exactly when it would set `task_result` to `value`; every other write goes through. */
function failingTaskResultWrite(value: string, reason: string): StateStore {
  return new Proxy(store, {
    get(target, property) {
      const original: unknown = Reflect.get(target, property, target)
      if (property !== 'writeUnderLock' || typeof original !== 'function') return original
      return async (changeDir: string, state: PipelineState, intent?: StateWriteIntent) => {
        if (state.fields.task_result === value) throw new Error(reason)
        return Reflect.apply(original, target, [changeDir, state, intent])
      }
    },
  })
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'tenon-archive-task-'))
  store = createStateStore()
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

describe('archiveTask · spec none', () => {
  it('原子移进 archive/，任务结果写在规范状态的 task_result 里随目录一起搬走', async () => {
    const source = await recreateChange('fix-a')
    expect((await store.read(source)).fields.task_result).toBe('')
    const r = await archiveTask(tmpDeps('2026-10-11'), 'fix-a', 'finished', 'none')
    expect(r).toEqual({
      change: 'fix-a',
      result: 'finished',
      archivedDir: 'openspec/changes/archive/2026-10-11-fix-a',
      endedAt: '2026-10-11T08:30:00.000Z',
    })
    expect(await readResult(r.archivedDir)).toBe('finished')
    expect((await store.read(join(repo, r.archivedDir))).fields.task_result).toBe('finished')
    // 其余状态原样保留：这只是一次字段写入，不是重建。
    expect((await store.read(join(repo, r.archivedDir))).fields.phase).toBe('build')
    expect(await exists(taskChangeDir(repo, 'fix-a'))).toBe(false)
    expect(await readFile(join(repo, r.archivedDir, 'notes.md'), 'utf8')).toBe('fix-a\n')
    // 不再有单独的任务结果文件。
    expect(await exists(join(repo, r.archivedDir, 'task-result.json'))).toBe(false)
  })

  it('三种任务结果都能记录', async () => {
    for (const result of ['finished', 'escalated', 'terminated'] as const) {
      await recreateChange(`task-${result}`)
      const r = await archiveTask(tmpDeps('2026-10-11'), `task-${result}`, result, 'none')
      expect(await readResult(r.archivedDir)).toBe(result)
    }
  })

  it('同日同名追加 -2、-3，绝不覆盖已有归档', async () => {
    await recreateChange('fix-a')
    const first = await archiveTask(tmpDeps('2026-10-11'), 'fix-a', 'terminated', 'none')
    await recreateChange('fix-a')
    const second = await archiveTask(tmpDeps('2026-10-11'), 'fix-a', 'finished', 'none')
    await recreateChange('fix-a')
    const third = await archiveTask(tmpDeps('2026-10-11'), 'fix-a', 'escalated', 'none')

    expect(first.archivedDir).toBe('openspec/changes/archive/2026-10-11-fix-a')
    expect(second.archivedDir).toBe('openspec/changes/archive/2026-10-11-fix-a-2')
    expect(third.archivedDir).toBe('openspec/changes/archive/2026-10-11-fix-a-3')
    expect(await readResult(first.archivedDir)).toBe('terminated')
    expect(await readResult(second.archivedDir)).toBe('finished')
    expect(await readResult(third.archivedDir)).toBe('escalated')
  })

  it('不同日期不加后缀', async () => {
    await recreateChange('fix-a')
    await archiveTask(tmpDeps('2026-10-11'), 'fix-a', 'terminated', 'none')
    await recreateChange('fix-a')
    const next = await archiveTask(tmpDeps('2026-10-12'), 'fix-a', 'finished', 'none')
    expect(next.archivedDir).toBe('openspec/changes/archive/2026-10-12-fix-a')
  })

  it('任务锁目录跟着任务目录搬进归档后被删掉：归档里不留无主的锁目录', async () => {
    const dir = await recreateChange('fix-a')
    await store.withLock(dir, async () => {
      expect(await exists(join(dir, '.pipeline.lock'))).toBe(true)
      const r = await archiveTask(tmpDeps('2026-10-11'), 'fix-a', 'finished', 'none')
      expect(await exists(join(repo, r.archivedDir, '.pipeline.lock'))).toBe(false)
      expect(await exists(join(repo, r.archivedDir, '.pipeline.yaml'))).toBe(true)
    })
  })

  it('目录不存在时报 not-found 且不创建 archive 目录', async () => {
    await expect(archiveTask(tmpDeps('2026-10-11'), 'ghost', 'terminated', 'none'))
      .rejects.toMatchObject({ name: 'ArchiveTaskError', code: 'not-found' })
    expect(await exists(join(repo, 'openspec', 'changes', 'archive'))).toBe(false)
  })

  it('非法或保留的任务名一律拒绝，不碰文件系统', async () => {
    for (const bad of ['', '..', 'a/b', '../x', 'a b', 'archive']) {
      await expect(archiveTask(tmpDeps('2026-10-11'), bad, 'terminated', 'none'))
        .rejects.toMatchObject({ code: 'invalid-name' })
    }
  })

  it('任务目录是符号链接时拒绝移动，也不跟随它', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'tenon-archive-outside-'))
    try {
      await writeFile(join(outside, 'keep.txt'), 'keep', 'utf8')
      await mkdir(join(repo, 'openspec', 'changes'), { recursive: true })
      await symlink(outside, taskChangeDir(repo, 'fix-a'))
      await expect(archiveTask(tmpDeps('2026-10-11'), 'fix-a', 'terminated', 'none'))
        .rejects.toMatchObject({ code: 'unsafe-path' })
      expect(await readdir(outside)).toEqual(['keep.txt'])
      expect(await exists(join(repo, 'openspec', 'changes', 'archive'))).toBe(false)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('archive 目录是符号链接时拒绝，任务原样留在原地', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'tenon-archive-outside-'))
    try {
      const dir = await recreateChange('fix-a')
      await symlink(outside, join(repo, 'openspec', 'changes', 'archive'))
      await expect(archiveTask(tmpDeps('2026-10-11'), 'fix-a', 'terminated', 'none'))
        .rejects.toMatchObject({ code: 'unsafe-path' })
      expect(await readdir(outside)).toEqual([])
      expect(await exists(taskChangeDir(repo, 'fix-a'))).toBe(true)
      expect((await store.read(dir)).fields.task_result).toBe('')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('archiveTask · spec openspec', () => {
  it('委托 openspec archive，并在目录移动之前已经把任务结果写进规范状态', async () => {
    await recreateChange('feat-b')
    const calls: string[] = []
    let resultBeforeMove: TaskResult | undefined
    const r = await archiveTask(tmpDeps('2026-10-11', {
      runOpenspecArchive: async (c) => {
        calls.push(c)
        resultBeforeMove = await readTaskResult(taskChangeDir(repo, c))
        await simulateOpenspecMove(c)
      },
    }), 'feat-b', 'finished', 'openspec')
    expect(calls).toEqual(['feat-b'])
    expect(resultBeforeMove).toBe('finished')
    expect(r.archivedDir).toBe('openspec/changes/archive/2026-10-11-feat-b')
    expect(await readResult(r.archivedDir)).toBe('finished')
  })

  it('同日同名时先改成带序号的活跃名再交给 openspec，归档目录追加 -2', async () => {
    await recreateChange('feat-b')
    await archiveTask(tmpDeps('2026-10-11'), 'feat-b', 'terminated', 'none')
    await recreateChange('feat-b')
    const calls: string[] = []
    const r = await archiveTask(tmpDeps('2026-10-11', {
      runOpenspecArchive: async (c) => { calls.push(c); await simulateOpenspecMove(c) },
    }), 'feat-b', 'finished', 'openspec')
    expect(calls).toEqual(['feat-b-2'])
    expect(r.archivedDir).toBe('openspec/changes/archive/2026-10-11-feat-b-2')
    expect(await readResult('openspec/changes/archive/2026-10-11-feat-b')).toBe('terminated')
    expect(await readResult(r.archivedDir)).toBe('finished')
    expect(await exists(taskChangeDir(repo, 'feat-b'))).toBe(false)
    expect(await exists(taskChangeDir(repo, 'feat-b-2'))).toBe(false)
  })

  it('名字以 - 开头的任务不交给 openspec（会被当成命令行选项）；rename 的轨道照常归档', async () => {
    const dir = await recreateChange('-odd')
    const calls: string[] = []
    await expect(archiveTask(tmpDeps('2026-10-11', {
      runOpenspecArchive: async (c) => { calls.push(c) },
    }), '-odd', 'terminated', 'openspec')).rejects.toMatchObject({ code: 'invalid-name' })
    expect(calls).toEqual([])
    expect(await exists(dir)).toBe(true)
    expect((await store.read(dir)).fields.task_result).toBe('')

    const r = await archiveTask(tmpDeps('2026-10-11'), '-odd', 'terminated', 'none')
    expect(r.archivedDir).toBe('openspec/changes/archive/2026-10-11--odd')
  })

  it('openspec 失败时任务目录仍在原处、状态里没有 task_result（已清回空值），并带出原因', async () => {
    const dir = await recreateChange('feat-b')
    let resultDuringRun: TaskResult | undefined
    await expect(archiveTask(tmpDeps('2026-10-11', {
      runOpenspecArchive: async (c) => {
        resultDuringRun = await readTaskResult(taskChangeDir(repo, c))
        throw new Error('archive_validation_failed')
      },
    }), 'feat-b', 'finished', 'openspec')).rejects.toMatchObject({
      code: 'openspec-failed',
      message: expect.stringContaining('archive_validation_failed'),
    })
    // 移动前确实写过，失败后又清掉了：任务仍是原来的活跃任务。
    expect(resultDuringRun).toBe('finished')
    expect(await exists(dir)).toBe(true)
    expect((await store.read(dir)).fields.task_result).toBe('')
    expect(await readTaskResult(dir)).toBeUndefined()
    expect(await exists(join(repo, 'openspec', 'changes', 'archive'))).toBe(false)
  })

  it('openspec 报成功却没把目录移到预期位置时报错，不假装成功，task_result 清回空值', async () => {
    const dir = await recreateChange('feat-b')
    await expect(archiveTask(tmpDeps('2026-10-11', {
      runOpenspecArchive: async () => undefined,
    }), 'feat-b', 'finished', 'openspec')).rejects.toBeInstanceOf(ArchiveTaskError)
    expect(await exists(dir)).toBe(true)
    expect((await store.read(dir)).fields.task_result).toBe('')
  })

  it('同日同名改了活跃名之后 openspec 失败：名字改回来，task_result 清回空值', async () => {
    await recreateChange('feat-b')
    await archiveTask(tmpDeps('2026-10-11'), 'feat-b', 'terminated', 'none')
    const dir = await recreateChange('feat-b')
    await expect(archiveTask(tmpDeps('2026-10-11', {
      runOpenspecArchive: async () => { throw new Error('boom') },
    }), 'feat-b', 'finished', 'openspec')).rejects.toMatchObject({ code: 'openspec-failed' })
    expect(await exists(dir)).toBe(true)
    expect(await exists(taskChangeDir(repo, 'feat-b-2'))).toBe(false)
    expect((await store.read(dir)).fields.task_result).toBe('')
  })

  it('改了活跃名、openspec 失败、名字又改不回来：原始原因与改名失败的原因一起报出来，task_result 清在任务实际所在的目录', async () => {
    await recreateChange('feat-b')
    await archiveTask(tmpDeps('2026-10-11'), 'feat-b', 'terminated', 'none')
    await recreateChange('feat-b')
    await expect(archiveTask(tmpDeps('2026-10-11', {
      runOpenspecArchive: async (c) => {
        // openspec 运行期间有人占了原名：把 feat-b-2 改回 feat-b 必然失败。
        await mkdir(join(taskChangeDir(repo, 'feat-b'), 'occupied'), { recursive: true })
        expect(c).toBe('feat-b-2')
        throw new Error('archive_validation_failed')
      },
    }), 'feat-b', 'finished', 'openspec')).rejects.toMatchObject({
      name: 'ArchiveTaskError',
      code: 'openspec-failed',
      message: expect.stringMatching(/archive_validation_failed.*没能从 feat-b-2 改回 feat-b.*openspec\/changes\/feat-b-2/su),
    })
    const stranded = taskChangeDir(repo, 'feat-b-2')
    expect(await exists(stranded)).toBe(true)
    expect((await store.read(stranded)).fields.task_result).toBe('')
  })

  it('openspec 已把目录移走、却认不出落在哪：报 move-failed 并说明已移动，不回滚（task_result 随目录留在归档里）', async () => {
    await recreateChange('feat-b')
    const archive = join(repo, 'openspec', 'changes', 'archive')
    await expect(archiveTask(tmpDeps('2026-10-11', {
      runOpenspecArchive: async (c) => {
        await simulateOpenspecMove(c)
        // 外部并发写入：archive/ 里同时多出另一个同名候选，差集不再是 1。
        await mkdir(join(archive, `2026-10-12-${c}`), { recursive: true })
      },
    }), 'feat-b', 'finished', 'openspec')).rejects.toMatchObject({
      name: 'ArchiveTaskError',
      code: 'move-failed',
      message: expect.stringMatching(/已把 feat-b 移出活跃目录.*无法确定归档目录/su),
    })
    expect(await exists(taskChangeDir(repo, 'feat-b'))).toBe(false)
    expect((await store.read(join(archive, '2026-10-11-feat-b'))).fields.task_result).toBe('finished')
  })

  it('openspec 把目录移到了认不出的名字下：同样报已移动、无法确定归档目录', async () => {
    await recreateChange('feat-b')
    const archive = join(repo, 'openspec', 'changes', 'archive')
    await expect(archiveTask(tmpDeps('2026-10-11', {
      runOpenspecArchive: async (c) => {
        await mkdir(archive, { recursive: true })
        await rename(taskChangeDir(repo, c), join(archive, 'renamed-elsewhere'))
      },
    }), 'feat-b', 'finished', 'openspec')).rejects.toMatchObject({ code: 'move-failed', message: expect.stringContaining('无法确定归档目录') })
    expect((await store.read(join(archive, 'renamed-elsewhere'))).fields.task_result).toBe('finished')
  })

  it('openspec 报成功、活跃目录没动，archive/ 里却并发多出了同名条目：仍按失败回滚，任务留在原处', async () => {
    const dir = await recreateChange('feat-b')
    const archive = join(repo, 'openspec', 'changes', 'archive')
    await expect(archiveTask(tmpDeps('2026-10-11', {
      runOpenspecArchive: async (c) => {
        await mkdir(join(archive, `2026-10-11-${c}`), { recursive: true })
        await mkdir(join(archive, `2026-10-12-${c}`), { recursive: true })
      },
    }), 'feat-b', 'finished', 'openspec')).rejects.toMatchObject({ code: 'openspec-failed' })
    expect(await exists(dir)).toBe(true)
    expect((await store.read(dir)).fields.task_result).toBe('')
  })

  // 文件系统自己的错误（EACCES、EXDEV…）不是裸异常冲出去：一律归成 ArchiveTaskError move-failed，带上原始原因。
  it.skipIf(process.getuid?.() === 0)('rename 失败（archive/ 不可写）时报 move-failed 并带出原始原因，目录仍在原处、task_result 清回空值', async () => {
    const dir = await recreateChange('feat-b')
    const archive = join(repo, 'openspec', 'changes', 'archive')
    await mkdir(archive, { recursive: true })
    await chmod(archive, 0o500)
    try {
      await expect(archiveTask(tmpDeps('2026-10-11'), 'feat-b', 'terminated', 'none')).rejects.toMatchObject({
        name: 'ArchiveTaskError',
        code: 'move-failed',
        message: expect.stringContaining('EACCES'),
      })
      expect(await exists(dir)).toBe(true)
      expect((await store.read(dir)).fields.task_result).toBe('')
    } finally {
      await chmod(archive, 0o700)
    }
  })

  it.skipIf(process.getuid?.() === 0)('改成带序号的活跃名时 rename 失败（changes/ 不可写）：报 move-failed，没改成名，task_result 清回空值', async () => {
    await recreateChange('feat-b')
    await archiveTask(tmpDeps('2026-10-11'), 'feat-b', 'terminated', 'none')
    const dir = await recreateChange('feat-b')
    const changes = join(repo, 'openspec', 'changes')
    await chmod(changes, 0o500)
    try {
      await expect(archiveTask(tmpDeps('2026-10-11', {
        runOpenspecArchive: async () => { throw new Error('名字没改成就不该调用 openspec') },
      }), 'feat-b', 'finished', 'openspec')).rejects.toMatchObject({
        name: 'ArchiveTaskError',
        code: 'move-failed',
        message: expect.stringContaining('EACCES'),
      })
      expect(await exists(dir)).toBe(true)
      expect(await exists(taskChangeDir(repo, 'feat-b-2'))).toBe(false)
      expect((await store.read(dir)).fields.task_result).toBe('')
    } finally {
      await chmod(changes, 0o700)
    }
  })

  it.skipIf(process.getuid?.() === 0)('openspec 运行前读不了 archive/（只有执行位）：报 move-failed 并带出原始原因，task_result 清回空值', async () => {
    const dir = await recreateChange('feat-b')
    const archive = join(repo, 'openspec', 'changes', 'archive')
    await mkdir(archive, { recursive: true })
    await chmod(archive, 0o100)
    try {
      await expect(archiveTask(tmpDeps('2026-10-11', {
        runOpenspecArchive: async () => { throw new Error('读不了归档目录就不该调用 openspec') },
      }), 'feat-b', 'finished', 'openspec')).rejects.toMatchObject({
        name: 'ArchiveTaskError',
        code: 'move-failed',
        message: expect.stringContaining('EACCES'),
      })
      expect(await exists(dir)).toBe(true)
      expect((await store.read(dir)).fields.task_result).toBe('')
    } finally {
      await chmod(archive, 0o700)
    }
  })

  // 同日同名要先把活跃目录改成 feat-b-2 再读 archive/；读失败时什么都不该动过，否则回滚去清原目录、名字也回不来。
  it.skipIf(process.getuid?.() === 0)('同日同名时读不了 archive/（只有执行位）：活跃目录没被改名，仍在原名下，task_result 清回空值', async () => {
    await recreateChange('feat-b')
    await archiveTask(tmpDeps('2026-10-11'), 'feat-b', 'terminated', 'none')
    const dir = await recreateChange('feat-b')
    const archive = join(repo, 'openspec', 'changes', 'archive')
    await chmod(archive, 0o111)
    try {
      await expect(archiveTask(tmpDeps('2026-10-11', {
        runOpenspecArchive: async () => { throw new Error('读不了归档目录就不该调用 openspec') },
      }), 'feat-b', 'finished', 'openspec')).rejects.toMatchObject({
        name: 'ArchiveTaskError',
        code: 'move-failed',
        message: expect.stringContaining('EACCES'),
      })
      expect(await exists(dir)).toBe(true)
      expect(await exists(taskChangeDir(repo, 'feat-b-2'))).toBe(false)
      expect((await store.read(dir)).fields.task_result).toBe('')
    } finally {
      await chmod(archive, 0o700)
    }
  })

  // openspec 报成功之后再读 archive/ 失败：认不出归档目录，按活跃目录还在不在分两路，不再按原目录盲目回滚。
  it.skipIf(process.getuid?.() === 0)('openspec 报成功、目录没动，之后读不了 archive/：当作没建出归档目录，名字改回原名，openspec-failed 带出读失败原因，task_result 清回空值', async () => {
    await recreateChange('feat-b')
    await archiveTask(tmpDeps('2026-10-11'), 'feat-b', 'terminated', 'none')
    const dir = await recreateChange('feat-b')
    const archive = join(repo, 'openspec', 'changes', 'archive')
    try {
      await expect(archiveTask(tmpDeps('2026-10-11', {
        runOpenspecArchive: async (c) => {
          expect(c).toBe('feat-b-2')
          // openspec 返回前 archive/ 变得读不了；目录没移动。
          await chmod(archive, 0o111)
        },
      }), 'feat-b', 'finished', 'openspec')).rejects.toMatchObject({
        name: 'ArchiveTaskError',
        code: 'openspec-failed',
        message: expect.stringMatching(/feat-b-2 仍在活跃目录里.*EACCES/su),
      })
      expect(await exists(dir)).toBe(true)
      expect(await exists(taskChangeDir(repo, 'feat-b-2'))).toBe(false)
      expect((await store.read(dir)).fields.task_result).toBe('')
    } finally {
      await chmod(archive, 0o700)
    }
  })

  it.skipIf(process.getuid?.() === 0)('openspec 已把目录移进 archive/、之后读不了 archive/：报 move-failed 并带出读失败原因，不回滚（task_result 随目录留在归档里）', async () => {
    await recreateChange('feat-b')
    const archive = join(repo, 'openspec', 'changes', 'archive')
    try {
      const failure: unknown = await archiveTask(tmpDeps('2026-10-11', {
        runOpenspecArchive: async (c) => {
          await simulateOpenspecMove(c)
          await chmod(archive, 0o111)
        },
      }), 'feat-b', 'finished', 'openspec').then(() => undefined, (error: unknown) => error)
      expect(failure).toBeInstanceOf(ArchiveTaskError)
      const message = failure instanceof Error ? failure.message : ''
      expect(failure).toMatchObject({ code: 'move-failed' })
      expect(message).toMatch(/已把 feat-b 移出活跃目录.*EACCES/su)
      // 不能说成「新增的同名目录有 0 个」，也不能是回滚去清不存在的原目录失败的那种报错。
      expect(message).not.toContain('有 0 个')
      expect(message).not.toContain('task_result 没能清回空值')
    } finally {
      await chmod(archive, 0o700)
    }
    expect(await exists(taskChangeDir(repo, 'feat-b'))).toBe(false)
    expect((await store.read(join(archive, '2026-10-11-feat-b'))).fields.task_result).toBe('finished')
  })

  it('清不回空值时把这件事连同原因一起报出来，不吞', async () => {
    const dir = await recreateChange('feat-b')
    const flaky = failingTaskResultWrite('', 'state locked')
    await expect(archiveTask(tmpDeps('2026-10-11', {
      store: flaky,
      runOpenspecArchive: async () => { throw new Error('archive_validation_failed') },
    }), 'feat-b', 'finished', 'openspec')).rejects.toMatchObject({
      code: 'openspec-failed',
      message: expect.stringMatching(/archive_validation_failed.*task_result 没能清回空值.*state locked/su),
    })
    expect(await exists(dir)).toBe(true)
  })

  it('状态写入失败（task_result 写不进去）：报 state-failed，目录没动', async () => {
    const dir = await recreateChange('feat-b')
    const failing = failingTaskResultWrite('finished', 'disk full')
    await expect(archiveTask(tmpDeps('2026-10-11', { store: failing }), 'feat-b', 'finished', 'none'))
      .rejects.toMatchObject({ code: 'state-failed', message: expect.stringContaining('disk full') })
    // 状态写入失败发生在移动之前：目录没动。
    expect(await exists(dir)).toBe(true)
    expect(await exists(join(repo, 'openspec', 'changes', 'archive'))).toBe(false)
    expect((await store.read(dir)).fields.task_result).toBe('')
  })
})

describe('openspecArchiveRunner', () => {
  const savedPath = process.env.PATH
  afterEach(() => {
    process.env.PATH = savedPath
  })

  async function fakeOpenspec(script: string): Promise<string> {
    const bin = await mkdtemp(join(tmpdir(), 'tenon-fake-openspec-'))
    await writeFile(join(bin, 'openspec'), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
    process.env.PATH = `${bin}:${savedPath ?? ''}`
    return bin
  }

  it('在仓库根里执行 openspec archive <c> --skip-specs --yes --json', async () => {
    const bin = await fakeOpenspec(`pwd > "${repo}/cwd.txt"\nprintf '%s ' "$@" > "${repo}/args.txt"`)
    try {
      await openspecArchiveRunner(repo)('feat-b')
      expect((await readFile(join(repo, 'args.txt'), 'utf8')).trim()).toBe('archive feat-b --skip-specs --yes --json')
      expect(await readFile(join(repo, 'cwd.txt'), 'utf8')).toContain(repo.replace(/^\/private/u, ''))
    } finally {
      await rm(bin, { recursive: true, force: true })
    }
  })

  it('失败时把 openspec 自己的诊断带出来', async () => {
    const bin = await fakeOpenspec(
      `echo '{"archive":null,"status":[{"severity":"error","code":"archive_validation_failed","message":"Validation failed for change feat-b."}]}'\nexit 1`,
    )
    try {
      await expect(openspecArchiveRunner(repo)('feat-b'))
        .rejects.toThrow('archive_validation_failed：Validation failed for change feat-b.')
    } finally {
      await rm(bin, { recursive: true, force: true })
    }
  })

  it('PATH 上没有 openspec 时给出可执行的提示', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'tenon-empty-bin-'))
    process.env.PATH = empty
    try {
      await expect(openspecArchiveRunner(repo)('feat-b')).rejects.toThrow('openspec-cli-missing')
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })
})

describe('readTaskResult', () => {
  it('读规范状态里的 task_result；活跃任务、没有状态的目录、状态损坏、取值不在闭集里都读成 undefined，从不抛', async () => {
    const active = await recreateChange('still-running')
    expect(await readTaskResult(active)).toBeUndefined()

    const plain = join(repo, 'plain')
    await mkdir(plain, { recursive: true })
    expect(await readTaskResult(plain)).toBeUndefined()
    expect(await readTaskResult(join(repo, 'does-not-exist'))).toBeUndefined()

    await writeFile(join(active, '.pipeline.yaml'), 'this is: not: valid\n', 'utf8')
    expect(await readTaskResult(active)).toBeUndefined()

    const odd = await recreateChange('odd-value')
    await store.set(odd, 'task_result', 'hidden')
    expect(await readTaskResult(odd)).toBeUndefined()
    await store.set(odd, 'task_result', 'terminated')
    expect(await readTaskResult(odd)).toBe('terminated')
  })
})

describe('clearStaleTaskResult', () => {
  it('活跃任务上残留的 task_result（写完结果、移动前进程被杀）清回空值，其余状态原样不动', async () => {
    const dir = await recreateChange('crashed')
    await store.set(dir, 'task_result', 'terminated')
    await clearStaleTaskResult(store, dir)
    const state = await store.read(dir)
    expect(state.fields.task_result).toBe('')
    expect(state.fields.phase).toBe('build')
    expect(await readTaskResult(dir)).toBeUndefined()
  })

  it('没有残留时不写任何修订', async () => {
    const dir = await recreateChange('clean')
    const before = (await readFile(join(dir, '.pipeline.yaml'), 'utf8'))
    await clearStaleTaskResult(store, dir)
    expect(await readFile(join(dir, '.pipeline.yaml'), 'utf8')).toBe(before)
  })

  it('状态读不出来时不抛：留给后面的步骤去报告', async () => {
    const plain = join(repo, 'plain')
    await mkdir(plain, { recursive: true })
    await expect(clearStaleTaskResult(store, plain)).resolves.toBeUndefined()
  })

  it('清不掉时报 state-failed 并带出原因', async () => {
    const dir = await recreateChange('crashed')
    await store.set(dir, 'task_result', 'finished')
    const failing: StateStore = new Proxy(store, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target)
        if (property !== 'writeUnderLock' || typeof value !== 'function') return value
        return async () => { throw new Error('disk full') }
      },
    })
    await expect(clearStaleTaskResult(failing, dir))
      .rejects.toMatchObject({ code: 'state-failed', message: expect.stringContaining('disk full') })
  })
})

describe('fieldText', () => {
  it('单值原样、多值以逗号相连、缺省为空串', () => {
    expect(fieldText('x')).toBe('x')
    expect(fieldText(['a', 'b'])).toBe('a,b')
    expect(fieldText([])).toBe('')
    expect(fieldText(undefined)).toBe('')
  })
})

describe('terminalTaskResult', () => {
  function fields(over: Partial<Record<FieldName, string>>): ReturnType<typeof emptyFields> {
    return Object.assign(emptyFields(), over)
  }

  it('状态机没走完（archived 不是 true）→ null', () => {
    expect(terminalTaskResult(fields({ phase: 'verify' }))).toBeNull()
    expect(terminalTaskResult(fields({ phase: 'verify', archived: 'false' }))).toBeNull()
  })

  it('走完且停在 escalated → 已升级；其余终态 → 完结', () => {
    expect(terminalTaskResult(fields({ phase: 'escalated', archived: 'true' }))).toBe('escalated')
    expect(terminalTaskResult(fields({ phase: 'done', archived: 'true' }))).toBe('finished')
    expect(terminalTaskResult(fields({ phase: 'archive', archived: 'true' }))).toBe('finished')
  })
})

describe('taskArchiveSpec', () => {
  function stateWith(documentPolicy: unknown): PipelineState {
    return {
      fields: emptyFields(),
      opaqueTail: '',
      runMetadata: {
        runId: 'run-1',
        transitionSequence: 0,
        workflowPlanSnapshot: { version: 4, documentPolicy } as unknown as WorkflowPlanSnapshot,
      },
    }
  }

  it('冻结的计划里有文档治理 → openspec', () => {
    expect(taskArchiveSpec(stateWith({ workflowId: 'default' }))).toBe('openspec')
  })

  it('冻结的计划没有文档治理、没有快照或快照形状不认识 → none', () => {
    expect(taskArchiveSpec(stateWith(null))).toBe('none')
    expect(taskArchiveSpec({ fields: emptyFields(), opaqueTail: '' })).toBe('none')
    expect(taskArchiveSpec({
      fields: emptyFields(),
      opaqueTail: '',
      runMetadata: { runId: 'run-1', transitionSequence: 0, workflowPlanSnapshot: { version: 1 } as unknown as WorkflowPlanSnapshot },
    })).toBe('none')
  })
})

describe('isTaskLifecycleName', () => {
  it('接受任务名语法，拒绝 OpenSpec 的 archive 目录', () => {
    expect(isTaskLifecycleName('add-login')).toBe(true)
    expect(isTaskLifecycleName('archive')).toBe(false)
    for (const bad of ['', '..', 'a/b', 'a b', 'a.b']) expect(isTaskLifecycleName(bad)).toBe(false)
  })
})
