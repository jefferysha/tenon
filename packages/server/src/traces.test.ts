/**
 * traces.test —— #34d traffic 查看器数据端真 HTTP 端到端（GOAL C9 / A7）。
 * 真起 http server + 真建 @tenon/tap 的 TraceStore（真落盘 sessions/*.json + records/*.jsonl）
 * → 真 node:http GET /api/traces/sessions、/api/traces/records?session=<id> → 断言真捕获数据。零 mock。
 *
 * #34e 护栏延续：traces 只读本地捕获、GET-only、不外发（server 绑 127.0.0.1，响应带 outbound=local-only）。
 * 本测试真用 tap 的 TraceStore（源零 outbound，见 tap/security.test），server 只投影本地结果。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDashboardServer } from './test-server.js'
import { resolveServerPaths } from './paths.js'
import type { DashboardServer } from './types.js'
import { projectTraceTimeline, type TraceStoreReader, type TraceTimelineStoreReader } from './traces.js'
import { makeProject, makeTempHome, newStore, initChange, reqGet, reqPost, testFlow } from './test-support.js'
// tap 是 workspace 包（root node_modules 符号链接）——测试文件不入 tsc build，可直接 import 真 API。
import { createTraceStore } from '@tenon/tap'

const openServers: DashboardServer[] = []
afterEach(async () => {
  while (openServers.length) await openServers.pop()!.close()
})

/** 真建一个 tap TraceStore（临时目录），落两条真 session + 记录。返回 store + 会话 id。 */
async function seedTraceStore(): Promise<{ dir: string; store: ReturnType<typeof createTraceStore>; s1: string; s2: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'pl-traces-'))
  const store = createTraceStore({ dir })
  const s1 = store.createSession({ client: 'claude', proxyMode: 'reverse', startedAt: new Date('2026-07-07T00:00:00Z') })
  store.appendRecord(s1, { timestamp: '2026-07-07T00:00:01Z', request_id: 'req-1', turn: 1, request: { path: '/v1/messages' }, response: { status: 200 } })
  store.appendRecord(s1, { timestamp: '2026-07-07T00:00:02Z', request_id: 'req-2', turn: 2, request: { path: '/v1/messages' }, response: { status: 200 } })
  store.finalizeSession(s1, { api_calls: 2 })
  const s2 = store.createSession({ client: 'codex', proxyMode: 'forward', startedAt: new Date('2026-07-07T01:00:00Z') })
  store.appendRecord(s2, { timestamp: '2026-07-07T01:00:01Z', request_id: 'req-3', turn: 1 })
  return { dir, store, s1, s2 }
}

async function startServer(traceStore?: TraceStoreReader): Promise<{ srv: DashboardServer; port: number; root: string }> {
  const store = newStore()
  const root = await makeProject()
  await initChange(store, root, 'demo')
  const srv = createTestDashboardServer({
    paths: resolveServerPaths({ home: await makeTempHome(), env: {} }),
    version: '9.9.9', token: 't', registry: () => [root], store, flow: testFlow(),
    clock: () => '2026-07-07T00:00:00Z', traceStore,
  })
  openServers.push(srv)
  const { port } = await srv.listen(0, '127.0.0.1')
  return { srv, port, root }
}

