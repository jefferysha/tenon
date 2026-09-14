import { reviewGateEvent, reviewGatePendingFor, reviewGateApprovedFor, reviewGateStatus } from '../state/review-gate.js'
import type { PipelineState } from '../types.js'
import type { InteractionEventV1, InteractionStepVisit } from '../interaction/contract.js'
import type { SkillInvocationEventV1 } from '../skill-invocation/types.js'
import type { TransitionRecord } from '../workflow/run-types.js'
import type { PendingDecision, PendingDecisionProjectionInput, PendingDecisionView, DecisionChannel, DecisionStatus } from './types.js'

function field(state: PipelineState, key: string): string {
  const fields: Record<string, unknown> = state.fields
  const value = fields[key]
  return typeof value === 'string' ? value : Array.isArray(value) ? value.join(',') : ''
}

function refId(kind: string, change: string, anchor: string, revision: number | null): string {
  // The revision is authorization metadata, not request identity. Including the current
  // revision here would make a still-pending request change identity on every refresh and
  // would make a cleared receipt impossible to recover from its immutable evidence chain.
  // Keep the kernel free of node/platform imports; this is an opaque 64-bit FNV-1a digest.
  void revision
  const source = `${kind}\0${change}\0${anchor}`
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < source.length; index += 1) {
    hash ^= BigInt(source.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return `decision:${hash.toString(16).padStart(16, '0')}`
}

function channel(value: string): DecisionChannel {
  return value === 'terminal' || value === 'dashboard' || value === 'automation' ? value : 'unknown'
}

function visitEqual(left: InteractionStepVisit, right: InteractionStepVisit): boolean {
  return left.runId === right.runId
    && left.transitionSequence === right.transitionSequence
    && (left.step === undefined || right.step === undefined || left.step === right.step)
}

interface ReviewEvidence {
  readonly request?: InteractionEventV1
  readonly acknowledgement?: InteractionEventV1
  readonly effect?: InteractionEventV1
  readonly transition?: TransitionRecord
  readonly rejected?: InteractionEventV1
  readonly complete: boolean
}

function transitionChainValid(transitions: readonly TransitionRecord[], candidate: TransitionRecord): boolean {
  if (!Number.isInteger(candidate.sequence) || candidate.sequence < 1) return false
  if (candidate.sequence === 1) return candidate.previousRecordId === undefined
  return candidate.previousRecordId !== undefined
    && transitions.some((record) => record.runId === candidate.runId
      && record.id === candidate.previousRecordId
      && record.sequence === candidate.sequence - 1)
}

function transitionClearsReviewReceipt(candidate: TransitionRecord): boolean {
  return candidate.effects.some((effect) => effect.kind === 'state-field-change'
    && (effect.field === 'review_gate_status' || effect.field === 'review_gate_phase')
    && (effect.to === '' || (Array.isArray(effect.to) && effect.to.length === 0)))
}

function reviewEvidence(input: PendingDecisionProjectionInput, phase: string, event: string, requestedAt?: string): ReviewEvidence {
  const interactions = [...(input.interactions ?? [])].sort((left, right) => left.sequence - right.sequence)
  const transitions = [...(input.transitions ?? [])].sort((left, right) => left.sequence - right.sequence)
  for (const request of interactions) {
    if (request.event !== 'review.requested' || request.result !== 'success'
      || (request.originStepVisit.step !== undefined && request.originStepVisit.step !== phase)) continue
    if (requestedAt !== undefined && request.occurredAt !== requestedAt) continue
    const acknowledged = interactions.find((candidate) => candidate.event === 'review.acknowledged'
      && candidate.result === 'success'
      && candidate.effectCode === 'review-gate.approved'
      && candidate.journeyId === request.journeyId
      && candidate.runId === request.runId
      && candidate.sequence > request.sequence
      && visitEqual(candidate.originStepVisit, request.originStepVisit)
      && candidate.stateBeforeHash === request.stateAfterHash)
    if (acknowledged === undefined) continue
    const effect = interactions.find((candidate) => candidate.event === 'review.effect-applied'
      && candidate.result === 'success'
      && candidate.effectCode === 'transition.applied'
      && candidate.journeyId === request.journeyId
      && candidate.runId === request.runId
      && candidate.sequence > acknowledged.sequence
      && candidate.stateBeforeHash === acknowledged.stateAfterHash
      && candidate.originStepVisit.runId === request.originStepVisit.runId)
    const transition = transitions.find((candidate) => candidate.runId === request.runId
      && candidate.from === phase
      && candidate.event === event
      && effect !== undefined
      && effect.stepVisit.runId === candidate.runId
      && effect.stepVisit.transitionSequence === candidate.sequence
      && candidate.sequence >= request.originStepVisit.transitionSequence
      && transitionChainValid(transitions, candidate)
      && transitionClearsReviewReceipt(candidate))
    return { request, acknowledgement: acknowledged, effect, transition, complete: effect !== undefined && transition !== undefined }
  }
  return { complete: false }
}

function reviewStatus(input: PendingDecisionProjectionInput, phase: string, event: string, _requestedAt: string): { status: DecisionStatus; evidence: string[] } {
  const status = reviewGateStatus(input.state)
  if (status !== null && reviewGatePendingFor(input.state, phase, event)) {
    return { status: 'pending', evidence: ['canonical-review-receipt'] }
  }
  if (status !== null && reviewGateApprovedFor(input.state, phase, event)) {
    const evidence = reviewEvidence(input, phase, event, _requestedAt)
    if (evidence.complete) return { status: 'consumed', evidence: ['transition-record', 'interaction-acknowledged', 'interaction-effect-applied'] }
    if (evidence.acknowledgement !== undefined) return { status: 'answered', evidence: ['canonical-review-receipt', 'interaction-acknowledged'] }
    return { status: 'answered', evidence: ['canonical-review-receipt'] }
  }
  return { status: 'unknown', evidence: ['incomplete-review-evidence'] }
}

function reviewDecision(input: PendingDecisionProjectionInput): PendingDecision | undefined {
  const phase = field(input.state, 'review_gate_phase')
  const event = reviewGateEvent(input.state)
  const requestedAt = field(input.state, 'review_requested_at')
  const evidence = phase !== '' && event !== '' ? reviewEvidence(input, phase, event, requestedAt) : reviewEvidenceFromClearedReceipt(input)
  if (phase === '' || event === '' || requestedAt === '') {
    if (evidence.request === undefined && evidence.acknowledgement === undefined && evidence.transition === undefined) return undefined
    const recoveredPhase = evidence.transition?.from ?? evidence.request?.originStepVisit.step ?? field(input.state, 'phase')
    const recoveredEvent = evidence.transition?.event ?? eventFromInteraction(evidence.request) ?? 'unknown'
    const anchor = logicalReviewAnchor(recoveredPhase, recoveredEvent, evidence.request, evidence.transition)
    const status: DecisionStatus = evidence.complete ? 'consumed' : evidence.rejected === undefined ? 'unknown' : 'superseded'
    return {
      ref: { id: refId('review', input.change, anchor, input.revision ?? null), kind: 'review', change: input.change, anchor, revision: input.revision ?? null },
      type: 'review', status, anchor: { phase: recoveredPhase, event: recoveredEvent }, revision: input.revision ?? null,
      evidence: evidence.complete ? ['transition-record', 'interaction-acknowledged', 'interaction-effect-applied'] : evidence.rejected === undefined ? ['incomplete-review-evidence'] : ['rejected-acknowledgement'],
      source: reviewSource(evidence.acknowledgement), channel: reviewChannel(evidence.acknowledgement), command: 'review-acknowledge',
    }
  }
  const anchor = logicalReviewAnchor(phase, event, evidence.request, evidence.transition, requestedAt)
  const result = reviewStatus(input, phase, event, requestedAt)
  const via = channel(field(input.state, 'review_acknowledged_via'))
  return {
    ref: { id: refId('review', input.change, anchor, input.revision ?? null), kind: 'review', change: input.change, anchor, revision: input.revision ?? null },
    type: 'review', status: result.status, anchor: { phase, event }, revision: input.revision ?? null,
    evidence: result.evidence, source: via === 'automation' ? 'afk' : via === 'unknown' ? 'unknown' : 'user', channel: via,
    command: 'review-acknowledge',
  }
}

function eventFromInteraction(event: InteractionEventV1 | undefined): string | undefined {
  return event?.pipelineStage === 'custom' ? event.originStepVisit.step : event?.pipelineStage
}

function logicalReviewAnchor(
  phase: string,
  event: string,
  request?: InteractionEventV1,
  transition?: TransitionRecord,
  requestedAt?: string,
): string {
  if (request !== undefined) return `${request.journeyId}:${phase}:${event}`
  if (transition !== undefined) return `${transition.runId}:${transition.sequence}:${transition.previousRecordId ?? 'root'}:${phase}:${event}`
  return `${phase}:${event}:${requestedAt ?? ''}`
}

function reviewChannel(event: InteractionEventV1 | undefined): DecisionChannel {
  if (event?.surface === 'cli') return 'terminal'
  if (event?.surface === 'dashboard') return 'dashboard'
  if (event?.executionMode === 'afk' || event?.actor === 'automation') return 'automation'
  return 'unknown'
}

function reviewSource(event: InteractionEventV1 | undefined): PendingDecision['source'] {
  const value = reviewChannel(event)
  return value === 'automation' ? 'afk' : value === 'unknown' ? 'unknown' : 'user'
}

function reviewEvidenceFromClearedReceipt(input: PendingDecisionProjectionInput): ReviewEvidence {
  const interactions = [...(input.interactions ?? [])].sort((left, right) => left.sequence - right.sequence)
  const request = interactions.find((event) => event.event === 'review.requested' && event.result === 'success')
  if (request === undefined) return { complete: false }
  const acknowledgement = interactions.find((event) => event.event === 'review.acknowledged'
    && event.result === 'success' && event.effectCode === 'review-gate.approved' && event.journeyId === request.journeyId
    && event.runId === request.runId && event.sequence > request.sequence
    && visitEqual(event.originStepVisit, request.originStepVisit)
    && event.stateBeforeHash === request.stateAfterHash)
  const rejected = interactions.find((event) => event.event === 'review.acknowledged'
    && event.result === 'rejected' && event.effectCode === 'review-gate.rejected' && event.journeyId === request.journeyId
    && event.runId === request.runId && event.sequence > request.sequence
    && visitEqual(event.originStepVisit, request.originStepVisit))
  const effect = interactions.find((event) => event.event === 'review.effect-applied'
    && event.result === 'success' && event.effectCode === 'transition.applied' && event.journeyId === request.journeyId
    && event.runId === request.runId && acknowledgement !== undefined && event.sequence > acknowledgement.sequence
    && event.stateBeforeHash === acknowledgement.stateAfterHash)
  const transition = input.transitions?.find((record) => record.runId === request.runId
    && record.from === request.originStepVisit.step
    && record.event !== ''
    && effect !== undefined
    && effect.stepVisit.runId === record.runId
    && effect.stepVisit.transitionSequence === record.sequence
    && transitionChainValid(input.transitions ?? [], record)
    && transitionClearsReviewReceipt(record))
  return { request, acknowledgement, rejected, effect, transition, complete: acknowledgement !== undefined && effect !== undefined && transition !== undefined }
}

function invocationDecisions(input: PendingDecisionProjectionInput): PendingDecision[] {
  const events = input.invocations ?? []
  const grouped = new Map<string, SkillInvocationEventV1[]>()
  for (const event of events) grouped.set(event.invocation_id, [...(grouped.get(event.invocation_id) ?? []), event])
  const result: PendingDecision[] = []
  for (const [invocationId, group] of grouped) {
    const started = group.find((event): event is Extract<SkillInvocationEventV1, { type: 'invocation-started' }> => event.type === 'invocation-started')
    if (started === undefined) continue
    const questions = group.filter((event): event is Extract<SkillInvocationEventV1, { type: 'question-recorded' }> => event.type === 'question-recorded'
      && event.subject.workflow_run_id === started.subject.workflow_run_id
      && event.subject.step_visit.run_id === started.subject.step_visit.run_id
      && event.subject.step_visit.transition_sequence === started.subject.step_visit.transition_sequence)
    for (const question of questions) {
      const decision = group.find((event): event is Extract<SkillInvocationEventV1, { type: 'decision-recorded' }> => event.type === 'decision-recorded'
        && event.payload.question_id === question.payload.question_id && event.sequence > question.sequence
        && event.subject.workflow_run_id === started.subject.workflow_run_id
        && event.subject.step_visit.run_id === started.subject.step_visit.run_id
        && event.subject.step_visit.transition_sequence === started.subject.step_visit.transition_sequence)
      const isAfk = started.payload.adapter.kind === 'afk'
      const kind = isAfk ? 'afk' : 'skill-question'
      const anchor = `${invocationId}:${question.payload.question_id}`
      const status: DecisionStatus = decision === undefined ? 'pending' : 'answered'
      const source = isAfk ? 'afk' : decision?.payload.mode === 'recommended-default' ? 'recommended-default' : 'user'
      result.push({
        ref: { id: refId(kind, input.change, anchor, input.revision ?? null), kind, change: input.change, anchor, revision: input.revision ?? null },
        type: kind, status, anchor: { invocationId, questionId: question.payload.question_id }, revision: input.revision ?? null,
        evidence: decision === undefined ? ['invocation-question'] : ['invocation-question', 'decision-recorded'], source,
        channel: isAfk ? 'automation' : 'terminal', command: 'skill-answer',
      })
    }
  }
  return result
}

export function projectPendingDecisions(input: PendingDecisionProjectionInput): PendingDecisionView {
  const review = reviewDecision(input)
  const items = [...(review === undefined ? [] : [review]), ...invocationDecisions(input)]
  return { schemaVersion: 'pending-decision-view/v1', revision: input.revision ?? null, items }
}
