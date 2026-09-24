import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { createSnapshotCache, sendSharedSnapshot, type SharedSnapshot } from './snapshotCache.js'
import type { SnapshotDeps } from './snapshot.js'
import type { Snapshot } from './types.js'
import type { TenonUserResolution } from '@tenon/kernel'

function snapshotAt(generatedAt: string, changeCount = 0): Snapshot {
  return {
    snapshot_protocol: 'tenon-snapshot/v2',
    version: '1',
    generated_at: generatedAt,
    capabilities: {},
    project_count: 0,
    change_count: changeCount,
    projects: [],
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** A cache over an injected fingerprint and builder, with a manual clock. */
function harness(opts: { maxAgeMs?: number } = {}) {
  let fp = 'fp-1'
  let clock = 1_000
  let builds = 0
  const snapshotDeps = (): SnapshotDeps => ({}) as SnapshotDeps
  const build = vi.fn(async () => snapshotAt(`t${++builds}`, builds))
  const fingerprint = vi.fn(async () => fp)
  const cache = createSnapshotCache({ snapshotDeps, build, fingerprint, now: () => clock, ...opts })
  return {
    cache,
    build,
    fingerprint,
    setFingerprint: (next: string) => { fp = next },
    advance: (ms: number) => { clock += ms },
  }
}

describe('createSnapshotCache —— 单飞与按指纹复用', () => {
  it('并发 N 次读取只构建一次，全部拿到同一份快照', async () => {
    const h = harness()
    const results = await Promise.all(Array.from({ length: 12 }, () => h.cache.current()))
    expect(h.build).toHaveBeenCalledTimes(1)
    expect(h.fingerprint).toHaveBeenCalledTimes(1)
    expect(new Set(results).size).toBe(1)
    expect(results[0]?.snapshot.generated_at).toBe('t1')
  })

  it('指纹不变时直接复用缓存，generated_at 保持首次构建的值', async () => {
    const h = harness()
    const first = await h.cache.current()
    h.advance(5_000)
    const second = await h.cache.current()
    expect(h.build).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
    expect(second.snapshot.generated_at).toBe('t1')
    expect(second.etag).toBe(first.etag)
  })

  it('指纹变化时重建', async () => {
    const h = harness()
    await h.cache.current()
    h.setFingerprint('fp-2')
    const next = await h.cache.current()
    expect(h.build).toHaveBeenCalledTimes(2)
    expect(next.snapshot.generated_at).toBe('t2')
    expect(next.fingerprint).toBe('fp-2')
  })

  it('超过最长复用时间后即使指纹不变也重建（覆盖指纹之外的输入）', async () => {
    const h = harness({ maxAgeMs: 10_000 })
    await h.cache.current()
    h.advance(9_999)
    await h.cache.current()
    expect(h.build).toHaveBeenCalledTimes(1)
    h.advance(1)
    const rebuilt = await h.cache.current()
    expect(h.build).toHaveBeenCalledTimes(2)
    expect(rebuilt.snapshot.generated_at).toBe('t2')
  })

  it('invalidate 后下一次读取重建，即使指纹没有变化', async () => {
    const h = harness()
    await h.cache.current()
    h.cache.invalidate()
    const next = await h.cache.current()
    expect(h.build).toHaveBeenCalledTimes(2)
    expect(next.snapshot.generated_at).toBe('t2')
  })

  it('写之前开始的构建不被写之后的读取复用，也不写入缓存', async () => {
    const snapshotDeps = (): SnapshotDeps => ({}) as SnapshotDeps
    const gates = [deferred<Snapshot>(), deferred<Snapshot>()]
    let call = 0
    const build = vi.fn(() => gates[call++]!.promise)
    const cache = createSnapshotCache({ snapshotDeps, build, fingerprint: async () => 'same' })

    const beforeWrite = cache.current()
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1))
    cache.invalidate()
    const afterWrite = cache.current()
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(2))

    gates[0]!.resolve(snapshotAt('stale'))
    gates[1]!.resolve(snapshotAt('fresh'))
    expect((await beforeWrite).snapshot.generated_at).toBe('stale')
    expect((await afterWrite).snapshot.generated_at).toBe('fresh')
    expect((await cache.current()).snapshot.generated_at).toBe('fresh')
    expect(build).toHaveBeenCalledTimes(2)
  })

  it('较早开始的构建晚完成时不覆盖较新的缓存', async () => {
    const snapshotDeps = (): SnapshotDeps => ({}) as SnapshotDeps
    const gates = [deferred<Snapshot>(), deferred<Snapshot>()]
    let call = 0
    let fp = 'a'
    const build = vi.fn(() => gates[call++]!.promise)
    const cache = createSnapshotCache({ snapshotDeps, build, fingerprint: async () => fp })

    const older = cache.current()
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1))
    fp = 'b'
    const newer = cache.current()
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(2))
    gates[1]!.resolve(snapshotAt('newer'))
    await newer
    gates[0]!.resolve(snapshotAt('older'))
    await older
    expect((await cache.current()).snapshot.generated_at).toBe('newer')
    expect(build).toHaveBeenCalledTimes(2)
  })

  it('构建失败时所有等待者都收到错误，下一次读取重新构建', async () => {
    const snapshotDeps = (): SnapshotDeps => ({}) as SnapshotDeps
    const build = vi.fn()
      .mockRejectedValueOnce(new Error('disk gone'))
      .mockResolvedValueOnce(snapshotAt('ok'))
    const cache = createSnapshotCache({ snapshotDeps, build, fingerprint: async () => 'fp' })
    const failures = await Promise.allSettled([cache.current(), cache.current()])
    expect(failures.map((result) => result.status)).toEqual(['rejected', 'rejected'])
    expect(build).toHaveBeenCalledTimes(1)
    expect((await cache.current()).snapshot.generated_at).toBe('ok')
    expect(build).toHaveBeenCalledTimes(2)
  })

  it('指纹计算失败时直接构建且不缓存', async () => {
    const snapshotDeps = (): SnapshotDeps => ({}) as SnapshotDeps
    let builds = 0
    const build = vi.fn(async () => snapshotAt(`t${++builds}`))
    const cache = createSnapshotCache({
      snapshotDeps,
      build,
      fingerprint: async () => { throw new Error('unreadable') },
    })
    expect((await cache.current()).snapshot.generated_at).toBe('t1')
    expect((await cache.current()).snapshot.generated_at).toBe('t2')
  })
})

