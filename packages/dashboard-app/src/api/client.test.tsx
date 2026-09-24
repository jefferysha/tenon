import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  ApiError,
  fetchSnapshot,
  fetchTraceTimeline,
  getToken,
  postTransition,
  subscribeSnapshot,
} from './client'
import { lastEventSource, resetEventSources } from '../test-setup'
import { makeChange, makeProject, makeSnapshot } from '../testkit'
import { formatApiError, formatServerProse } from './transport'

beforeEach(() => {
  resetEventSources()
  ;(window as unknown as { __TENON_DASHBOARD_TOKEN__?: string }).__TENON_DASHBOARD_TOKEN__ = 'tok-abc'
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('getToken（同源注入的 window token）', () => {
  it('读取 window.__TENON_DASHBOARD_TOKEN__', () => {
    expect(getToken()).toBe('tok-abc')
  })
})

describe('formatApiError locale boundary', () => {
  const t = (key: string, vars?: Record<string, string | number>): string => {
    if (key === 'common.network_error') return '网络错误'
    if (key === 'common.invalid_response') return '服务端响应格式无效。'
    if (key === 'common.request_http_error') return `请求失败（HTTP ${String(vars?.status)}）。`
    return key
  }

  it('中文也只展示真实 server detail，不把客户端英文 fallback 当成服务端原文', () => {
    expect(formatApiError(
      new ApiError('skill registry request failed (503)', 503),
      t,
      { exposeServerDetail: true },
    )).toBe('请求失败（HTTP 503）。')
    expect(formatApiError(
      new ApiError('技能注册表暂不可用', 503, true),
      t,
      { exposeServerDetail: true },
    )).toBe('技能注册表暂不可用')
  })
})

describe('formatServerProse locale boundary', () => {
  it('英文隐藏服务端自然语言，中文只在明确允许时展示', () => {
    const t = (key: string): string => ({
      'common.request_failed': 'Request failed.',
    })[key] ?? key
    expect(formatServerProse('服务端内部原因', t)).toBe('Request failed.')
    expect(formatServerProse('服务端内部原因', t, { exposeServerDetail: true })).toBe('服务端内部原因')
    expect(formatServerProse('', t, { exposeServerDetail: true })).toBe('Request failed.')
  })
})

describe('postTransition（B5 token 写回，契约 { root, event }）', () => {
  it('POST 正确 url / method / Authorization Bearer / body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
    vi.stubGlobal('fetch', fetchMock)
    await postTransition('login flow', '/repo-a', 'build-complete')
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/change/login%20flow/transition')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok-abc')
    expect(headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual({ root: '/repo-a', event: 'build-complete' })
  })

  it('!ok 时抛 ApiError 且带 server error 文案', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ ok: false, error: 'phase 不匹配' }) }),
    )
    await expect(postTransition('c', '/r', 'verify-pass')).rejects.toThrow('phase 不匹配')
    await expect(postTransition('c', '/r', 'verify-pass')).rejects.toBeInstanceOf(ApiError)
  })

  // 评审 P1-5：server PreconditionError 返回 { error: lines[0], detail: lines }——此前只读
  // error，多条 guard 违规只显示第一条，用户「修一条→再撞下一条」。detail 全量透传。
  it('409 带 detail[] 多行 → ApiError 文案包含全部违规行，不只第一条', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false, status: 409,
        json: async () => ({ ok: false, error: '缺 design_doc', detail: ['缺 design_doc', '缺 verification_report', 'branch_status 未处理'] }),
      }),
    )
    const err = await postTransition('c', '/r', 'verify-pass').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    const msg = (err as ApiError).message
    expect(msg).toContain('缺 design_doc')
    expect(msg).toContain('缺 verification_report')
    expect(msg).toContain('branch_status 未处理')
  })
})

