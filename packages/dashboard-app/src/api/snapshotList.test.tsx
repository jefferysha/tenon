/**
 * The list snapshot on the wire: shared sub-trees written once per project and pointed at by integer, expanded
 * back before the strict decoder sees them; per-project deltas applied to the last snapshot the stream delivered;
 * and the change detail a list row's `rev` asks for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeChange, makeProject, makeSnapshot } from '../testkit'
import type { ChangeSnapshot, Snapshot } from '../types'
import { fetchChangeDetail } from './changeDetailClient'
import { subscribeSnapshot } from './snapshotClient'
import { applySnapshotDelta, decodeSnapshot, decodeSnapshotDelta } from './snapshotDecoder'
import { expandWireProject } from './snapshotWire'
import { ApiError } from './transport'

type Wire = Record<string, unknown>

/** What the server writes for a project: one shared table per kind, changes pointing into it. */
function wireProject(root: string, changes: readonly ChangeSnapshot[], over: Wire = {}): Wire {
  const rules = changes[0]?.workflowRules
  return {
    root,
    ok: true,
    changes: changes.map((change) => {
      const { workflowRules: _r, workflowExecution: _e, todo: _t, owner: _o, creator: _c, ...rest } = change
      return { ...rest, workflowRules: 0, workflowExecution: 1, owner: null, creator: 0, rev: `rev-${change.name}` }
    }),
    shared: {
      workflowRules: rules === undefined ? [] : [rules],
      workflowExecution: changes.length === 0 ? [] : [changes[0]?.workflowExecution, changes[1]?.workflowExecution ?? changes[0]?.workflowExecution],
      todo: [],
      user: [{ id: 'a@x.io', name: 'A', slug: 'a-at-x.io' }],
    },
    ...over,
  }
}

function listSnapshot(projects: Wire[], over: Wire = {}): Wire {
  const count = projects.reduce((n, p) => n + (Array.isArray(p.changes) ? p.changes.length : 0), 0)
  return {
    snapshot_protocol: 'tenon-snapshot/v2', view: 'list', version: '1', generated_at: 't',
    capabilities: { snapshot: true }, project_count: projects.length, change_count: count, projects, ...over,
  }
}

describe('expandWireProject', () => {
  it('整数指针换回共享表里的同一个对象；shared 键消失；没有 shared 的项目原样返回', () => {
    const change = makeChange('a', 'open')
    const expanded = expandWireProject(wireProject('/r', [change])) as { shared?: unknown; changes: Wire[] }
    expect(expanded).not.toHaveProperty('shared')
    expect(expanded.changes[0]?.workflowRules).toBe(change.workflowRules)
    expect(expanded.changes[0]?.creator).toEqual({ id: 'a@x.io', name: 'A', slug: 'a-at-x.io' })
    expect(expanded.changes[0]?.owner).toBeNull()
    const plain = { root: '/r', ok: true, changes: [change] }
    expect(expandWireProject(plain)).toBe(plain)
  })

  it.each([
    ['越界的指针', (wire: Wire) => { (wire.changes as Wire[])[0]!.workflowRules = 5 }],
    ['负数指针', (wire: Wire) => { (wire.changes as Wire[])[0]!.workflowRules = -1 }],
    ['非整数指针', (wire: Wire) => { (wire.changes as Wire[])[0]!.workflowRules = 0.5 }],
    ['shared 不是对象', (wire: Wire) => { wire.shared = [] }],
    ['某张表不是数组', (wire: Wire) => { (wire.shared as Wire).user = {} }],
    ['指向不存在的表（用户表缺失）', (wire: Wire) => { delete (wire.shared as Wire).user }],
  ])('%s → null', (_name, mutate) => {
    const wire = wireProject('/r', [makeChange('a', 'open')])
    mutate(wire)
    expect(expandWireProject(wire)).toBeNull()
  })
})

