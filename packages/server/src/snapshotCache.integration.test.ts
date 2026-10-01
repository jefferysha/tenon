/**
 * The shared snapshot through the real HTTP server: page-load concurrency builds once, an unchanged
 * fingerprint serves the cached bytes, a server write is visible on the next read and drops only the project it
 * names, the stream sends a full frame then per-project deltas, the list tier and the change detail agree on a
 * change's `rev`, and the viewer's identity is part of the cache key.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { get as httpGet } from 'node:http'
import { gunzipSync } from 'node:zlib'
import { ensureUserLocalDir, serializeTaskArchive, type StateStore, type TenonUserResolution } from '@tenon/kernel'
import { createDashboardServer } from './server.js'
import { resolveServerPaths } from './paths.js'
import { computeFingerprint } from './snapshot.js'
import type { DashboardServer, Snapshot } from './types.js'
import type { ListSnapshot } from './snapshotListTypes.js'
import {
  initChange, makeProject, makeTempHome, newStore, openSSE, recordWorkflowPhaseSkill, reqGet, reqPost,
  seedGovernedDocumentEvidence, testFlow,
} from './test-support.js'

const openServers: DashboardServer[] = []
afterEach(async () => {
  while (openServers.length) await openServers.pop()?.close()
})

/** Every snapshot build inspects each change's projection exactly once, so this counts builds. */
function countingStore(store: StateStore): { store: StateStore; builds: () => number } {
  let builds = 0
  const counted = new Proxy(store, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      if (property === 'inspectProjection') {
        return (...args: unknown[]) => { builds += 1; return Reflect.apply(value, target, args) }
      }
      return (...args: unknown[]) => Reflect.apply(value, target, args)
    },
  })
  return { store: counted, builds: () => builds }
}

async function start(opts: { resolveUser?: (root: string) => TenonUserResolution; projects?: number; pollIntervalMs?: number } = {}) {
  const base = newStore()
  const root = await makeProject()
  const name = 'my-change'
  const changeDir = await initChange(base, root, name)
  await seedGovernedDocumentEvidence(root, changeDir, name)
  await recordWorkflowPhaseSkill(root, changeDir)
  const others: string[] = []
  for (let index = 1; index < (opts.projects ?? 1); index++) {
    const other = await makeProject()
    await initChange(base, other, name)
    others.push(other)
  }
  const roots = [root, ...others]
  const { store, builds } = countingStore(base)
  let tick = 0
  const srv = createDashboardServer({
    paths: resolveServerPaths({ home: await makeTempHome(), env: {} }),
    version: '9.9.9', token: 'secret', registry: () => roots, store, flow: testFlow(),
    clock: () => `2026-07-07T00:00:${String(tick++).padStart(2, '0')}Z`,
    pollIntervalMs: opts.pollIntervalMs ?? 20,
    ...(opts.resolveUser === undefined ? {} : { resolveUser: opts.resolveUser }),
  })
  openServers.push(srv)
  const { port } = await srv.listen(0, '127.0.0.1')
  return { port, root, roots, name, builds, changeDir, base }
}

const phaseOf = (snapshot: Snapshot): string | undefined => snapshot.projects[0]?.changes[0]?.phase

