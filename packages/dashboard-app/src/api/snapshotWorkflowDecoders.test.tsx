import { describe, expect, it } from 'vitest'
import { AGENT_BLOCKER_REASONS, decodeTransitionReadinessBlocker, GUARD_TYPES } from './snapshotWorkflowDecoders'

describe('decodeTransitionReadinessBlocker · 通用离开条件', () => {
  it.each(['tasks-through-step', 'not-afk-queued', 'dependencies-ended'])('%s 不满足的阻断可以解码，字段原样保留', (guardType) => {
    expect(GUARD_TYPES.has(guardType)).toBe(true)
    expect(decodeTransitionReadinessBlocker({ kind: 'guard-failed', guardType, actual: 'queued' }))
      .toEqual({ kind: 'guard-failed', guardType, actual: 'queued' })
    expect(decodeTransitionReadinessBlocker({ kind: 'evaluation-error', guardType }))
      .toEqual({ kind: 'evaluation-error', guardType })
  })

  it('认不出的离开条件类型整条拒收', () => {
    expect(decodeTransitionReadinessBlocker({ kind: 'guard-failed', guardType: 'made-up' })).toBeNull()
  })
})

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
