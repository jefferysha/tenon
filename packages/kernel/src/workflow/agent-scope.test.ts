import { describe, expect, test } from 'vitest'
import type { PathClass } from '../workspace/path-classes.js'
import { attachedReviewers, evaluateStepAgents, nextAgentWave, projectStepAgents } from './agent-verdict.js'
import { unattachedReviewers } from './agent-scope.js'
import type { StepAgentsCapability } from './effective-plan-types.js'

const reviewer = (
  agent: string,
  extra: Partial<StepAgentsCapability['reviewers'][number]> = {},
): StepAgentsCapability['reviewers'][number] => ({
  agent, required: true, blockAt: 'medium', dependsOn: [], readsTests: [], ...extra,
})

const SCOPES: Readonly<Record<string, readonly PathClass[]>> = { security: ['auth', 'dependency', 'contract'] }
const attachOnOf = (agent: string): readonly PathClass[] | undefined => SCOPES[agent]

describe('unattachedReviewers', () => {
  const reviewers = [reviewer('code-review'), reviewer('security')]

  test('改动没碰到声明的路径类 → 评审者不挂载；没声明的永远挂载', () => {
    expect(unattachedReviewers(reviewers, attachOnOf, new Set<PathClass>())).toEqual(['security'])
    expect(unattachedReviewers(reviewers, attachOnOf, new Set<PathClass>(['migration']))).toEqual(['security'])
  })

  test('命中任一类 → 挂载', () => {
    expect(unattachedReviewers(reviewers, attachOnOf, new Set<PathClass>(['dependency']))).toEqual([])
  })

  test('读不出改动（touched 缺席）→ 失败关闭，全部挂载', () => {
    expect(unattachedReviewers(reviewers, attachOnOf, undefined)).toEqual([])
  })
})

describe('未挂载的评审者不进入步骤判定', () => {
  const step: StepAgentsCapability = {
    stepId: 'verify',
    executors: [],
    reviewers: [
      reviewer('code-review'),
      reviewer('security'),
      reviewer('architecture', { required: false, dependsOn: ['security', 'code-review'] }),
    ],
  }
  const input = { step, runs: [], stepVisit: 'v1', candidate: 'c1', testsReady: { ready: true, pending: [] } }

  test('不投影、不产生阻断、depends_on 里指向它的依赖被去掉', () => {
    const scoped = { ...input, unattached: ['security'] }
    expect(projectStepAgents(scoped).map((view) => view.agent)).toEqual(['code-review', 'architecture'])
    expect(evaluateStepAgents(scoped).blockers).toEqual([{ kind: 'reviewer-missing', agent: 'code-review' }])
    expect(attachedReviewers(scoped).find((ref) => ref.agent === 'architecture')?.dependsOn).toEqual(['code-review'])
    expect(nextAgentWave(scoped).wave).toEqual(['code-review'])
  })

  test('缺省 = 全部挂载（旧行为）', () => {
    expect(projectStepAgents(input).map((view) => view.agent)).toEqual(['code-review', 'security', 'architecture'])
    expect(evaluateStepAgents(input).blockers.map((blocker) => blocker.agent)).toEqual(['code-review', 'security'])
  })
})
