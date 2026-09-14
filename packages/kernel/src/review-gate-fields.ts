/**
 * Review-gate v2 fields are append-only state schema additions. Keeping the group named lets the
 * canonical reader recognise precisely one historical shape written before this feature, without
 * weakening the closed schema for arbitrary missing fields. The YAML compatibility projection
 * omits the entire group while every value is blank, then writes all receipt fields together for a live
 * receipt; canonical state always retains the complete group.
 */
export const REVIEW_GATE_FIELDS = [
  'review_gate_phase',
  'review_gate_status',
  // The approved decision must bind the exact outgoing edge. `verify` has both a pass and a
  // rollback edge; phase-only approval would let one human decision authorize the other.
  'review_gate_event',
  'review_requested_at',
  'review_acknowledged_at',
  'review_acknowledged_via',
] as const
export type ReviewGateField = (typeof REVIEW_GATE_FIELDS)[number]
export const REVIEW_GATE_FIELD_DEFAULTS: Readonly<Record<ReviewGateField, string>> = {
  review_gate_phase: '',
  review_gate_status: '',
  review_gate_event: '',
  review_requested_at: '',
  review_acknowledged_at: '',
  review_acknowledged_via: 'unknown',
}
export const PRE_VERIFY_REVIEW_FIELD = 'pre_verify_review_result' as const
export const PRE_VERIFY_REVIEW_DEFAULT = 'pending'
