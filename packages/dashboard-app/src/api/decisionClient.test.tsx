import { describe, expect, it, vi } from 'vitest'
import { DECISION_REF_ID_MAX_LENGTH, fetchPendingDecisions, postReviewAcknowledge, reviewIdempotencyKey } from './decisionClient'

describe('decisionClient', () => {
  it('decodes pending decisions and sends review acknowledge payload', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ schemaVersion: 'pending-decision-view/v1', revision: 7, items: [{ ref: { id: 'decision:1', kind: 'review', change: 'demo', anchor: 'explore:explore-complete', revision: 7 }, type: 'review', status: 'pending', anchor: { phase: 'explore', event: 'explore-complete' }, revision: 7, evidence: ['canonical-review-receipt'], source: 'terminal', channel: 'terminal', command: 'review-acknowledge' }] }), { status: 200 }))
    const view = await fetchPendingDecisions('/repo', 'demo')
    expect(view.items[0]?.ref.id).toBe('decision:1')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, ref: 'decision:1', changed: true, idempotent: false, channel: 'dashboard' }), { status: 200 }))
    await postReviewAcknowledge({ root: '/repo', change: 'demo', ref: 'decision:1', expectedRevision: 7 })
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ method: 'POST', body: JSON.stringify({ root: '/repo', ref: 'decision:1', expected_revision: 7, idempotency_key: reviewIdempotencyKey('decision:1', 7) }) }))
    fetchMock.mockRestore()
  })

  it('derives a stable, charset-safe idempotency key from ref and revision', () => {
    const ref = 'decision:review:demo:verify/verify-pass:2026-09-14T00:00:00Z+sha256=ab?'
    const key = reviewIdempotencyKey(ref, 3)
    expect(key).toBe(reviewIdempotencyKey(ref, 3))
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(reviewIdempotencyKey(ref, 4)).not.toBe(key)
    expect(reviewIdempotencyKey(`${ref}x`, 3)).not.toBe(key)
    expect(reviewIdempotencyKey('复核', 1)).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(reviewIdempotencyKey('a\n1', 2)).not.toBe(reviewIdempotencyKey('a', 12))
    expect(reviewIdempotencyKey('x'.repeat(DECISION_REF_ID_MAX_LENGTH), Number.MAX_SAFE_INTEGER).length).toBeLessThanOrEqual(256)
  })

  it('rejects a pending view whose ref id exceeds the key bound', async () => {
    const item = (id: string) => ({ ref: { id, kind: 'review', change: 'demo', anchor: 'a', revision: 1 }, type: 'review', status: 'pending', anchor: {}, revision: 1, evidence: [], source: 'terminal', channel: 'terminal', command: 'review-acknowledge' })
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ schemaVersion: 'pending-decision-view/v1', revision: 1, items: [item('x'.repeat(DECISION_REF_ID_MAX_LENGTH + 1))] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ schemaVersion: 'pending-decision-view/v1', revision: 1, items: [item('')] }), { status: 200 }))
    await expect(fetchPendingDecisions('/repo', 'demo')).rejects.toThrow()
    await expect(fetchPendingDecisions('/repo', 'demo')).rejects.toThrow()
    fetchMock.mockRestore()
  })
})
