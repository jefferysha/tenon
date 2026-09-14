import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ArtifactCatalog } from '@tenon/kernel'
import { describe, expect, it } from 'vitest'
import { resolveArtifactRoute, type ArtifactRouteDeps, type ArtifactService } from './serverArtifactRoutes.js'
import type { WorkflowRootAnchor } from './workflowRootAnchor.js'

const ROOT = '/projects/demo'
const anchor = { path: ROOT, realPath: ROOT, fd: -1 } as unknown as WorkflowRootAnchor

function harness(attempts: readonly { stageId: string; stageAttemptId: string; startedAt: string }[]) {
  const catalogCalls: string[] = []
  const service: ArtifactService = {
    catalog: async (id) => {
      catalogCalls.push(id)
      return { revision: 3, digest: 'sha256:abc', stageAttemptId: id, entries: [] } as unknown as ArtifactCatalog
    },
    inspect: async () => { throw new Error('unused') },
    read: async () => { throw new Error('unused') },
    events: async () => [],
    attempts: async (stageId) => attempts.filter((row) => row.stageId === stageId),
  }
  const sent: { status: number; body: unknown }[] = []
  const deps: ArtifactRouteDeps = {
    service,
    workflowRootForRequest: () => ({ ok: true, anchor }),
    sendJson: (_res, status, body) => { sent.push({ status, body }) },
  }
  const request = async (query: string) => {
    const handled = await resolveArtifactRoute(
      { url: `/api/artifacts/catalog?root=${encodeURIComponent(ROOT)}${query}` } as IncomingMessage,
      {} as ServerResponse,
      '/api/artifacts/catalog',
      deps,
    )
    expect(handled).toBe(true)
    return sent.at(-1)
  }
  return { request, catalogCalls }
}

describe('artifact catalog route', () => {
  it('answers an empty catalog for a valid stage that never ran on the artifact runtime', async () => {
    const { request, catalogCalls } = harness([])
    await expect(request('&stageId=stage-1&includeHistory=true')).resolves.toEqual({
      status: 200,
      body: { ok: true, catalog: { revision: 0, digest: '', stageAttemptId: '', entries: [] } },
    })
    expect(catalogCalls).toEqual([])
  })

  it('serves the latest attempt of a stage that has runs', async () => {
    const { request, catalogCalls } = harness([
      { stageId: 'build', stageAttemptId: 'attempt-old', startedAt: '2026-09-15T00:00:00Z' },
      { stageId: 'build', stageAttemptId: 'attempt-new', startedAt: '2026-09-15T01:00:00Z' },
    ])
    const response = await request('&stageId=build')
    expect(response?.status).toBe(200)
    expect(catalogCalls).toEqual(['attempt-new'])
  })

  it('still rejects a request without a valid stage or attempt id', async () => {
    const { request, catalogCalls } = harness([])
    await expect(request('')).resolves.toMatchObject({ status: 400 })
    await expect(request(`&stageId=${encodeURIComponent('bad id!')}`)).resolves.toMatchObject({ status: 400 })
    expect(catalogCalls).toEqual([])
  })
})
