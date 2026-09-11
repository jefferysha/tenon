import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchWorkflowIndex } from './governanceClient'

afterEach(() => {
  vi.restoreAllMocks()
})

function respond(body: unknown): void {
  global.fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch
}

describe('fetchWorkflowIndex', () => {
  it.each(['builtin', 'project', 'global'] as const)('接受 default.source = %s', async (source) => {
    respond({ names: ['release'], default: { source } })
    await expect(fetchWorkflowIndex('')).resolves.toEqual({ names: ['release'], defaultSource: source })
  })

  it('旧 server 不带 default 字段时回落 builtin', async () => {
    respond({ names: [] })
    await expect(fetchWorkflowIndex('')).resolves.toEqual({ names: [], defaultSource: 'builtin' })
  })

  it('未知来源仍然拒绝', async () => {
    respond({ names: [], default: { source: 'cloud' } })
    await expect(fetchWorkflowIndex('')).rejects.toThrow()
  })
})
