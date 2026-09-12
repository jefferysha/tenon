import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import {
  artifactSubjectId,
  isArtifactSubjectRef,
  type ArtifactSubjectRef,
} from '../artifacts/subject.js'
import type { FieldName } from '../types.js'
import { atomicReplaceFile } from './atomic-publish.js'

/** Change-local projection for field outputs. It deliberately stays outside .pipeline.yaml. */
export const FIELD_SUBJECTS_FILE = '.pipeline-field-subjects.json'
export const FIELD_SUBJECTS_CONTRACT = 'field-subjects-v1' as const
export const FIELD_SUBJECTS_VERSION = 1 as const
export const MAX_FIELD_SUBJECT_RECORDS = 128
export const MAX_FIELD_SUBJECTS_BYTES = 512 * 1024

export type FieldSubjectPathStatus = 'resolved' | 'missing' | 'value'

export interface FieldSubjectRecord {
  readonly field: string
  readonly valueDigest: `sha256:${string}`
  readonly subjectRef: ArtifactSubjectRef
  readonly recordedAt: string
  readonly producer?: string
  readonly sourcePath?: string
  readonly pathStatus: FieldSubjectPathStatus
}

export interface FieldSubjectMigrationReceipt {
  readonly receiptId: string
  readonly field: string
  readonly subjectId: string
  readonly migratedAt: string
  readonly kind: 'legacy-field-state'
}

export interface FieldSubjectLedger {
  readonly version: 1
  readonly contract: typeof FIELD_SUBJECTS_CONTRACT
  readonly createdAt: string
  readonly records: readonly FieldSubjectRecord[]
  readonly migrationReceipts?: readonly FieldSubjectMigrationReceipt[]
}

export interface RecordFieldSubjectInput {
  readonly changeDir: string
  /** Repository root used only to probe an optional source path. */
  readonly repoRoot?: string
  readonly field: FieldName | string
  readonly value: string | readonly string[]
  readonly sourcePath?: string
  readonly recordedAt: string
  readonly producer?: string
  readonly logicalKey?: string
  readonly namespace?: string
  /** Submission service may provide a digest-bound ref. */
  readonly subjectRef?: ArtifactSubjectRef
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`field subject ${label} 必须是非空字符串`)
  return value
}

function digest(value: Uint8Array | string): `sha256:${string}` {
  const hash = createHash('sha256').update(value).digest('hex')
  return `sha256:${hash}`
}

function validDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value)
}

function parseSubjectRef(value: unknown, index: number): ArtifactSubjectRef {
  if (!isArtifactSubjectRef(value) || value.projection !== 'field') {
    throw new Error(`field subject records[${index}].subjectRef 非法`)
  }
  return value
}

function parseRecord(value: unknown, index: number): FieldSubjectRecord {
  const item = object(value)
  if (!item) throw new Error(`field subject records[${index}] 必须是对象`)
  const field = text(item.field, `records[${index}].field`)
  const valueDigest = item.valueDigest
  if (!validDigest(valueDigest)) throw new Error(`field subject records[${index}].valueDigest 非法`)
  const recordedAt = text(item.recordedAt, `records[${index}].recordedAt`)
  const pathStatus = item.pathStatus
  if (pathStatus !== 'resolved' && pathStatus !== 'missing' && pathStatus !== 'value') {
    throw new Error(`field subject records[${index}].pathStatus 非法`)
  }
  const sourcePath = item.sourcePath === undefined ? undefined : text(item.sourcePath, `records[${index}].sourcePath`)
  const producer = item.producer === undefined ? undefined : text(item.producer, `records[${index}].producer`)
  return {
    field,
    valueDigest,
    subjectRef: parseSubjectRef(item.subjectRef, index),
    recordedAt,
    ...(producer === undefined ? {} : { producer }),
    ...(sourcePath === undefined ? {} : { sourcePath }),
    pathStatus,
  }
}

function parseReceipt(value: unknown, index: number): FieldSubjectMigrationReceipt {
  const item = object(value)
  if (!item) throw new Error(`field subject migrationReceipts[${index}] 必须是对象`)
  const receiptId = text(item.receiptId, `migrationReceipts[${index}].receiptId`)
  const field = text(item.field, `migrationReceipts[${index}].field`)
  const subjectId = text(item.subjectId, `migrationReceipts[${index}].subjectId`)
  const migratedAt = text(item.migratedAt, `migrationReceipts[${index}].migratedAt`)
  if (item.kind !== 'legacy-field-state') throw new Error(`field subject migrationReceipts[${index}].kind 非法`)
  return { receiptId, field, subjectId, migratedAt, kind: 'legacy-field-state' }
}

