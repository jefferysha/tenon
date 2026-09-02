import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchOrchestrationV2Snapshot, OrchestrationV2ApiError } from './orchestrationV2Client'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('orchestrationV2Client', () => {
  it('preserves the structured not-found code so legacy changes can be treated as unsupported', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      code: 'ORCHESTRATION_V2_CHANGE_NOT_FOUND',
      error: 'not initialized',
    }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })))

    await expect(fetchOrchestrationV2Snapshot('/repo', 'legacy')).rejects.toEqual(
      expect.objectContaining<Partial<OrchestrationV2ApiError>>({
        name: 'OrchestrationV2ApiError',
        status: 404,
        code: 'ORCHESTRATION_V2_CHANGE_NOT_FOUND',
      }),
    )
  })
})