describe('#34d capabilities.traffic —— 注入 traceStore 才报 true（未装则占位）', () => {
  it('注入 traceStore → capabilities.traffic = true', async () => {
    const seeded = await seedTraceStore()
    const { port } = await startServer(seeded.store)
    const s = (await reqGet(port, '/api/snapshot')).json<any>()
    expect(s.capabilities.traffic).toBe(true)
  })

  it('未注入 traceStore → capabilities.traffic = false（不谎报），端点 404', async () => {
    const { port } = await startServer(undefined)
    const s = (await reqGet(port, '/api/snapshot')).json<any>()
    expect(s.capabilities.traffic).toBe(false)
    const r = await reqGet(port, '/api/traces/sessions')
    expect(r.status).toBe(404)
  })

  it('旧 records-only adapter 保留旧端点，但不宣称新 timeline capability', async () => {
    const legacyStore: TraceStoreReader = {
      listSessions: () => [],
      readRecords: () => [],
    }
    const { port } = await startServer(legacyStore)
    const snapshot = (await reqGet(port, '/api/snapshot')).json<any>()
    expect(snapshot.capabilities.traffic).toBe(false)
    expect((await reqGet(port, '/api/traces/sessions')).status).toBe(200)
    expect((await reqGet(port, '/api/traces/timeline?session=legacy')).status).toBe(404)
  })
})

