/**
 * 已结束任务的只读详情：快照、编排、记录三个读接口都认 `archived=1`，按归档目录名从 `openspec/changes/archive/`
 * 读取，名字与目录过同一条校验（`resolveArchivedTaskDir`），读取不写任何文件。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { readdir, rename, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { createTestDashboardServer } from './test-server.js'
import { resolveServerPaths } from './paths.js'
import type { DashboardServer } from './types.js'
import { initChange, makeProject, makeTempHome, newStore, reqGet, seedArchivedTasks, testFlow } from './test-support.js'
import type { ChangeOrchestrationResponse } from './workflowOrchestration.js'

const open: DashboardServer[] = []
afterEach(async () => {
  while (open.length > 0) await open.pop()?.close()
})

const DIR = '2026-10-01-old-one'

interface Harness {
  readonly port: number
  readonly root: string
  readonly archived: string
  /** 另一个项目里的一个真任务目录：符号链接指向它。 */
  readonly elsewhere: string
}

async function start(): Promise<Harness> {
  const store = newStore()
  const root = await makeProject()
  await initChange(store, root, 'running')
  const [archived] = await seedArchivedTasks(root, [{ dir: DIR, observedAt: '2026-10-01T09:00:00Z', fields: { task_result: 'finished' } }])
  const [elsewhere] = await seedArchivedTasks(await makeProject(), [{ dir: DIR, observedAt: '2026-10-01T09:00:00Z' }])
  if (archived === undefined || elsewhere === undefined) throw new Error('seed failed')
  const hostHome = await makeTempHome()
  const srv = createTestDashboardServer({
    version: '9.9.9',
    hostHome,
    paths: resolveServerPaths({ home: hostHome, env: {} }),
    token: 'secret-token-abc',
    registry: () => [root],
    store,
    flow: testFlow(),
    clock: () => '2026-10-11T00:00:00Z',
    pollIntervalMs: 20,
  })
  open.push(srv)
  const { port } = await srv.listen(0, '127.0.0.1')
  return { port, root, archived, elsewhere }
}

type Endpoint = 'snapshot' | 'orchestration' | 'history'
const ENDPOINTS: readonly Endpoint[] = ['snapshot', 'orchestration', 'history']

/** 找不到 / 名字非法 → 状态码：快照与记录沿用「找不到该 change」的 400，编排是 404；路径不可信时编排是 403。 */
const MISSING: Record<Endpoint, number> = { snapshot: 400, history: 400, orchestration: 404 }
const UNTRUSTED: Record<Endpoint, number> = { snapshot: 400, history: 400, orchestration: 403 }

function urlOf(h: Harness, endpoint: Endpoint, name: string, query = 'archived=1'): string {
  return `/api/change/${name}/${endpoint}?root=${encodeURIComponent(h.root)}${query === '' ? '' : `&${query}`}`
}

/** 目录里每个文件的相对路径、大小与修改时间：读完之后必须与读之前一模一样。 */
async function fingerprint(dir: string): Promise<string[]> {
  const out: string[] = []
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      const info = await stat(full)
      out.push(`${relative(dir, full)}:${info.size}:${info.mtimeMs}`)
    }
  }
  await walk(dir)
  return out.sort()
}

describe('已结束任务的只读详情接口（archived=1）', () => {
  it.each(ENDPOINTS)('%s：按归档目录名读到 200，且不写任何文件', async (endpoint) => {
    const h = await start()
    const before = await fingerprint(h.archived)

    const res = await reqGet(h.port, urlOf(h, endpoint, DIR))

    expect(res.status, res.body).toBe(200)
    expect(await fingerprint(h.archived)).toEqual(before)
  })

  it('编排：任务冻结的计划 + 运行状态，change 是归档目录名', async () => {
    const h = await start()

    const body = (await reqGet(h.port, urlOf(h, 'orchestration', DIR))).json<ChangeOrchestrationResponse>()

    expect(body.change).toBe(DIR)
    expect(body.workflow).toBe('default')
    expect(body.stages.length).toBeGreaterThan(0)
    expect(body.stages.every((stage) => stage.entries.every((entry) => typeof entry.status === 'string'))).toBe(true)
    expect(body).not.toHaveProperty('io')
    expect(Object.keys(body.stepIo).length).toBeGreaterThan(0)
  })

  it('记录：读归档目录里的历史', async () => {
    const h = await start()
    await writeFile(join(h.archived, '.pipeline-history.jsonl'), `${JSON.stringify({ ts: '2026-10-01T08:00:00Z', kind: 'transition', from: 'build', to: 'verify', raw: 'build-complete' })}\n`, 'utf8')

    const body = (await reqGet(h.port, urlOf(h, 'history', DIR))).json<{ entries: Array<{ kind: string; from?: string; to?: string }> }>()

    expect(body.entries.map((entry) => [entry.kind, entry.from, entry.to])).toContainEqual(['transition', 'build', 'verify'])
  })

  it.each(ENDPOINTS)('%s：没带 archived 时归档目录名不是活跃任务', async (endpoint) => {
    const h = await start()

    expect((await reqGet(h.port, urlOf(h, endpoint, DIR, ''))).status).toBe(MISSING[endpoint])
  })

  it.each(ENDPOINTS)('%s：带 archived 时读不到活跃任务的名字', async (endpoint) => {
    const h = await start()

    expect((await reqGet(h.port, urlOf(h, endpoint, 'running'))).status).toBe(MISSING[endpoint])
  })

  it.each(ENDPOINTS)('%s：非法目录名（.. 、含分隔符、含点、空字符）一律 400', async (endpoint) => {
    const h = await start()

    for (const name of ['..', '%2e%2e', '..%2Fx', 'a%2Fb', 'a%5Cb', `${DIR}%2F..`, 'x.y', '%00']) {
      expect([name, (await reqGet(h.port, urlOf(h, endpoint, name))).status]).toEqual([name, 400])
    }
  })

  it.each(ENDPOINTS)('%s：不存在的归档目录被拒', async (endpoint) => {
    const h = await start()

    expect((await reqGet(h.port, urlOf(h, endpoint, '2026-10-09-ghost'))).status).toBe(MISSING[endpoint])
  })

  it.each(ENDPOINTS)('%s：归档里指向归档之外的符号链接被拒，不读出另一个项目的任务', async (endpoint) => {
    const h = await start()
    await symlink(h.elsewhere, join(h.root, 'openspec', 'changes', 'archive', '2026-10-02-link'), 'dir')

    expect((await reqGet(h.port, urlOf(h, endpoint, '2026-10-02-link'))).status).toBe(UNTRUSTED[endpoint])
  })

  it.each(ENDPOINTS)('%s：archive 目录整个是符号链接时被拒', async (endpoint) => {
    const h = await start()
    const archive = join(h.root, 'openspec', 'changes', 'archive')
    await rename(archive, `${archive}-moved`)
    await symlink(dirname(h.elsewhere), archive, 'dir')

    expect((await reqGet(h.port, urlOf(h, endpoint, DIR))).status).toBe(UNTRUSTED[endpoint])
  })

  it.each(ENDPOINTS)('%s：未登记的 root 是 404', async (endpoint) => {
    const h = await start()

    const res = await reqGet(h.port, `/api/change/${DIR}/${endpoint}?root=${encodeURIComponent('/nope')}&archived=1`)

    expect(res.status).toBe(404)
  })
})
