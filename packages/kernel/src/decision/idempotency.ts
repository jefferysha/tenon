import { join } from 'node:path'
import type { ReviewAcknowledgedVia } from '../state/review-gate.js'

/** The single durable ledger owned by a Change. Filesystem IO enters through `ReviewDecisionLedgerFs`. */
export const REVIEW_DECISION_IDEMPOTENCY_FILE = '.pipeline-decision-idempotency.jsonl' as const
export const REVIEW_DECISION_IDEMPOTENCY_MAX_BYTES = 1024 * 1024

/** Successful outcomes that a replay of the same key reports again. */
export type ReviewDecisionStoredCode = 'approved' | 'idempotent-replay'

export type ReviewDecisionIdempotencyRecord = {
  readonly key: string
  readonly ref: string
  readonly expectedRevision: number | null
  readonly channel: ReviewAcknowledgedVia
  /** Digest of the complete command payload; legacy records may omit this field. */
  readonly payloadDigest?: string
  readonly acknowledgedAt: string
  /**
   * Stored success code. Records written before failures stopped being persisted may still carry
   * `outcome: 'rejected'` with a free-form code; they stay decodable but never answer a lookup.
   */
  readonly code?: string
  readonly outcome?: 'rejected'
  readonly error?: string
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

/** The only payload digest for review decision commands, shared by terminal and Dashboard. */
export function reviewDecisionPayloadDigest(
  ref: string,
  expectedRevision: number | null,
  channel: ReviewAcknowledgedVia,
): string {
  return `${channel}\0${ref}\0${expectedRevision === null ? 'null' : expectedRevision}`
}

/** Filesystem port. `readText` returns undefined when the ledger does not exist yet. */
export interface ReviewDecisionLedgerFs {
  readonly readText: (path: string) => Promise<string | undefined>
  readonly appendText: (path: string, text: string) => Promise<void>
}

export type ReviewDecisionLedgerLookup =
  | { readonly kind: 'missing' }
  | { readonly kind: 'replay'; readonly code: ReviewDecisionStoredCode }
  | { readonly kind: 'conflict' }

export interface ReviewDecisionLedger {
  /** Compare a key against the stored successful payload. Throws on a damaged ledger. */
  readonly lookup: (key: string, payloadDigest: string) => Promise<ReviewDecisionLedgerLookup>
  /** Persist one successful outcome. Failures are never stored. */
  readonly remember: (record: ReviewDecisionIdempotencyRecord & { readonly code: ReviewDecisionStoredCode }) => Promise<void>
}

function parseLedger(raw: string): readonly ReviewDecisionIdempotencyRecord[] {
  if (Buffer.byteLength(raw, 'utf8') > REVIEW_DECISION_IDEMPOTENCY_MAX_BYTES) {
    throw new Error('decision idempotency record exceeds size limit')
  }
  if (raw === '') return []
  if (!raw.endsWith('\n')) throw new Error('decision idempotency record is truncated')
  return raw.split('\n').filter(Boolean).map((line) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new Error('decision idempotency record is invalid')
    }
    if (!isReviewDecisionIdempotencyRecord(parsed)) throw new Error('decision idempotency record is invalid')
    return parsed
  })
}

function storedCode(record: ReviewDecisionIdempotencyRecord): ReviewDecisionStoredCode {
  return record.code === 'idempotent-replay' ? 'idempotent-replay' : 'approved'
}

export function createReviewDecisionLedger(changeDir: string, fs: ReviewDecisionLedgerFs): ReviewDecisionLedger {
  const path = join(changeDir, REVIEW_DECISION_IDEMPOTENCY_FILE)
  return {
    lookup: async (key, payloadDigest) => {
      const raw = await fs.readText(path)
      const prior = parseLedger(raw ?? '')
        .find((record) => record.key === key && record.outcome !== 'rejected')
      if (prior === undefined) return { kind: 'missing' }
      const priorDigest = prior.payloadDigest ?? reviewDecisionPayloadDigest(prior.ref, prior.expectedRevision, prior.channel)
      return priorDigest === payloadDigest ? { kind: 'replay', code: storedCode(prior) } : { kind: 'conflict' }
    },
    remember: async (record) => {
      await fs.appendText(path, `${JSON.stringify(record)}\n`)
    },
  }
}
