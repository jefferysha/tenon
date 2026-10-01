import { describe, expect, it } from 'vitest'
import { AGENT_BLOCKER_REASONS, decodeTransitionReadinessBlocker } from './snapshotWorkflowDecoders'

describe('decodeTransitionReadinessBlocker · agent 阻断码', () => {
  it('kernel 的评审者阻断码全部收得下，包括宿主不符；认不出的码整条拒收', () => {
    for (const reason of ['reviewer-missing', 'reviewer-running', 'reviewer-stale', 'reviewer-failed', 'reviewer-wrong-host']) {
      expect(AGENT_BLOCKER_REASONS.has(reason), reason).toBe(true)
    }
    expect(decodeTransitionReadinessBlocker({ kind: 'agents-incomplete', agents: [{ agent: 'security', reason: 'reviewer-wrong-host' }] }))
      .toEqual({ kind: 'agents-incomplete', agents: [{ agent: 'security', reason: 'reviewer-wrong-host' }] })
    expect(decodeTransitionReadinessBlocker({ kind: 'agents-incomplete', agents: [{ agent: 'security', reason: 'exploded' }] })).toBeNull()
  })

  it('step-exit：结构化字段 subject / state 原样保留（宿主不符、测试完整性）', () => {
    expect(decodeTransitionReadinessBlocker({
      kind: 'step-exit', source: 'reviewer', code: 'reviewer-wrong-host', message: 'whole', subject: 'security', state: 'wrong-host',
    })).toEqual({ kind: 'step-exit', source: 'reviewer', code: 'reviewer-wrong-host', message: 'whole', subject: 'security', state: 'wrong-host' })
    expect(decodeTransitionReadinessBlocker({
      kind: 'step-exit', source: 'test', code: 'test-evidence', message: 'whole', state: 'integrity',
    })).toEqual({ kind: 'step-exit', source: 'test', code: 'test-evidence', message: 'whole', state: 'integrity' })
  })
})
