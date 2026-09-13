import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const DECISION_IDEMPOTENCY_FILE = '.pipeline-decision-idempotency.jsonl'
export const DECISION_IDEMPOTENCY_MAX_BYTES = 1024 * 1024

export type DecisionIdempotencyRecord = {
  readonly key: string
  readonly ref: string
  readonly expectedRevision: number | null
  readonly channel: 'dashboard'
  readonly kind?: 'review' | 'skill-question' | 'afk'
  readonly acknowledgedAt: string
  readonly outcome?: 'approved' | 'rejected'
  readonly error?: string
  readonly code?: string
}

function isDecisionIdempotencyRecord(value: unknown): value is DecisionIdempotencyRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.key === 'string'
    && typeof record.ref === 'string'
    && (typeof record.expectedRevision === 'number' || record.expectedRevision === null)
    && record.channel === 'dashboard'
    && (record.kind === undefined || record.kind === 'review' || record.kind === 'skill-question' || record.kind === 'afk')
    && typeof record.acknowledgedAt === 'string'
    && (record.outcome === undefined || record.outcome === 'approved' || record.outcome === 'rejected')
    && (record.error === undefined || typeof record.error === 'string')
    && (record.code === undefined || typeof record.code === 'string')
}

export async function readDecisionIdempotency(changeDir: string): Promise<readonly DecisionIdempotencyRecord[]> {
  try {
    const raw = await readFile(join(changeDir, DECISION_IDEMPOTENCY_FILE), 'utf8')
    if (Buffer.byteLength(raw, 'utf8') > DECISION_IDEMPOTENCY_MAX_BYTES) throw new Error('decision idempotency record exceeds size limit')
    if (raw === '') return []
    if (!raw.endsWith('\n')) throw new Error('decision idempotency record is truncated')
    return raw.split('\n').filter(Boolean).map((line) => {
      const parsed: unknown = JSON.parse(line)
      if (!isDecisionIdempotencyRecord(parsed)) throw new Error('decision idempotency record is invalid')
      return parsed
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export async function appendDecisionIdempotency(changeDir: string, record: DecisionIdempotencyRecord): Promise<void> {
  await appendFile(join(changeDir, DECISION_IDEMPOTENCY_FILE), `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a', mode: 0o600 })
}
