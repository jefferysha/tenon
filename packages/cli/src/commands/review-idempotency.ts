import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  isReviewDecisionIdempotencyRecord,
  REVIEW_DECISION_IDEMPOTENCY_FILE,
  REVIEW_DECISION_IDEMPOTENCY_MAX_BYTES,
  type ReviewAcknowledgedVia,
  type ReviewDecisionIdempotencyRecord,
} from '@tenon/kernel'

async function readRecords(changeDir: string): Promise<readonly ReviewDecisionIdempotencyRecord[]> {
  try {
    const raw = await readFile(join(changeDir, REVIEW_DECISION_IDEMPOTENCY_FILE), 'utf8')
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
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
}

export function createReviewIdempotencyAdapter(input: {
  readonly changeDir: string
  readonly ref: string
  readonly channel: ReviewAcknowledgedVia
  readonly acknowledgedAt: string
}): {
  readonly check: (key: string) => Promise<'missing' | 'replay' | 'rejected' | 'conflict'>
  readonly remember: (key: string) => Promise<void>
} {
  const payloadDigest = (key: string): string => `${input.channel}\0${input.ref}\0${key}`
  return {
    check: async (key) => {
      const records = await readRecords(input.changeDir)
      const matching = records.find((record) => record.key === key)
      if (matching === undefined) return 'missing'
      if (matching.channel !== input.channel || matching.ref !== input.ref) return 'conflict'
      if (matching.outcome === 'rejected') return 'rejected'
      return 'replay'
    },
    remember: async (key) => {
      const existing = (await readRecords(input.changeDir)).find((record) => record.key === key)
      if (existing !== undefined) return
      const record: ReviewDecisionIdempotencyRecord = {
        key,
        ref: input.ref,
        expectedRevision: null,
        channel: input.channel,
        payloadDigest: payloadDigest(key),
        acknowledgedAt: input.acknowledgedAt,
      }
      await appendFile(join(input.changeDir, REVIEW_DECISION_IDEMPOTENCY_FILE), `${JSON.stringify(record)}\n`, {
        encoding: 'utf8', flag: 'a', mode: 0o600,
      })
    },
  }
}
