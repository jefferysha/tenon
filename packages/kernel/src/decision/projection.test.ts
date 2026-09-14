import { describe, expect, it } from 'vitest'
import { emptyFields, projectPendingDecisions, type PipelineState } from '../index.js'
import type { InteractionEventV1 } from '../interaction/contract.js'
import type { SkillInvocationEventV1 } from '../skill-invocation/types.js'
import type { TransitionRecord } from '../workflow/run-types.js'

function state(overrides: Record<string, string>): PipelineState {
  return { fields: { ...emptyFields(), ...overrides }, opaqueTail: '' }
}

const requestedAt = '2026-09-13T00:00:00Z'
const beforeHash = 'a'.repeat(64)
const approvedHash = 'b'.repeat(64)
const afterHash = 'c'.repeat(64)

function interaction(overrides: Partial<InteractionEventV1> & Pick<InteractionEventV1, 'event' | 'sequence'>): InteractionEventV1 {
  const originStepVisit = { runId: 'run-1', transitionSequence: 1, step: 'verify' }
  const stepVisit = { ...originStepVisit }
  return {
    schema: 'tenon-interaction-event/v1', eventId: `event-${overrides.sequence}`, sequence: overrides.sequence,
    previousEventHash: null, journeyId: 'journey-1', occurredAt: requestedAt, change: 'demo', runId: 'run-1',
    workflow: 'default', workflowHash: 'workflow-hash', originStepVisit, stepVisit,
    stateBeforeHash: beforeHash, stateAfterHash: beforeHash, actor: 'system', surface: 'cli',
    executionMode: 'interactive', workflowMode: 'default', track: 'backend', trackKind: 'built-in',
    pipelineStage: 'verify', controlStage: 'verification', reasonCode: 'review.required', triggerCode: 'review.exit-requested',
    effectCode: 'review-gate.pending', result: 'success', outcomeCode: 'review.requested', durationMs: 0,
    ...overrides,
  }
}

function reviewChain(): { interactions: InteractionEventV1[]; transitions: TransitionRecord[] } {
  const request = interaction({ event: 'review.requested', sequence: 1, journeyId: 'journey-1', stateBeforeHash: beforeHash, stateAfterHash: approvedHash })
  const acknowledgement = interaction({ event: 'review.acknowledged', sequence: 2, journeyId: 'journey-1', stateBeforeHash: approvedHash, stateAfterHash: approvedHash, effectCode: 'review-gate.approved', outcomeCode: 'review.acknowledged' })
  const effect = interaction({ event: 'review.effect-applied', sequence: 3, journeyId: 'journey-1', stateBeforeHash: approvedHash, stateAfterHash: afterHash, effectCode: 'transition.applied', outcomeCode: 'review.effect-applied', actor: 'agent', stepVisit: { runId: 'run-1', transitionSequence: 2, step: 'build' } })
  const first: TransitionRecord = {
    schemaVersion: 1, id: 'transition-1', runId: 'run-1', sequence: 1, workflowId: 'default', event: 'enter-verify', from: 'explore', to: 'verify', effects: [], observedAt: requestedAt,
  }
  const transition: TransitionRecord = {
    schemaVersion: 1, id: 'transition-2', runId: 'run-1', sequence: 2, previousRecordId: first.id, workflowId: 'default', event: 'verify-pass', from: 'verify', to: 'build',
    effects: [
      { kind: 'state-field-change', field: 'review_gate_status', from: 'approved', to: '' },
      { kind: 'state-field-change', field: 'review_gate_phase', from: 'verify', to: '' },
    ], observedAt: requestedAt,
  }
  return { interactions: [request, acknowledgement, effect], transitions: [first, transition] }
}