describe('fetchSnapshot', () => {
  it('解析 /api/snapshot JSON', async () => {
    const snap = makeSnapshot([])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => snap }))
    const got = await fetchSnapshot()
    expect(got.capabilities.snapshot).toBe(true)
  })

  it('!ok → ApiError 带状态码', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }))
    await expect(fetchSnapshot()).rejects.toThrow('500')
  })

  it('带上次的 ETag 发 If-None-Match；304 复用上次解码的快照', async () => {
    const snap = makeSnapshot([])
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers({ ETag: '"v1"' }), json: async () => snap })
      .mockResolvedValueOnce({ ok: false, status: 304, headers: new Headers({ ETag: '"v1"' }), json: async () => { throw new Error('no body') } })
      .mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(), json: async () => snap })
      .mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(), json: async () => snap })
    vi.stubGlobal('fetch', fetchMock)
    const first = await fetchSnapshot()
    expect(fetchMock.mock.calls[0]?.[1]).toEqual({ headers: { Accept: 'application/json' } })
    const second = await fetchSnapshot()
    expect(fetchMock.mock.calls[1]?.[1]).toEqual({ headers: { Accept: 'application/json', 'If-None-Match': '"v1"' } })
    expect(second).toBe(first)
    // A response without an ETag forgets the cached one: the next request is unconditional.
    await fetchSnapshot()
    await fetchSnapshot()
    expect(fetchMock.mock.calls[3]?.[1]).toEqual({ headers: { Accept: 'application/json' } })
  })

  it('没有缓存时的 304 按失败处理', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 304, headers: new Headers(), json: async () => ({}) }))
    await expect(fetchSnapshot()).rejects.toThrow('304')
  })

  it('2xx 响应解码失败不伪装成 HTTP 200 错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }))
    const error = await fetchSnapshot().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBeUndefined()
  })
})

describe('fetchTraceTimeline', () => {
  const timeline = {
    generated_at: '2026-07-29T00:00:00.000Z',
    outbound: 'local-only',
    content: 'metadata-only',
    session: {
      id: 'session a',
      client: 'codex',
      proxy_mode: 'forward',
      status: 'complete',
      started_at: '2026-07-29T00:00:00.000Z',
      updated_at: '2026-07-29T00:00:01.000Z',
    },
    total_count: 0,
    returned_count: 0,
    skipped_count: 0,
    truncated: false,
    integrity: 'complete',
    warnings: [],
    summary: {
      success_count: 0,
      error_count: 0,
      unknown_count: 0,
      total_duration_ms: null,
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
    },
    entries: [],
  }

  it('GETs the encoded session from the metadata-only endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => timeline,
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchTraceTimeline('session a')).resolves.toEqual(timeline)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/traces/timeline?session=session%20a',
      { headers: { Accept: 'application/json' } },
    )
  })

  it('rejects HTTP failures and malformed disclosure responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'unknown session' }),
    }))
    await expect(fetchTraceTimeline('missing')).rejects.toThrow('404')

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ...timeline, outbound: 'remote' }),
    }))
    await expect(fetchTraceTimeline('session a')).rejects.toThrow('响应形状无效')

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ...timeline, session: { ...timeline.session, id: 'different-session' } }),
    }))
    await expect(fetchTraceTimeline('session a')).rejects.toThrow('响应形状无效')
  })
})

describe('subscribeSnapshot（真 EventSource stub，组件真收帧）', () => {
  it('emit snapshot 事件 → 回调收到解析后的 Snapshot；退订调用 close', () => {
    const received: unknown[] = []
    const unsub = subscribeSnapshot((s) => received.push(s))
    const es = lastEventSource()!
    expect(es.url).toBe('/api/stream')
    es.emit('snapshot', JSON.stringify(makeSnapshot([])))
    expect(received).toHaveLength(1)
    expect((received[0] as { version: string }).version).toBe('0.1.0')
    unsub()
    expect(es.readyState).toBe(2) // CLOSED
  })

  it('坏帧不抛（忽略）', () => {
    const received: unknown[] = []
    subscribeSnapshot((s) => received.push(s))
    const es = lastEventSource()!
    expect(() => es.emit('snapshot', '{bad json')).not.toThrow()
    expect(received).toHaveLength(0)
  })

  it('present but malformed reviewHandshake fails closed through the stream error callback', () => {
    const received: unknown[] = []
    const errors: unknown[] = []
    const change = makeChange('review-change', 'explore')
    ;(change as unknown as { reviewHandshake: unknown }).reviewHandshake = {
      status: 'pending',
      event: 'explore-complete',
      requestedAt: 42,
    }
    subscribeSnapshot(
      (snapshot) => received.push(snapshot),
      () => errors.push('invalid-stream-snapshot'),
    )

    const es = lastEventSource()!
    expect(() => es.emit(
      'snapshot',
      JSON.stringify(makeSnapshot([makeProject('/repo', [change])])),
    )).not.toThrow()
    expect(received).toHaveLength(0)
    expect(errors).toEqual(['invalid-stream-snapshot'])
  })
})

