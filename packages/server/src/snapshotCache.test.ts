import type { IncomingMessage, ServerResponse } from 'node:http'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import type { TenonUserResolution } from '@tenon/kernel'
import {
  createSnapshotCache, MAX_AGE_REFRESH_PER_READ, sendSharedSnapshot, type ProjectScanners,
} from './snapshotCache.js'
import type { SnapshotDeps } from './snapshot.js'
import type { RootFingerprint } from './snapshotFingerprint.js'
import { sharedBody, type SharedSnapshot } from './snapshotShared.js'
import type { ChangeSnapshot, ProjectSnapshot, Snapshot } from './types.js'
import type { ChangeListSnapshot, ProjectListSnapshot } from './snapshotListTypes.js'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function listChange(name: string, phase = 'open'): ChangeListSnapshot {
  return {
    name, path: `/p/openspec/changes/${name}`, phase, phase_status: 'pending', track: 'backend', preset: 'full', archived: 'false',
    updated_at: '2026-07-07T00:00:00Z', fields: { workflow: 'default', automation: 'off', assignee: 'x' }, owner: null, creator: null,
    workflowPlanFingerprint: 'a'.repeat(64),
    workflowRules: { executionModel: 'phase-manifest', steps: ['open'], transitions: { open: [] }, gateByStep: { open: null }, labelByStep: { open: 'open' }, outputsByStep: { open: [] } },
    workflowExecution: { readinessByTransition: {} },
    reviewHandshake: { status: 'not-requested' },
  }
}

function listProject(root: string, label: string, names: readonly string[] = ['c1']): ProjectListSnapshot {
  return { root, ok: true, changes: names.map((name) => listChange(name, label)) }
}

function fullProject(root: string, label: string): ProjectSnapshot {
  return { ...listProject(root, label), workflowRules: {} }
}

/** A cache over injected fingerprints and scanners, with a manual clock. One fingerprint per root, changeable per test. */
function harness(opts: { roots?: readonly string[]; maxAgeMs?: number } = {}) {
  const roots = opts.roots ?? ['/a', '/b']
  const keys = new Map(roots.map((root) => [root, `${root}-1`]))
  const revs = new Map<string, Map<string, string>>()
  let clock = 1_000
  const builds: string[] = []
  const details: string[] = []
  const scanners: ProjectScanners = {
    list: vi.fn(async (_deps, root) => { builds.push(`list:${root}`); return listProject(root, `${root}@${keys.get(root)}`) }),
    full: vi.fn(async (_deps, root) => { builds.push(`full:${root}`); return fullProject(root, `${root}@${keys.get(root)}`) }),
    detail: vi.fn(async (_deps, root, name) => {
      details.push(`${root}/${name}`)
      const change: ChangeSnapshot = { ...listChange(name), workflowRules: { ...listChange(name).workflowRules, policy: undefined as never } }
      return { change }
    }),
  }
  const fingerprints = vi.fn(async (_deps: SnapshotDeps, _now: number, asked: readonly string[]): Promise<RootFingerprint[]> =>
    asked.map((root) => ({ root, key: keys.get(root) ?? '', revs: revs.get(root) ?? new Map([['c1', `${root}-rev-1`]]) })))
  const cache = createSnapshotCache({
    snapshotDeps: () => ({ registry: () => [...roots], version: '1', clock: () => `t${clock}`, capabilities: {} }) as unknown as SnapshotDeps,
    scanners, fingerprints, now: () => clock, ...(opts.maxAgeMs === undefined ? {} : { maxAgeMs: opts.maxAgeMs }),
  })
  return {
    cache, scanners, builds, details, fingerprints,
    setKey: (root: string, key: string) => { keys.set(root, key) },
    setRevs: (root: string, next: Map<string, string>) => { revs.set(root, next) },
    advance: (ms: number) => { clock += ms },
  }
}

