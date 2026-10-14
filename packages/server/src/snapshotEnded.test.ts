/**
 * 已结束任务进入快照：两个层级的项目都带 `ended`，不进 changes / change_count；缓存按项目沿用；任务移进
 * archive/ 会推动指纹；已结束任务的详情按归档目录只读读取。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createTestDashboardServer } from './test-server.js'
import { resolveServerPaths } from './paths.js'
import { buildListSnapshot, buildSnapshot, computeFingerprint, scanProject, type SnapshotDeps } from './snapshot.js'
import type { DashboardServer } from './types.js'
import type { ListSnapshot } from './snapshotListTypes.js'
import { MAX_ENDED_TASKS } from './endedTasks.js'
import { copyArchivedTaskState, initChange, makeProject, makeTempHome, newStore, reqGet, seedArchivedTasks, testFlow } from './test-support.js'

const openServers: DashboardServer[] = []
afterEach(async () => {
  while (openServers.length) await openServers.pop()?.close()
})

function depsFor(root: string): SnapshotDeps {
  return { registry: () => [root], store: newStore(), version: '1', clock: () => 't' }
}

async function projectWithEnded(): Promise<{ root: string; archived: string }> {
  const root = await makeProject()
  await initChange(newStore(), root, 'running')
  const [archived] = await seedArchivedTasks(root, [
    { dir: '2026-10-01-old-one', observedAt: '2026-10-01T09:00:00Z', fields: { task_result: 'finished' } },
    { dir: '2026-10-02-new-one', observedAt: '2026-10-02T09:00:00Z', fields: { task_result: 'terminated' } },
  ])
  if (archived === undefined) throw new Error('seed failed')
  return { root, archived }
}

describe('快照里的已结束任务', () => {
  it('完整层与列表层的项目都带 ended（结束时间倒序），且不算进 changes 与 change_count', async () => {
    const { root } = await projectWithEnded()

    const full = await buildSnapshot(depsFor(root))
    const list = await buildListSnapshot(depsFor(root))

    for (const project of [full.projects[0], list.projects[0]]) {
      expect(project?.changes.map((change) => change.name)).toEqual(['running'])
      expect(project?.ended?.map((task) => [task.name, task.result])).toEqual([['new-one', 'terminated'], ['old-one', 'finished']])
    }
    expect(full.change_count).toBe(1)
    expect(list.change_count).toBe(1)
  })

  it('没有归档任务的项目不带 ended 字段', async () => {
    const root = await makeProject()
    await initChange(newStore(), root, 'running')

    const project = await scanProject(depsFor(root), root, 0, 'list')

    expect(project).not.toHaveProperty('ended')
  })

  it('列表被截断时项目带 endedTotal（归档总数）；没截断就没有这个字段', async () => {
    const root = await makeProject()
    const [template] = await seedArchivedTasks(root, [{ dir: '2026-01-01-template', observedAt: '2026-06-01T00:00:00Z' }])
    if (template === undefined) throw new Error('seed failed')
    const whole = await scanProject(depsFor(root), root, 0, 'list')
    expect(whole.ended).toHaveLength(1)
    expect(whole).not.toHaveProperty('endedTotal')

    await copyArchivedTaskState(template, root, Array.from({ length: MAX_ENDED_TASKS }, (_, index) => `2026-02-01-copy-${String(index).padStart(4, '0')}`))
    const truncated = await scanProject(depsFor(root), root, 0, 'list')

    expect(truncated.ended).toHaveLength(MAX_ENDED_TASKS)
    expect(truncated.endedTotal).toBe(MAX_ENDED_TASKS + 1)
  })

  it('同一项目的两次扫描共用缓存：归档目录没动就不重读状态', async () => {
    const { root, archived } = await projectWithEnded()
    const first = await scanProject(depsFor(root), root, 0, 'list')

    // 嵌套文件的改动不动归档目录自己的 mtime；若第二次扫描重读，这一项会消失。
    await writeFile(join(archived, '.pipeline-run', 'current.json'), '{ not json', 'utf8')
    const second = await scanProject(depsFor(root), root, 0, 'list')

    expect(second.ended).toEqual(first.ended)
    expect(second.ended).toHaveLength(2)
  })

  it('任务移进 archive/ 后指纹变化，即使别的输入都没变', async () => {
    const { root, archived } = await projectWithEnded()
    const before = await computeFingerprint([root], 1)

    const archive = join(root, 'openspec', 'changes', 'archive')
    await cp(archived, join(archive, '2026-10-03-third'), { recursive: true })
    const later = new Date(Date.now() + 60_000)
    await utimes(archive, later, later)

    expect(await computeFingerprint([root], 1)).not.toBe(before)
  })

  it('归档目录里的内容变化本身不推动指纹：已结束任务不进实时变更检测', async () => {
    const { root, archived } = await projectWithEnded()
    const before = await computeFingerprint([root], 1)

    await writeFile(join(archived, 'tasks.md'), '- [x] edited later\n', 'utf8')
    await writeFile(join(archived, '.pipeline-run', 'current.json'), '{ not json', 'utf8')

    expect(await computeFingerprint([root], 1)).toBe(before)
  })
})

describe('GET /api/snapshot?view=list 与已结束任务的详情', () => {
  async function start(root: string) {
    const srv = createTestDashboardServer({
      paths: resolveServerPaths({ home: await makeTempHome(), env: {} }),
      version: '9.9.9', token: 'secret', registry: () => [root], store: newStore(), flow: testFlow(),
      clock: () => '2026-10-11T00:00:00Z', pollIntervalMs: 50,
    })
    openServers.push(srv)
    const { port } = await srv.listen(0, '127.0.0.1')
    return port
  }

  it('列表线上形态带 ended，每项只含摘要字段', async () => {
    const { root } = await projectWithEnded()
    const port = await start(root)

    const body = (await reqGet(port, '/api/snapshot?view=list')).json<ListSnapshot>()

    const ended = body.projects[0]?.ended
    expect(ended?.map((task) => task.archivedDir)).toEqual([
      'openspec/changes/archive/2026-10-02-new-one',
      'openspec/changes/archive/2026-10-01-old-one',
    ])
    expect(Object.keys(ended?.[0] ?? {}).sort()).toEqual(['archivedDir', 'endedAt', 'name', 'owner', 'result', 'track', 'workflow'])
  })

  it('详情接口接受归档目录：同样的证据、只读、不写任何文件', async () => {
    const { root, archived } = await projectWithEnded()
    // 活跃任务的扫描会把缺失的 YAML 投影补回去；归档任务的详情不能写。
    await rm(join(archived, '.pipeline.yaml'))
    const before = await readdir(archived)
    const port = await start(root)

    const detail = await reqGet(port, `/api/change/${basename(archived)}/snapshot?root=${encodeURIComponent(root)}&archived=1`)

    expect(detail.status).toBe(200)
    const change = detail.json<{ name: string; documents?: unknown; fields: Record<string, string> }>()
    expect(change.name).toBe('2026-10-01-old-one')
    expect(change.documents).toBeDefined()
    expect(change.fields.task_result).toBe('finished')
    expect(await readdir(archived)).toEqual(before)
  })

  it('没带 archived 时归档目录名不是活跃任务；不存在的归档目录 400；非法名字 400', async () => {
    const { root } = await projectWithEnded()
    const port = await start(root)
    const encoded = encodeURIComponent(root)

    expect((await reqGet(port, `/api/change/2026-10-02-new-one/snapshot?root=${encoded}`)).status).toBe(400)
    expect((await reqGet(port, `/api/change/2026-10-09-ghost/snapshot?root=${encoded}&archived=1`)).status).toBe(400)
    expect((await reqGet(port, `/api/change/..%2Fx/snapshot?root=${encoded}&archived=1`)).status).toBe(400)
    expect((await reqGet(port, `/api/change/2026-10-02-new-one/snapshot?root=${encodeURIComponent('/nope')}&archived=1`)).status).toBe(404)
  })
})