describe('GET /api/traces/timeline —— 有界 metadata-only 投影', () => {
  it('只返回白名单元数据，并归一化 outcome、实际 usage、query 与 stream count', async () => {
    const seeded = await seedTraceStore()
    const session = seeded.store.createSession({ client: 'claude', proxyMode: 'reverse' })
    seeded.store.appendRecord(session, {
      timestamp: '2026-07-07T02:00:01Z',
      request_id: 'request-sensitive-safe-id',
      turn: 1,
      duration_ms: 25,
      transport: 'reverse',
      upstream_base_url: 'https://sentinel-upstream.example',
      unknown_extension: { sentinel_unknown: 'sentinel-private-value' },
      request: {
        method: 'POST',
        path: 'https://sentinel-user:sentinel-password@sentinel-authority.example/v1/messages?token=sentinel-query-value',
        headers: { authorization: 'sentinel-header-value' },
        body: {
          model: 'claude-sonnet-4',
          messages: [{ content: 'sentinel-prompt-value' }],
          tools: [{ input: 'sentinel-tool-value' }],
        },
      },
      response: {
        status: 200,
        headers: { 'x-private': 'sentinel-response-header' },
        body: {
          usage: { input_tokens: 0, output_tokens: 8, cache_read_input_tokens: 3 },
          output: 'sentinel-response-value',
        },
        sse_events: [{ type: 'message_start' }, { type: 'message_stop' }],
      },
    })
    seeded.store.appendRecord(session, {
      turn: 2,
      duration_ms: 5,
      request: { method: 'POST', path: '/v1/responses', body: { model: 'gpt-5' } },
      response: {
        status: 429,
        body: {
          usage: {
            prompt_tokens: 10,
            completion_tokens: 2,
            prompt_tokens_details: { cached_tokens: 4 },
          },
        },
      },
    })
    seeded.store.appendRecord(session, { turn: 3, request: { path: '/v1/messages' }, response: {} })

    const { port } = await startServer(seeded.store)
    const r = await reqGet(port, `/api/traces/timeline?session=${encodeURIComponent(session)}`)

    expect(r.status).toBe(200)
    const body = r.json<any>()
    expect(body.outbound).toBe('local-only')
    expect(body.content).toBe('metadata-only')
    expect(body.entries).toHaveLength(3)
    expect(body.entries[0]).toEqual({
      sequence: 1,
      request_id: 'request-sensitive-safe-id',
      turn: 1,
      timestamp: '2026-07-07T02:00:01Z',
      duration_ms: 25,
      transport: 'reverse',
      method: 'POST',
      path: '/v1/messages',
      status_code: 200,
      outcome: 'success',
      model: 'claude-sonnet-4',
      input_tokens: 0,
      output_tokens: 8,
      cached_input_tokens: 3,
      stream_event_count: 2,
    })
    expect(body.entries[1]).toMatchObject({
      sequence: 2,
      status_code: 429,
      outcome: 'error',
      input_tokens: 10,
      output_tokens: 2,
      cached_input_tokens: 4,
    })
    expect(body.entries[2]).toMatchObject({
      sequence: 3,
      status_code: null,
      outcome: 'unknown',
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      stream_event_count: null,
    })
    expect(body.summary).toEqual({
      success_count: 1,
      error_count: 1,
      unknown_count: 1,
      total_duration_ms: 30,
      input_tokens: 10,
      output_tokens: 10,
      cached_input_tokens: 7,
    })
    expect(Object.keys(body).sort()).toEqual([
      'content', 'entries', 'generated_at', 'integrity', 'outbound', 'returned_count',
      'session', 'skipped_count', 'summary', 'total_count', 'truncated', 'warnings',
    ])
    const serialized = JSON.stringify(body)
    for (const sentinel of [
      'sentinel-upstream', 'sentinel_unknown', 'sentinel-private-value', 'sentinel-query-value',
      'sentinel-user', 'sentinel-password', 'sentinel-authority',
      'sentinel-header-value', 'sentinel-prompt-value', 'sentinel-tool-value',
      'sentinel-response-header', 'sentinel-response-value',
    ]) {
      expect(serialized).not.toContain(sentinel)
    }
  })

  it('缺失、未知、已知空与 reader 失败分别返回 400/404/200/500', async () => {
    const seeded = await seedTraceStore()
    const empty = seeded.store.createSession({ client: 'codex', proxyMode: 'forward' })
    const { port } = await startServer(seeded.store)

    expect((await reqGet(port, '/api/traces/timeline')).status).toBe(400)
    expect((await reqGet(port, '/api/traces/timeline?session=missing')).status).toBe(404)
    const emptyResponse = await reqGet(port, `/api/traces/timeline?session=${encodeURIComponent(empty)}`)
    expect(emptyResponse.status).toBe(200)
    expect(emptyResponse.json<any>()).toMatchObject({
      total_count: 0,
      returned_count: 0,
      entries: [],
      integrity: 'complete',
    })

    const sensitivePath = '/Users/example/.local/share/tenon-tap/records/private.jsonl'
    const throwingStore: TraceTimelineStoreReader = {
      listSessions: () => seeded.store.listSessions(),
      loadSessionRow: (id) => seeded.store.loadSessionRow(id),
      readRecords: (id) => seeded.store.readRecords(id),
      readRecordWindow: () => { throw new Error(`window exploded at ${sensitivePath}`) },
    }
    const failed = await startServer(throwingStore)
    const errorResponse = await reqGet(failed.port, `/api/traces/timeline?session=${encodeURIComponent(seeded.s1)}`)
    expect(errorResponse.status).toBe(500)
    expect(errorResponse.json<any>().error).toBe('trace timeline 暂时不可用')
    expect(JSON.stringify(errorResponse.json<any>())).not.toContain(sensitivePath)
  })

  it('旧 records API 保持原响应兼容', async () => {
    const seeded = await seedTraceStore()
    const { port } = await startServer(seeded.store)

    const r = await reqGet(port, `/api/traces/records?session=${encodeURIComponent(seeded.s1)}`)

    expect(r.status).toBe(200)
    expect(r.json<any>().records.map((record: any) => record.request_id)).toEqual(['req-1', 'req-2'])
  })

  it('非法或超限 provider 字段保持 null，汇总只使用实际值并安全饱和', () => {
    const row = {
      id: 'session',
      started_at: '2026-07-07T00:00:00Z',
      updated_at: '2026-07-07T00:00:01Z',
      date_key: '2026-07-07',
      client: 'codex',
      proxy_mode: 'forward',
      status: 'complete',
      record_count: 2,
      summary: null,
    }
    const body = projectTraceTimeline(row, {
      total_count: 2,
      returned_count: 2,
      skipped_count: 0,
      truncated: false,
      integrity: 'complete',
      warnings: [],
      records: [
        {
          duration_ms: Number.MAX_SAFE_INTEGER,
          request: { path: `/v1/responses?${'q'.repeat(5000)}`, body: { model: 'm'.repeat(257) } },
          response: { status: 600, body: { usage: { input_tokens: -1, output_tokens: Number.MAX_SAFE_INTEGER } } },
        },
        {
          duration_ms: 1,
          request: { path: '/v1/responses' },
          response: { status: '200', body: { usage: { output_tokens: 1 } } },
        },
      ],
    }, () => '2026-07-07T00:00:00Z')

    expect(body.entries[0]).toMatchObject({
      path: '/v1/responses',
      model: null,
      status_code: null,
      outcome: 'unknown',
      input_tokens: null,
      output_tokens: Number.MAX_SAFE_INTEGER,
    })
    expect(body.entries[1]).toMatchObject({ status_code: null, outcome: 'unknown' })
    expect(body.summary).toMatchObject({
      total_duration_ms: Number.MAX_SAFE_INTEGER,
      input_tokens: null,
      output_tokens: Number.MAX_SAFE_INTEGER,
      unknown_count: 2,
    })
  })
})

