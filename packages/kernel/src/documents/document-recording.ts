import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requiredDocumentProducerInvocation } from '../state/document-producer-invocation.js'
import {
  recordDocumentLedger,
  DocumentLedgerError,
  type DocumentLedger,
  type RecordDocumentLedgerInput,
} from '../state/document-ledger.js'
import { HISTORY_FILE } from '../state/history.js'
import { skillsEquivalent } from '../state/document-record-policy.js'
import type { DocumentGovernancePolicy, DocumentKind } from '../workflow/document-contract.js'
import type { ArtifactSubjectRef } from '../artifacts/subject.js'

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

async function hasSkillEvidence(
  changeDir: string,
  producer: string,
  phase: string,
  allowEarlierPhaseEvidence: boolean,
): Promise<boolean> {
  let text: string
  try {
    text = await readFile(join(changeDir, HISTORY_FILE), 'utf8')
  } catch (error) {
    if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT') return false
    throw error
  }
  const entries: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const entry = object(JSON.parse(trimmed))
      if (entry) entries.push(entry)
    } catch {
      // JSONL history is append-only; malformed legacy rows cannot satisfy evidence.
    }
  }
  let start = 0
  if (!allowEarlierPhaseEvidence) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]
      if (entry?.kind === 'transition' && entry.to === phase) {
        start = index + 1
        break
      }
    }
  }
  for (const entry of entries.slice(start)) {
    if (entry.kind !== 'tool') continue
    try {
      const raw = string(entry.raw)
      const match = raw ? /^(?:Skill|CodexSkillRead): (.+)$/u.exec(raw) : null
      if (match && skillsEquivalent(match[1] ?? '', producer)) return true
    } catch {
      // A malformed legacy tool row cannot satisfy producer evidence.
    }
  }
  return false
}

export interface RecordDocumentInput {
  readonly repoRoot: string
  readonly changeDir: string
  readonly phase: string
  readonly policy: DocumentGovernancePolicy
  readonly kind: DocumentKind
  readonly path: string
  readonly producer: string
  readonly recordedAt: string
  readonly allowBackfill?: boolean
  /** Optional canonical ref supplied by a unified artifact submission boundary. */
  readonly subjectRef?: ArtifactSubjectRef
  /** Declared operator stored on the ledger record. */
  readonly actor?: import('../users/user.js').RecordActor
}

/** Public recording use case; the producer anchor is always derived from canonical evidence. */
export async function recordDocument(input: RecordDocumentInput): Promise<DocumentLedger> {
  await recordDocumentLedger({ ...input, validateOnly: true })
  if (!await hasSkillEvidence(input.changeDir, input.producer, input.phase, input.allowBackfill === true)) {
    throw new DocumentLedgerError(
      `缺少 Skill 调用证据（当前 phase）: '${input.producer}'；先由宿主在本 phase 实际调用该 skill，确认完成态证据已写入 history 后再登记 '${input.kind}'`,
    )
  }
  const producerInvocation = await requiredDocumentProducerInvocation(
    input.changeDir, input.producer, input.phase, input.recordedAt, input.allowBackfill === true,
  )
  const coreInput: RecordDocumentLedgerInput = {
    ...input,
    ...(producerInvocation === undefined ? {} : { producerInvocation }),
  }
  return recordDocumentLedger(coreInput)
}