describe('decodeSnapshot —— 列表线格式', () => {
  it('解码得到与完整快照同形状的 change，带 rev，没有逐 change 证据', () => {
    const a = makeChange('a', 'open')
    const b = makeChange('b', 'explore')
    const decoded = decodeSnapshot(listSnapshot([wireProject('/r', [a, b])]))
    expect(decoded).not.toBeNull()
    expect(decoded?.view).toBe('list')
    const [first, second] = decoded?.projects[0]?.changes ?? []
    expect(first).toMatchObject({ name: 'a', phase: 'open', rev: 'rev-a', creator: { slug: 'a-at-x.io' }, owner: null })
    expect(first?.workflowRules).toEqual(a.workflowRules)
    expect(second?.workflowExecution).toEqual(b.workflowExecution)
    expect(first?.documents).toBeUndefined()
    expect(first?.tests).toBeUndefined()
  })

  it('坏指针让整份快照无效，而不是悄悄少一个 change', () => {
    const wire = wireProject('/r', [makeChange('a', 'open')])
    ;(wire.changes as Wire[])[0]!.workflowExecution = 9
    expect(decodeSnapshot(listSnapshot([wire]))).toBeNull()
  })

  it('rev 必须是非空字符串', () => {
    for (const rev of [1, '', null]) {
      const wire = wireProject('/r', [makeChange('a', 'open')])
      ;(wire.changes as Wire[])[0]!.rev = rev
      expect(decodeSnapshot(listSnapshot([wire])), String(rev)).toBeNull()
    }
  })

  it('完整快照（没有 view、没有 shared）照旧解码', () => {
    const full = makeSnapshot([makeProject('/r', [makeChange('a', 'open')])])
    const decoded = decodeSnapshot(JSON.parse(JSON.stringify(full)))
    expect(decoded?.view).toBeUndefined()
    expect(decoded?.projects[0]?.changes[0]?.name).toBe('a')
  })
})

describe('snapshot-delta', () => {
  const base = (): Snapshot => decodeSnapshot(listSnapshot([wireProject('/a', [makeChange('a1', 'open')]), wireProject('/b', [makeChange('b1', 'open')])])) as Snapshot
  const delta = (projects: Wire[], roots: string[]): unknown => ({ ...listSnapshot(projects), roots })

  it('只换被重发的项目，其余项目保持对象身份；顺序跟 roots', () => {
    const before = base()
    const parsed = decodeSnapshotDelta(delta([wireProject('/b', [makeChange('b1', 'explore')])], ['/b', '/a']))
    expect(parsed).not.toBeNull()
    const next = applySnapshotDelta(before, parsed!)
    expect(next?.projects.map((project) => project.root)).toEqual(['/b', '/a'])
    expect(next?.projects[1]).toBe(before.projects[0])
    expect(next?.projects[0]?.changes[0]?.phase).toBe('explore')
    expect(next?.generated_at).toBe('t')
  })

  it('新增项目、移除项目', () => {
    const before = base()
    const added = applySnapshotDelta(before, decodeSnapshotDelta(delta([wireProject('/c', [makeChange('c1', 'open')])], ['/a', '/b', '/c']))!)
    expect(added?.projects.map((project) => project.root)).toEqual(['/a', '/b', '/c'])
    const removed = applySnapshotDelta(before, decodeSnapshotDelta(delta([], ['/a']))!)
    expect(removed?.projects.map((project) => project.root)).toEqual(['/a'])
  })

  it('roots 点名了两边都不认识的项目 → null（流失步了，调用方重连）', () => {
    expect(applySnapshotDelta(base(), decodeSnapshotDelta(delta([], ['/a', '/ghost']))!)).toBeNull()
  })

  it('形状不对的帧解码为 null', () => {
    expect(decodeSnapshotDelta({ ...delta([], []), roots: 'nope' })).toBeNull()
    expect(decodeSnapshotDelta({ ...delta([], []), projects: {} })).toBeNull()
    expect(decodeSnapshotDelta(delta([{ root: '/x', ok: true, changes: [{ not: 'a change' }] }], ['/x']))).toBeNull()
  })
})