describe('共享快照 —— 真 HTTP server', () => {
  it('页面加载并发（多次 /api/snapshot?view=list + 列表流首帧 + afk 路由）只构建一次', async () => {
    const h = await start()
    const stream = await openSSE(h.port, '/api/stream?view=list')
    const responses = await Promise.all([
      ...Array.from({ length: 6 }, () => reqGet(h.port, '/api/snapshot?view=list')),
      reqGet(h.port, '/api/afk/snapshot'),
      reqGet(h.port, '/api/afk/log'),
    ])
    const frame = await stream.waitFor((event) => event.event === 'snapshot')
    stream.close()
    expect(responses.map((response) => response.status)).toEqual(Array(8).fill(200))
    const bodies = new Set(responses.slice(0, 6).map((response) => response.body))
    expect(bodies.size).toBe(1)
    expect(frame.data).toBe(responses[0]?.body)
    expect(h.builds()).toBe(1)
  })

  it('不带 view 的 /api/snapshot 仍是完整快照：每个 change 带全部证据，单独构建一次', async () => {
    const h = await start()
    const responses = await Promise.all(Array.from({ length: 4 }, () => reqGet(h.port, '/api/snapshot')))
    expect(new Set(responses.map((response) => response.body)).size).toBe(1)
    expect(h.builds()).toBe(1)
    const change = responses[0]?.json<Snapshot>().projects[0]?.changes[0]
    expect(change?.documents).toBeDefined()
    expect(change?.skillRuns).toBeDefined()
    expect(change?.workflowRules.policy).toBeDefined()
    expect(change?.rev).toBeUndefined()
  })

  it('指纹不变时复用缓存（generated_at 不变），If-None-Match 命中返回 304', async () => {
    const h = await start()
    const first = await reqGet(h.port, '/api/snapshot?view=list')
    const second = await reqGet(h.port, '/api/snapshot?view=list')
    expect(h.builds()).toBe(1)
    expect(second.json<ListSnapshot>().generated_at).toBe(first.json<ListSnapshot>().generated_at)
    const etag = first.headers.etag
    expect(typeof etag).toBe('string')
    const conditional = await reqGet(h.port, '/api/snapshot?view=list', '127.0.0.1', { 'If-None-Match': String(etag) })
    expect(conditional.status).toBe(304)
    expect(conditional.body).toBe('')
    expect(h.builds()).toBe(1)
  })

  it('server 执行的写完成后，下一次读取看到新数据', async () => {
    const h = await start()
    expect(phaseOf((await reqGet(h.port, '/api/snapshot')).json<Snapshot>())).toBe('open')
    const advanced = await reqPost(h.port, `/api/change/${h.name}/transition`, {
      root: h.root, event: 'open-complete',
    }, { headers: { Authorization: 'Bearer secret' } })
    expect(advanced.status).toBe(200)
    expect(phaseOf((await reqGet(h.port, '/api/snapshot')).json<Snapshot>())).toBe('explore')
  })

  it('任何非 GET 请求都使缓存失效，即使它没有改动指纹覆盖的文件', async () => {
    const h = await start()
    await reqGet(h.port, '/api/snapshot')
    await reqGet(h.port, '/api/snapshot')
    expect(h.builds()).toBe(1)
    const rejected = await reqPost(h.port, `/api/change/${h.name}/transition`, { root: h.root, event: 'open-complete' })
    expect(rejected.status).toBe(401)
    const before = h.builds()
    await reqGet(h.port, '/api/snapshot')
    expect(h.builds()).toBe(before + 1)
  })

  it('不同查看者不共用快照：经 server 切换身份后按新查看者的归档重建', async () => {
    const alice: TenonUserResolution = { id: 'a@x.io', name: 'A', slug: 'a-at-x.io', source: 'env', trust: 'declared' }
    const bob: TenonUserResolution = { id: 'b@x.io', name: 'B', slug: 'b-at-x.io', source: 'env', trust: 'declared' }
    let viewer = alice
    const h = await start({ resolveUser: () => viewer })
    const paths = await ensureUserLocalDir(h.root, alice.slug)
    await writeFile(paths.archived, serializeTaskArchive({
      version: 1,
      changes: { [h.name]: { archivedAt: '2026-09-15T12:00:00.000Z', phase: 'open', actor: { id: alice.id, name: 'A', trust: 'declared' } } },
    }), 'utf8')

    const forAlice = (await reqGet(h.port, '/api/snapshot')).json<Snapshot>()
    expect(forAlice.projects[0]?.changes).toEqual([])
    expect(forAlice.projects[0]?.archived?.map((change) => change.name)).toEqual([h.name])

    // The declared identity changes through the server, which drops the cached snapshot and identities.
    viewer = bob
    const declared = await reqPost(h.port, '/api/user', { id: bob.id, name: bob.name }, { headers: { Authorization: 'Bearer secret' } })
    expect(declared.status).toBe(200)
    const forBob = (await reqGet(h.port, '/api/snapshot')).json<Snapshot>()
    expect(forBob.projects[0]?.changes.map((change) => change.name)).toEqual([h.name])
    expect(forBob.projects[0]?.archived).toBeUndefined()
  })

  it('查看者身份本身进入指纹：两人都没有归档记录时指纹也不同', async () => {
    const root = await makeProject()
    await initChange(newStore(), root, 'shared')
    const alice: TenonUserResolution = { id: 'a@x.io', name: 'A', slug: 'a-at-x.io', source: 'env', trust: 'declared' }
    const bob: TenonUserResolution = { id: 'b@x.io', name: 'B', slug: 'b-at-x.io', source: 'env', trust: 'declared' }
    const forAlice = await computeFingerprint([root], 1, undefined, undefined, () => alice)
    const forBob = await computeFingerprint([root], 1, undefined, undefined, () => bob)
    expect(forAlice).not.toBe(forBob)
    expect(await computeFingerprint([root], 1, undefined, undefined, () => alice)).toBe(forAlice)
  })
})

