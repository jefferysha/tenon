import { reviewGateEvent, reviewGatePendingFor, reviewGateApprovedFor, reviewGateStatus } from '../state/review-gate.js'
import type { PipelineState } from '../types.js'
import type { InteractionEventV1 } from '../interaction/contract.js'
import type { SkillInvocationEventV1 } from '../skill-invocation/types.js'
import type { TransitionRecord } from '../workflow/run-types.js'
import type { PendingDecision, PendingDecisionProjectionInput, PendingDecisionView, DecisionChannel, DecisionStatus } from './types.js'

function field(state: PipelineState, key: string): string {
  const fields: Record<string, unknown> = state.fields
  const value = fields[key]
  return typeof value === 'string' ? value : Array.isArray(value) ? value.join(',') : ''
}

function refId(kind: string, change: string, anchor: string, revision: number | null): string {
  // Keep the kernel free of node/platform imports. This stable 64-bit FNV-1a digest is an
  // opaque reference only; canonical state and revision remain the authorization source.
  const source = `${kind}\0${change}\0${anchor}\0${revision ?? ''}`
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

function reviewStatus(input: PendingDecisionProjectionInput, phase: string, event: string): { status: DecisionStatus; evidence: string[] } {
  const { state } = input
  const status = reviewGateStatus(state)
  if (status === undefined || status === null || !field(state, 'review_gate_phase') || !field(state, 'review_requested_at')) {
    return { status: 'superseded', evidence: ['review-receipt-cleared'] }
  }
  if (reviewGatePendingFor(state, phase, event)) return { status: 'pending', evidence: ['canonical-review-receipt'] }
  if (!reviewGateApprovedFor(state, phase, event)) return { status: 'superseded', evidence: ['receipt-anchor-mismatch'] }
  const acknowledged = input.interactions?.some((eventRecord) =>
    eventRecord.event === 'review.acknowledged' && eventRecord.result === 'success' && eventRecord.effectCode === 'review-gate.approved') ?? false
  const transition = input.transitions?.some((record) => record.event === event && record.from === phase)
  if (transition && acknowledged) return { status: 'consumed', evidence: ['transition-record', 'interaction-acknowledged', 'interaction-effect-applied'] }
  if (acknowledged) return { status: 'answered', evidence: ['canonical-review-receipt', 'interaction-acknowledged'] }
  return { status: 'answered', evidence: ['canonical-review-receipt'] }
}

function reviewDecision(input: PendingDecisionProjectionInput): PendingDecision | undefined {
  const phase = field(input.state, 'review_gate_phase')
  const event = reviewGateEvent(input.state)
  const requestedAt = field(input.state, 'review_requested_at')
  if (phase === '' || event === '' || requestedAt === '') return undefined
  const anchor = `${phase}:${event}:${requestedAt}`
  const result = reviewStatus(input, phase, event)
  const via = channel(field(input.state, 'review_acknowledged_via'))
  return {
    ref: { id: refId('review', input.change, anchor, input.revision ?? null), kind: 'review', change: input.change, anchor, revision: input.revision ?? null },
    type: 'review', status: result.status, anchor: { phase, event }, revision: input.revision ?? null,
    evidence: result.evidence, source: via === 'automation' ? 'afk' : via === 'unknown' ? 'unknown' : 'user', channel: via,
    command: 'review-acknowledge',
  }
}

function invocationDecisions(input: PendingDecisionProjectionInput): PendingDecision[] {
  const events = input.invocations ?? []
  const grouped = new Map<string, SkillInvocationEventV1[]>()
  for (const event of events) grouped.set(event.invocation_id, [...(grouped.get(event.invocation_id) ?? []), event])
  const result: PendingDecision[] = []
  for (const [invocationId, group] of grouped) {
    const started = group.find((event): event is Extract<SkillInvocationEventV1, { type: 'invocation-started' }> => event.type === 'invocation-started')
    if (started === undefined) continue
    const questions = group.filter((event): event is Extract<SkillInvocationEventV1, { type: 'question-recorded' }> => event.type === 'question-recorded')
    for (const question of questions) {
      const decision = group.find((event): event is Extract<SkillInvocationEventV1, { type: 'decision-recorded' }> => event.type === 'decision-recorded' && event.payload.question_id === question.payload.question_id)
      const isAfk = started.payload.adapter.kind === 'afk'
      const kind = isAfk ? 'afk' : 'skill-question'
      const anchor = `${invocationId}:${question.payload.question_id}`
      const status: DecisionStatus = decision === undefined ? 'pending' : 'answered'
      const source = isAfk ? 'afk' : decision?.payload.mode === 'recommended-default' ? 'recommended-default' : 'user'
      result.push({
        ref: { id: refId(kind, input.change, anchor, input.revision ?? null), kind, change: input.change, anchor, revision: input.revision ?? null },
        type: kind, status, anchor: { invocationId, questionId: question.payload.question_id }, revision: input.revision ?? null,
        evidence: decision === undefined ? ['invocation-question'] : ['invocation-question', 'decision-recorded'], source,
        channel: isAfk ? 'automation' : 'terminal', command: isAfk ? 'afk-answer' : 'skill-answer',
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
