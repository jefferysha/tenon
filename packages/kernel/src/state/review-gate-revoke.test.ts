import { describe, expect, it } from 'vitest'
import { emptyFields, type PipelineState } from '../index.js'
import type { FieldName } from '../types.js'
import {
  reviewGateApprovalPatch,
  reviewGateApprovedFor,
  reviewGatePendingFor,
  reviewGateRequestPatch,
  reviewGateRevokePatch,
} from './review-gate.js'

const REQUESTED_AT = '2026-10-07T00:00:00.000Z'
const ACKNOWLEDGED_AT = '2026-10-07T00:01:00.000Z'

function stateWith(patch: Partial<Record<FieldName, string>>): PipelineState {
  return { fields: { ...emptyFields(), phase: 'spec', ...patch }, opaqueTail: '' } as PipelineState
}

describe('reviewGateRevokePatch', () => {
  it('returns an approved receipt to pending for the same event and keeps requestedAt', () => {
    const approved = stateWith({
      ...reviewGateRequestPatch('spec', 'spec-complete', REQUESTED_AT),
      ...reviewGateApprovalPatch(ACKNOWLEDGED_AT, 'terminal'),
    })
    expect(reviewGateApprovedFor(approved, 'spec', 'spec-complete')).toBe(true)

    const revoked = stateWith({
      ...reviewGateRequestPatch('spec', 'spec-complete', REQUESTED_AT),
      ...reviewGateApprovalPatch(ACKNOWLEDGED_AT, 'terminal'),
      ...reviewGateRevokePatch(),
    })
    expect(reviewGatePendingFor(revoked, 'spec', 'spec-complete')).toBe(true)
    expect(reviewGateApprovedFor(revoked, 'spec', 'spec-complete')).toBe(false)
    expect(revoked.fields.review_requested_at).toBe(REQUESTED_AT)
    expect(revoked.fields.review_acknowledged_at).toBe('')
    expect(revoked.fields.review_acknowledged_via).toBe('unknown')
  })

  it('touches only the status and the acknowledgement fields', () => {
    expect(Object.keys(reviewGateRevokePatch()).sort()).toEqual([
      'review_acknowledged_at', 'review_acknowledged_via', 'review_gate_status',
    ])
  })
})
