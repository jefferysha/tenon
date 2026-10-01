/**
 * useSnapshot().reconnect —— 评审修复（.superpowers/sdd/task-5-report.md 担忧①）。
 *
 * 病灶：断线横幅「重连」钮此前在 App.tsx 另开一条独立 SSE 订阅（`subscribeSnapshot(() => refresh())`），
 * 不碰这个 hook 内部真正持有 `connected` 状态的那条订阅——点了重连，新连接自己收得到帧，但
 * `connected`（横幅显隐唯一状态源）仍然只由原始（已失效）订阅决定，横幅不会自愈，页面还挂了
 * 两条并行 `/api/stream`。
 *
 * 修复：重连下沉到这条真订阅本体——hook 新增 `reconnect()`，关闭当前 EventSource（复用
 * subscribeSnapshot 返回的 unsub 路径）、重建一条新的（用 streamGen 计数器触发既有订阅 effect
 * 重跑，不复制订阅逻辑），并 `refresh()` 补一次全量 GET（断线期间可能漏帧的既有补偿语义）。
 * 新连接 open/收到帧时，effect 里既有的 setConnected(true) 逻辑自然把 connected 翻正。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useSnapshot } from './useSnapshot'
import { lastEventSource, resetEventSources } from '../test-setup'
import { makeChange, makeProject, makeSnapshot } from '../testkit'

function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/snapshot?view=list') return { ok: true, json: async () => makeSnapshot([]) }
    throw new Error(`unexpected fetch ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  resetEventSources()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('useSnapshot().reconnect —— 重连下沉本体（评审修复：担忧①）', () => {
  it('挂载即建立一条 /api/stream 订阅', async () => {
    stubFetch()
    const { result } = renderHook(() => useSnapshot())
    await waitFor(() => expect(result.current.loading).toBe(false))

    const es = lastEventSource()
    expect(es).toBeDefined()
    expect(es!.url).toBe('/api/stream?view=list')
    expect(es!.readyState).not.toBe(2) // 非 CLOSED
  })

  it('调用 reconnect：旧 EventSource 被 close（既有 unsub 路径复用）+ 新建一条不同实例', async () => {
    stubFetch()
    const { result } = renderHook(() => useSnapshot())
    await waitFor(() => expect(result.current.loading).toBe(false))

    const first = lastEventSource()!
    expect(first.readyState).not.toBe(2) // CLOSED

    act(() => {
      result.current.reconnect()
    })

    expect(first.readyState).toBe(2) // CLOSED —— 旧订阅关闭，不是晾在那里泄漏
    const second = lastEventSource()!
    expect(second).not.toBe(first) // 新建了一条，不是复用失效的旧连接

    // reconnect() 顺带 refresh() 触发的那次 GET 是异步的；等它落地再收尾，
    // 避免测试提前退出导致状态更新落在 act() 之外（噪音警告，非本用例断言范围）。
    await waitFor(() => expect(result.current.loading).toBe(false))
  })

  it('调用 reconnect：额外发起一次 GET /api/snapshot（断线期间可能漏帧的补偿语义）', async () => {
    const fetchMock = stubFetch()
    const { result } = renderHook(() => useSnapshot())
    await waitFor(() => expect(result.current.loading).toBe(false))

    const before = fetchMock.mock.calls.filter((c: unknown[]) => c[0] === '/api/snapshot?view=list').length

    act(() => {
      result.current.reconnect()
    })

    await waitFor(() => {
      const after = fetchMock.mock.calls.filter((c: unknown[]) => c[0] === '/api/snapshot?view=list').length
      expect(after).toBe(before + 1)
    })
  })

  it('SSE onerror → connected=false；reconnect 后新连接收到快照帧 → connected 翻正为 true（横幅自愈的状态源头）', async () => {
    stubFetch()
    const { result } = renderHook(() => useSnapshot())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.connected).toBe(true)

    const first = lastEventSource()!
    act(() => {
      first.emit('error', '')
    })
    expect(result.current.connected).toBe(false)

    act(() => {
      result.current.reconnect()
    })
    const second = lastEventSource()!
    expect(second).not.toBe(first)

    act(() => {
      second.emit('snapshot', JSON.stringify(makeSnapshot([])))
    })
    expect(result.current.connected).toBe(true)

    // reconnect() 顺带 refresh() 触发的那次 GET 是异步的；等它落地再收尾（同上一条用例）。
    await waitFor(() => expect(result.current.loading).toBe(false))
  })

  it('畸形 reviewHandshake 帧不覆盖旧快照，并把 connected 标为 false，避免把陈旧审批状态伪装成实时', async () => {
    stubFetch()
    const { result } = renderHook(() => useSnapshot())
    await waitFor(() => expect(result.current.loading).toBe(false))
    const change = makeChange('review-change', 'explore', {
      reviewHandshake: {
        status: 'pending',
        event: 'explore-complete',
        requestedAt: '2026-07-30T02:00:00Z',
      },
    })
    const valid = makeSnapshot([makeProject('/repo', [change])])
    const es = lastEventSource()!
    act(() => {
      es.emit('snapshot', JSON.stringify(valid))
    })
    expect(result.current.connected).toBe(true)
    expect(result.current.snapshot?.projects[0]?.changes[0]?.reviewHandshake).toEqual(
      change.reviewHandshake,
    )

    const malformed = structuredClone(valid)
    ;(malformed.projects[0]!.changes[0] as unknown as {
      reviewHandshake: { requestedAt: unknown }
    }).reviewHandshake.requestedAt = 42
    act(() => {
      es.emit('snapshot', JSON.stringify(malformed))
    })

    expect(result.current.connected).toBe(false)
    expect(result.current.snapshot?.projects[0]?.changes[0]?.reviewHandshake).toEqual(
      change.reviewHandshake,
    )
  })
})
