import { describe, expect, it } from 'vitest'
import { emptyFields, type PipelineState } from '../index.js'
import { acknowledgeReview } from './review-application.js'

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
})
