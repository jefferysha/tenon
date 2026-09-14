/**
 * Revision-bound storage for the logical canonical `review_acknowledged_via`.
 *
 * The field records the entry route of a review acknowledgement. The schemaVersion=1 wire,
 * mutation/TransitionRecord effects and the YAML projection keep the field closure that earlier
 * runtimes read, so the value lives in its own immutable companion keyed by revision + revisionId
 * and bound to that revision's `stateDigest`.
 *
 * - The record is published before the immutable revision/current pointer, and only when the value
 *   is not `unknown`; a crash can only leave an unreachable orphan.
 * - A missing record reads as `unknown`. That covers fresh changes, released revisions, and any
 *   revision written by an earlier runtime (which never writes this record).
 * - The released pre-Verify companion and its opaqueTail anchor stay byte-for-byte unchanged:
 *   runtimes v1.0.7–v1.0.9 validate their exact shape and digest. The channel is provenance and
 *   never authorises a transition, so its content is bound to the revision by identity and digest
 *   rather than by an extra wire anchor that earlier runtimes and the oracle would observe.
 * - Revisions from unreleased development builds carried the channel inside wire `state.fields`.
 *   Without a record the parsed wire value is kept; the next write publishes this companion shape.
 */
import { lstat, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  REVIEW_ACKNOWLEDGED_VIA_DEFAULT,
  REVIEW_ACKNOWLEDGED_VIA_FIELD,
  REVIEW_ACKNOWLEDGED_VIA_VALUES,
} from '../types.js'
import { atomicLinkPublish } from './atomic-publish.js'
import type { RunRevision } from './run-revision-codec.js'
import { RunStateCorruptError } from './run-revision-validation.js'

export const REVIEW_ACKNOWLEDGED_VIA_DIR = 'review-acknowledged-via'
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/
const ALLOWED_VALUES: ReadonlySet<string> = new Set(REVIEW_ACKNOWLEDGED_VIA_VALUES)

interface ReviewAcknowledgedViaRecord {
  readonly schemaVersion: 1
  readonly revision: number
  readonly revisionId: string
  readonly stateDigest: string
  readonly via: string
}

function errnoCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const code = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : undefined
}

export function reviewAcknowledgedViaRelativePath(revision: number, revisionId: string): string {
  return join(
    '.pipeline-run',
    REVIEW_ACKNOWLEDGED_VIA_DIR,
    `${String(revision).padStart(6, '0')}-${revisionId}.json`,
  )
}

function parseRecord(raw: string, source: string): ReviewAcknowledgedViaRecord {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new RunStateCorruptError(`${source}: review channel companion JSON 损坏（${String(error)}）`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RunStateCorruptError(`${source}: review channel companion 不是对象`)
  }
  const record = Object.fromEntries(Object.entries(value))
  if (Object.keys(record).sort().join(',') !== 'revision,revisionId,schemaVersion,stateDigest,via'
    || record.schemaVersion !== 1
    || typeof record.revision !== 'number'
    || !Number.isSafeInteger(record.revision) || record.revision < 0
    || typeof record.revisionId !== 'string' || !SAFE_ID_RE.test(record.revisionId)
    || typeof record.stateDigest !== 'string' || !/^[0-9a-f]{64}$/.test(record.stateDigest)
    || typeof record.via !== 'string' || !ALLOWED_VALUES.has(record.via)) {
    throw new RunStateCorruptError(`${source}: review channel companion 形状非法`)
  }
  return {
    schemaVersion: 1,
    revision: record.revision,
    revisionId: record.revisionId,
    stateDigest: record.stateDigest,
    via: record.via,
  }
}

function attach(revision: RunRevision, record?: ReviewAcknowledgedViaRecord): RunRevision {
  if (record === undefined) return revision
  if (record.revision !== revision.revision
    || record.revisionId !== revision.revisionId
    || record.stateDigest !== revision.stateDigest) {
    throw new RunStateCorruptError('review channel companion 与 canonical revision 身份/摘要不一致')
  }
  return {
    ...revision,
    state: {
      ...revision.state,
      fields: { ...revision.state.fields, [REVIEW_ACKNOWLEDGED_VIA_FIELD]: record.via },
    },
  }
}

/** `revision` must come from `createRunRevision`, whose logical state has a validated channel. */
export async function publishReviewAcknowledgedViaRecord(
  changeDir: string,
  revision: RunRevision,
): Promise<void> {
  const via = revision.state.fields[REVIEW_ACKNOWLEDGED_VIA_FIELD]
  if (via === REVIEW_ACKNOWLEDGED_VIA_DEFAULT) return
  if (typeof via !== 'string' || !ALLOWED_VALUES.has(via)) {
    throw new RunStateCorruptError(`canonical ${REVIEW_ACKNOWLEDGED_VIA_FIELD} 非法`)
  }
  const dir = join(changeDir, '.pipeline-run', REVIEW_ACKNOWLEDGED_VIA_DIR)
  await mkdir(dir, { recursive: true })
  const record: ReviewAcknowledgedViaRecord = {
    schemaVersion: 1,
    revision: revision.revision,
    revisionId: revision.revisionId,
    stateDigest: revision.stateDigest,
    via,
  }
  await atomicLinkPublish(
    dir,
    '.tmp',
    join(changeDir, reviewAcknowledgedViaRelativePath(revision.revision, revision.revisionId)),
    `${JSON.stringify(record)}\n`,
  )
}

export async function hydrateReviewAcknowledgedVia(
  changeDir: string,
  revision: RunRevision,
): Promise<RunRevision> {
  const target = join(changeDir, reviewAcknowledgedViaRelativePath(revision.revision, revision.revisionId))
  let info
  try {
    info = await lstat(target)
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return attach(revision)
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new RunStateCorruptError(`${target}: review channel companion 必须是非 symlink 普通文件`)
  }
  return attach(revision, parseRecord(await readFile(target, 'utf8'), target))
}

export function hydrateReviewAcknowledgedViaFromSync(
  readText: (relativePath: string) => string | undefined,
  revision: RunRevision,
  sourceRoot = 'canonical state',
): RunRevision {
  const relative = reviewAcknowledgedViaRelativePath(revision.revision, revision.revisionId)
  const raw = readText(relative)
  return attach(revision, raw === undefined ? undefined : parseRecord(raw, join(sourceRoot, relative)))
}
