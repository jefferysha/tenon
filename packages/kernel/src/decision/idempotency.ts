import type { ReviewAcknowledgedVia } from '../state/review-gate.js'

/** The single durable ledger owned by a Change. Filesystem adapters own its IO. */
export const REVIEW_DECISION_IDEMPOTENCY_FILE = '.pipeline-decision-idempotency.jsonl' as const
export const REVIEW_DECISION_IDEMPOTENCY_MAX_BYTES = 1024 * 1024

export type ReviewDecisionIdempotencyRecord = {
  readonly key: string
  readonly ref: string
  readonly expectedRevision: number | null
  readonly channel: ReviewAcknowledgedVia
  /** Digest of the complete command payload; legacy records may omit this field. */
  readonly payloadDigest?: string
  readonly acknowledgedAt: string
  readonly outcome?: 'rejected'
  readonly error?: string
  readonly code?: string
}

export function isReviewDecisionIdempotencyRecord(value: unknown): value is ReviewDecisionIdempotencyRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.key === 'string'
    && typeof record.ref === 'string'
    && (typeof record.expectedRevision === 'number' || record.expectedRevision === null)
    && (record.channel === 'terminal' || record.channel === 'dashboard' || record.channel === 'automation'
      || record.channel === 'delegated' || record.channel === 'unknown')
    && (record.payloadDigest === undefined || typeof record.payloadDigest === 'string')
    && typeof record.acknowledgedAt === 'string'
    && (record.outcome === undefined || record.outcome === 'rejected')
    && (record.error === undefined || typeof record.error === 'string')
    && (record.code === undefined || typeof record.code === 'string')
}

export function reviewDecisionPayloadDigest(
  ref: string,
  expectedRevision: number | null,
  channel: ReviewAcknowledgedVia,
): string {
  return `${channel}\0${ref}\0${expectedRevision === null ? 'null' : expectedRevision}`
}