describe('pending decision projection', () => {
  it('projects an exact pending review receipt with a ref stable across refresh revisions', () => {
    const input = { change: 'demo', state: state({ phase: 'verify', review_gate_phase: 'verify', review_gate_event: 'verify-pass', review_gate_status: 'pending', review_requested_at: requestedAt }), revision: 3 }
    const first = projectPendingDecisions(input)
    const second = projectPendingDecisions({ ...input, revision: 4 })
    expect(first.items[0]).toMatchObject({ type: 'review', status: 'pending', command: 'review-acknowledge', revision: 3 })
    expect(first.items[0]?.ref.id).toBe(second.items[0]?.ref.id)
  })

  it('keeps one ref id from pending through answered to consumed (contract F anchor)', () => {
    const binding = { version: 1 as const, phase: 'verify', event: 'verify-pass', requestedAt, decisionStateDigest: 'e'.repeat(64), runId: 'run-1' }
    const receipt = { phase: 'verify', review_gate_phase: 'verify', review_gate_event: 'verify-pass', review_requested_at: requestedAt }
    const pending = projectPendingDecisions({ change: 'demo', state: state({ ...receipt, review_gate_status: 'pending' }), reviewBinding: binding, revision: 3 })
    const answered = projectPendingDecisions({ change: 'demo', state: state({ ...receipt, review_gate_status: 'approved', review_acknowledged_via: 'dashboard' }), reviewBinding: binding, revision: 4 })
    const consumed = projectPendingDecisions({ change: 'demo', state: state({ phase: 'build' }), ...reviewChain(), reviewBinding: binding, revision: 5 })
    expect([pending.items[0]?.status, answered.items[0]?.status, consumed.items[0]?.status]).toEqual(['pending', 'answered', 'consumed'])
    expect(answered.items[0]?.ref.id).toBe(pending.items[0]?.ref.id)
    expect(consumed.items[0]?.ref.id).toBe(pending.items[0]?.ref.id)
    expect(pending.items[0]?.ref.anchor).toBe(`${requestedAt}|${'e'.repeat(64)}|run-1`)
    expect(answered.items[0]).toMatchObject({ source: 'dashboard', channel: 'dashboard' })
    expect(consumed.items[0]).toMatchObject({ source: 'terminal', channel: 'terminal' })
  })

  it('derives the anchor from the current decision digest when no sidecar names the request', () => {
    const receipt = { phase: 'verify', review_gate_phase: 'verify', review_gate_event: 'verify-pass', review_requested_at: requestedAt }
    const pending = projectPendingDecisions({ change: 'demo', state: state({ ...receipt, review_gate_status: 'pending' }), reviewDecisionStateDigest: 'f'.repeat(64) })
    const approved = projectPendingDecisions({ change: 'demo', state: state({ ...receipt, review_gate_status: 'approved' }), reviewDecisionStateDigest: 'f'.repeat(64) })
    const refreshed = projectPendingDecisions({ change: 'demo', state: state({ ...receipt, review_requested_at: '2026-09-13T00:05:00Z', review_gate_status: 'pending' }), reviewDecisionStateDigest: 'f'.repeat(64) })
    expect(approved.items[0]?.ref.id).toBe(pending.items[0]?.ref.id)
    expect(refreshed.items[0]?.ref.id).not.toBe(pending.items[0]?.ref.id)
  })

  it('does not infer consumed from a cleared receipt', () => {
    const view = projectPendingDecisions({ change: 'demo', state: state({ phase: 'build' }) })
    expect(view.items).toHaveLength(0)
  })

  it('recovers consumed only from the complete transition and interaction chain', () => {
    const chain = reviewChain()
    const view = projectPendingDecisions({ change: 'demo', state: state({ phase: 'build' }), ...chain, revision: 9 })
    expect(view.items[0]).toMatchObject({ status: 'consumed', anchor: { phase: 'verify', event: 'verify-pass' }, revision: 9 })
    expect(view.items[0]?.evidence).toEqual(['transition-record', 'interaction-acknowledged', 'interaction-effect-applied'])
  })

  it('returns unknown when cleared receipt evidence is incomplete', () => {
    const chain = reviewChain()
    const view = projectPendingDecisions({ change: 'demo', state: state({ phase: 'build' }), interactions: chain.interactions.slice(0, 2), transitions: chain.transitions })
    expect(view.items[0]).toMatchObject({ status: 'unknown', evidence: ['incomplete-review-evidence'] })
  })

  it('derives superseded only from an explicit rejected acknowledgement', () => {
    const chain = reviewChain()
    const rejected = interaction({ event: 'review.acknowledged', sequence: 2, journeyId: 'journey-1', stateBeforeHash: approvedHash, stateAfterHash: approvedHash, effectCode: 'review-gate.rejected', result: 'rejected', outcomeCode: 'review.acknowledged' })
    const view = projectPendingDecisions({ change: 'demo', state: state({ phase: 'build' }), interactions: [chain.interactions[0]!, rejected] })
    expect(view.items[0]).toMatchObject({ status: 'superseded', evidence: ['rejected-acknowledgement'] })
  })

  it('rejects a cross-run or state-hash-mismatched join as unknown', () => {
    const chain = reviewChain()
    const mismatched = chain.interactions.map((event) => event.event === 'review.acknowledged' ? { ...event, runId: 'other-run' } : event)
    const view = projectPendingDecisions({ change: 'demo', state: state({ phase: 'build' }), interactions: mismatched, transitions: chain.transitions })
    expect(view.items[0]).toMatchObject({ status: 'unknown', evidence: ['incomplete-review-evidence'] })
  })

  it('rejects a state hash discontinuity even when run and journey match', () => {
    const chain = reviewChain()
    const mismatched = chain.interactions.map((event) => event.event === 'review.acknowledged' ? { ...event, stateBeforeHash: 'd'.repeat(64) } : event)
    const view = projectPendingDecisions({ change: 'demo', state: state({ phase: 'build' }), interactions: mismatched, transitions: chain.transitions })
    expect(view.items[0]).toMatchObject({ status: 'unknown', evidence: ['incomplete-review-evidence'] })
  })

  it('attributes AFK from invocation-started adapter, independently of decision mode', () => {
    const subject = { project_id: 'p', workflow_definition_id: 'w', workflow_run_id: 'run-1', step_id: 'verify', step_visit: { run_id: 'run-1', transition_sequence: 1 }, attempt: { attempt_id: 'a', reservation_id: 'res' } }
    const started = { schema_version: 'skill-invocation-evidence/v1' as const, event_id: 'e1', invocation_id: 'i1', sequence: 1, type: 'invocation-started' as const, recorded_at: requestedAt, subject, payload: { skill: { id: 'skill', version: '1' }, input: { schema_id: 'input', fields: [] }, adapter: { kind: 'afk' as const, proof_ref: 'proof' } } } satisfies SkillInvocationEventV1
    const question = { ...started, event_id: 'e2', sequence: 2, type: 'question-recorded' as const, payload: { question_id: 'q1', key: 'confirm', schema_id: 'q', option_ids: ['yes'], requiredness: 'hard-gate' as const, shown: true } } satisfies SkillInvocationEventV1
    const decision = { ...started, event_id: 'e3', sequence: 3, type: 'decision-recorded' as const, payload: { decision_id: 'd1', question_id: 'q1', mode: 'user-answer' as const, selected_option_ids: ['yes'] } } satisfies SkillInvocationEventV1
    const view = projectPendingDecisions({ change: 'demo', state: state({ phase: 'verify' }), invocations: [started, question, decision] })
    expect(view.items[0]).toMatchObject({ type: 'afk', source: 'automation', channel: 'automation', command: 'skill-answer', status: 'answered' })
  })
})
