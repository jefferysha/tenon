import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveArtifactRoute } from './serverArtifactRoutes.js'

const version = { artifactId: 'artifact:x', version: 'v1', contentDigest: 'a'.repeat(64), size: 3, mediaType: 'text/plain', kind: 'text', origin: 'stage', contentUri: 'artifact://x/a', disposition: 'deliverable', quality: 'unchecked', createdAt: '2026-01-01T00:00:00Z' }
function req(url: string): any { return { url } }
function deps() {
  const sendJson = vi.fn()
  const service: any = { catalog: vi.fn(async () => ({ revision: 1, digest: 'd', stageAttemptId: 'attempt-1', entries: [version] })), inspect: vi.fn(async () => ({ version })), read: vi.fn(async () => ({ version, bytes: new Uint8Array([65, 66]) })), events: vi.fn(async () => []) }
  return { sendJson, service, workflowRootForRequest: () => ({ ok: true, anchor: { path: '/tmp/root' } as any }) }
}
describe('runtime artifact GET routes', () => {
  it('returns scoped catalog and clamps policy', async () => { const d = deps(); await resolveArtifactRoute(req('/api/artifacts/catalog?root=%2Ftmp%2Froot&stageAttemptId=attempt-1&maxEntries=9999'), {} as any, '/api/artifacts/catalog', d); expect(d.sendJson).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({ ok: true })); expect(d.service.catalog).toHaveBeenCalledWith('attempt-1', expect.objectContaining({ maxEntries: 256 })) })
  it('UI content read does not create execution receipt', async () => { const d = deps(); await resolveArtifactRoute(req('/api/artifacts/read?root=%2Ftmp%2Froot&stageAttemptId=attempt-1&artifactId=artifact:x&version=v1'), {} as any, '/api/artifacts/read', d); expect(d.service.read).toHaveBeenCalledWith('attempt-1', 'artifact:x', 'v1', expect.objectContaining({ consumer: 'ui' })) })
  it('rejects missing root and unsafe identifiers', async () => { const d = deps(); await resolveArtifactRoute(req('/api/artifacts/catalog?stageAttemptId=attempt-1'), {} as any, '/api/artifacts/catalog', d); expect(d.sendJson).toHaveBeenCalledWith(expect.anything(), 400, expect.anything()); const d2 = deps(); await resolveArtifactRoute(req('/api/artifacts/read?root=x&stageAttemptId=../../x&artifactId=a&version=v1'), {} as any, '/api/artifacts/read', d2); expect(d2.sendJson).toHaveBeenCalledWith(expect.anything(), 400, expect.anything()) })
  it('serves the bounded change-local subject registry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-subject-route-'))
    try {
      await writeFile(join(root, '.pipeline-artifact-subjects.json'), JSON.stringify({ version: 1, records: [{ logicalKey: 'design', projection: 'document', status: 'committed', receiptId: 'r1', recordedAt: '2026-01-01T00:00:00Z', subjectRef: { subject_id: 'subject:scope:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', namespace: 'scope', version: 'v1', projection: 'document', content_digest: `sha256:${'a'.repeat(64)}` } }] }))
      const d = deps(); d.workflowRootForRequest = () => ({ ok: true, anchor: { path: root } as any })
      await resolveArtifactRoute(req(`/api/artifacts/subjects?root=${encodeURIComponent(root)}`), {} as any, '/api/artifacts/subjects', d)
      expect(d.sendJson).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({ ok: true }))
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('bounds event replay for reconnecting clients', async () => {
    const d = deps(); d.service.events = vi.fn(async () => Array.from({ length: 20 }, (_, index) => ({ seq: index + 1, idempotencyKey: `e:${index + 1}`, type: 'artifact.observed', at: '2026-01-01T00:00:00Z' })))
    await resolveArtifactRoute(req('/api/artifacts/events?root=%2Ftmp%2Froot&after=3&limit=4'), {} as any, '/api/artifacts/events', d)
    expect(d.service.events).toHaveBeenCalledWith(3, 4)
    expect(d.sendJson).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({ events: expect.arrayContaining([expect.objectContaining({ seq: 4 })]) }))
    const body = d.sendJson.mock.calls.at(-1)?.[2] as { events: readonly unknown[] }
    expect(body.events).toHaveLength(4)
  })
})
