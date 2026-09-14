import { reviewGateApprovedFor, reviewGatePendingFor, reviewGateApprovalPatch, type ReviewAcknowledgedVia } from '../state/review-gate.js'
import type { PipelineState } from '../types.js'
import { interactionJourneyId } from '../interaction/contract.js'
import type { InteractionEventRecordDraft } from '../interaction/ports.js'
import type { RunRevision } from '../state/run-revision-codec.js'
import { reviewGateDecisionStateDigest } from '../state/review-gate-binding.js'
import { createHash } from 'node:crypto'

/** Shared, model-free interaction draft used by CLI and Dashboard review acknowledgements. */
export function reviewAcknowledgedInteractionDraft(input: {
  readonly change: string
  readonly state: PipelineState
  readonly revision: RunRevision
  readonly beforeRevision: RunRevision
  readonly phase: string
  readonly event: string
  readonly requestedAt: string
  readonly acknowledgedAt: string
  readonly rejected?: boolean
  readonly surface: 'cli' | 'dashboard'
  readonly actor?: 'human' | 'system'
  readonly workflow: string
  readonly workflowHash: string
  readonly track: string
  readonly trackKind: InteractionEventRecordDraft['trackKind']
  readonly workflowMode: InteractionEventRecordDraft['workflowMode']
  readonly pipelineStage: InteractionEventRecordDraft['pipelineStage']
  readonly originStepVisit?: InteractionEventRecordDraft['originStepVisit']
  readonly stepVisit?: InteractionEventRecordDraft['stepVisit']
}): InteractionEventRecordDraft {
  const origin = input.beforeRevision.state.runMetadata
  const current = input.revision.state.runMetadata
  if (origin === undefined || current === undefined) throw new Error('interaction projection 缺 run identity')
  const originStepVisit = input.originStepVisit ?? { runId: origin.runId, transitionSequence: origin.transitionSequence, step: input.phase }
  const stepVisit = input.stepVisit ?? { runId: current.runId, transitionSequence: current.transitionSequence, step: input.phase }
  const rejected = input.rejected === true
  return {
    change: input.change, runId: current.runId, workflow: input.workflow,
    workflowHash: input.workflowHash, originStepVisit, stepVisit,
    stateBeforeHash: input.beforeRevision.stateDigest, stateAfterHash: input.revision.stateDigest,
    actor: input.actor ?? 'system', surface: input.surface, executionMode: 'interactive', workflowMode: input.workflowMode, track: input.track, trackKind: input.trackKind, pipelineStage: input.pipelineStage,
    
    journeyId: interactionJourneyId({ change: input.change, runId: origin.runId, originStepVisit, reviewEvent: input.event, requestedAt: input.requestedAt }),
    controlStage: 'verification', event: 'review.acknowledged',
    reasonCode: rejected ? 'decision.state-stale' : 'decision.accepted', triggerCode: 'review.acknowledge',
    effectCode: rejected ? 'review-gate.rejected' : 'review-gate.approved', result: rejected ? 'rejected' : 'success',
    outcomeCode: 'review.acknowledged', occurredAt: input.acknowledgedAt, durationMs: 0,
  }
}

/**
 * Platform-neutral review acknowledge orchestration. CLI and Dashboard adapt their own IO,
 * marker and history ports around this function; neither surface owns a second receipt protocol.
 */
export interface ReviewAcknowledgeApplicationInput {
  readonly state: PipelineState
  readonly phase: string
  readonly event: string
  readonly acknowledgedAt: string
  readonly via?: ReviewAcknowledgedVia
  readonly bindingMatches: boolean
  readonly writeState: (patch: Partial<Record<string, string>>) => Promise<void>
  readonly recordInteraction?: (input: { readonly state: PipelineState; readonly acknowledgedAt: string; readonly rejected?: boolean }) => Promise<void>
  readonly recordHistory?: (input: { readonly acknowledgedAt: string; readonly phase: string; readonly event: string; readonly rejected?: boolean }) => Promise<void>
  /** Returns false when the marker could not be cleared; this is a deferred projection, not a
   * reason to roll back the canonical receipt. */
  readonly clearMarker?: () => Promise<boolean | void>
  readonly recordRejectedAcknowledgement?: (input: { readonly state: PipelineState; readonly acknowledgedAt: string; readonly phase: string; readonly event: string }) => Promise<void>
  readonly onRejected?: (error: Error) => Promise<void>
}

export interface ReviewAcknowledgeApplicationResult {
  readonly changed: boolean
  readonly acknowledgedAt: string
  readonly deferred: readonly string[]
  /** Stable machine result for adapters; canonical failures remain thrown with no write. */
  readonly code: 'approved' | 'idempotent-replay' | 'marker-warning'
  readonly idempotent: boolean
}

