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

  it('required-output（必须产出）：没产出 / 当前步骤不可判 / 能力不可用 / 评估出错的阻断都能解码', () => {
    expect(GUARD_TYPES.has('required-output')).toBe(true)
    for (const actual of ['missing', 'current-step-unavailable']) {
      expect(decodeTransitionReadinessBlocker({ kind: 'guard-failed', guardType: 'required-output', actual }))
        .toEqual({ kind: 'guard-failed', guardType: 'required-output', actual })
    }
    expect(decodeTransitionReadinessBlocker({ kind: 'capability-unavailable', guardType: 'required-output', capability: 'requiredOutput' }))
      .toEqual({ kind: 'capability-unavailable', guardType: 'required-output', capability: 'requiredOutput' })
    expect(decodeTransitionReadinessBlocker({ kind: 'evaluation-error', guardType: 'required-output' }))
      .toEqual({ kind: 'evaluation-error', guardType: 'required-output' })
    expect(decodeTransitionReadinessBlocker({ kind: 'evaluation-error', guardType: 'required-output', capability: 'requiredOutput' }))
      .toEqual({ kind: 'evaluation-error', guardType: 'required-output', capability: 'requiredOutput' })
  })

  it('required-output 的 guard-failed 带可选路径：原样保留；没带也能解码；不是字符串整条拒收', () => {
    const path = 'openspec/changes/plan-checkout/proposal.md'
    expect(decodeTransitionReadinessBlocker({ kind: 'guard-failed', guardType: 'required-output', actual: 'missing', path }))
      .toEqual({ kind: 'guard-failed', guardType: 'required-output', actual: 'missing', path })
    expect(decodeTransitionReadinessBlocker({ kind: 'guard-failed', guardType: 'required-output', actual: 'missing' }))
      .toEqual({ kind: 'guard-failed', guardType: 'required-output', actual: 'missing' })
    expect(decodeTransitionReadinessBlocker({ kind: 'guard-failed', guardType: 'required-output', actual: 'missing', path: 1 })).toBeNull()
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
