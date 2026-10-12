/**
 * 已结束任务的文档状态：任务结束时整个目录移进 `archive/<日期>-<名>/`，而文档台账里登记的仍是移动前的路径。
 * 读已结束任务时这些路径要按归档后的位置求值——摘要没变的文档是已登记，真被改过或缺失的照实报；活跃任务一律不变。
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanChangeDetail, type SnapshotDeps } from './snapshot.js'
import { createSnapshotCache } from './snapshotCache.js'
import { initChange, makeProject, newStore, seedGovernedDocumentEvidence, testFlow } from './test-support.js'
import type { StateStore } from '@tenon/kernel'

const NAME = 'alpha'
const ARCHIVED = `2026-10-05-${NAME}`

function depsFor(root: string, store: StateStore): SnapshotDeps {
  return { registry: () => [root], store, version: '1', clock: () => 't', flow: testFlow() }
}

interface Task {
  readonly root: string
  readonly deps: SnapshotDeps
  readonly activeDir: string
  readonly archivedDir: string
}

/** A task with real hash-bound document evidence at `phase`, still in `openspec/changes/<name>`. */
async function activeTask(phase: string): Promise<Task> {
  const store = newStore()
  const root = await makeProject()
  const activeDir = await initChange(store, root, NAME)
  await seedGovernedDocumentEvidence(root, activeDir, NAME)
  await store.set(activeDir, 'phase', phase)
  return { root, deps: depsFor(root, store), activeDir, archivedDir: join(root, 'openspec', 'changes', 'archive', ARCHIVED) }
}

/** What `tenon task finish` does to the directory: the whole task moves into `archive/`. */
async function endTask(task: Task): Promise<void> {
  await mkdir(dirname(task.archivedDir), { recursive: true })
  await rename(task.activeDir, task.archivedDir)
}

async function documentItems(task: Task, area: 'active' | 'archive') {
  const name = area === 'archive' ? ARCHIVED : NAME
  const detail = await scanChangeDetail(task.deps, task.root, name, 1, area)
  const items = detail?.change.documents?.items
  if (items === undefined) throw new Error(`no document evidence for ${name}`)
  return items.map((item) => ({ kind: item.kind, status: item.status, reason: item.reason }))
}

describe('已结束任务的文档状态', () => {
  it.each(['open', 'spec'])('%s：归档后读取，摘要没变的文档不是 stale，状态与结束前一致', async (phase) => {
    const task = await activeTask(phase)
    const before = await documentItems(task, 'active')
    expect(before.length).toBeGreaterThan(0)
    expect(before.filter((item) => item.status === 'stale')).toEqual([])

    await endTask(task)

    expect(await documentItems(task, 'archive')).toEqual(before)
  })

  it('归档后任务目录里的文档被改过：照实报 stale（内容变化）', async () => {
    const task = await activeTask('open')
    await endTask(task)
    await writeFile(join(task.archivedDir, 'proposal.md'), '# rewritten after the task ended\n', 'utf8')

    const items = await documentItems(task, 'archive')

    expect(items.find((item) => item.kind === 'proposal')).toMatchObject({ status: 'stale', reason: 'changed' })
    expect(items.filter((item) => item.kind !== 'proposal' && item.status === 'stale')).toEqual([])
  })

  it('归档后任务目录里的文档缺失：照实报 stale', async () => {
    const task = await activeTask('open')
    await endTask(task)
    await rm(join(task.archivedDir, 'tasks.md'))

    expect((await documentItems(task, 'archive')).find((item) => item.kind === 'tasks')).toMatchObject({ status: 'stale', reason: 'changed' })
  })

  it('登记路径不在本任务目录下（docs/…）：不映射，照旧在原位置求值', async () => {
    const task = await activeTask('spec')
    await endTask(task)
    expect((await documentItems(task, 'archive')).find((item) => item.kind === 'plan')).toMatchObject({ status: expect.not.stringMatching(/^stale$/u) })

    await writeFile(join(task.root, 'docs', 'superpowers', 'plans', `${NAME}.md`), '# plan edited after the task ended\n', 'utf8')

    expect((await documentItems(task, 'archive')).find((item) => item.kind === 'plan')).toMatchObject({ status: 'stale', reason: 'changed' })
  })

  it('任务自己的 delta-spec 移进归档后不是旧路径', async () => {
    const task = await activeTask('spec')
    await endTask(task)

    expect((await documentItems(task, 'archive')).find((item) => item.kind === 'delta-spec')).toMatchObject({ status: expect.not.stringMatching(/^stale$/u) })
  })

  it('活跃任务的求值不变：文件在登记路径时已登记，改过即 stale，归档位置上的副本不算数', async () => {
    const task = await activeTask('open')
    expect((await documentItems(task, 'active')).filter((item) => item.status === 'stale')).toEqual([])

    // 归档位置上放一份摘要相同的副本：活跃任务不映射，所以登记路径被删就是 stale。
    const proposal = await readFile(join(task.activeDir, 'proposal.md'), 'utf8')
    await mkdir(task.archivedDir, { recursive: true })
    await writeFile(join(task.archivedDir, 'proposal.md'), proposal, 'utf8')
    await rm(join(task.activeDir, 'proposal.md'))

    expect((await documentItems(task, 'active')).find((item) => item.kind === 'proposal')).toMatchObject({ status: 'stale', reason: 'changed' })
  })

  it('经快照缓存读已结束任务：状态按归档位置求值，显示的路径也在归档位置', async () => {
    const task = await activeTask('open')
    await endTask(task)
    const cache = createSnapshotCache({ snapshotDeps: () => task.deps })

    const shared = await cache.archivedDetail(task.root, ARCHIVED)

    const proposal = shared?.change.documents?.items.find((item) => item.kind === 'proposal')
    expect(proposal).toMatchObject({ status: expect.not.stringMatching(/^stale$/u) })
    expect(proposal?.paths).toEqual([`openspec/changes/archive/${ARCHIVED}/proposal.md`])
  })
})