describe('createSnapshotCache —— 按项目缓存与按指纹复用', () => {
  it('并发 N 次读取每个项目只构建一次，全部拿到同一份列表快照', async () => {
    const h = harness()
    const results = await Promise.all(Array.from({ length: 12 }, () => h.cache.list()))
    expect(h.builds.sort()).toEqual(['list:/a', 'list:/b'])
    expect(new Set(results).size).toBe(1)
  })

  it('指纹没变的项目直接复用，generated_at 与 ETag 保持首次组装的值', async () => {
    const h = harness()
    const first = await h.cache.list()
    h.advance(5_000)
    const second = await h.cache.list()
    expect(second).toBe(first)
    expect(second.etag).toBe(first.etag)
    expect(h.builds).toHaveLength(2)
  })

  it('一个项目的指纹变了：只重建那一个项目，其余项目的序列化字节原样复用', async () => {
    const h = harness()
    const first = await h.cache.list()
    h.setKey('/b', '/b-2')
    const next = await h.cache.list()
    expect(h.builds.sort()).toEqual(['list:/a', 'list:/b', 'list:/b'])
    expect(next.chunks[0]).toBe(first.chunks[0])
    expect(next.chunks[1]?.digest).not.toBe(first.chunks[1]?.digest)
    expect(next.etag).not.toBe(first.etag)
  })

  it('列表与完整两个层级各自构建、互不重复', async () => {
    const h = harness()
    await h.cache.list()
    await h.cache.full()
    await h.cache.full()
    await h.cache.list()
    expect(h.builds.sort()).toEqual(['full:/a', 'full:/b', 'list:/a', 'list:/b'])
  })

  it('超过最长复用时间后即使指纹不变也重建（覆盖指纹之外的输入），但每次读取最多刷新 MAX_AGE_REFRESH_PER_READ 个', async () => {
    const roots = Array.from({ length: MAX_AGE_REFRESH_PER_READ + 3 }, (_, index) => `/r${index}`)
    const h = harness({ roots, maxAgeMs: 10_000 })
    await h.cache.list()
    h.advance(9_999)
    await h.cache.list()
    expect(h.builds).toHaveLength(roots.length)
    h.advance(1)
    await h.cache.list()
    expect(h.builds).toHaveLength(roots.length + MAX_AGE_REFRESH_PER_READ)
    await h.cache.list()
    expect(h.builds).toHaveLength(roots.length * 2)
  })

  it('invalidate() 不带参数：下一次读取全部重建，即使指纹没有变化', async () => {
    const h = harness()
    await h.cache.list()
    h.cache.invalidate()
    await h.cache.list()
    expect(h.builds).toHaveLength(4)
  })

  it('invalidate([root])：只重建被写到的项目', async () => {
    const h = harness()
    await h.cache.list()
    h.cache.invalidate(['/a/'])
    await h.cache.list()
    expect(h.builds.sort()).toEqual(['list:/a', 'list:/a', 'list:/b'])
  })

  it('写之前开始的构建不被写之后的读取复用，也不写入缓存', async () => {
    const gates = [deferred<ProjectListSnapshot>(), deferred<ProjectListSnapshot>()]
    let call = 0
    const scanners: ProjectScanners = {
      list: vi.fn(() => gates[call++]!.promise),
      full: vi.fn(),
      detail: vi.fn(),
    }
    const cache = createSnapshotCache({
      snapshotDeps: () => ({ registry: () => ['/a'], version: '1', clock: () => 't', capabilities: {} }) as unknown as SnapshotDeps,
      scanners,
      fingerprints: async () => [{ root: '/a', key: 'same', revs: new Map() }],
    })
    const beforeWrite = cache.list()
    await vi.waitFor(() => expect(scanners.list).toHaveBeenCalledTimes(1))
    cache.invalidate(['/a'])
    const afterWrite = cache.list()
    await vi.waitFor(() => expect(scanners.list).toHaveBeenCalledTimes(2))

    gates[0]!.resolve(listProject('/a', 'stale'))
    gates[1]!.resolve(listProject('/a', 'fresh'))
    expect((await beforeWrite).snapshot.projects[0]?.changes[0]?.phase).toBe('stale')
    expect((await afterWrite).snapshot.projects[0]?.changes[0]?.phase).toBe('fresh')
    expect((await cache.list()).snapshot.projects[0]?.changes[0]?.phase).toBe('fresh')
    expect(scanners.list).toHaveBeenCalledTimes(2)
  })

  it('较早开始的构建晚完成时不覆盖较新的缓存', async () => {
    const gates = [deferred<ProjectListSnapshot>(), deferred<ProjectListSnapshot>()]
    let call = 0
    let key = 'a'
    const scanners: ProjectScanners = { list: vi.fn(() => gates[call++]!.promise), full: vi.fn(), detail: vi.fn() }
    const cache = createSnapshotCache({
      snapshotDeps: () => ({ registry: () => ['/a'], version: '1', clock: () => 't', capabilities: {} }) as unknown as SnapshotDeps,
      scanners,
      fingerprints: async () => [{ root: '/a', key, revs: new Map() }],
    })
    const older = cache.list()
    await vi.waitFor(() => expect(scanners.list).toHaveBeenCalledTimes(1))
    key = 'b'
    const newer = cache.list()
    await vi.waitFor(() => expect(scanners.list).toHaveBeenCalledTimes(2))
    gates[1]!.resolve(listProject('/a', 'newer'))
    await newer
    gates[0]!.resolve(listProject('/a', 'older'))
    await older
    expect((await cache.list()).snapshot.projects[0]?.changes[0]?.phase).toBe('newer')
    expect(scanners.list).toHaveBeenCalledTimes(2)
  })

  it('构建失败时所有等待者都收到错误，下一次读取重新构建', async () => {
    const list = vi.fn<ProjectScanners['list']>()
      .mockRejectedValueOnce(new Error('disk gone'))
      .mockResolvedValueOnce(listProject('/a', 'ok'))
    const cache = createSnapshotCache({
      snapshotDeps: () => ({ registry: () => ['/a'], version: '1', clock: () => 't', capabilities: {} }) as unknown as SnapshotDeps,
      scanners: { list },
      fingerprints: async () => [{ root: '/a', key: 'fp', revs: new Map() }],
    })
    const failures = await Promise.allSettled([cache.list(), cache.list()])
    expect(failures.map((result) => result.status)).toEqual(['rejected', 'rejected'])
    expect(list).toHaveBeenCalledTimes(1)
    expect((await cache.list()).snapshot.projects[0]?.changes[0]?.phase).toBe('ok')
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('指纹计算失败时直接构建且不缓存', async () => {
    const list = vi.fn<ProjectScanners['list']>(async (_deps, root) => listProject(root, 'x'))
    const cache = createSnapshotCache({
      snapshotDeps: () => ({ registry: () => ['/a'], version: '1', clock: () => 't', capabilities: {} }) as unknown as SnapshotDeps,
      scanners: { list },
      fingerprints: async () => { throw new Error('unreadable') },
    })
    await cache.list()
    await cache.list()
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('不再注册的项目被丢掉，重新注册后从头构建', async () => {
    let registered = ['/a', '/b']
    const builds: string[] = []
    const cache = createSnapshotCache({
      snapshotDeps: () => ({ registry: () => registered, version: '1', clock: () => 't', capabilities: {} }) as unknown as SnapshotDeps,
      scanners: { list: async (_deps, root) => { builds.push(root); return listProject(root, 'x') } },
      fingerprints: async (_deps, _now, roots) => roots.map((root) => ({ root, key: root, revs: new Map() })),
    })
    await cache.list()
    registered = ['/a']
    expect((await cache.list()).snapshot.project_count).toBe(1)
    registered = ['/a', '/b']
    await cache.list()
    expect(builds.sort()).toEqual(['/a', '/b', '/b'])
  })

  it('没有任何项目注册：列表快照同样被复用（同一份字节、同一个 ETag）', async () => {
    const h = harness({ roots: [] })
    const first = await h.cache.list()
    const second = await h.cache.list()
    expect(second).toBe(first)
    expect(first.snapshot.project_count).toBe(0)
  })

  it('完整层级只在有人用文档化的 API 读它时才驻留：停读两分钟后，下一次列表读取释放它', async () => {
    const h = harness({ roots: ['/a'], maxAgeMs: 10_000_000 })
    await h.cache.full()
    await h.cache.full()
    expect(h.builds).toEqual(['full:/a'])
    h.advance(119_000)
    await h.cache.list()
    await h.cache.full()
    expect(h.builds).toEqual(['full:/a', 'list:/a'])
    h.advance(120_001)
    await h.cache.list()
    await h.cache.full()
    expect(h.builds).toEqual(['full:/a', 'list:/a', 'full:/a'])
  })

  it('整体指纹是各项目指纹的拼接，任一项目变化它就变', async () => {
    const h = harness()
    const before = await h.cache.fingerprint()
    expect(before).toContain('/a:/a-1')
    h.setKey('/b', '/b-2')
    expect(await h.cache.fingerprint()).not.toBe(before)
  })
})

describe('createSnapshotCache —— 列表快照的线格式', () => {
  it('body 是信封 + 各项目序列化字节的拼接；每个 change 带指纹给出的 rev，fields 只留列表行读的键', async () => {
    const h = harness({ roots: ['/a'] })
    const shared = await h.cache.list()
    const body: { view: string; projects: { changes: { name: string; rev?: string; fields: Record<string, unknown> }[] }[] } = JSON.parse(shared.body)
    expect(body.view).toBe('list')
    expect(body.projects).toHaveLength(1)
    expect(body.projects[0]?.changes[0]).toMatchObject({ name: 'c1', rev: '/a-rev-1', fields: { workflow: 'default', automation: 'off' } })
    expect(body.projects[0]?.changes[0]?.fields).not.toHaveProperty('assignee')
    expect(shared.chunks.map((chunk) => JSON.parse(chunk.json).root)).toEqual(['/a'])
    // 服务端内部的列表对象（AFK 等读它）仍带完整 fields。
    expect(shared.snapshot.projects[0]?.changes[0]?.fields).toHaveProperty('assignee')
  })

  it('同一计划的 change 共用一份规则：线格式里只出现一次', async () => {
    const shared = listChange('x').workflowRules
    const cache = createSnapshotCache({
      snapshotDeps: () => ({ registry: () => ['/a'], version: '1', clock: () => 't', capabilities: {} }) as unknown as SnapshotDeps,
      scanners: { list: async () => ({ root: '/a', ok: true, changes: ['c1', 'c2', 'c3'].map((name) => ({ ...listChange(name), workflowRules: shared })) }) },
      fingerprints: async () => [{ root: '/a', key: 'k', revs: new Map() }],
    })
    const body: { projects: { changes: { workflowRules: number }[]; shared: { workflowRules: unknown[] } }[] } = JSON.parse((await cache.list()).body)
    expect(body.projects[0]?.shared.workflowRules).toHaveLength(1)
    expect(body.projects[0]?.changes.map((change) => change.workflowRules)).toEqual([0, 0, 0])
  })
})

describe('createSnapshotCache —— 单个 change 的详情', () => {
  it('按 change 的 rev 复用；rev 变了重读；带 rev 的响应体', async () => {
    const h = harness({ roots: ['/a'] })
    const first = await h.cache.detail('/a', 'c1')
    const again = await h.cache.detail('/a', 'c1')
    expect(again).toBe(first)
    expect(h.details).toEqual(['/a/c1'])
    expect(JSON.parse(first?.body ?? '{}')).toMatchObject({ name: 'c1', rev: '/a-rev-1' })
    h.setRevs('/a', new Map([['c1', '/a-rev-2']]))
    const moved = await h.cache.detail('/a', 'c1')
    expect(moved?.rev).toBe('/a-rev-2')
    expect(h.details).toEqual(['/a/c1', '/a/c1'])
  })

  it('指纹里没有这个 change → null，不去读', async () => {
    const h = harness({ roots: ['/a'] })
    expect(await h.cache.detail('/a', 'nope')).toBeNull()
    expect(h.details).toEqual([])
  })

  it('invalidate([root]) 丢掉该项目的详情；并发读取共用一次构建', async () => {
    const h = harness({ roots: ['/a'] })
    await Promise.all([h.cache.detail('/a', 'c1'), h.cache.detail('/a', 'c1'), h.cache.detail('/a', 'c1')])
    expect(h.details).toHaveLength(1)
    h.cache.invalidate(['/a'])
    await h.cache.detail('/a', 'c1')
    expect(h.details).toHaveLength(2)
  })

  it('读不出来的 change（扫描返回 undefined）→ null', async () => {
    const cache = createSnapshotCache({
      snapshotDeps: () => ({ registry: () => ['/a'], version: '1', clock: () => 't', capabilities: {} }) as unknown as SnapshotDeps,
      scanners: { detail: async () => undefined },
      fingerprints: async () => [{ root: '/a', key: 'k', revs: new Map([['c1', 'r']]) }],
    })
    expect(await cache.detail('/a', 'c1')).toBeNull()
  })
})

describe('createSnapshotCache —— 身份解析复用', () => {
  const alice: TenonUserResolution = { id: 'a@x.io', name: 'A', slug: 'a-at-x.io', source: 'env', trust: 'declared' }

  it('指纹与构建在 TTL 内复用每个 root 的查看者 / 执行者身份；过期后重新解析；按项目失效只清该项目', async () => {
    let clock = 0
    const viewer = vi.fn((_root: string) => alice)
    const acting = vi.fn((_root: string) => alice)
    const fingerprints = vi.fn(async (deps: SnapshotDeps, _now: number, roots: readonly string[]) => {
      for (const root of roots) deps.viewer?.(root)
      return roots.map((root) => ({ root, key: 'fp', revs: new Map<string, string>() }))
    })
    const list = vi.fn<ProjectScanners['list']>(async (deps, root) => {
      deps.viewer?.(root)
      deps.resolveUser?.(root)
      return listProject(root, 't')
    })
    const cache = createSnapshotCache({
      snapshotDeps: () => ({ viewer, resolveUser: acting, registry: () => ['/r1', '/r2'], version: '1', clock: () => 't', capabilities: {} }) as unknown as SnapshotDeps,
      scanners: { list },
      fingerprints,
      now: () => clock,
      identityTtlMs: 1_000,
    })

    await cache.list()
    await cache.fingerprint()
    expect(viewer.mock.calls.map(([root]) => root)).toEqual(['/r1', '/r2'])
    expect(acting).toHaveBeenCalledTimes(2)

    clock = 1_000
    await cache.fingerprint()
    expect(viewer).toHaveBeenCalledTimes(4)

    cache.invalidate(['/r1'])
    await cache.fingerprint()
    expect(viewer.mock.calls.filter(([root]) => root === '/r1')).toHaveLength(3)
    expect(viewer.mock.calls.filter(([root]) => root === '/r2')).toHaveLength(2)

    cache.invalidate()
    await cache.fingerprint()
    expect(viewer.mock.calls.filter(([root]) => root === '/r2')).toHaveLength(3)
  })
})

function fakeResponse(): { res: ServerResponse; status: () => number; headers: () => Record<string, unknown>; body: () => Buffer } {
  let status = 0
  let headers: Record<string, unknown> = {}
  let body: Buffer = Buffer.alloc(0)
  const res = {
    writeHead(code: number, head: Record<string, unknown>) { status = code; headers = head; return res },
    end(chunk?: Buffer) { body = chunk ?? Buffer.alloc(0) },
  }
  return { res: res as unknown as ServerResponse, status: () => status, headers: () => headers, body: () => body }
}

describe('sendSharedSnapshot —— ETag / gzip / If-None-Match', () => {
  const small: SharedSnapshot = { ...sharedBody('{"a":1}'), snapshot: {} as Snapshot, fingerprint: 'fp' }
  const request = (headers: Record<string, string> = {}): IncomingMessage => ({ headers }) as IncomingMessage

  it('无条件请求返回 200 + ETag + 原字节，且不进浏览器缓存', () => {
    const out = fakeResponse()
    sendSharedSnapshot(request(), out.res, small)
    expect(out.status()).toBe(200)
    expect(out.headers()).toMatchObject({ ETag: small.etag, 'Cache-Control': 'no-store' })
    expect(out.body().toString('utf8')).toBe('{"a":1}')
  })

  it('ETag 命中返回 304 空体；不命中返回 200', () => {
    const hit = fakeResponse()
    sendSharedSnapshot(request({ 'if-none-match': `"old", ${small.etag}` }), hit.res, small)
    expect(hit.status()).toBe(304)
    expect(hit.body().length).toBe(0)

    const miss = fakeResponse()
    sendSharedSnapshot(request({ 'if-none-match': '"old"' }), miss.res, small)
    expect(miss.status()).toBe(200)
  })

  it('大于阈值且调用方接受 gzip：返回压缩字节并复用（只压一次）；不接受则原样', () => {
    const big: SharedSnapshot = { ...sharedBody(JSON.stringify({ rows: Array.from({ length: 200 }, (_, i) => ({ i, text: 'same text' })) })), snapshot: {} as Snapshot, fingerprint: 'fp' }
    const zipped = fakeResponse()
    sendSharedSnapshot(request({ 'accept-encoding': 'gzip, deflate' }), zipped.res, big)
    expect(zipped.headers()).toMatchObject({ 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' })
    expect(zipped.body().length).toBeLessThan(big.body.length / 4)
    expect(gunzipSync(zipped.body()).toString('utf8')).toBe(big.body)
    const cached = big.gzip
    sendSharedSnapshot(request({ 'accept-encoding': 'gzip' }), fakeResponse().res, big)
    expect(big.gzip).toBe(cached)
    const plain = fakeResponse()
    sendSharedSnapshot(request({ 'accept-encoding': 'identity' }), plain.res, big)
    expect(plain.headers()).not.toHaveProperty('Content-Encoding')
    expect(plain.body().toString('utf8')).toBe(big.body)
  })
})
