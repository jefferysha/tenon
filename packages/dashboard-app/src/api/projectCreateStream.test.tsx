import { afterEach, describe, expect, it, vi } from 'vitest'
import { chooseFolder, decodeFolderListing, decodeFolderPick, listFolders } from './fsClient'
import { InstructionApiError } from './instructionsClient'
import { decodeCreateFrame, streamProjectCreate, type CreateStreamEvent } from './projectCreateStream'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function chunked(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

const INPUT = { mode: 'existing', path: '/code/a', instructions: null } as const

describe('streamProjectCreate', () => {
  it('帧跨块切开也能按序解析；带 token 与 JSON 请求体', async () => {
    const whole = 'event: plan\ndata: {"steps":["register"]}\n\nevent: step\ndata: {"id":"register","state":"running"}\n\n'
      + 'event: step\ndata: {"id":"register","state":"done"}\n\n'
      + 'event: done\ndata: {"ok":true,"root":"/code/a","git":"none","registration":"add","directories":[],"files":[]}\n\n'
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, body: chunked([whole.slice(0, 17), whole.slice(17, 90), whole.slice(90)]) }))
    vi.stubGlobal('fetch', fetchMock)
    ;(window as unknown as { __TENON_DASHBOARD_TOKEN__?: string }).__TENON_DASHBOARD_TOKEN__ = 'tok'
    const events: CreateStreamEvent[] = []
    await streamProjectCreate(INPUT, (event) => events.push(event))
    expect(events.map((event) => event.type)).toEqual(['plan', 'step', 'step', 'done'])
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.headers).toMatchObject({ Authorization: 'Bearer tok', 'Content-Type': 'application/json' })
    expect(JSON.parse(String(init.body))).toEqual(INPUT)
  })

  it('流在 done / failed 之前断开 → 抛错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, body: chunked(['event: plan\ndata: {"steps":[]}\n\n']) })))
    await expect(streamProjectCreate(INPUT, () => undefined)).rejects.toThrow('进度流中断')
  })

  it('执行前的 JSON 错误 → InstructionApiError 带 code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 412, json: async () => ({ ok: false, code: 'user-missing', error: 'x' }) })))
    await expect(streamProjectCreate(INPUT, () => undefined)).rejects.toMatchObject({ code: 'user-missing', status: 412 })
  })

  it('decodeCreateFrame：未知事件与坏 JSON 忽略；failed 带 code', () => {
    expect(decodeCreateFrame('event: other\ndata: {}')).toBeNull()
    expect(decodeCreateFrame('event: step\ndata: {oops')).toBeNull()
    expect(decodeCreateFrame('event: step\ndata: {"id":"git","state":"weird"}')).toBeNull()
    expect(decodeCreateFrame('event: step\ndata: {"id":"git","state":"failed","error":"boom"}')).toEqual({ type: 'step', id: 'git', state: 'failed', error: 'boom' })
    expect(decodeCreateFrame('event: failed\ndata: {"ok":false,"code":"project-create-failed","error":"x","step":"git-init"}'))
      .toEqual({ type: 'failed', code: 'project-create-failed', error: 'x', step: 'git-init' })
  })
})

describe('fsClient', () => {
  it('decodeFolderPick 三种答复；其他形状为 null', () => {
    expect(decodeFolderPick({ ok: true, path: '/a' })).toEqual({ kind: 'picked', path: '/a' })
    expect(decodeFolderPick({ ok: false, cancelled: true })).toEqual({ kind: 'cancelled' })
    expect(decodeFolderPick({ ok: false, unavailable: true })).toEqual({ kind: 'unavailable' })
    expect(decodeFolderPick({ ok: true })).toBeNull()
  })

  it('decodeFolderListing 校验条目形状', () => {
    expect(decodeFolderListing({ ok: true, dir: '/a', parent: null, home: '/h', entries: [{ name: 'b', path: '/a/b' }], truncated: false }))
      .toEqual({ dir: '/a', parent: null, home: '/h', entries: [{ name: 'b', path: '/a/b' }], truncated: false })
    expect(decodeFolderListing({ ok: true, dir: '/a', parent: null, home: '/h', entries: [{ name: 1 }], truncated: false })).toBeNull()
  })

  it('chooseFolder 带起始目录；409 picker-busy 抛 InstructionApiError', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, path: '/code' }) }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await chooseFolder('Pick', '/start')).toEqual({ kind: 'picked', path: '/code' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ title: 'Pick', start_dir: '/start' })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ ok: false, code: 'picker-busy', error: 'x' }) })))
    const error = await chooseFolder('Pick', null).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(InstructionApiError)
    expect(error).toMatchObject({ code: 'picker-busy' })
  })

  it('listFolders 带 hidden 与 token', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, dir: '/a', parent: '/', home: '/h', entries: [], truncated: false }) }))
    vi.stubGlobal('fetch', fetchMock)
    ;(window as unknown as { __TENON_DASHBOARD_TOKEN__?: string }).__TENON_DASHBOARD_TOKEN__ = 'tok'
    await listFolders('/a', true)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/fs/list?dir=%2Fa&hidden=1')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer tok' })
  })
})
