import { classifyInteractionWorkflowIdentity, type InteractionEventRecordDraft, type PipelineState, type RunRevision } from '@tenon/kernel'

type DecisionState = PipelineState

function scalar(state: DecisionState, key: keyof DecisionState['fields']): string {
  const value = state.fields[key]
  return Array.isArray(value) ? value.join(',') : (value ?? '')
}

/** Builds the redacted, model-free interaction receipt for a Dashboard review action. */
export function reviewInteractionDraft(input: {
  readonly change: string
  readonly state: DecisionState
  readonly revision: RunRevision | undefined
  readonly beforeRevision?: RunRevision
  readonly phase: string
  readonly event: string
  readonly acknowledgedAt: string
  readonly rejected?: boolean
}): InteractionEventRecordDraft | undefined {
  const metadata = input.revision?.state.runMetadata ?? input.state.runMetadata
  const before = input.beforeRevision ?? input.revision
  if (metadata === undefined || before === undefined) return undefined
  const workflow = scalar(input.state, 'workflow') || 'default'
  const track = scalar(input.state, 'track') || 'backend'
  const step = scalar(input.state, 'phase') || input.phase
  const visit = { runId: metadata.runId, transitionSequence: metadata.transitionSequence, step }
  const rejected = input.rejected === true
  const identity = classifyInteractionWorkflowIdentity({ workflow, track, step })
  return {
    change: input.change, runId: metadata.runId, workflow,
    // Legacy snapshots may not carry the fingerprint; zero is an explicit unknown sentinel.
    workflowHash: metadata.workflowPlanFingerprint ?? '0'.repeat(64),
    originStepVisit: visit, stepVisit: visit,
    stateBeforeHash: before.stateDigest, stateAfterHash: input.revision?.stateDigest ?? before.stateDigest,
    actor: 'human', surface: 'dashboard', executionMode: 'interactive',
    ...identity, track,
    controlStage: 'verification', event: 'review.acknowledged',
    reasonCode: rejected ? 'decision.state-stale' : 'decision.accepted',
    triggerCode: 'review.acknowledge', effectCode: rejected ? 'review-gate.rejected' : 'review-gate.approved',
    result: rejected ? 'rejected' : 'success', outcomeCode: 'review.acknowledged',
    occurredAt: input.acknowledgedAt, durationMs: 0,
  }
}
