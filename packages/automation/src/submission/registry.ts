import { atomicReplaceFile } from '@tenon/kernel'
import { isArtifactSubjectRef, type ArtifactProjectionKind, type ArtifactSubjectRef } from '@tenon/kernel'
import { readFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const ARTIFACT_SUBJECT_REGISTRY_FILE = '.pipeline-artifact-subjects.json'
export interface ArtifactSubjectProjectionRecord {
  readonly subjectRef: ArtifactSubjectRef
  readonly logicalKey: string
  readonly projection: ArtifactProjectionKind
  readonly path?: string
  readonly documentKind?: string
  readonly field?: string
  readonly status: 'declared' | 'committed' | 'pending' | 'failed'
  readonly receiptId: string
  readonly recordedAt: string
  readonly stateRevisionId?: string
}
export interface ArtifactSubjectRegistry { readonly version: 1; readonly records: readonly ArtifactSubjectProjectionRecord[] }
const emptyRegistry = (): ArtifactSubjectRegistry => ({ version: 1, records: [] })

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function decodeRegistry(value: unknown): ArtifactSubjectRegistry {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.records)) throw new Error('invalid artifact subject registry')
  const records = value.records.filter(isRecord).map((record) => {
    if (!isArtifactSubjectRef(record.subjectRef) || typeof record.logicalKey !== 'string' || typeof record.projection !== 'string' || typeof record.status !== 'string' || typeof record.receiptId !== 'string' || typeof record.recordedAt !== 'string') throw new Error('invalid artifact subject registry record')
    if (!['document', 'field', 'runtime'].includes(record.projection) || !['declared', 'committed', 'pending', 'failed'].includes(record.status)) throw new Error('invalid artifact subject registry projection/status')
    return {
      subjectRef: record.subjectRef,
      logicalKey: record.logicalKey,
      projection: record.projection as ArtifactProjectionKind,
      ...(typeof record.path === 'string' ? { path: record.path } : {}),
      ...(typeof record.documentKind === 'string' ? { documentKind: record.documentKind } : {}),
      ...(typeof record.field === 'string' ? { field: record.field } : {}),
      status: record.status as ArtifactSubjectProjectionRecord['status'],
      receiptId: record.receiptId,
      recordedAt: record.recordedAt,
      ...(typeof record.stateRevisionId === 'string' ? { stateRevisionId: record.stateRevisionId } : {}),
    }
  })
  if (records.length !== value.records.length) throw new Error('invalid artifact subject registry records')
  return { version: 1, records }
}

export async function readArtifactSubjectRegistry(changeDir: string): Promise<ArtifactSubjectRegistry> {
  try {
    return decodeRegistry(JSON.parse(await readFile(join(changeDir, ARTIFACT_SUBJECT_REGISTRY_FILE), 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyRegistry()
    throw error
  }
}

export async function recordArtifactSubjectProjection(changeDir: string, record: ArtifactSubjectProjectionRecord): Promise<ArtifactSubjectRegistry> {
  const current = await readArtifactSubjectRegistry(changeDir)
  const records = current.records.filter((candidate) => candidate.receiptId !== record.receiptId)
  records.push(record)
  const next = { version: 1 as const, records }
  await mkdir(dirname(join(changeDir, ARTIFACT_SUBJECT_REGISTRY_FILE)), { recursive: true })
  await atomicReplaceFile(join(changeDir, ARTIFACT_SUBJECT_REGISTRY_FILE), `${JSON.stringify(next, null, 2)}\n`)
  return next
}