describe('GET /api/traces/sessions —— TraceStore.listSessions 真投影', () => {
  it('返回真落盘的两条 session（含 client/record_count/status）', async () => {
    const seeded = await seedTraceStore()
    const { port } = await startServer(seeded.store)
    const r = await reqGet(port, '/api/traces/sessions')
    expect(r.status).toBe(200)
    const body = r.json<any>()
    expect(body.outbound).toBe('local-only')
    expect(body.count).toBe(2)
    const byId = new Map(body.sessions.map((s: any) => [s.id, s]))
    expect(byId.get(seeded.s1).client).toBe('claude')
    expect(byId.get(seeded.s1).record_count).toBe(2)
    expect(byId.get(seeded.s1).status).toBe('complete')
    expect(byId.get(seeded.s2).client).toBe('codex')
  })
})

describe('GET /api/traces/records?session=<id> —— TraceStore.readRecords 真投影', () => {
  it('返回该 session 的两条真记录（保序 + 字段完好）', async () => {
    const seeded = await seedTraceStore()
    const { port } = await startServer(seeded.store)
    const r = await reqGet(port, `/api/traces/records?session=${encodeURIComponent(seeded.s1)}`)
    expect(r.status).toBe(200)
    const body = r.json<any>()
    expect(body.outbound).toBe('local-only')
    expect(body.session).toBe(seeded.s1)
    expect(body.count).toBe(2)
    expect(body.records.map((x: any) => x.request_id)).toEqual(['req-1', 'req-2'])
    expect(body.records[0].response.status).toBe(200)
  })

  it('缺 session 参数 → 400', async () => {
    const seeded = await seedTraceStore()
    const { port } = await startServer(seeded.store)
    const r = await reqGet(port, '/api/traces/records')
    expect(r.status).toBe(400)
  })

  it('未知 session → 200 空记录（readRecords 容错，不泄露它源）', async () => {
    const seeded = await seedTraceStore()
    const { port } = await startServer(seeded.store)
    const r = await reqGet(port, '/api/traces/records?session=does-not-exist')
    expect(r.status).toBe(200)
    expect(r.json<any>().count).toBe(0)
  })
})

describe('#34e 护栏 —— traces 只读、不外发', () => {
  it('traces 端点仅 GET；POST /api/traces/sessions 非写回路由（404/405 之类非 200）', async () => {
    const seeded = await seedTraceStore()
    const { port, root } = await startServer(seeded.store)
    const r = await reqPost(port, '/api/traces/sessions', { root }, {
      headers: { Authorization: 'Bearer t' },
    })
    expect(r.status).not.toBe(200)
  })

  it('timeline 端点同样只允许 GET', async () => {
    const seeded = await seedTraceStore()
    const { port, root } = await startServer(seeded.store)
    const r = await reqPost(port, `/api/traces/timeline?session=${encodeURIComponent(seeded.s1)}`, { root }, {
      headers: { Authorization: 'Bearer t' },
    })
    expect(r.status).not.toBe(200)
  })
})