export async function acknowledgeReview(input: ReviewAcknowledgeApplicationInput): Promise<ReviewAcknowledgeApplicationResult> {
  const deferred: string[] = []
  const reject = async (state: PipelineState, acknowledgedAt: string): Promise<void> => {
    if (input.recordRejectedAcknowledgement !== undefined) {
      await input.recordRejectedAcknowledgement({ state, acknowledgedAt, phase: input.phase, event: input.event })
    } else if (input.recordInteraction === undefined) deferred.push('rejected-acknowledgement-interaction')
  }
  if (!input.bindingMatches) {
    const error = new Error(`phase '${input.phase}' 的 review receipt 未绑定当前 canonical decision state；请重新 request ${input.event}`)
    if (input.onRejected !== undefined) await input.onRejected(error)
    if (input.recordInteraction !== undefined) {
      await input.recordInteraction({ state: input.state, acknowledgedAt: input.acknowledgedAt, rejected: true })
    } else {
      await reject(input.state, input.acknowledgedAt)
    }
    throw error
  }
  if (reviewGateApprovedFor(input.state, input.phase, input.event)) {
    return { changed: false, acknowledgedAt: input.acknowledgedAt, deferred, code: 'idempotent-replay', idempotent: true }
  }
  if (!reviewGatePendingFor(input.state, input.phase, input.event)) {
    const error = new Error(`phase '${input.phase}' 尚未为 event '${input.event}' request review`)
    if (input.onRejected !== undefined) await input.onRejected(error)
    if (input.recordInteraction === undefined) await reject(input.state, input.acknowledgedAt)
    throw error
  }
  const patch = reviewGateApprovalPatch(input.acknowledgedAt, input.via ?? 'terminal')
  await input.writeState(patch)
  if (input.recordInteraction !== undefined) {
    await input.recordInteraction({ state: { ...input.state, fields: { ...input.state.fields, ...patch } }, acknowledgedAt: input.acknowledgedAt })
  } else deferred.push('review-interaction')
  if (input.recordHistory !== undefined) await input.recordHistory({ acknowledgedAt: input.acknowledgedAt, phase: input.phase, event: input.event })
  else deferred.push('review-history')
  if (input.clearMarker !== undefined) {
    if ((await input.clearMarker()) === false) deferred.push('review-marker-clear')
  } else deferred.push('review-marker-clear')
  return {
    changed: true,
    acknowledgedAt: input.acknowledgedAt,
    deferred,
    code: deferred.includes('review-marker-clear') ? 'marker-warning' : 'approved',
    idempotent: false,
  }
}

/**
 * Shared command boundary for review acknowledgements. Adapters provide only storage and
 * projection ports; ordering and result codes stay identical for terminal and Dashboard.
 */
export type ReviewAcknowledgeCommandCode =
  | 'approved'
  | 'idempotent-replay'
  | 'review-approval-required'
  | 'revision-conflict'
  | 'idempotency-conflict'
  | 'invalid-input'
  | 'marker-warning'

export type ReviewAcknowledgeCommandResult =
  | { readonly ok: true; readonly code: 'approved' | 'idempotent-replay' | 'marker-warning'; readonly changed: boolean; readonly idempotent: boolean; readonly deferred: readonly string[] }
  | { readonly ok: false; readonly code: 'review-approval-required' | 'revision-conflict' | 'idempotency-conflict' | 'invalid-input'; readonly message: string }

export interface ReviewAcknowledgeCommandPort {
  readonly withLock: <T>(fn: () => Promise<T>) => Promise<T>
  readonly readState: () => Promise<PipelineState>
  readonly readRevision?: () => Promise<number | null>
  readonly expectedRevision?: number | null
  /** A fixed key is used by HTTP; the terminal adapter may derive it from the locked state. */
  /** A derived adapter key may be omitted when its trusted binding cannot be verified. */
  readonly idempotencyKey?: string | ((state: PipelineState) => string | undefined | Promise<string | undefined>)
  /** Returns replay/rejected/conflict/missing for the complete command payload. */
  readonly checkIdempotency?: (key: string) => Promise<'missing' | 'replay' | 'rejected' | 'conflict'>
  /** Stable failure code for a previously rejected command with the same payload. */
  readonly rejectedCode?: 'review-approval-required' | 'revision-conflict'
  readonly hasIdempotencyKey?: (key: string) => Promise<boolean>
  readonly rememberIdempotencyKey?: (key: string) => Promise<void>
  readonly phase: string
  readonly event: string
  readonly acknowledgedAt: string
  readonly via?: ReviewAcknowledgedVia
  readonly bindingMatches: (state: PipelineState) => Promise<boolean> | boolean
  /** Performs the canonical patch and all append-only projections while the Change lock is held. */
  readonly commit: (state: PipelineState, acknowledgedAt: string) => Promise<{ readonly deferred?: readonly string[] }>
  /** Best-effort append-only evidence for a rejected command. Must never mutate canonical state. */
  readonly recordRejected?: (state: PipelineState, reason: string) => Promise<void>
}

