import { reviewGateApprovedFor, reviewGatePendingFor, reviewGateApprovalPatch, type ReviewAcknowledgedVia } from '../state/review-gate.js'
import type { PipelineState } from '../types.js'
import { interactionJourneyId } from '../interaction/contract.js'
import type { InteractionEventRecordDraft } from '../interaction/ports.js'
import type { RunRevision } from '../state/run-revision-codec.js'

function scalar(state: PipelineState, key: keyof PipelineState['fields']): string {
  const value = state.fields[key]
  return Array.isArray(value) ? value.join(',') : (value ?? '')
}

function workflowMode(workflow: string): 'default' | 'custom' { return workflow === 'default' ? 'default' : 'custom' }
function trackKind(track: string): 'built-in' | 'free' | 'custom' {
  if (track === 'free') return 'free'
  return ['chat', 'simple', 'pm', 'frontend', 'backend'].includes(track) ? 'built-in' : 'custom'
}
function pipelineStage(step: string): 'open' | 'explore' | 'spec' | 'build' | 'verify' | 'ship' | 'archive' | 'custom' {
  return ['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive'].includes(step) ? step as never : 'custom'
}

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
}): InteractionEventRecordDraft {
  const workflow = scalar(input.state, 'workflow') || 'default'
  const track = scalar(input.state, 'track') || 'backend'
  const origin = input.beforeRevision.state.runMetadata
  const current = input.revision.state.runMetadata
  if (origin === undefined || current === undefined) throw new Error('interaction projection 缺 run identity')
  const originStepVisit = { runId: origin.runId, transitionSequence: origin.transitionSequence, step: input.phase }
  const stepVisit = { runId: current.runId, transitionSequence: current.transitionSequence, step: input.phase }
  const rejected = input.rejected === true
  return {
    change: input.change, runId: current.runId, workflow,
    workflowHash: current.workflowPlanFingerprint ?? '0'.repeat(64), originStepVisit, stepVisit,
    stateBeforeHash: input.beforeRevision.stateDigest, stateAfterHash: input.revision.stateDigest,
    actor: input.actor ?? 'system', surface: input.surface, executionMode: 'interactive', workflowMode: workflowMode(workflow), track, trackKind: trackKind(track), pipelineStage: pipelineStage(input.phase),
    
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
    return { changed: false, acknowledgedAt: input.acknowledgedAt, deferred }
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
  return { changed: true, acknowledgedAt: input.acknowledgedAt, deferred }
}
