import {
  interactionJourneyId,
  type InteractionEventRecorder,
  type InteractionEventRecordDraft,
} from '../interaction/index.js'
import type { RunRevision } from '../state/run-revision-store.js'
import type { PipelineState } from '../types.js'
import type { WorkflowRun } from './run-types.js'
import { isDefaultWorkflowName } from './identifier.js'

interface InteractionEffectInput {
  readonly changeName: string
  readonly reviewEvent: string
  readonly from: string
  readonly to: string
  readonly track: string
  readonly workflowRun: WorkflowRun
  readonly before: RunRevision
  readonly after: RunRevision
}

function field(state: PipelineState, name: keyof PipelineState['fields']): string {
  const value = state.fields[name]
  return Array.isArray(value) ? value.join(',') : (value ?? '')
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

/** Canonical workflow identity classification shared by all interaction projections. */
export function classifyInteractionWorkflowIdentity(input: {
  readonly workflow: string
  readonly track: string
  readonly step: string
}): {
  readonly workflowMode: 'default' | 'custom'
  readonly trackKind: 'built-in' | 'free' | 'custom'
  readonly pipelineStage: 'open' | 'explore' | 'spec' | 'build' | 'verify' | 'ship' | 'archive' | 'custom'
} {
  return {
    workflowMode: isDefaultWorkflowName(input.workflow) ? 'default' : 'custom',
    trackKind: trackKind(input.track),
    pipelineStage: pipelineStage(input.step),
  }
}

/** Build the post-commit projection for an approved transition without weakening canonical anchors. */
export function createInteractionEffectDraft(input: InteractionEffectInput): InteractionEventRecordDraft {
  const workflowHash = input.workflowRun.workflowPlanFingerprint
  const afterMetadata = input.after.state.runMetadata
  if (workflowHash === undefined || afterMetadata === undefined
    || afterMetadata.runId === undefined || afterMetadata.transitionSequence === undefined) {
    throw new Error('interaction projection 缺 canonical run/workflow/state anchor')
  }
  const requestedAt = field(input.before.state, 'review_requested_at') || input.before.mutation.observedAt
  const originStepVisit = {
    runId: input.workflowRun.id,
    transitionSequence: input.workflowRun.transitionSequence,
    step: input.from,
  }
  return {
    journeyId: interactionJourneyId({
      change: input.changeName,
      runId: input.workflowRun.id,
      originStepVisit,
      reviewEvent: input.reviewEvent,
      requestedAt,
    }),
    occurredAt: input.after.mutation.observedAt,
    change: input.changeName,
    runId: input.workflowRun.id,
    workflow: input.workflowRun.workflowId,
    workflowHash,
    originStepVisit,
    stepVisit: {
      runId: afterMetadata.runId,
      transitionSequence: afterMetadata.transitionSequence,
      step: input.to,
    },
    stateBeforeHash: input.before.stateDigest,
    stateAfterHash: input.after.stateDigest,
    actor: 'agent',
    surface: 'cli',
    executionMode: 'interactive',
    workflowMode: isDefaultWorkflowName(input.workflowRun.workflowId) ? 'default' : 'custom',
    track: input.track,
    trackKind: trackKind(input.track),
    pipelineStage: pipelineStage(input.from),
    controlStage: 'execution',
    event: 'review.effect-applied',
    reasonCode: 'effect.applied',
    triggerCode: 'transition.approved',
    effectCode: 'transition.applied',
    result: 'success',
    outcomeCode: 'review.effect-applied',
    durationMs: 0,
  }
}

export async function recordInteractionEffectUnderLock(
  input: InteractionEffectInput & {
    readonly changeDir: string
    readonly recorder: InteractionEventRecorder
  },
): Promise<void> {
  await input.recorder.recordUnderLock(input.changeDir, createInteractionEffectDraft(input))
}

export async function emitInteractionEffectUnderLock(input: Omit<InteractionEffectInput, 'before' | 'after'> & {
  readonly changeDir: string
  readonly recorder: InteractionEventRecorder
  readonly before?: RunRevision
  readonly readAfter: () => Promise<RunRevision | undefined>
}): Promise<void> {
  const after = await input.readAfter()
  if (input.before === undefined || after === undefined) {
    throw new Error('interaction projection 缺 canonical run/workflow/state anchor')
  }
  await recordInteractionEffectUnderLock({ ...input, before: input.before, after })
}