/** Stable terminal key derivation. The receipt fields are excluded from the state digest. */
export function deriveReviewAcknowledgeIdempotencyKey(input: {
  readonly change: string
  readonly phase: string
  readonly event: string
  readonly requestedAt: string
  readonly state: PipelineState
  readonly channel: ReviewAcknowledgedVia
}): string {
  const runId = input.state.runMetadata?.runId ?? ''
  const anchor = `${input.change}\0${input.phase}\0${input.event}\0${input.requestedAt}\0${reviewGateDecisionStateDigest(input.state)}\0${runId}\0${input.channel}`
  return `review-ack:${createHash('sha256').update(anchor, 'utf8').digest('hex')}`
}

/** Execute the common idempotency → receipt/binding → revision → commit journey under one lock. */
export async function executeReviewAcknowledgeCommand(
  port: ReviewAcknowledgeCommandPort,
): Promise<ReviewAcknowledgeCommandResult> {
  if (!port.phase || !port.event) return { ok: false, code: 'invalid-input', message: 'review phase and event are required' }
  if (port.expectedRevision !== undefined && port.expectedRevision === null) {
    return { ok: false, code: 'invalid-input', message: 'expected revision is required' }
  }
  return port.withLock(async () => {
    let state: PipelineState | undefined
    const key = typeof port.idempotencyKey === 'function'
      ? undefined
      : port.idempotencyKey
    if (key !== undefined && key === '') return { ok: false, code: 'invalid-input', message: 'idempotency key is required' }
    if (typeof port.idempotencyKey === 'function') state = await port.readState()
    const resolvedKey = typeof port.idempotencyKey === 'function'
      ? await port.idempotencyKey(state as PipelineState)
      : key
    if (resolvedKey !== undefined && resolvedKey === '') return { ok: false, code: 'invalid-input', message: 'idempotency key is required' }
    const idempotency = resolvedKey !== undefined && port.checkIdempotency !== undefined
      ? await port.checkIdempotency(resolvedKey)
      : resolvedKey !== undefined && port.hasIdempotencyKey !== undefined && await port.hasIdempotencyKey(resolvedKey)
        ? 'replay' : 'missing'
    if (idempotency === 'conflict') return { ok: false, code: 'idempotency-conflict', message: 'idempotency key is already bound to another decision' }
    if (idempotency === 'rejected') {
      const code = port.rejectedCode ?? 'review-approval-required'
      return { ok: false, code, message: 'the same decision command was previously rejected' }
    }
    if (idempotency === 'replay') {
      return { ok: true, code: 'idempotent-replay', changed: false, idempotent: true, deferred: [] }
    }
    state ??= await port.readState()
    const bindingMatches = await port.bindingMatches(state)
    if (!bindingMatches) {
      await port.recordRejected?.(state, 'review receipt binding mismatch')
      return { ok: false, code: 'review-approval-required', message: `phase '${port.phase}' 的 review receipt 未绑定当前 canonical decision state；请重新 request ${port.event}` }
    }
    if (port.expectedRevision !== undefined && port.readRevision !== undefined) {
      const current = await port.readRevision()
      if (current !== port.expectedRevision) {
        await port.recordRejected?.(state, 'decision revision conflict')
        return { ok: false, code: 'revision-conflict', message: 'decision revision conflict' }
      }
    }
    if (!reviewGatePendingFor(state, port.phase, port.event) && !reviewGateApprovedFor(state, port.phase, port.event)) {
      await port.recordRejected?.(state, 'review decision is no longer pending')
      return { ok: false, code: 'review-approval-required', message: `phase '${port.phase}' 尚未为 event '${port.event}' request review` }
    }
    if (reviewGateApprovedFor(state, port.phase, port.event)) {
      if (resolvedKey !== undefined) await port.rememberIdempotencyKey?.(resolvedKey)
      return { ok: true, code: 'idempotent-replay', changed: false, idempotent: true, deferred: [] }
    }
    const committed = await port.commit(state, port.acknowledgedAt)
    if (resolvedKey !== undefined) await port.rememberIdempotencyKey?.(resolvedKey)
    const deferred = committed.deferred ?? []
    return { ok: true, code: deferred.includes('review-marker-clear') ? 'marker-warning' : 'approved', changed: true, idempotent: false, deferred }
  })
}