/** Strict parser boundary for the optional field projection. */
export function parseFieldSubjectLedger(raw: string): FieldSubjectLedger {
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('field subject ledger 不是合法 JSON') }
  const item = object(value)
  if (!item) throw new Error('field subject ledger 必须是 JSON 对象')
  if (item.version !== FIELD_SUBJECTS_VERSION) throw new Error('field subject ledger version 非法')
  if (item.contract !== FIELD_SUBJECTS_CONTRACT) throw new Error('field subject ledger contract 非法')
  const createdAt = text(item.createdAt, 'createdAt')
  if (!Array.isArray(item.records)) throw new Error('field subject ledger records 必须是数组')
  if (item.records.length > MAX_FIELD_SUBJECT_RECORDS) throw new Error(`field subject records 超过 ${MAX_FIELD_SUBJECT_RECORDS} 条上限`)
  const records = item.records.map(parseRecord)
  const fields = new Set<string>()
  for (const record of records) {
    if (fields.has(record.field)) throw new Error(`field subject ledger 有重复 field: ${record.field}`)
    fields.add(record.field)
  }
  const migrationReceipts = item.migrationReceipts === undefined
    ? undefined
    : Array.isArray(item.migrationReceipts) ? item.migrationReceipts.map(parseReceipt) : (() => { throw new Error('field subject migrationReceipts 必须是数组') })()
  return {
    version: 1,
    contract: FIELD_SUBJECTS_CONTRACT,
    createdAt,
    records,
    ...(migrationReceipts === undefined ? {} : { migrationReceipts }),
  }
}

export function initialFieldSubjectLedgerContent(createdAt: string): string {
  return `${JSON.stringify({ version: 1, contract: FIELD_SUBJECTS_CONTRACT, createdAt, records: [] }, null, 2)}\n`
}

export async function readFieldSubjectLedger(changeDir: string): Promise<FieldSubjectLedger | undefined> {
  try {
    const raw = await readFile(join(changeDir, FIELD_SUBJECTS_FILE), 'utf8')
    if (Buffer.byteLength(raw, 'utf8') > MAX_FIELD_SUBJECTS_BYTES) throw new Error('field subject ledger 超过大小上限')
    return parseFieldSubjectLedger(raw)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function safeSourcePath(repoRoot: string | undefined, sourcePath: string): string | undefined {
  if (sourcePath === '' || isAbsolute(sourcePath)) return undefined
  const root = resolve(repoRoot ?? '.')
  const absolute = resolve(root, sourcePath)
  const rel = relative(root, absolute)
  if (rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`)) return undefined
  return absolute
}

async function contentDigestFor(input: RecordFieldSubjectInput): Promise<{ valueDigest: `sha256:${string}`; pathStatus: FieldSubjectPathStatus }> {
  if (input.sourcePath !== undefined) {
    const path = safeSourcePath(input.repoRoot, input.sourcePath)
    if (path !== undefined) {
      try {
        const info = await stat(path)
        if (info.isFile()) return { valueDigest: digest(await readFile(path)), pathStatus: 'resolved' }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return { valueDigest: digest(typeof input.value === 'string' ? input.value : JSON.stringify(input.value)), pathStatus: 'missing' }
  }
  return { valueDigest: digest(typeof input.value === 'string' ? input.value : JSON.stringify(input.value)), pathStatus: 'value' }
}

function makeSubjectRef(input: RecordFieldSubjectInput, valueDigest: `sha256:${string}`, previous?: ArtifactSubjectRef): ArtifactSubjectRef {
  const namespace = input.namespace ?? previous?.namespace ?? 'field'
  const logicalKey = input.logicalKey ?? previous?.subject_id ?? `field:${input.field}`
  const subjectId = previous?.subject_id ?? artifactSubjectId(namespace, logicalKey)
  return {
    subject_id: subjectId,
    namespace: previous?.namespace ?? namespace,
    version: previous?.content_digest === valueDigest ? previous.version : valueDigest,
    projection: 'field',
    content_digest: valueDigest,
    source: {
      ...(previous?.source ?? {}),
      field: input.field,
      ...(input.sourcePath === undefined ? {} : { path: input.sourcePath }),
    },
  }
}

/** Record a field projection after the canonical field reducer has committed. */
export async function recordFieldSubject(input: RecordFieldSubjectInput): Promise<FieldSubjectLedger | undefined> {
  try {
    await stat(input.changeDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const observed = await contentDigestFor(input)
  if (input.subjectRef !== undefined) {
    if (!isArtifactSubjectRef(input.subjectRef) || input.subjectRef.projection !== 'field' || input.subjectRef.content_digest !== observed.valueDigest) {
      throw new Error(`field '${input.field}' subjectRef 与当前值不匹配`)
    }
  }
  const current = await readFieldSubjectLedger(input.changeDir)
  const previous = current?.records.find(record => record.field === input.field)
  const subjectRef = input.subjectRef ?? makeSubjectRef(input, observed.valueDigest, previous?.subjectRef)
  const record: FieldSubjectRecord = {
    field: input.field,
    valueDigest: observed.valueDigest,
    subjectRef,
    recordedAt: input.recordedAt,
    ...(input.producer === undefined ? {} : { producer: input.producer }),
    ...(input.sourcePath === undefined ? {} : { sourcePath: input.sourcePath }),
    pathStatus: observed.pathStatus,
  }
  const next: FieldSubjectLedger = {
    version: 1,
    contract: FIELD_SUBJECTS_CONTRACT,
    createdAt: current?.createdAt ?? input.recordedAt,
    records: [...(current?.records ?? []).filter(candidate => candidate.field !== input.field), record],
    ...(current?.migrationReceipts === undefined ? {} : { migrationReceipts: current.migrationReceipts }),
  }
  const encoded = `${JSON.stringify(next, null, 2)}\n`
  parseFieldSubjectLedger(encoded)
  await atomicReplaceFile(join(input.changeDir, FIELD_SUBJECTS_FILE), encoded)
  return next
}
