import { describe, expect, it } from 'vitest'
import { emptyFields, projectPendingDecisions, type PipelineState } from '../index.js'

function state(overrides: Record<string, string>): PipelineState {
  return { fields: { ...emptyFields(), ...overrides }, opaqueTail: '' }
}

describe('pending decision projection', () => {
  it('projects an exact pending review receipt with a stable ref', () => {
    const input = { change: 'demo', state: state({
      phase: 'verify', review_gate_phase: 'verify', review_gate_event: 'verify-pass', review_gate_status: 'pending', review_requested_at: '2026-09-13T00:00:00Z',
    }), revision: 3 }
    const first = projectPendingDecisions(input)
    const second = projectPendingDecisions(input)
    expect(first).toEqual(second)
    expect(first.items[0]).toMatchObject({ type: 'review', status: 'pending', command: 'review-acknowledge', revision: 3 })
  })

  it('does not infer consumed from a cleared receipt', () => {
    const view = projectPendingDecisions({ change: 'demo', state: state({ phase: 'verify' }) })
    expect(view.items).toHaveLength(0)
  })

  it('attributes AFK from invocation adapter, independently of decision mode', () => {
    const started = {
      schema_version: 'skill-invocation-evidence/v1' as const, event_id: 'e1', invocation_id: 'i1', sequence: 1 as const,
      type: 'invocation-started' as const, recorded_at: '2026-09-13T00:00:00Z', subject: { project_id: 'p', workflow_definition_id: 'w', workflow_run_id: 'r', step_id: 'verify', step_visit: { run_id: 'r', transition_sequence: 1 }, attempt: { attempt_id: 'a', reservation_id: 'res' } },
      payload: { skill: { id: 'skill', version: '1' }, input: { schema_id: 'input', fields: [] }, adapter: { kind: 'afk' as const, proof_ref: 'proof' } },
    }
    const question = { ...started, event_id: 'e2', sequence: 2 as const, type: 'question-recorded' as const, payload: { question_id: 'q1', key: 'confirm', schema_id: 'q', option_ids: ['yes'], requiredness: 'hard-gate' as const, shown: true } }
    const decision = { ...started, event_id: 'e3', sequence: 3 as const, type: 'decision-recorded' as const, payload: { decision_id: 'd1', question_id: 'q1', mode: 'user-answer' as const, selected_option_ids: ['yes'] } }
    const view = projectPendingDecisions({ change: 'demo', state: state({ phase: 'verify' }), invocations: [started, question, decision] })
    expect(view.items[0]).toMatchObject({ type: 'afk', source: 'afk', channel: 'automation', command: 'afk-answer', status: 'answered' })
  })
})
