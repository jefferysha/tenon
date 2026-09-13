import { constants } from 'node:fs'
import { lstat, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const DECISION_AUDIT_FILE = '.pipeline-decision-audit.jsonl'
export const DECISION_AUDIT_MAX_BYTES = 1024 * 1024

export type DecisionAuditRecord =
  | {
      readonly version: 1
      readonly type: 'decision-mode-switched'
      readonly from: 'hitl' | 'afk'
      readonly to: 'hitl' | 'afk'
      readonly strategy: 'interactive' | 'recommended-defaults' | 'afk'
      readonly actor: 'user' | 'automation'
      readonly channel: 'dashboard'
      readonly occurredAt: string
      readonly expectedRevision: number
      readonly idempotencyKey: string
    }
  | {
      readonly version: 1
      readonly type: 'pending-decision-self-approval-suspected'
      readonly pendingDecisionId: string
      readonly channel: 'terminal' | 'dashboard' | 'hook' | 'automation'
      readonly operation: 'read-token' | 'local-api-call'
      readonly tokenDigest: string | null
      readonly observedAt: string
      readonly severity: 'warning'
      readonly idempotencyKey: string
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAuditRecord(value: unknown): value is DecisionAuditRecord {
  if (!isRecord(value) || value.version !== 1 || typeof value.type !== 'string') return false
  if (value.type === 'decision-mode-switched') {
    return (value.from === 'hitl' || value.from === 'afk')
      && (value.to === 'hitl' || value.to === 'afk')
      && (value.strategy === 'interactive' || value.strategy === 'recommended-defaults' || value.strategy === 'afk')
      && (value.actor === 'user' || value.actor === 'automation')
      && value.channel === 'dashboard'
      && typeof value.occurredAt === 'string' && Number.isSafeInteger(value.expectedRevision)
      && typeof value.idempotencyKey === 'string' && value.idempotencyKey !== ''
  }
  if (value.type === 'pending-decision-self-approval-suspected') {
    return typeof value.pendingDecisionId === 'string' && value.pendingDecisionId !== ''
      && (value.channel === 'terminal' || value.channel === 'dashboard' || value.channel === 'hook' || value.channel === 'automation')
      && (value.operation === 'read-token' || value.operation === 'local-api-call')
      && (value.tokenDigest === null || (typeof value.tokenDigest === 'string' && /^[a-f0-9]{64}$/.test(value.tokenDigest)))
      && typeof value.observedAt === 'string' && value.severity === 'warning'
      && typeof value.idempotencyKey === 'string' && value.idempotencyKey !== ''
  }
  return false
}

function pathFor(changeDir: string): string {
  return join(changeDir, DECISION_AUDIT_FILE)
}

export async function readDecisionAudit(changeDir: string): Promise<readonly DecisionAuditRecord[]> {
  const path = pathFor(changeDir)
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('decision audit must be a regular file')
    const raw = await readFile(path, 'utf8')
    if (Buffer.byteLength(raw) > DECISION_AUDIT_MAX_BYTES || (raw !== '' && !raw.endsWith('\n'))) throw new Error('decision audit is invalid')
    return raw.split('\n').filter(Boolean).map((line) => {
      const parsed: unknown = JSON.parse(line)
      if (!isAuditRecord(parsed)) throw new Error('decision audit record is invalid')
      return parsed
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Caller must already hold the canonical Change lock. The file is append-only and redacted. */
export async function appendDecisionAuditUnderLock(changeDir: string, record: DecisionAuditRecord): Promise<void> {
  const path = pathFor(changeDir)
  const current = await readDecisionAudit(changeDir)
  if (current.some((item) => item.type === record.type && item.idempotencyKey === record.idempotencyKey)) return
  const line = `${JSON.stringify(record)}\n`
  const existing = current.reduce((size, item) => size + Buffer.byteLength(`${JSON.stringify(item)}\n`), 0)
  if (existing + Buffer.byteLength(line) > DECISION_AUDIT_MAX_BYTES) throw new Error('decision audit exceeds size limit')
  const handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('decision audit must be a regular file')
    await handle.write(line, undefined, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}
