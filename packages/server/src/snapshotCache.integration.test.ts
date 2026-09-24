/**
 * The shared snapshot through the real HTTP server: page-load concurrency builds once, an unchanged
 * fingerprint serves the cached bytes, a server write is visible on the next read, and the viewer's
 * identity is part of the cache key.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { ensureUserLocalDir, serializeTaskArchive, type StateStore, type TenonUserResolution } from '@tenon/kernel'
import { createDashboardServer } from './server.js'
import { resolveServerPaths } from './paths.js'
import { computeFingerprint } from './snapshot.js'
import type { DashboardServer, Snapshot } from './types.js'
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

async function start(opts: { resolveUser?: (root: string) => TenonUserResolution } = {}) {
  const base = newStore()
  const root = await makeProject()
  const name = 'my-change'
  const changeDir = await initChange(base, root, name)
  await seedGovernedDocumentEvidence(root, changeDir, name)
  await recordWorkflowPhaseSkill(root, changeDir)
  const { store, builds } = countingStore(base)
  let tick = 0
  const srv = createDashboardServer({
    paths: resolveServerPaths({ home: await makeTempHome(), env: {} }),
    version: '9.9.9', token: 'secret', registry: () => [root], store, flow: testFlow(),
    clock: () => `2026-07-07T00:00:${String(tick++).padStart(2, '0')}Z`,
    pollIntervalMs: 20,
    ...(opts.resolveUser === undefined ? {} : { resolveUser: opts.resolveUser }),
  })
  openServers.push(srv)
  const { port } = await srv.listen(0, '127.0.0.1')
  return { port, root, name, builds }
}

const phaseOf = (snapshot: Snapshot): string | undefined => snapshot.projects[0]?.changes[0]?.phase

describe('共享快照 —— 真 HTTP server', () => {
  it('页面加载并发（多次 /api/snapshot + /api/stream 首帧 + afk 路由）只构建一次', async () => {
    const h = await start()
    const stream = await openSSE(h.port, '/api/stream')
    const responses = await Promise.all([
      ...Array.from({ length: 6 }, () => reqGet(h.port, '/api/snapshot')),
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

  it('指纹不变时复用缓存（generated_at 不变），If-None-Match 命中返回 304', async () => {
    const h = await start()
    const first = await reqGet(h.port, '/api/snapshot')
    const second = await reqGet(h.port, '/api/snapshot')
    expect(h.builds()).toBe(1)
    expect(second.json<Snapshot>().generated_at).toBe(first.json<Snapshot>().generated_at)
    const etag = first.headers.etag
    expect(typeof etag).toBe('string')
    const conditional = await reqGet(h.port, '/api/snapshot', '127.0.0.1', { 'If-None-Match': String(etag) })
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
