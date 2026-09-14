import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TransitionRecord } from '../workflow/run-types.js'
import {
  parseRunRevision,
  type RunRevision,
} from './run-revision-codec.js'
import { RunStateCorruptError } from './run-revision-validation.js'
import {
  assertDirectPredecessor,
  assertMutationEffects,
  assertTransitionRevisionLink,
} from './run-revision-continuity.js'
import { hydrateCompanionsFromSync } from './revision-companions.js'
import {
  readCurrentRunRevision,
  readCurrentRunRevisionFromSync,
  readImmutableRunRevision,
  type RunRevisionTextReader,
  RUN_REVISIONS_DIR,
  RUN_STATE_DIR,
} from './run-revision-store.js'
import {
  validateAnchoredTransitionHead,
  validateAnchoredTransitionHeadFromSync,
} from './transition-head-anchor.js'
import { TRANSITION_RECORDS_DIR } from './transition-record-store.js'

const MAX_LEGACY_REVISIONS = 64
const MAX_SYNC_CANONICAL_BYTES = 8 * 1024 * 1024

function previousRevisionIdFor(revision: RunRevision): string {
  if (revision.previousRevisionId === undefined) {
    throw new RunStateCorruptError('非初始 revision 缺 previousRevisionId')
  }
  return revision.previousRevisionId
}

function revisionFileName(revision: number, revisionId: string): string {
  return `${String(revision).padStart(6, '0')}-${revisionId}.json`
}

async function readRegularTextIfExists(pathname: string): Promise<string | undefined> {
  try {
    const entry = await lstat(pathname)
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new RunStateCorruptError(`${pathname}: canonical 文件必须是非 symlink 普通文件`)
    }
    return await readFile(pathname, 'utf8')
  } catch (error) {
    if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

function transitionRelativePath(revision: RunRevision): string {
  const metadata = revision.state.runMetadata
  if (revision.mutation.kind !== 'transition' || metadata?.transitionHead === undefined
    || metadata.transitionSequence < 1) {
    throw new RunStateCorruptError('transition revision 缺 canonical run head/sequence')
  }
  return join(
    TRANSITION_RECORDS_DIR,
    `${String(metadata.transitionSequence).padStart(6, '0')}-${revision.mutation.transitionRecordId}.json`,
  )
}

function validateCommittingRecord(
  cursor: RunRevision,
  previous: RunRevision,
  raw: string,
): TransitionRecord {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new RunStateCorruptError(`TransitionRecord 损坏: ${String(error)}`)
  }
  return assertTransitionRevisionLink(cursor, parsed, raw, previous)
}

/**
 * Resolve the current metadata head through its immutable committing revision. New revisions use
 * an O(1) digest anchor; pre-anchor or N-1-preserved stale anchors use a bounded compatibility walk.
 */
export async function readValidatedTransitionHead(
  changeDir: string,
): Promise<{ readonly current: RunRevision; readonly record: TransitionRecord } | undefined> {
  const current = await readCurrentRunRevision(changeDir)
  const metadata = current?.state.runMetadata
  if (current === undefined || metadata?.transitionHead === undefined
    || metadata.transitionSequence < 1) return undefined
  const anchored = await validateAnchoredTransitionHead(
    current,
    (relativePath) => readRegularTextIfExists(join(changeDir, relativePath)),
    changeDir,
  )
  if (anchored !== undefined) return { current, record: anchored }
  let cursor = current
  for (let traversed = 0; traversed < MAX_LEGACY_REVISIONS; traversed++) {
    if (cursor.revision === 0) break
    const previousId = previousRevisionIdFor(cursor)
    const previous = await readImmutableRunRevision(changeDir, cursor.revision - 1, previousId)
    const bound = assertDirectPredecessor(cursor, previous)
    if (cursor.mutation.kind === 'transition'
      && cursor.mutation.transitionRecordId === metadata.transitionHead) {
      const raw = await readRegularTextIfExists(join(changeDir, transitionRelativePath(cursor)))
      if (raw === undefined) throw new RunStateCorruptError('canonical head TransitionRecord 缺失')
      const record = validateCommittingRecord(cursor, bound, raw)
      if (record.sequence !== metadata.transitionSequence || record.runId !== metadata.runId) {
        throw new RunStateCorruptError('canonical transition head 与提交 revision 不一致')
      }
      return { current, record }
    }
    cursor = bound
  }
  throw new RunStateCorruptError('legacy canonical transition head 超过兼容校验上限或缺提交 revision')
}

/**
 * Trusted synchronous variant. The byte budget includes current/twin/predecessor/head reads and
 * the legacy walk, bounding work before the server is allowed to touch the document ledger.
 */
export function readValidatedTransitionHeadFromSync(
  readText: RunRevisionTextReader,
  sourceRoot = 'canonical state',
): { readonly current: RunRevision; readonly record?: TransitionRecord } | undefined {
  let totalBytes = 0
  const boundedRead: RunRevisionTextReader = (relativePath) => {
    const raw = readText(relativePath)
    if (raw === undefined) return undefined
    totalBytes += Buffer.byteLength(raw, 'utf8')
    if (totalBytes > MAX_SYNC_CANONICAL_BYTES) {
      throw new RunStateCorruptError('canonical trusted read 超过 8 MiB 兼容校验上限')
    }
    return raw
  }
  const current = readCurrentRunRevisionFromSync(boundedRead, sourceRoot)
  const metadata = current?.state.runMetadata
  if (current === undefined) return undefined
  if (metadata?.transitionHead === undefined || metadata.transitionSequence < 1) return { current }
  const anchored = validateAnchoredTransitionHeadFromSync(current, boundedRead, sourceRoot)
  if (anchored !== undefined) return { current, record: anchored }
  const revisionsRel = join(RUN_STATE_DIR, RUN_REVISIONS_DIR)
  let cursor = current
  for (let traversed = 0; traversed < MAX_LEGACY_REVISIONS; traversed++) {
    if (cursor.revision === 0) break
    const previousId = previousRevisionIdFor(cursor)
    const previousRel = join(
      revisionsRel,
      revisionFileName(cursor.revision - 1, previousId),
    )
    const previousRaw = boundedRead(previousRel)
    const previous = assertDirectPredecessor(
      cursor,
      previousRaw === undefined
        ? undefined
        : hydrateCompanionsFromSync(
            boundedRead,
            parseRunRevision(previousRaw, join(sourceRoot, previousRel)),
            sourceRoot,
          ),
    )
    if (cursor.mutation.kind === 'transition'
      && cursor.mutation.transitionRecordId === metadata.transitionHead) {
      const relativePath = transitionRelativePath(cursor)
      const raw = boundedRead(relativePath)
      if (raw === undefined) throw new RunStateCorruptError('canonical head TransitionRecord 缺失')
      const record = validateCommittingRecord(cursor, previous, raw)
      if (record.sequence !== metadata.transitionSequence || record.runId !== metadata.runId) {
        throw new RunStateCorruptError('canonical transition head 与提交 revision 不一致')
      }
      return { current, record }
    }
    cursor = previous
  }
  throw new RunStateCorruptError('legacy canonical transition head 超过兼容校验上限或缺提交 revision')
}