describe('G18 api 两函数（unregisterProject/fetchWorkflowNames）', () => {
  it('unregisterProject：DELETE /api/projects?root= 带 token、无 Content-Type', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
    vi.stubGlobal('fetch', fetchMock)
    const { unregisterProject } = await import('./client')
    await unregisterProject('/repo a')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/projects?root=%2Frepo%20a')
    expect(init.method).toBe('DELETE')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok-abc')
    expect(headers['Content-Type']).toBeUndefined()
  })

  it('fetchWorkflowNames：GET /api/workflows?root= 返回 names', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ names: ['rel', 'hotfix'] }) })
    vi.stubGlobal('fetch', fetchMock)
    const { fetchWorkflowNames } = await import('./client')
    const names = await fetchWorkflowNames('/repo')
    expect(names).toEqual(['rel', 'hotfix'])
    expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/workflows?root=%2Frepo')
  })
})

/**
 * T9 失败卡动作两函数：重试（server 既有 /retry，CAS failed/conflict/paused → queued）与
 * 放弃（决议 #4 的 /dismiss，端点由 T11 落地——客户端先按同一契约接线）。
 */
describe('T9 afk 失败卡动作（postAfkRetry/postAfkDismiss）', () => {
  it('postAfkRetry：POST /api/afk/:name/retry 带 token + body {root}（name URL 编码）', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
    vi.stubGlobal('fetch', fetchMock)
    const { postAfkRetry } = await import('./client')
    await postAfkRetry('hotfix login', '/repo-a')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/afk/hotfix%20login/retry')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok-abc')
    expect(headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual({ root: '/repo-a' })
  })

  it('postAfkDismiss：POST /api/afk/:name/dismiss；!ok 抛 ApiError 带 server 文案', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
    vi.stubGlobal('fetch', fetchMock)
    const { postAfkDismiss } = await import('./client')
    await postAfkDismiss('hotfix-login', '/repo-a')
    expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/afk/hotfix-login/dismiss')

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ ok: false, error: '状态已变，请刷新' }) }))
    await expect(postAfkDismiss('hotfix-login', '/repo-a')).rejects.toThrow('状态已变')
  })
})

describe('AFK 手动挂队（postAfkEnqueue）', () => {
  it('POST /api/afk/:name/enqueue 带 token + body {root}', async () => {
    const fetchMock = vi.mocked(global.fetch)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const { postAfkEnqueue } = await import('./client')
    await postAfkEnqueue('gate d', '/repo-a')
    expect(fetchMock).toHaveBeenCalledWith('/api/afk/gate%20d/enqueue', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ root: '/repo-a' }),
    }))
  })
})

/**
 * v9-J：fetchSessionLinks 批量预取（进度视图 failed 行「回终端」chip 一次拉全部，产品决策=
 * 批量端点而非逐行发请求）。非 2xx / 网络异常静默降级空表，不抛 ApiError——批量预取失败不该
 * 炸整个视图（同 fetchSessionLink 单条先例）。
 */
