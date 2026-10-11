/**
 * 三个通用离开条件的能力工厂：真实临时目录里验证口径——任务勾选走 TaskPlan/tasks.md 的现有判定，
 * AFK 排队读 automation 字段并受调度器旁路约束，依赖结束沿用 depends-archived 的归档判定。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeGuardFileContext } from '../infrastructure/guard-file-context.js'
import { emptyFields } from '../state/parse.js'
import { publishInitialRunRevision } from '../state/run-revision-store.js'
import { universalGuardCapabilities } from './universal-guard-capabilities.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tenon-universal-guards-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function changeDirOf(name: string): string {
  return join(root, 'openspec', 'changes', name)
}

async function seedChange(
  name: string,
  over: Partial<Record<string, string | string[]>> = {},
): Promise<string> {
  const dir = changeDirOf(name)
  await mkdir(dir, { recursive: true })
  const fields = { ...emptyFields(), phase: 'build', ...over } as ReturnType<typeof emptyFields>
  await publishInitialRunRevision(dir, { fields, opaqueTail: '' }, '2026-10-10T00:00:00Z')
  return dir
}

function sourceOf(name: string, automationRunner = false): ReturnType<ReturnType<typeof makeGuardFileContext>> {
  return makeGuardFileContext(root, { automationRunner })(name)
}

function must<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} 应已注入`)
  return value
}

describe('tasksThroughStep', () => {
  async function withTasks(markdown: string | undefined): Promise<string> {
    const dir = await seedChange('c')
    if (markdown !== undefined) await writeFile(join(dir, 'tasks.md'), markdown)
    return dir
  }

  it('有未勾任务：未完成，并带出现有口径的失败说明（含未勾数量）', async () => {
    const dir = await withTasks('- [x] 已做\n- [ ] 没做\n')
    const result = await must(universalGuardCapabilities(dir).tasksThroughStep, 'tasksThroughStep')('build')
    expect(result.complete).toBe(false)
    expect(result.unchecked).toEqual([expect.stringContaining('1 项未勾')])
  })

  it('全部已勾：完成', async () => {
    const dir = await withTasks('- [x] 一\n- [x] 二\n')
    const result = await must(universalGuardCapabilities(dir).tasksThroughStep, 'tasksThroughStep')('build')
    expect(result).toEqual({ complete: true, unchecked: [] })
  })

  it('build 步 tasks.md 缺失：沿用旧口径按未完成处理', async () => {
    const dir = await withTasks(undefined)
    const result = await must(universalGuardCapabilities(dir).tasksThroughStep, 'tasksThroughStep')('build')
    expect(result.complete).toBe(false)
    expect(result.unchecked).toEqual([expect.stringContaining('缺失')])
  })

  it('截至本步：后续阶段标题下的未勾任务不拦本步，但拦它自己', async () => {
    const dir = await withTasks('## build\n- [x] 实现\n## verify\n- [ ] 验证\n')
    const capability = must(universalGuardCapabilities(dir).tasksThroughStep, 'tasksThroughStep')
    expect((await capability('build')).complete).toBe(true)
    expect((await capability('verify')).complete).toBe(false)
  })

  it('不是流水线阶段的步骤没有对应任务段：视为完成（与 Todo 投影对未知阶段的口径一致）', async () => {
    const dir = await withTasks('## build\n- [ ] 没做\n')
    const result = await must(universalGuardCapabilities(dir).tasksThroughStep, 'tasksThroughStep')('escalated')
    expect(result).toEqual({ complete: true, unchecked: [] })
  })
})

describe('afkQueued', () => {
  it('automation=queued：排队中', async () => {
    const dir = await seedChange('c', { automation: 'queued' })
    expect(await must(universalGuardCapabilities(dir, sourceOf('c')).afkQueued, 'afkQueued')()).toBe(true)
  })

  it.each(['off', 'null', 'running'])('automation=%s：未排队', async (value) => {
    const dir = await seedChange('c', { automation: value })
    expect(await must(universalGuardCapabilities(dir, sourceOf('c')).afkQueued, 'afkQueued')()).toBe(false)
  })

  it('调度器自己跑（automationRunner）：恒 false，且不读状态', async () => {
    const dir = changeDirOf('no-state-here')
    const afkQueued = must(universalGuardCapabilities(dir, sourceOf('no-state-here', true)).afkQueued, 'afkQueued')
    expect(await afkQueued()).toBe(false)
  })

  it('没有文件面也提供（不能当作调度器旁路）：queued 仍判排队', async () => {
    const dir = await seedChange('c', { automation: 'queued' })
    expect(await must(universalGuardCapabilities(dir).afkQueued, 'afkQueued')()).toBe(true)
  })

  it('读不到任务状态：抛错，交给 guard 失败关闭', async () => {
    const dir = changeDirOf('missing')
    await expect(must(universalGuardCapabilities(dir, sourceOf('missing')).afkQueued, 'afkQueued')()).rejects.toThrow()
  })
})

describe('dependencyStates', () => {
  async function seedArchivedDir(dep: string): Promise<void> {
    await mkdir(join(root, 'openspec', 'changes', 'archive', `2026-10-01-${dep}`), { recursive: true })
  }

  it('没有 depends_on（字面 null）：空列表', async () => {
    const dir = await seedChange('c')
    expect(await must(universalGuardCapabilities(dir, sourceOf('c')).dependencyStates, 'dependencyStates')()).toEqual([])
  })

  it('活跃但已归档 / 物理归档目录：已结束；活跃未归档 / 完全不存在：未结束', async () => {
    await seedChange('dep-done', { archived: 'true' })
    await seedChange('dep-active', { archived: 'false' })
    await seedArchivedDir('dep-moved')
    const dir = await seedChange('c', { depends_on: ['dep-done', 'dep-active', 'dep-moved', 'dep-missing'] })
    expect(await must(universalGuardCapabilities(dir, sourceOf('c')).dependencyStates, 'dependencyStates')()).toEqual([
      { name: 'dep-done', ended: true },
      { name: 'dep-active', ended: false },
      { name: 'dep-moved', ended: true },
      { name: 'dep-missing', ended: false },
    ])
  })

  it('活跃目录存在时以活跃状态为准，不被同名后缀的归档目录放行', async () => {
    await seedChange('dep', { archived: 'false' })
    await seedArchivedDir('dep')
    const dir = await seedChange('c', { depends_on: ['dep'] })
    expect(await must(universalGuardCapabilities(dir, sourceOf('c')).dependencyStates, 'dependencyStates')()).toEqual([
      { name: 'dep', ended: false },
    ])
  })

  it('旧式逗号标量写法同样展开', async () => {
    await seedChange('a', { archived: 'true' })
    const dir = await seedChange('c', { depends_on: 'a, b' })
    expect(await must(universalGuardCapabilities(dir, sourceOf('c')).dependencyStates, 'dependencyStates')()).toEqual([
      { name: 'a', ended: true },
      { name: 'b', ended: false },
    ])
  })

  it('依赖名不是合法任务名（路径穿越）：不探测文件系统，按未结束处理', async () => {
    await seedChange('outside', { archived: 'true' })
    const dir = await seedChange('c', { depends_on: ['../changes/outside', 'a/b'] })
    expect(await must(universalGuardCapabilities(dir, sourceOf('c')).dependencyStates, 'dependencyStates')()).toEqual([
      { name: '../changes/outside', ended: false },
      { name: 'a/b', ended: false },
    ])
  })

  it('没有文件面（探针缺失）：不提供该能力，guard 会失败关闭', async () => {
    const dir = await seedChange('c', { depends_on: ['a'] })
    expect(universalGuardCapabilities(dir).dependencyStates).toBeUndefined()
  })
})
