import { describe, expect, it, vi } from 'vitest'
import { fetchPendingDecisions, postReviewAcknowledge } from './decisionClient'

describe('decisionClient', () => {
  it('decodes pending decisions and sends review acknowledge payload', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ schemaVersion: 'pending-decision-view/v1', revision: 7, items: [{ ref: { id: 'decision:1', kind: 'review', change: 'demo', anchor: 'explore:explore-complete', revision: 7 }, type: 'review', status: 'pending', anchor: { phase: 'explore', event: 'explore-complete' }, revision: 7, evidence: ['canonical-review-receipt'], source: 'terminal', channel: 'terminal', command: 'review-acknowledge' }] }), { status: 200 }))
    const view = await fetchPendingDecisions('/repo', 'demo')
    expect(view.items[0]?.ref.id).toBe('decision:1')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, ref: 'decision:1', changed: true, idempotent: false, channel: 'dashboard' }), { status: 200 }))
    await postReviewAcknowledge({ root: '/repo', change: 'demo', ref: 'decision:1', expectedRevision: 7, idempotencyKey: 'k1' })
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ method: 'POST', body: JSON.stringify({ root: '/repo', ref: 'decision:1', expected_revision: 7, idempotency_key: 'k1' }) }))
    fetchMock.mockRestore()
  })
})
