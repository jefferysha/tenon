import { createHash } from 'node:crypto'
import { diffLegacyChannelWireFieldsToEffects, diffWireFieldsToEffects } from './run-metadata.js'
import type { RunRevision } from './run-revision-codec.js'
import { RunStateCorruptError } from './run-revision-validation.js'
import { parseTransitionRecord } from './transition-record-store.js'
import {
  assertTransitionHeadAnchorMatchesMetadata,
  readTransitionHeadAnchor,
  transitionHeadAnchorMatchesMetadata,
} from './transition-head-anchor.js'
import type { TransitionRecord } from '../workflow/run-types.js'

function ownRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return Object.fromEntries(Object.entries(value))
}

/** Core run identity/head invariants shared by publish and all canonical readers. */
export function assertRunMetadataContinuity(
  current: RunRevision,
  previous: RunRevision,
): void {
  const before = previous.state.runMetadata
  const after = current.state.runMetadata
  const beforeAnchor = readTransitionHeadAnchor(previous.state)
  const afterAnchor = readTransitionHeadAnchor(current.state)
  if (current.mutation.kind === 'transition') {
    if (after === undefined
      || (before !== undefined && after.runId !== before.runId)
      || after.transitionSequence !== (before?.transitionSequence ?? 0) + 1
      || after.transitionHead !== current.mutation.transitionRecordId) {
      throw new RunStateCorruptError('transition revision 的 runMetadata head/sequence 链不连续')
    }
    // Revisions published before the anchor format remain readable. Every new publisher writes
    // the anchor; legacy readers fall back to the bounded committing-revision validation path.
    if (afterAnchor !== undefined && transitionHeadAnchorMatchesMetadata(afterAnchor, after)) {
      if (afterAnchor.recordDigest !== current.mutation.transitionRecordDigest) {
        throw new RunStateCorruptError('transition revision 的 transition head anchor digest 不匹配')
      }
      assertTransitionHeadAnchorMatchesMetadata(afterAnchor, after)
    } else if (afterAnchor !== undefined
      && JSON.stringify(afterAnchor) !== JSON.stringify(beforeAnchor)) {
      throw new RunStateCorruptError('transition revision 携带未知的 stale transition head anchor')
    }
    return
  }
  if (before === undefined) {
    if (after !== undefined
      && (after.transitionSequence !== 0 || after.transitionHead !== undefined)) {
      throw new RunStateCorruptError('非 transition revision 不得伪造历史 transition head')
    }
    if (afterAnchor !== undefined) {
      throw new RunStateCorruptError('无 canonical runMetadata 的 revision 不得携带 transition head anchor')
    }
    return
  }
  if (after === undefined
    || after.runId !== before.runId
    || after.transitionSequence !== before.transitionSequence
    || after.transitionHead !== before.transitionHead) {
    throw new RunStateCorruptError('非 transition revision 不得改写 runMetadata head/sequence')
  }
  if (JSON.stringify(afterAnchor) !== JSON.stringify(beforeAnchor)) {
    throw new RunStateCorruptError('非 transition revision 不得改写 transition head anchor')
  }
  // N-1 may preserve a stale opaqueTail anchor across a transition and later set revisions. The
  // bounded committing-revision reader validates that head; do not grant stale anchor authority.
  if (afterAnchor !== undefined && transitionHeadAnchorMatchesMetadata(afterAnchor, after)) {
    assertTransitionHeadAnchorMatchesMetadata(afterAnchor, after)
  }
}

export function assertMutationEffects(current: RunRevision, previous: RunRevision): void {
  const observed = JSON.stringify(current.mutation.effects)
  const expected = JSON.stringify(diffWireFieldsToEffects(previous.state.fields, current.state.fields))
  // Unreleased development builds kept the channel in the wire and therefore in effects. Both
  // shapes are exact diffs of the same hydrated logical states; they differ only in that entry.
  if (observed !== expected
    && observed !== JSON.stringify(
      diffLegacyChannelWireFieldsToEffects(previous.state.fields, current.state.fields),
    )) {
    throw new RunStateCorruptError('canonical mutation.effects 与 previous→current 真实 diff 不一致')
  }
  assertRunMetadataContinuity(current, previous)
}

export function assertTransitionRevisionLink(
  current: RunRevision,
  transition: unknown,
  raw: string,
  previous?: RunRevision,
): TransitionRecord {
  const observedDigest = createHash('sha256').update(raw).digest('hex')
  if (observedDigest !== current.mutation.transitionRecordDigest) {
    throw new RunStateCorruptError('TransitionRecord digest 与 canonical revision 审计绑定不一致')
  }
  const metadata = current.state.runMetadata
  if (metadata === undefined || metadata.transitionHead === undefined
    || metadata.transitionSequence < 1) {
    throw new RunStateCorruptError('transition revision 缺 canonical run head/sequence')
  }
  let parsed: TransitionRecord
  try {
    parsed = parseTransitionRecord(transition, 'canonical transition revision')
  } catch (error) {
    throw new RunStateCorruptError(`TransitionRecord schema 损坏: ${String(error)}`)
  }
  const record = ownRecord(parsed)
  if (record === undefined) throw new RunStateCorruptError('transition revision 引用的 TransitionRecord 缺失')
  const previousPhase = previous?.state.fields.phase
  const currentPhase = current.state.fields.phase
  const workflowId = String(current.state.fields.workflow || 'default')
  if (record.id !== current.mutation.transitionRecordId
    || record.sequence !== metadata.transitionSequence
    || record.runId !== metadata.runId
    || (previous !== undefined
      && record.previousRecordId !== previous.state.runMetadata?.transitionHead)
    || (previous !== undefined && record.from !== previousPhase)
    || record.to !== currentPhase
    || record.workflowId !== workflowId
    || JSON.stringify(record.effects) !== JSON.stringify(current.mutation.effects)) {
    throw new RunStateCorruptError('transition revision 与 TransitionRecord 不一致')
  }
  return parsed
}

export function assertDirectPredecessor(
  revision: RunRevision,
  previous: RunRevision | undefined,
): RunRevision {
  if (revision.revision < 1 || previous === undefined) {
    throw new RunStateCorruptError('transition revision 引用的 previous revision 缺失')
  }
  if (previous.revisionId !== revision.previousRevisionId
    || previous.revision !== revision.revision - 1) {
    throw new RunStateCorruptError('transition revision 引用的 previous revision 身份不一致')
  }
  assertMutationEffects(revision, previous)
  return previous
}
