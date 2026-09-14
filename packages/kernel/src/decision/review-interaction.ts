import { interactionJourneyId } from '../interaction/contract.js'
import type { InteractionEventRecordDraft } from '../interaction/ports.js'
import type { ReviewAcknowledgedVia } from '../state/review-gate.js'
import type { RunRevision } from '../state/run-revision-codec.js'
import type { HistoryEntry, PipelineState } from '../types.js'
import { classifyInteractionWorkflowIdentity } from '../workflow/interaction-effect.js'

function scalar(state: PipelineState, field: keyof PipelineState['fields']): string {
  const value = state.fields[field]
  return Array.isArray(value) ? value.join(',') : (value ?? '')
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
  readonly surface: 'cli' | 'dashboard'
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
  return {
    change: input.change,
    runId: current.runId,
    workflow: input.workflow,
    workflowHash: input.workflowHash,
    originStepVisit,
    stepVisit,
    stateBeforeHash: input.beforeRevision.stateDigest,
    stateAfterHash: input.revision.stateDigest,
    // The entry route is capability evidence, not operator identity: the actor is never human.
    actor: 'system',
    surface: input.surface,
    executionMode: 'interactive',
    workflowMode: input.workflowMode,
    track: input.track,
    trackKind: input.trackKind,
    pipelineStage: input.pipelineStage,
    journeyId: interactionJourneyId({
      change: input.change, runId: origin.runId, originStepVisit, reviewEvent: input.event, requestedAt: input.requestedAt,
    }),
    controlStage: 'verification',
    event: 'review.acknowledged',
    reasonCode: 'decision.accepted',
    triggerCode: 'review.acknowledge',
    effectCode: 'review-gate.approved',
    result: 'success',
    outcomeCode: 'review.acknowledged',
    occurredAt: input.acknowledgedAt,
    durationMs: 0,
  }
}

/** Derive the acknowledgement draft from the committed revisions; identical for every channel. */
export function reviewAcknowledgedInteractionFor(input: {
  /** Approved state as read through the StateStore; it carries the workflow governance binding. */
  readonly state: PipelineState
  readonly change: string
  readonly phase: string
  readonly event: string
  readonly channel: ReviewAcknowledgedVia
  readonly acknowledgedAt: string
  readonly before: RunRevision
  readonly after: RunRevision
}): InteractionEventRecordDraft {
  const state = input.state
  const workflow = scalar(state, 'workflow') || 'default'
  const track = scalar(state, 'track')
  // Canonical revisions omit the governance binding; the StateStore view restores it.
  const workflowHash = state.runMetadata?.workflowPlanFingerprint
    ?? input.after.state.runMetadata?.workflowPlanFingerprint
    ?? input.before.state.runMetadata?.workflowPlanFingerprint
  if (workflowHash === undefined) throw new Error('interaction projection 缺 workflow/run anchor')
  return reviewAcknowledgedInteractionDraft({
    change: input.change,
    state,
    revision: input.after,
    beforeRevision: input.before,
    phase: input.phase,
    event: input.event,
    requestedAt: scalar(input.before.state, 'review_requested_at'),
    acknowledgedAt: input.acknowledgedAt,
    surface: input.channel === 'dashboard' ? 'dashboard' : 'cli',
    workflow,
    workflowHash,
    track,
    ...classifyInteractionWorkflowIdentity({ workflow, track, step: input.phase }),
  })
}

/** One history line format for every acknowledgement channel. */
export function reviewAcknowledgeHistoryEntry(input: {
  readonly acknowledgedAt: string
  readonly phase: string
  readonly event: string
  readonly channel: ReviewAcknowledgedVia
  /** Channel-specific audit suffix, e.g. the delegated authority reference. */
  readonly detail?: string
}): HistoryEntry {
  const detail = input.detail === undefined || input.detail === '' ? '' : ` ${input.detail}`
  return {
    ts: input.acknowledgedAt,
    kind: 'tool',
    raw: `review:acknowledge via=${input.channel} phase=${input.phase} event=${input.event}${detail}`,
  }
}