const AUTH = { headers: { Authorization: 'Bearer secret' } }

describe('列表层级、项目级失效、增量推送与详情', () => {
  it('server 的写只失效它点名的项目：另一个项目不重建', async () => {
    const h = await start({ projects: 2 })
    const [rootA, rootB] = h.roots
    const first = (await reqGet(h.port, '/api/snapshot?view=list')).json<ListSnapshot>()
    expect(h.builds()).toBe(2)
    const advanced = await reqPost(h.port, `/api/change/${h.name}/transition`, { root: rootA, event: 'open-complete' }, AUTH)
    expect(advanced.status).toBe(200)
    const before = h.builds()
    const next = (await reqGet(h.port, '/api/snapshot?view=list')).json<ListSnapshot>()
    expect(h.builds()).toBe(before + 1)
    expect(next.projects.find((project) => project.root === rootA)?.changes[0]?.phase).toBe('explore')
    expect(next.projects.find((project) => project.root === rootB)?.changes[0]?.phase).toBe('open')
    expect(first.projects.find((project) => project.root === rootA)?.changes[0]?.phase).toBe('open')
  })

  it('列表层级不含逐 change 证据；同一计划的规则只出现一次；每个 change 带 rev', async () => {
    const h = await start()
    const response = await reqGet(h.port, '/api/snapshot?view=list')
    const body = response.json<{ view: string; projects: { shared: Record<string, unknown[]>; changes: Record<string, unknown>[] }[] }>()
    expect(body.view).toBe('list')
    const change = body.projects[0]?.changes[0]
    expect(change).toBeDefined()
    for (const heavy of ['documents', 'skillRuns', 'agentRuns', 'tests', 'testPolicy', 'testPlan', 'testUser', 'testDiagnostics']) {
      expect(change, heavy).not.toHaveProperty(heavy)
    }
    expect(typeof change?.rev).toBe('string')
    expect(body.projects[0]?.shared.workflowRules).toHaveLength(1)
    expect(Object.keys(change?.fields as Record<string, unknown>).sort()).toEqual(['automation', 'workflow'])
  })

  it('列表响应对接受 gzip 的调用方压缩，解压后与原字节一致', async () => {
    const h = await start()
    const plain = await reqGet(h.port, '/api/snapshot?view=list')
    const zipped = await new Promise<{ encoding: string | undefined; body: Buffer }>((resolve, reject) => {
      httpGet({ host: '127.0.0.1', port: h.port, path: '/api/snapshot?view=list', headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ encoding: res.headers['content-encoding'], body: Buffer.concat(chunks) }))
      }).on('error', reject)
    })
    expect(zipped.encoding).toBe('gzip')
    expect(gunzipSync(zipped.body).toString('utf8')).toBe(plain.body)
    expect(zipped.body.length).toBeLessThan(plain.body.length)
  })

  it('详情：与列表行同一个 rev，带全部证据；ETag 命中 304；写入后 rev 与内容更新', async () => {
    const h = await start()
    const list = (await reqGet(h.port, '/api/snapshot?view=list')).json<ListSnapshot>()
    const rev = list.projects[0]?.changes[0]?.rev
    expect(typeof rev).toBe('string')
    const url = `/api/change/${h.name}/snapshot?root=${encodeURIComponent(h.root)}`
    const detail = await reqGet(h.port, url)
    expect(detail.status).toBe(200)
    const change = detail.json<Snapshot['projects'][number]['changes'][number]>()
    expect(change.rev).toBe(rev)
    expect(change.documents).toBeDefined()
    expect(change.skillRuns).toBeDefined()
    expect(change.workflowRules.policy).toBeDefined()
    expect(Object.keys(change.fields).length).toBeGreaterThan(2)
    const conditional = await reqGet(h.port, url, '127.0.0.1', { 'If-None-Match': String(detail.headers.etag) })
    expect(conditional.status).toBe(304)
    const advanced = await reqPost(h.port, `/api/change/${h.name}/transition`, { root: h.root, event: 'open-complete' }, AUTH)
    expect(advanced.status).toBe(200)
    const after = (await reqGet(h.port, url)).json<Snapshot['projects'][number]['changes'][number]>()
    expect(after.phase).toBe('explore')
    expect(after.rev).not.toBe(rev)
    expect(after.rev).toBe((await reqGet(h.port, '/api/snapshot?view=list')).json<ListSnapshot>().projects[0]?.changes[0]?.rev)
  })

  it('详情：非法名字 400、未登记的 root 404、不存在的 change 400', async () => {
    const h = await start()
    const root = encodeURIComponent(h.root)
    expect((await reqGet(h.port, `/api/change/..%2Fx/snapshot?root=${root}`)).status).toBe(400)
    expect((await reqGet(h.port, `/api/change/${h.name}/snapshot?root=${encodeURIComponent('/nope')}`)).status).toBe(404)
    expect((await reqGet(h.port, `/api/change/ghost/snapshot?root=${root}`)).status).toBe(400)
  })

  it('列表流：首帧是完整 snapshot，之后只推变化的项目（snapshot-delta），顺序随帧给出', async () => {
    const h = await start({ projects: 2 })
    const [rootA, rootB] = h.roots
    const stream = await openSSE(h.port, '/api/stream?view=list')
    const first = await stream.waitFor((event) => event.event === 'snapshot', 10_000)
    expect(JSON.parse(first.data).projects.map((project: { root: string }) => project.root)).toEqual([rootA, rootB])
    const advanced = await reqPost(h.port, `/api/change/${h.name}/transition`, { root: rootA, event: 'open-complete' }, AUTH)
    expect(advanced.status).toBe(200)
    const delta = await stream.waitFor((event) => event.event === 'snapshot-delta', 10_000)
    stream.close()
    const frame = JSON.parse(delta.data) as { view: string; roots: string[]; projects: { root: string; changes: { phase: string }[] }[]; project_count: number }
    expect(frame.view).toBe('list')
    expect(frame.roots).toEqual([rootA, rootB])
    expect(frame.projects.map((project) => project.root)).toEqual([rootA])
    expect(frame.projects[0]?.changes[0]?.phase).toBe('explore')
    expect(frame.project_count).toBe(2)
  })

  it('完整流（不带 view）仍整份重发 snapshot 事件', async () => {
    const h = await start()
    const stream = await openSSE(h.port, '/api/stream')
    await stream.waitFor((event) => event.event === 'snapshot', 10_000)
    const advanced = await reqPost(h.port, `/api/change/${h.name}/transition`, { root: h.root, event: 'open-complete' }, AUTH)
    expect(advanced.status).toBe(200)
    const again = await stream.waitFor((event) => event.event === 'snapshot' && phaseOf(JSON.parse(event.data) as Snapshot) === 'explore', 10_000)
    stream.close()
    expect(JSON.parse(again.data).projects[0].changes[0].documents).toBeDefined()
  })

  it('后来的连接不会吞掉先到的连接还没收到的变化（标记只在唯一客户端时前移）', async () => {
    const h = await start({ pollIntervalMs: 1_500 })
    const first = await openSSE(h.port, '/api/stream?view=list')
    await first.waitFor((event) => event.event === 'snapshot', 10_000)
    // 终端里的写：不经 server，只有指纹能发现它。
    await h.base.set(h.changeDir, 'phase', 'explore')
    const second = await openSSE(h.port, '/api/stream?view=list')
    const initial = await second.waitFor((event) => event.event === 'snapshot', 10_000)
    expect(phaseOf(JSON.parse(initial.data) as Snapshot)).toBe('explore')
    const delta = await first.waitFor((event) => event.event === 'snapshot-delta', 10_000)
    first.close()
    second.close()
    expect(JSON.parse(delta.data).projects[0].changes[0].phase).toBe('explore')
  })
})