class FakeEventSource {
  static last: FakeEventSource | undefined
  readonly listeners = new Map<string, ((event: Event) => void)[]>()
  closed = false
  constructor(readonly url: string) { FakeEventSource.last = this }
  addEventListener(type: string, listener: (event: Event) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]) }
  removeEventListener(type: string, listener: (event: Event) => void): void { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== listener)) }
  close(): void { this.closed = true }
  emit(type: string, data: unknown): void {
    const event = Object.assign(new Event(type), { data: typeof data === 'string' ? data : JSON.stringify(data) })
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

describe('subscribeSnapshot —— 增量帧', () => {
  beforeEach(() => { vi.stubGlobal('EventSource', FakeEventSource) })
  afterEach(() => { vi.unstubAllGlobals() })

  it('整帧之后的增量帧合并进上一份快照再交给回调；订阅的是列表流', () => {
    const received: Snapshot[] = []
    const errors: string[] = []
    const stop = subscribeSnapshot((snapshot) => received.push(snapshot), () => errors.push('error'))
    const source = FakeEventSource.last!
    expect(source.url).toBe('/api/stream?view=list')
    source.emit('snapshot', listSnapshot([wireProject('/a', [makeChange('a1', 'open')]), wireProject('/b', [makeChange('b1', 'open')])]))
    source.emit('snapshot-delta', { ...listSnapshot([wireProject('/a', [makeChange('a1', 'explore')])], { generated_at: 't2' }), roots: ['/a', '/b'] })
    expect(errors).toEqual([])
    expect(received).toHaveLength(2)
    expect(received[1]?.generated_at).toBe('t2')
    expect(received[1]?.projects[0]?.changes[0]?.phase).toBe('explore')
    expect(received[1]?.projects[1]).toBe(received[0]?.projects[1])
    stop()
    expect(source.closed).toBe(true)
  })

  it('没有底稿的增量帧、无法应用的增量帧、坏帧：都走错误回调，不交出半份快照', () => {
    const received: Snapshot[] = []
    const errors: string[] = []
    subscribeSnapshot((snapshot) => received.push(snapshot), () => errors.push('error'))
    const source = FakeEventSource.last!
    source.emit('snapshot-delta', { ...listSnapshot([]), roots: [] })
    expect(errors).toHaveLength(1)
    source.emit('snapshot', listSnapshot([wireProject('/a', [makeChange('a1', 'open')])]))
    source.emit('snapshot-delta', { ...listSnapshot([]), roots: ['/a', '/ghost'] })
    expect(errors).toHaveLength(2)
    source.emit('snapshot-delta', '{bad json')
    expect(errors).toHaveLength(3)
    expect(received).toHaveLength(1)
  })
})

describe('fetchChangeDetail', () => {
  afterEach(() => { vi.unstubAllGlobals() })
  const body = (over: Partial<ChangeSnapshot> = {}): string => JSON.stringify({ ...makeChange('a', 'build'), rev: 'r1', ...over })

  it('解码完整的 change；带 If-None-Match 重取时 304 复用上一份', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(body(), { status: 200, headers: { ETag: '"e1"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
    vi.stubGlobal('fetch', fetchMock)
    const first = await fetchChangeDetail('/detail-root', 'a')
    expect(first).toMatchObject({ name: 'a', rev: 'r1' })
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/change/a/snapshot?root=%2Fdetail-root')
    const second = await fetchChangeDetail('/detail-root', 'a')
    expect(second).toBe(first)
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).headers).toMatchObject({ 'If-None-Match': '"e1"' })
  })

  it('HTTP 错误 → 带状态的 ApiError；坏形状 → invalid；网络错误 → ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: 'gone' }), { status: 404 })))
    await expect(fetchChangeDetail('/err-root', 'a')).rejects.toMatchObject({ status: 404 })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ nope: true }), { status: 200 })))
    await expect(fetchChangeDetail('/err-root', 'a')).rejects.toThrow('invalid')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('offline')))
    await expect(fetchChangeDetail('/err-root', 'a')).rejects.toBeInstanceOf(ApiError)
  })
})
