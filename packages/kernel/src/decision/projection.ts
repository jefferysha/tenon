import { reviewGateEvent, reviewGatePendingFor, reviewGateApprovedFor, reviewGateStatus } from '../state/review-gate.js'
import type { PipelineState } from '../types.js'
import type { InteractionEventV1, InteractionStepVisit } from '../interaction/contract.js'
import type { SkillInvocationEventV1 } from '../skill-invocation/types.js'
import type { TransitionRecord } from '../workflow/run-types.js'
import type { ReviewGateBinding } from '../state/review-gate-binding.js'
import type { DecisionRef, PendingDecision, PendingDecisionProjectionInput, PendingDecisionView, DecisionChannel, DecisionStatus } from './types.js'

function field(state: PipelineState, key: string): string {
  const fields: Record<string, unknown> = state.fields
  const value = fields[key]
  return typeof value === 'string' ? value : Array.isArray(value) ? value.join(',') : ''
}

function refId(kind: string, change: string, anchor: string): string {
  // The revision is authorization metadata, not request identity. Including the current
  // revision here would make a still-pending request change identity on every refresh and
  // would make a cleared receipt impossible to recover from its immutable evidence chain.
  // Keep the kernel free of node/platform imports; this is an opaque 64-bit FNV-1a digest.
  const source = `${kind}\0${change}\0${anchor}`
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < source.length; index += 1) {
    hash ^= BigInt(source.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return `decision:${hash.toString(16).padStart(16, '0')}`
}

/** Contract F request anchor: exactly `requestedAt + decisionStateDigest + runId`. */
export function reviewDecisionAnchor(input: {
  readonly requestedAt: string
  readonly decisionStateDigest: string
  readonly runId?: string
}): string {
  return `${input.requestedAt}|${input.decisionStateDigest}|${input.runId ?? ''}`
}

/**
 * Anchor for a live receipt. The binding sidecar is authoritative when it names the same request;
 * otherwise the caller-supplied digest of the current decision state is used. Approval changes only
 * receipt fields, which the digest excludes, so pending and approved share one anchor.
 */
export function selectReviewAnchor(input: {
  readonly phase: string
  readonly event: string
  readonly requestedAt: string
  readonly binding?: ReviewGateBinding
  readonly decisionStateDigest?: string
  readonly runId?: string
}): string {
  const binding = input.binding
  if (binding !== undefined && binding.phase === input.phase && binding.event === input.event
    && binding.requestedAt === input.requestedAt) {
    return reviewDecisionAnchor(binding)
  }
  return reviewDecisionAnchor({
    requestedAt: input.requestedAt,
    decisionStateDigest: input.decisionStateDigest ?? '',
    runId: input.runId,
  })
}

/** Review ref: change + kind + phase/event + anchor. GET projection and POST command use this one function. */
export function reviewDecisionRef(change: string, phase: string, event: string, anchor: string, revision: number | null): DecisionRef {
  return { id: refId('review', change, `${phase}\0${event}\0${anchor}`), kind: 'review', change, anchor, revision }
}

function channel(value: string): DecisionChannel {
  return value === 'terminal' || value === 'dashboard' || value === 'automation' || value === 'delegated' ? value : 'unknown'
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

function reviewStatus(input: PendingDecisionProjectionInput, phase: string, event: string, requestedAt: string): { status: DecisionStatus; evidence: string[] } {
  const status = reviewGateStatus(input.state)
  if (status !== null && reviewGatePendingFor(input.state, phase, event)) {
    return { status: 'pending', evidence: ['canonical-review-receipt'] }
  }
  if (status !== null && reviewGateApprovedFor(input.state, phase, event)) {
    const evidence = reviewEvidence(input, phase, event, requestedAt)
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
  const revision = input.revision ?? null
  if (phase === '' || event === '' || requestedAt === '') return clearedReviewDecision(input, revision)
  const anchor = selectReviewAnchor({
    phase, event, requestedAt, binding: input.reviewBinding,
    decisionStateDigest: input.reviewDecisionStateDigest, runId: input.state.runMetadata?.runId,
  })
  const result = reviewStatus(input, phase, event, requestedAt)
  const via = channel(field(input.state, 'review_acknowledged_via'))
  return {
    ref: reviewDecisionRef(input.change, phase, event, anchor, revision),
    type: 'review', status: result.status, anchor: { phase, event }, revision,
    evidence: result.evidence, source: via, channel: via,
    command: 'review-acknowledge',
  }
}

/**
 * A consumed receipt has cleared canonical fields. The binding sidecar still names the request, so
 * the ref keeps the anchor it had while pending; status comes only from the evidence chain.
 */
function clearedReviewDecision(input: PendingDecisionProjectionInput, revision: number | null): PendingDecision | undefined {
  const binding = input.reviewBinding
  const evidence = reviewEvidenceFromClearedReceipt(input, binding)
  if (evidence.request === undefined) return undefined
  const recoveredPhase = binding?.phase ?? evidence.transition?.from ?? evidence.request.originStepVisit.step ?? field(input.state, 'phase')
  const recoveredEvent = binding?.event ?? evidence.transition?.event ?? eventFromInteraction(evidence.request) ?? 'unknown'
  const anchor = binding !== undefined
    ? reviewDecisionAnchor(binding)
    : reviewDecisionAnchor({ requestedAt: evidence.request.occurredAt, decisionStateDigest: '', runId: evidence.request.runId })
  const status: DecisionStatus = evidence.complete ? 'consumed' : evidence.rejected === undefined ? 'unknown' : 'superseded'
  const via = reviewChannel(evidence.acknowledgement)
  return {
    ref: reviewDecisionRef(input.change, recoveredPhase, recoveredEvent, anchor, revision),
    type: 'review', status, anchor: { phase: recoveredPhase, event: recoveredEvent }, revision,
    evidence: evidence.complete
      ? ['transition-record', 'interaction-acknowledged', 'interaction-effect-applied']
      : evidence.rejected === undefined ? ['incomplete-review-evidence'] : ['rejected-acknowledgement'],
    source: via, channel: via, command: 'review-acknowledge',
  }
}

function eventFromInteraction(event: InteractionEventV1 | undefined): string | undefined {
  return event?.pipelineStage === 'custom' ? event.originStepVisit.step : event?.pipelineStage
}

function reviewChannel(event: InteractionEventV1 | undefined): DecisionChannel {
  if (event?.surface === 'cli') return 'terminal'
  if (event?.surface === 'dashboard') return 'dashboard'
  if (event?.executionMode === 'afk' || event?.actor === 'automation') return 'automation'
  return 'unknown'
}

function reviewEvidenceFromClearedReceipt(input: PendingDecisionProjectionInput, binding?: ReviewGateBinding): ReviewEvidence {
  const interactions = [...(input.interactions ?? [])].sort((left, right) => left.sequence - right.sequence)
  const request = interactions.find((event) => event.event === 'review.requested' && event.result === 'success'
    && (binding === undefined || (event.occurredAt === binding.requestedAt
      && (event.originStepVisit.step === undefined || event.originStepVisit.step === binding.phase))))
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
    && (binding === undefined || record.event === binding.event)
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
      const channel = isAfk ? 'automation' as const : 'terminal' as const
      const source = channel
      result.push({
        ref: { id: refId(kind, input.change, anchor), kind, change: input.change, anchor, revision: input.revision ?? null },
        type: kind, status, anchor: { invocationId, questionId: question.payload.question_id }, revision: input.revision ?? null,
        evidence: decision === undefined ? ['invocation-question'] : ['invocation-question', 'decision-recorded'], source,
        channel, command: 'skill-answer',
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
