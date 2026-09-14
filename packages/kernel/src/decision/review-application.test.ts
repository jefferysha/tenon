import { describe, expect, it } from 'vitest'
import { emptyFields, type PipelineState } from '../index.js'
import { acknowledgeReview, executeReviewAcknowledgeCommand } from './review-application.js'

function state(status: 'pending' | 'approved' = 'pending'): PipelineState {
  return {
    fields: {
      ...emptyFields(),
      phase: 'verify',
      review_gate_phase: 'verify',
      review_gate_event: 'verify-pass',
      review_gate_status: status,
      review_requested_at: '2026-09-13T00:00:00Z',
    },
    opaqueTail: '',
  }
}

describe('review acknowledge application', () => {
  it('keeps canonical approval while reporting missing projection ports as deferred', async () => {
    let patch: Record<string, string> | undefined
    const result = await acknowledgeReview({
      state: state(), phase: 'verify', event: 'verify-pass', acknowledgedAt: '2026-09-13T00:01:00Z',
      via: 'dashboard', bindingMatches: true,
      writeState: async (next) => { patch = next },
    })
    expect(patch).toMatchObject({ review_gate_status: 'approved', review_acknowledged_via: 'dashboard' })
    expect(result.deferred).toEqual(['review-interaction', 'review-history', 'review-marker-clear'])
  })

  it('rejects a stale binding without mutating canonical state and records the rejection port', async () => {
    let wrote = false
    let rejected = 0
    await expect(acknowledgeReview({
      state: state(), phase: 'verify', event: 'verify-pass', acknowledgedAt: '2026-09-13T00:01:00Z',
      via: 'dashboard', bindingMatches: false,
      writeState: async () => { wrote = true },
      recordRejectedAcknowledgement: async () => { rejected += 1 },
    })).rejects.toThrow('未绑定当前 canonical')
    expect(wrote).toBe(false)
    expect(rejected).toBe(1)
  })

  it('does not rewrite an already approved receipt', async () => {
    let writes = 0
    const result = await acknowledgeReview({
      state: state('approved'), phase: 'verify', event: 'verify-pass', acknowledgedAt: '2026-09-13T00:01:00Z',
      via: 'dashboard', bindingMatches: true,
      writeState: async () => { writes += 1 },
    })
    expect(result).toMatchObject({ changed: false })
    expect(writes).toBe(0)
  })

  it('uses one ordered command journey and commits only after binding and revision checks', async () => {
    const order: string[] = []
    let writes = 0
    const result = await executeReviewAcknowledgeCommand({
      withLock: async (fn) => { order.push('lock'); return fn() },
      readState: async () => { order.push('receipt'); return state() },
      readRevision: async () => { order.push('revision'); return 4 },
      expectedRevision: 4,
      idempotencyKey: 'k1',
      checkIdempotency: async () => { order.push('idempotency'); return 'missing' },
      phase: 'verify', event: 'verify-pass', acknowledgedAt: '2026-09-13T00:01:00Z',
      bindingMatches: async () => { order.push('binding'); return true },
      commit: async () => { order.push('commit'); writes += 1; return { deferred: [] } },
      rememberIdempotencyKey: async () => { order.push('remember') },
    })
    expect(result).toMatchObject({ ok: true, code: 'approved', changed: true })
    expect(writes).toBe(1)
    expect(order).toEqual(['lock', 'idempotency', 'receipt', 'binding', 'revision', 'commit', 'remember'])
  })

  it('returns idempotency conflict with zero canonical side effects', async () => {
    let writes = 0
    const result = await executeReviewAcknowledgeCommand({
      withLock: async (fn) => fn(), readState: async () => state(), phase: 'verify', event: 'verify-pass',
      acknowledgedAt: '2026-09-13T00:01:00Z', expectedRevision: 1, idempotencyKey: 'same',
      checkIdempotency: async () => 'conflict', bindingMatches: () => true,
      commit: async () => { writes += 1; return {} },
    })
    expect(result).toEqual({ ok: false, code: 'idempotency-conflict', message: 'idempotency key is already bound to another decision' })
    expect(writes).toBe(0)
  })

  it('checks revision before treating an approved receipt as a replay', async () => {
    const result = await executeReviewAcknowledgeCommand({
      withLock: async (fn) => fn(), readState: async () => state('approved'),
      phase: 'verify', event: 'verify-pass', acknowledgedAt: '2026-09-13T00:01:00Z',
      expectedRevision: 2, readRevision: async () => 3,
      bindingMatches: () => true, commit: async () => ({}),
    })
    expect(result).toMatchObject({ ok: false, code: 'revision-conflict' })
  })

  it('does not turn a previously rejected command into a successful replay', async () => {
    const result = await executeReviewAcknowledgeCommand({
      withLock: async (fn) => fn(), readState: async () => state(),
      phase: 'verify', event: 'verify-pass', acknowledgedAt: '2026-09-13T00:01:00Z',
      idempotencyKey: 'same', checkIdempotency: async () => 'rejected', rejectedCode: 'revision-conflict',
      bindingMatches: () => true, commit: async () => { throw new Error('must not commit') },
    })
    expect(result).toMatchObject({ ok: false, code: 'revision-conflict' })
  })
})