describe('fetchSessionLinks（GET /api/mem/session-links 批量）', () => {
  it('items 为空 → 直接返回空表，不发请求', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { fetchSessionLinks } = await import('./client')
    const got = await fetchSessionLinks([])
    expect(got).toEqual({})
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('URL 里 root/name 用重复键正确配对（下标对齐，同 server getAll 契约）', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ links: {} }) })
    vi.stubGlobal('fetch', fetchMock)
    const { fetchSessionLinks } = await import('./client')
    await fetchSessionLinks([
      { root: '/repo a', name: 'x' },
      { root: '/repo-b', name: 'y' },
    ])
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined]
    expect(String(url)).toBe('/api/mem/session-links?root=%2Frepo+a&name=x&root=%2Frepo-b&name=y')
    expect((init?.headers as Record<string, string> | undefined)?.Accept).toBe('application/json')
  })

  it('非 2xx → 静默降级为空对象，不抛错', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ ok: false }) }))
    const { fetchSessionLinks } = await import('./client')
    const got = await fetchSessionLinks([{ root: '/repo', name: 'a' }])
    expect(got).toEqual({})
  })

  it('成功 → 透传 server 的 .links', async () => {
    const links = { 'a@/repo': { found: true, platform: 'claude', resumeCmd: 'cd /repo && claude --resume sid' } }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ links }) }))
    const { fetchSessionLinks } = await import('./client')
    const got = await fetchSessionLinks([{ root: '/repo', name: 'a' }])
    expect(got).toEqual(links)
  })

  // ── 客户端分片（codex review P2）：server 端单请求硬上限 50（roots.length > 50 → 400），
  //    此前 fetchSessionLinks 不分片，超限时整批被 400、非 2xx 又被静默吃成 {}，导致全部失败行
  //    （不只是超出上限的那部分）集体退化成静态兜底命令。以下用例锁住「按 50 一批分片、结果合并、
  //    单批失败只影响那一批」的契约——各批之间是顺序发出还是并发发出不属于这几条用例锁的范围，
  //    见后面第八轮 codex review P2 专用的用例。──

  it('items 超过分片阈值（51 个）→ 按 50 一批分两次请求，各批 root/name 对数分别是 50 和 1', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ links: {} }) })
    vi.stubGlobal('fetch', fetchMock)
    const { fetchSessionLinks } = await import('./client')
    const items = Array.from({ length: 51 }, (_, i) => ({ root: '/repo', name: `n${i}` }))
    await fetchSessionLinks(items)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const calls = fetchMock.mock.calls as Array<[string, RequestInit | undefined]>
    const pairCounts = calls.map(([url]) => {
      const sp = new URLSearchParams(String(url).split('?')[1] ?? '')
      return { roots: sp.getAll('root').length, names: sp.getAll('name').length }
    })
    expect(pairCounts).toEqual([
      { roots: 50, names: 50 },
      { roots: 1, names: 1 },
    ])
  })

  it('恰好 50 个（分片阈值本身）→ 只发 1 次请求，不多切一刀', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ links: {} }) })
    vi.stubGlobal('fetch', fetchMock)
    const { fetchSessionLinks } = await import('./client')
    const items = Array.from({ length: 50 }, (_, i) => ({ root: '/repo', name: `n${i}` }))
    await fetchSessionLinks(items)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('两批都成功 → 合并结果同时包含两批各自的 key，互不覆盖', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => ({
        ok: true,
        json: async () => ({ links: { 'a@/repo': { found: true, platform: 'claude', resumeCmd: 'cmd-a' } } }),
      }))
      .mockImplementationOnce(async () => ({
        ok: true,
        json: async () => ({ links: { 'b@/repo': { found: true, platform: 'codex', resumeCmd: 'cmd-b' } } }),
      }))
    vi.stubGlobal('fetch', fetchMock)
    const { fetchSessionLinks } = await import('./client')
    const items = Array.from({ length: 51 }, (_, i) => ({ root: '/repo', name: `n${i}` }))
    const got = await fetchSessionLinks(items)
    expect(got).toEqual({
      'a@/repo': { found: true, platform: 'claude', resumeCmd: 'cmd-a' },
      'b@/repo': { found: true, platform: 'codex', resumeCmd: 'cmd-b' },
    })
  })

  it('其中一批非 2xx → 该批 key 缺席，另一批成功的 key 仍在（局部失败不拖累整体）', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => ({ ok: false, status: 500, json: async () => ({ ok: false }) }))
      .mockImplementationOnce(async () => ({
        ok: true,
        json: async () => ({ links: { 'b@/repo': { found: true, platform: 'codex', resumeCmd: 'cmd-b' } } }),
      }))
    vi.stubGlobal('fetch', fetchMock)
    const { fetchSessionLinks } = await import('./client')
    const items = Array.from({ length: 51 }, (_, i) => ({ root: '/repo', name: `n${i}` }))
    const got = await fetchSessionLinks(items)
    expect(got).toEqual({ 'b@/repo': { found: true, platform: 'codex', resumeCmd: 'cmd-b' } })
  })

  it('其中一批 fetch 网络异常（reject）→ 该批 key 缺席，另一批成功的 key 仍在（网络异常同样不拖累其它批）', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error('network down')
      })
      .mockImplementationOnce(async () => ({
        ok: true,
        json: async () => ({ links: { 'b@/repo': { found: true, platform: 'codex', resumeCmd: 'cmd-b' } } }),
      }))
    vi.stubGlobal('fetch', fetchMock)
    const { fetchSessionLinks } = await import('./client')
    const items = Array.from({ length: 51 }, (_, i) => ({ root: '/repo', name: `n${i}` }))
    const got = await fetchSessionLinks(items)
    expect(got).toEqual({ 'b@/repo': { found: true, platform: 'codex', resumeCmd: 'cmd-b' } })
  })

  // ── 各批顺序发出、不再 Promise.all 并发（第八轮 codex review P2）：server 端
  //    /api/mem/session-links 单次请求内部本身已经对最多 50 个 root/name pair 并发查询（每个 pair
  //    还可能触发多次文件系统/SQLite 扫描）。客户端如果再把多个 chunk 一起 Promise.all 甩出去，会在
  //    单进程 dashboard server 上叠加出成百上千个并发操作，拖慢同进程内其它请求（包括 SSE 心跳）——
  //    于是 fetchSessionLinks 改成逐批 await。以下用例用一个手动控制 resolve 时机的 fetch mock，
  //    直接锁住「后一批的 fetch 必须等前一批的 fetch 真正 resolve 之后才发起」，而不只是「调用顺序
  //    是 1→2→3」——并发实现下调用顺序同样是 1→2→3（chunks.map 本身是同步遍历），但不会等前一批
  //    resolve，这里如果只断言调用顺序会漏过并发这个问题本身。──

  it('items 超过分片阈值（101 个，切 3 片）→ 各批顺序等待发出，不是一次性 Promise.all 并发', async () => {
    let callCount = 0
    let resolvedCount = 0
    const resolvedCountWhenCalled: number[] = []
    let unblockFirst!: () => void
    const firstGate = new Promise<void>((res) => {
      unblockFirst = res
    })
    const fetchMock = vi.fn(async () => {
      callCount += 1
      const isFirstCall = callCount === 1
      resolvedCountWhenCalled.push(resolvedCount) // 这次调用发起时，此前已经有几次调用 resolve 完成
      if (isFirstCall) await firstGate // 卡住第一批，不让它立刻 resolve
      resolvedCount += 1
      return { ok: true, json: async () => ({ links: {} }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    const { fetchSessionLinks } = await import('./client')
    const items = Array.from({ length: 101 }, (_, i) => ({ root: '/repo', name: `n${i}` }))

    const pending = fetchSessionLinks(items)
    // 第一批还卡在 firstGate 上未 resolve 时：顺序实现这时候还没走到第二批的 fetch 调用，只发生过
    // 1 次调用；旧的 Promise.all 并发实现会在 chunks.map(fetchSessionLinksOneChunk) 这个同步阶段
    // 就把 3 批的 fetch 全部发出去，这里会立刻观察到 3 次调用。
    expect(fetchMock).toHaveBeenCalledTimes(1)

    unblockFirst()
    await pending

    expect(fetchMock).toHaveBeenCalledTimes(3)
    // 顺序 await 的直接证据：第 2、3 次调用发起时，此前调用都已经 resolve 完成（resolvedCount 此时
    // 分别已经是 1、2）。并发实现下第一批还没 resolve，第二、三批就已经被同步触发，这里会是
    // [0, 0, 1] 而不是 [0, 1, 2]。
    expect(resolvedCountWhenCalled).toEqual([0, 1, 2])
  })

  // ── 客户端分片字节维度（codex review 第二轮 P2）：上面的分片用例只锁了「条数」维度，但 root 是
  //    绝对路径、每一项都要在查询串里完整重复一次，URLSearchParams 序列化又会把 `/` 编码成 %2F，
  //    条数远没到 50 时单批编码后字节数可能已经先超过 Node --max-http-header-size / 反代请求行长度
  //    上限——纯按条数切片堵不住这个口子，超限请求会被整体拒绝，非 2xx 又被静默吃成 {}，静默丢失
  //    该批全部行的真恢复命令。以下用例锁住「按条数 + 编码后字节数双维度切片」的契约。──

  it('条数远小于 50，但单项 root 编码后很长（累计超字节阈值）→ 按字节数切成多批，且每批查询串长度不超过安全阈值', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ links: {} }) })
    vi.stubGlobal('fetch', fetchMock)
    const { fetchSessionLinks } = await import('./client')
    // 模拟嵌套较深的 monorepo 项目根目录：拼接长路径片段到几百字符，10 项累计编码后远超阈值。
    const deepSegment = '/packages/some-nested-service/src/components/deeply/'
    const items = Array.from({ length: 10 }, (_, i) => ({
      root: `/repo${deepSegment.repeat(10)}-${i}`,
      name: `n${i}`,
    }))
    await fetchSessionLinks(items)
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1)
    // 6000 镜像 client.ts 里的私有常量 SESSION_LINKS_CHUNK_MAX_URL_CHARS——该常量不导出，测试侧
    // 手抄同款数字（同文件其它分片阈值用例的既有写法，如上面「恰好 50 个」用例硬编码 50）。
    const SESSION_LINKS_CHUNK_MAX_URL_CHARS = 6000
    for (const [url] of fetchMock.mock.calls as Array<[string, RequestInit | undefined]>) {
      const queryString = String(url).split('?')[1] ?? ''
      expect(queryString.length).toBeLessThanOrEqual(SESSION_LINKS_CHUNK_MAX_URL_CHARS)
    }
  })

  it('正常短路径场景（fixture root 短字符串）× 50 条 → 仍只发 1 次请求，不被字节维度过度切片', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ links: {} }) })
    vi.stubGlobal('fetch', fetchMock)
    const { fetchSessionLinks } = await import('./client')
    const items = Array.from({ length: 50 }, (_, i) => ({ root: '/repo', name: `n${i}` }))
    await fetchSessionLinks(items)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('单项 root 编码后本身就超过字节阈值（极端超长路径）→ 独占一批，不与相邻正常项合并，不丢数据、不卡死', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ links: {} }) })
    vi.stubGlobal('fetch', fetchMock)
    const { fetchSessionLinks } = await import('./client')
    const items = [
      { root: '/repo', name: 'a' },
      { root: `/repo/${'x'.repeat(10000)}`, name: 'huge' }, // 单项编码后远超阈值的极端路径
      { root: '/repo', name: 'c' },
    ]
    const got = await fetchSessionLinks(items)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const calls = fetchMock.mock.calls as Array<[string, RequestInit | undefined]>
    const pairCounts = calls.map(([url]) => {
      const sp = new URLSearchParams(String(url).split('?')[1] ?? '')
      return { roots: sp.getAll('root').length, names: sp.getAll('name').length }
    })
    expect(pairCounts).toEqual([
      { roots: 1, names: 1 },
      { roots: 1, names: 1 },
      { roots: 1, names: 1 },
    ])
    expect(got).toEqual({})
  })

  // ── 测量方法本身的正确性（codex review 第三轮 P2）：上面两个用例锁住了「按条数+字节数切片」的
  //    契约，但当时的实现用 encodeURIComponent 手算估算字节数，而 fetchSessionLinksOneChunk 实际
  //    拼查询串用的是 URLSearchParams（application/x-www-form-urlencoded 规则）——两者对 `! ' ( ) ~`
  //    这五个字符的转义规则不一样：encodeURIComponent 原样保留（1 字符），URLSearchParams 全部转义
  //    成 %21/%27/%28/%29/%7E（3 字符）。这几个字符在真实文件系统路径里不算罕见（如
  //    "My Project (2024)"、"O'Brien's repo"），一旦命中，手算估算会比真实序列化结果小好几倍，
  //    分片以为留了安全边际，实际发出去的 URL 可能远超阈值，静默丢失整批真恢复命令。以下用例锁住
  //    「用 URLSearchParams 真实序列化测长度，而不是手算估算」的契约。──

  it('root 含 URLSearchParams 会转义但 encodeURIComponent 不转义的字符（! \' ( ) ~）→ 即便手算估算远低于阈值，真实序列化超阈值时仍正确切成多批，且每批真实查询串长度都 ≤ 6000', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ links: {} }) })
    vi.stubGlobal('fetch', fetchMock)
    const { fetchSessionLinks } = await import('./client')
    // 每项 root 塞 100 个单引号 + ()~!：这 20 项累计后，encodeURIComponent 手算估算总长只有 2560
    // 字符（远低于 6000，旧实现会误判整批不用切，只发 1 次请求），但真实 URLSearchParams 序列化后
    // 是 6719 字符——已经超过安全阈值（数值已用脚本对本用例构造分别跑旧/新两版分片逻辑核实过：旧
    // 实现下这条用例会失败，因为单次请求真实查询串长度 6719 > 6000；修复后正确切成 2 批，真实长度
    // 分别是 5708 和 1010，均 ≤ 6000）。
    const items = Array.from({ length: 20 }, (_, i) => ({
      root: `/repo${"'".repeat(100)}()~!-${i}`,
      name: `n${i}`,
    }))
    await fetchSessionLinks(items)
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1)
    const SESSION_LINKS_CHUNK_MAX_URL_CHARS = 6000
    for (const [url] of fetchMock.mock.calls as Array<[string, RequestInit | undefined]>) {
      const queryString = String(url).split('?')[1] ?? ''
      expect(queryString.length).toBeLessThanOrEqual(SESSION_LINKS_CHUNK_MAX_URL_CHARS)
    }
  })
})