describe('createSnapshotCache —— 身份解析复用', () => {
  const alice: TenonUserResolution = { id: 'a@x.io', name: 'A', slug: 'a-at-x.io', source: 'env', trust: 'declared' }

  it('指纹与构建在 TTL 内复用每个 root 的查看者 / 执行者身份，过期或失效后重新解析', async () => {
    let clock = 0
    const viewer = vi.fn((_root: string) => alice)
    const acting = vi.fn((_root: string) => alice)
    const seen: SnapshotDeps[] = []
    const fingerprint = vi.fn(async (deps: SnapshotDeps) => {
      deps.viewer?.('/r1')
      deps.viewer?.('/r2')
      return 'fp'
    })
    const build = vi.fn(async (deps: SnapshotDeps) => {
      seen.push(deps)
      deps.viewer?.('/r1')
      deps.resolveUser?.('/r1')
      return snapshotAt('t')
    })
    const cache = createSnapshotCache({
      snapshotDeps: () => ({ viewer, resolveUser: acting }) as unknown as SnapshotDeps,
      build,
      fingerprint,
      now: () => clock,
      identityTtlMs: 1_000,
    })

    await cache.current()
    await cache.fingerprint()
    expect(viewer.mock.calls.map(([root]) => root)).toEqual(['/r1', '/r2'])
    expect(acting).toHaveBeenCalledTimes(1)

    clock = 1_000
    await cache.fingerprint()
    expect(viewer).toHaveBeenCalledTimes(4)

    cache.invalidate()
    await cache.fingerprint()
    expect(viewer).toHaveBeenCalledTimes(6)
    expect(seen).toHaveLength(1)
  })
})

function fakeResponse(): { res: ServerResponse; status: () => number; headers: () => Record<string, unknown>; body: () => string } {
  let status = 0
  let headers: Record<string, unknown> = {}
  let body = ''
  const res = {
    writeHead(code: number, head: Record<string, unknown>) { status = code; headers = head; return res },
    end(chunk?: Buffer) { body = chunk === undefined ? '' : chunk.toString('utf8') },
  }
  return { res: res as unknown as ServerResponse, status: () => status, headers: () => headers, body: () => body }
}

describe('sendSharedSnapshot —— ETag / If-None-Match', () => {
  const shared: SharedSnapshot = { snapshot: snapshotAt('t'), body: '{"a":1}', etag: '"abc"', fingerprint: 'fp' }
  const request = (ifNoneMatch?: string): IncomingMessage =>
    ({ headers: ifNoneMatch === undefined ? {} : { 'if-none-match': ifNoneMatch } }) as IncomingMessage

  it('无条件请求返回 200 + ETag + 原字节，且不进浏览器缓存', () => {
    const out = fakeResponse()
    sendSharedSnapshot(request(), out.res, shared)
    expect(out.status()).toBe(200)
    expect(out.headers()).toMatchObject({ ETag: '"abc"', 'Cache-Control': 'no-store' })
    expect(out.body()).toBe('{"a":1}')
  })

  it('ETag 命中返回 304 空体；不命中返回 200', () => {
    const hit = fakeResponse()
    sendSharedSnapshot(request('"old", "abc"'), hit.res, shared)
    expect(hit.status()).toBe(304)
    expect(hit.body()).toBe('')

    const miss = fakeResponse()
    sendSharedSnapshot(request('"old"'), miss.res, shared)
    expect(miss.status()).toBe(200)
  })
})
