import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { REVIEW_GATE_FIELDS, type FieldName, type PipelineState } from '../types.js'
import { atomicReplaceFile } from './atomic-publish.js'
import {
  readBoundedFileHandle,
  readOptionalBoundedRegularTextFile,
  type BoundedFileHandleReader,
} from './document-path.js'
import { serializePipeline } from './parse.js'

/** Sidecar binding for the canonical review decision state (never an interaction projection). */
export const REVIEW_GATE_BINDING_FILE = '.pipeline-review-gate-binding.json' as const
export const MAX_REVIEW_GATE_BINDING_BYTES = 16 * 1024

export interface ReviewGateBinding {
  readonly version: 1
  readonly phase: string
  readonly event: string
  readonly requestedAt: string
  readonly decisionStateDigest: string
  readonly runId?: string
}

async function readReviewGateBindingSource(
  handle: Parameters<BoundedFileHandleReader>[0],
  maxBytes: number,
): Promise<Buffer> {
  const content = await readBoundedFileHandle(handle, maxBytes)
  if (content.length >= 3 && content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf) {
    throw new Error('review gate binding 必须使用 canonical JSON bytes')
  }
  return content
}

function scalar(state: PipelineState, field: FieldName): string {
  const value = state.fields[field]
  return Array.isArray(value) ? value.join(',') : value
}

/**
 * Hash the canonical decision state while excluding only the review receipt fields themselves.
 * The receipt cannot therefore change its own binding, but any other canonical mutation does.
 */
export function reviewGateDecisionStateDigest(state: PipelineState): string {
  const fields = { ...state.fields }
  for (const field of REVIEW_GATE_FIELDS) fields[field] = ''
  const canonical: PipelineState = {
    fields,
    ...(state.runMetadata === undefined ? {} : { runMetadata: state.runMetadata }),
    opaqueTail: state.opaqueTail,
  }
  return createHash('sha256').update(serializePipeline(canonical), 'utf8').digest('hex')
}

export function reviewGateBindingForState(
  state: PipelineState,
  phase: string,
  event: string,
  requestedAt: string,
): ReviewGateBinding {
  const runId = state.runMetadata?.runId
  return {
    version: 1,
    phase,
    event,
    requestedAt,
    decisionStateDigest: reviewGateDecisionStateDigest(state),
    ...(runId === undefined ? {} : { runId }),
  }
}

function parseBinding(value: unknown): ReviewGateBinding {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('review gate binding 形状非法')
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  const allowed = new Set(['version', 'phase', 'event', 'requestedAt', 'decisionStateDigest', 'runId'])
  if (keys.some((key) => !allowed.has(key))
    || record.version !== 1
    || typeof record.phase !== 'string' || record.phase === ''
    || typeof record.event !== 'string' || record.event === ''
    || typeof record.requestedAt !== 'string' || record.requestedAt === ''
    || typeof record.decisionStateDigest !== 'string' || !/^[0-9a-f]{64}$/.test(record.decisionStateDigest)
    || (record.runId !== undefined && (typeof record.runId !== 'string' || record.runId === ''))) {
    throw new Error('review gate binding 形状非法')
  }
  return {
    version: 1,
    phase: record.phase,
    event: record.event,
    requestedAt: record.requestedAt,
    decisionStateDigest: record.decisionStateDigest,
    ...(record.runId === undefined ? {} : { runId: record.runId }),
  }
}

export async function readReviewGateBinding(
  changeDir: string,
  readSource: BoundedFileHandleReader = readReviewGateBindingSource,
): Promise<ReviewGateBinding | undefined> {
  const target = join(changeDir, REVIEW_GATE_BINDING_FILE)
  const raw = await readOptionalBoundedRegularTextFile(
    target,
    MAX_REVIEW_GATE_BINDING_BYTES,
    'review gate binding',
    readSource,
  )
  if (raw === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('review gate binding JSON 非法')
  }
  const binding = parseBinding(value)
  if (`${JSON.stringify(binding)}\n` !== raw) {
    throw new Error('review gate binding 必须使用 canonical JSON bytes')
  }
  return binding
}

/** Must be called while the Change lock is held; it intentionally overwrites only this sidecar. */
export async function writeReviewGateBindingUnderLock(
  changeDir: string,
  binding: ReviewGateBinding,
): Promise<void> {
  await atomicReplaceFile(
    join(changeDir, REVIEW_GATE_BINDING_FILE),
    `${JSON.stringify(binding)}\n`,
  )
}

export function reviewGateBindingMatches(
  binding: ReviewGateBinding | undefined,
  state: PipelineState,
  phase: string,
  event: string,
): boolean {
  if (binding === undefined
    || binding.phase !== phase
    || binding.event !== event
    || binding.requestedAt !== scalar(state, 'review_requested_at')
    || binding.decisionStateDigest !== reviewGateDecisionStateDigest(state)) return false
  const runId = state.runMetadata?.runId
  return binding.runId === runId
}
