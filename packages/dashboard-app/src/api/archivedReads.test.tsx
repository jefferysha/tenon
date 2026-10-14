/** 已结束任务的只读详情：编排与记录的读取和快照一样带 `archived=1`，活跃任务的请求不变。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getHistory } from './governanceClient'
import { fetchChangeOrchestration } from './workflowOrchestrationClient'

afterEach(() => vi.restoreAllMocks())

function stubFetch(body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(body), { status: 200 }))
}

const urlsOf = (spy: ReturnType<typeof stubFetch>): string[] => spy.mock.calls.map(([input]) => String(input))

describe('getHistory', () => {
  it('活跃任务：不带 archived', async () => {
    const spy = stubFetch({ entries: [] })
    await getHistory('demo', '/repo')
    expect(urlsOf(spy)).toEqual(['/api/change/demo/history?root=%2Frepo'])
  })

  it('已结束任务：按归档目录名读，带 archived=1', async () => {
    const spy = stubFetch({ entries: [] })
    await getHistory('2026-10-11-demo', '/repo', true)
    expect(urlsOf(spy)).toEqual(['/api/change/2026-10-11-demo/history?root=%2Frepo&archived=1'])
  })
})

describe('fetchChangeOrchestration', () => {
  it('活跃任务：不带 archived', async () => {
    const spy = stubFetch({})
    await expect(fetchChangeOrchestration('demo', '/repo')).rejects.toBeDefined()
    expect(urlsOf(spy)).toEqual(['/api/change/demo/orchestration?root=%2Frepo'])
  })

  it('已结束任务：按归档目录名读，带 archived=1', async () => {
    const spy = stubFetch({})
    await expect(fetchChangeOrchestration('2026-10-11-demo', '/repo', undefined, true)).rejects.toBeDefined()
    expect(urlsOf(spy)).toEqual(['/api/change/2026-10-11-demo/orchestration?root=%2Frepo&archived=1'])
  })
})
