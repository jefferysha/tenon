/**
 * Review-gate v2 的纯状态判定。
 *
 * Review 不是“进入某 phase 前先停住”，而是“当前 review phase 的产物已呈现后，确认才可离开”。
 * marker 只是 hook 的短时投影；这里的 canonical receipt 才是 transition 的硬前置条件。
 */
import type { FieldName, PipelineState } from '../types.js'

export const REVIEW_GATE_PENDING = 'pending'
export const REVIEW_GATE_APPROVED = 'approved'

export type ReviewGateStatus = typeof REVIEW_GATE_PENDING | typeof REVIEW_GATE_APPROVED

function scalar(state: PipelineState, field: FieldName): string {
  const value = state.fields[field]
  return Array.isArray(value) ? value.join(',') : (value ?? '')
}

export function reviewGateStatus(state: PipelineState): ReviewGateStatus | null {
  const value = scalar(state, 'review_gate_status')
  return value === REVIEW_GATE_PENDING || value === REVIEW_GATE_APPROVED ? value : null
}

export function reviewGateEvent(state: PipelineState): string {
  return scalar(state, 'review_gate_event')
}

/**
 * A receipt is only authorization for its exact outgoing event. Keeping `event` optional lets
 * inbox/status callers inspect a phase-scoped pending receipt without weakening transition
 * enforcement, which always supplies the event it is about to execute.
 */
export function reviewGateMatches(state: PipelineState, phase: string, event?: string): boolean {
  return scalar(state, 'review_gate_phase') === phase
    && (event === undefined || reviewGateEvent(state) === event)
}

export function reviewGateApprovedFor(state: PipelineState, phase: string, event?: string): boolean {
  return reviewGateMatches(state, phase, event) && reviewGateStatus(state) === REVIEW_GATE_APPROVED
}

export function reviewGatePendingFor(state: PipelineState, phase: string, event?: string): boolean {
  return reviewGateMatches(state, phase, event) && reviewGateStatus(state) === REVIEW_GATE_PENDING
}

export function reviewGateRequestPatch(
  phase: string,
  event: string,
  requestedAt: string,
): Partial<Record<FieldName, string>> {
  return {
    review_gate_phase: phase,
    review_gate_status: REVIEW_GATE_PENDING,
    review_gate_event: event,
    review_requested_at: requestedAt,
    review_acknowledged_at: '',
    review_acknowledged_via: 'unknown',
  }
}

/** Entry route for an acknowledgement. This is provenance, not operator identity. */
export type ReviewAcknowledgedVia = 'terminal' | 'dashboard' | 'automation' | 'delegated' | 'unknown'

export function reviewGateApprovalPatch(acknowledgedAt: string, via: ReviewAcknowledgedVia = 'terminal'): Partial<Record<FieldName, string>> {
  return {
    review_gate_status: REVIEW_GATE_APPROVED,
    review_acknowledged_at: acknowledgedAt,
    review_acknowledged_via: via,
  }
}

/** Transition consumes the receipt so an approval can never authorise a later revisit of the same phase. */
export function clearReviewGatePatch(): Partial<Record<FieldName, string>> {
  return {
    review_gate_phase: '',
    review_gate_status: '',
    review_gate_event: '',
    review_requested_at: '',
    review_acknowledged_at: '',
    review_acknowledged_via: 'unknown',
  }
}
