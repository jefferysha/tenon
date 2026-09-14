import {
  interactionJourneyId,
  isDefaultWorkflowName,
  type InteractionEventRecorder,
  type InteractionEventRecordDraft,
  type InteractionEventV1,
  type InteractionStepVisit,
  type PipelineState,
  type RunRevision,
} from '@tenon/kernel'

export interface InteractionCapture {
  readonly recordReviewRequested: (input: ReviewCaptureInput) => Promise<InteractionEventV1>
  readonly recordResume: (input: ResumeCaptureInput) => Promise<InteractionEventV1>
}

interface CommonCaptureInput {
  readonly changeDir: string
  readonly changeName: string
  readonly state: PipelineState
  readonly revision: RunRevision
  readonly clock?: string
  readonly durationMs?: number
}

interface ReviewCaptureInput extends CommonCaptureInput {
  readonly event: string
  readonly requestedAt?: string
  readonly beforeRevision?: RunRevision
  readonly suppressed?: boolean
}

interface ResumeCaptureInput extends CommonCaptureInput {
  readonly effectRevision: RunRevision
  readonly result: 'success' | 'rejected'
  readonly journeyId?: string
  readonly originStepVisit?: InteractionStepVisit
}

function scalar(state: PipelineState, field: keyof PipelineState['fields']): string {
  const value = state.fields[field]
  return Array.isArray(value) ? value.join(',') : (value ?? '')
}

function workflowMode(workflow: string): 'default' | 'custom' {
  return isDefaultWorkflowName(workflow) ? 'default' : 'custom'
}

function trackKind(track: string): 'built-in' | 'free' | 'custom' {
  if (track === 'free') return 'free'
  if (['chat', 'simple', 'pm', 'frontend', 'backend'].includes(track)) return 'built-in'
  return 'custom'
}

function pipelineStage(step: string): 'open' | 'explore' | 'spec' | 'build' | 'verify' | 'ship' | 'archive' | 'custom' {
  return ['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive'].includes(step)
    ? step as 'open' | 'explore' | 'spec' | 'build' | 'verify' | 'ship' | 'archive'
    : 'custom'
}

function visit(revision: RunRevision, state: PipelineState): InteractionStepVisit {
  const revisionMetadata = revision.state.runMetadata
  const stateMetadata = state.runMetadata
  const runId = revisionMetadata?.runId ?? stateMetadata?.runId
  const transitionSequence = revisionMetadata?.transitionSequence ?? stateMetadata?.transitionSequence
  if (runId === undefined || transitionSequence === undefined) {
    throw new Error('interaction projection 缺 run identity')
  }
  const step = scalar(state, 'phase')
  return { runId, transitionSequence, step }
}

function common(input: CommonCaptureInput, revision: RunRevision): Pick<InteractionEventRecordDraft,
  'change' | 'runId' | 'workflow' | 'workflowHash' | 'originStepVisit' | 'stepVisit' | 'stateBeforeHash' |
  'stateAfterHash' | 'actor' | 'surface' | 'executionMode' | 'workflowMode' | 'track' | 'trackKind' |
  'pipelineStage' | 'controlStage' | 'occurredAt' | 'durationMs'> {
  const revisionMetadata = revision.state.runMetadata
  const stateMetadata = input.state.runMetadata
  const runId = revisionMetadata?.runId ?? stateMetadata?.runId
  const workflowPlanFingerprint = revisionMetadata?.workflowPlanFingerprint
    ?? stateMetadata?.workflowPlanFingerprint
  if (runId === undefined || workflowPlanFingerprint === undefined) {
    throw new Error('interaction projection 缺 workflow/run anchor')
  }
  const workflow = scalar(input.state, 'workflow') || 'default'
  const track = scalar(input.state, 'track')
  const currentVisit = visit(revision, input.state)
  return {
    change: input.changeName,
    runId,
    workflow,
    workflowHash: workflowPlanFingerprint,
    originStepVisit: currentVisit,
    stepVisit: currentVisit,
    stateBeforeHash: revision.stateDigest,
    stateAfterHash: revision.stateDigest,
    // The terminal route is capability evidence, not operator identity; the actor is never human.
    actor: 'system',
    surface: 'cli',
    executionMode: 'interactive',
    workflowMode: workflowMode(workflow),
    track,
    trackKind: trackKind(track),
    pipelineStage: pipelineStage(scalar(input.state, 'phase')),
    controlStage: 'verification',
    occurredAt: input.clock ?? new Date().toISOString(),
    durationMs: input.durationMs ?? 0,
  }
}

function journey(input: CommonCaptureInput, origin: RunRevision, event: string, requestedAt: string): string {
  const metadata = origin.state.runMetadata ?? input.state.runMetadata
  if (metadata === undefined) throw new Error('interaction projection 缺 run identity')
  return interactionJourneyId({
    change: input.changeName,
    runId: metadata.runId,
    originStepVisit: visit(origin, input.state),
    reviewEvent: event,
    requestedAt,
  })
}

export function createInteractionCapture(recorder: InteractionEventRecorder, clock: () => string): InteractionCapture {
  const write = (changeDir: string, draft: InteractionEventRecordDraft): Promise<InteractionEventV1> => recorder.recordUnderLock(changeDir, draft)
  return {
    recordReviewRequested: async (input) => {
      const origin = input.beforeRevision ?? input.revision
      const requestedAt = input.requestedAt ?? input.clock ?? clock()
      const base = common(input, input.revision)
      const suppressed = input.suppressed === true
      return write(input.changeDir, {
        ...base,
        journeyId: journey(input, origin, input.event, requestedAt),
        originStepVisit: visit(origin, input.state),
        stepVisit: visit(input.revision, input.state),
        stateBeforeHash: origin.stateDigest,
        stateAfterHash: input.revision.stateDigest,
        event: suppressed ? 'review.prompt-suppressed' : 'review.requested',
        reasonCode: suppressed ? 'review.same-state-repeat' : 'review.required',
        triggerCode: 'review.exit-requested',
        effectCode: 'review-gate.pending',
        result: suppressed ? 'suppressed' : 'success',
        outcomeCode: suppressed ? 'review.prompt-suppressed' : 'review.requested',
        occurredAt: input.clock ?? requestedAt,
      })
    },
    recordResume: async (input) => {
      const effect = input.effectRevision
      const requestedAt = scalar(effect.state, 'review_requested_at') || input.clock || clock()
      const base = common(input, input.revision)
      const origin = effect
      return write(input.changeDir, {
        ...base,
        journeyId: input.journeyId ?? journey(input, origin, scalar(effect.state, 'review_gate_event') || 'review', requestedAt),
        originStepVisit: input.originStepVisit ?? visit(origin, effect.state),
        stepVisit: visit(input.revision, input.state),
        stateBeforeHash: input.revision.stateDigest,
        stateAfterHash: input.revision.stateDigest,
        actor: 'system',
        controlStage: 'exact-resume',
        event: 'resume.validated',
        reasonCode: input.result === 'success' ? 'resume.valid' : 'resume.state-mismatch',
        triggerCode: 'session.activate',
        effectCode: 'resume.bound',
        result: input.result,
        outcomeCode: input.result === 'success' ? 'resume.valid' : 'resume.state-mismatch',
        occurredAt: input.clock ?? clock(),
      })
    },
  }
}
