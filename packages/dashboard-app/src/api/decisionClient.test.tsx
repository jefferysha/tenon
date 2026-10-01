import { describe, expect, it, vi } from 'vitest'
import { DECISION_REF_ID_MAX_LENGTH, fetchPendingDecisions, postReviewAcknowledge, PRESENCE_HEADER, reviewIdempotencyKey } from './decisionClient'

const presence = (nonce = 'nonce-1') => new Response(JSON.stringify({ ok: true, nonce, expires_in_ms: 30000 }), { status: 200 })

describe('decisionClient', () => {
  it('decodes pending decisions and sends review acknowledge payload', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ schemaVersion: 'pending-decision-view/v1', revision: 7, items: [{ ref: { id: 'decision:1', kind: 'review', change: 'demo', anchor: 'explore:explore-complete', revision: 7 }, type: 'review', status: 'pending', anchor: { phase: 'explore', event: 'explore-complete' }, revision: 7, evidence: ['canonical-review-receipt'], source: 'terminal', channel: 'terminal', command: 'review-acknowledge' }] }), { status: 200 }))
    const view = await fetchPendingDecisions('/repo', 'demo')
    expect(view.items[0]?.ref.id).toBe('decision:1')
    fetchMock
      .mockResolvedValueOnce(presence('nonce-7'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, ref: 'decision:1', changed: true, idempotent: false, channel: 'dashboard' }), { status: 200 }))
    await postReviewAcknowledge({ root: '/repo', change: 'demo', ref: 'decision:1', expectedRevision: 7 })
    // Proof of presence first, bound to this exact review; the approval then carries the nonce it got.
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/change/demo/decisions/presence')
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ method: 'POST', body: JSON.stringify({ root: '/repo', ref: 'decision:1', expected_revision: 7 }) }))
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/change/demo/decisions')
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(expect.objectContaining({ method: 'POST', body: JSON.stringify({ root: '/repo', ref: 'decision:1', expected_revision: 7, idempotency_key: reviewIdempotencyKey('decision:1', 7) }) }))
    expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get(PRESENCE_HEADER)).toBe('nonce-7')
    fetchMock.mockRestore()
  })

  it('never posts the approval when no presence nonce could be obtained', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, code: 'session-required', error: 'x' }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const input = { root: '/repo', change: 'demo', ref: 'decision:1', expectedRevision: 1 }
    await expect(postReviewAcknowledge(input)).rejects.toMatchObject({ status: 401, code: 'session-required' })
    await expect(postReviewAcknowledge(input)).rejects.toThrow() // a nonce-less 200 is not a nonce
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.every((call) => String(call[0]).endsWith('/decisions/presence'))).toBe(true)
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

  it('decodes the frozen waivers and the approval outcome; absent means none, malformed rejects', async () => {
    const item = { ref: { id: 'decision:1', kind: 'review', change: 'demo', anchor: 'a', revision: 1 }, type: 'review', status: 'pending', anchor: {}, revision: 1, evidence: [], source: 'terminal', channel: 'terminal', command: 'review-acknowledge' }
    const body = (waivers?: unknown) => new Response(JSON.stringify({ schemaVersion: 'pending-decision-view/v1', revision: 1, items: [item], ...(waivers === undefined ? {} : { waivers }) }), { status: 200 })
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(body([{ key: 'kind:unit', reason: '纯文档改动' }]))
      .mockResolvedValueOnce(body())
      .mockResolvedValueOnce(body([{ key: 'kind:unit' }]))
      .mockResolvedValueOnce(body('kind:unit'))
    expect((await fetchPendingDecisions('/repo', 'demo')).waivers).toEqual([{ key: 'kind:unit', reason: '纯文档改动' }])
    expect((await fetchPendingDecisions('/repo', 'demo')).waivers).toEqual([])
    await expect(fetchPendingDecisions('/repo', 'demo')).rejects.toThrow()
    await expect(fetchPendingDecisions('/repo', 'demo')).rejects.toThrow()

    const ack = (waivers?: unknown) => new Response(JSON.stringify({ ok: true, ref: 'decision:1', changed: true, idempotent: false, channel: 'dashboard', ...(waivers === undefined ? {} : { waivers }) }), { status: 200 })
    fetchMock
      .mockResolvedValueOnce(presence())
      .mockResolvedValueOnce(ack({ approved: ['kind:unit'], skipped: [{ key: 'kind:lint', why: 'reason-changed' }] }))
      .mockResolvedValueOnce(presence())
      .mockResolvedValueOnce(ack())
      .mockResolvedValueOnce(presence())
      .mockResolvedValueOnce(ack({ approved: ['kind:unit'], skipped: [{ key: 'kind:lint', why: 'nope' }] }))
    const input = { root: '/repo', change: 'demo', ref: 'decision:1', expectedRevision: 1 }
    expect((await postReviewAcknowledge(input)).waivers).toEqual({ approved: ['kind:unit'], skipped: [{ key: 'kind:lint', why: 'reason-changed' }] })
    expect((await postReviewAcknowledge(input)).waivers).toEqual({ approved: [], skipped: [] })
    await expect(postReviewAcknowledge(input)).rejects.toThrow()
    fetchMock.mockRestore()
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
