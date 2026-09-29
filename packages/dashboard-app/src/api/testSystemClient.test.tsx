import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './transport'
import {
  fetchSuiteBaselines, fetchTestCatalog, fetchTestPlan, fetchTestRecord, fetchTestRecords,
} from './testSystemClient'
import {
  FIXTURE_CHANGE, FIXTURE_RUN, FIXTURE_USER, baselinesResponse, catalogResponse, planView, recordDetail, recordList,
} from './testSystemFixtures'

afterEach(() => vi.restoreAllMocks())

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function stub(body: unknown, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => respond(body, status))
}

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ApiError) return error
    throw error
  }
  throw new Error('expected rejection')
}

describe('testSystemClient', () => {
  it('目录：请求带 root，响应经严格解码', async () => {
    const spy = stub({ ok: true, ...catalogResponse() })
    const result = await fetchTestCatalog('/repo')
    expect(String(spy.mock.calls[0]?.[0])).toBe('/api/tests/catalog?root=%2Frepo')
    expect(result.catalog.state).toBe('ok')
    expect(result.latest).toHaveLength(2)
  })

  it('基线：请求带 suite；响应里的 suite 与请求不符视为无效', async () => {
    const spy = stub({ ok: true, ...baselinesResponse('api-bench') })
    expect((await fetchSuiteBaselines('/repo', 'api-bench')).baselines[0]?.profileLabel).toBe('darwin-arm64-m3max-node22')
    expect(String(spy.mock.calls[0]?.[0])).toBe('/api/tests/baselines?root=%2Frepo&suite=api-bench')
    stub({ ok: true, ...baselinesResponse('other') })
    expect((await failure(fetchSuiteBaselines('/repo', 'api-bench'))).message).toBe('invalid response')
  })

  it('计划：三种状态原样给出', async () => {
    const spy = stub({ ok: true, plan: planView() })
    expect((await fetchTestPlan('/repo', FIXTURE_CHANGE)).state).toBe('ok')
    expect(String(spy.mock.calls[0]?.[0])).toBe(`/api/tests/plan?root=%2Frepo&change=${FIXTURE_CHANGE}`)
    stub({ ok: true, plan: { state: 'tampered', reason: '摘要不符' } })
    expect(await fetchTestPlan('/repo', FIXTURE_CHANGE)).toEqual({ state: 'tampered', reason: '摘要不符' })
  })

  it('记录列表：可选 suite 过滤进查询', async () => {
    const spy = stub({ ok: true, limit: 50, ...recordList() })
    expect((await fetchTestRecords('/repo', FIXTURE_CHANGE, 'web-e2e')).runs).toHaveLength(1)
    expect(String(spy.mock.calls[0]?.[0])).toBe(`/api/tests/records?root=%2Frepo&change=${FIXTURE_CHANGE}&suite=web-e2e`)
    await fetchTestRecords('/repo', FIXTURE_CHANGE)
    expect(String(spy.mock.calls[1]?.[0])).not.toContain('suite=')
  })

  it('记录明细：返回的 run 或 user 与请求不符视为无效', async () => {
    stub({ ok: true, record: recordDetail() })
    expect((await fetchTestRecord('/repo', FIXTURE_CHANGE, FIXTURE_USER, FIXTURE_RUN)).suites[0]?.suite).toBe('web-e2e')
    expect((await failure(fetchTestRecord('/repo', FIXTURE_CHANGE, FIXTURE_USER, '20260929T000000Z-ffffff'))).message).toBe('invalid response')
    expect((await failure(fetchTestRecord('/repo', FIXTURE_CHANGE, 'someone-at-x.io', FIXTURE_RUN))).message).toBe('invalid response')
  })

  it('HTTP 错误：状态、服务端文案与稳定 code 一并带出', async () => {
    stub({ ok: false, error: '运行记录不存在', code: 'record-not-found' }, 404)
    const error = await failure(fetchTestRecord('/repo', FIXTURE_CHANGE, FIXTURE_USER, FIXTURE_RUN))
    expect(error).toMatchObject({ status: 404, message: '运行记录不存在', hasServerDetail: true, code: 'record-not-found' })
    stub('<html>', 502)
    expect((await failure(fetchTestCatalog('/repo'))).status).toBe(502)
  })

  it('响应形状不合 / ok 缺失 → invalid response；网络失败 → network error；中止原样抛出', async () => {
    stub({ ok: true, catalog: { state: 'odd' }, knownFailures: { state: 'missing' }, latest: [] })
    expect((await failure(fetchTestCatalog('/repo'))).message).toBe('invalid response')
    stub({ catalog: { state: 'missing' } })
    expect((await failure(fetchTestCatalog('/repo'))).message).toBe('invalid response')
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'))
    expect((await failure(fetchTestCatalog('/repo'))).message).toBe('network error')
    const abort = new DOMException('aborted', 'AbortError')
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(abort)
    await expect(fetchTestCatalog('/repo')).rejects.toBe(abort)
  })
})
