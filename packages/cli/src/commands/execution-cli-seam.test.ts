import {
  compileEffectiveWorkflowPlan, effectiveWorkflowPlanFromSnapshot, loadEffectiveWorkflowPlan, selectExecution,
  workflowPlanSnapshot, type EffectiveWorkflowPlan,
} from '@tenon/kernel'
import { describe, expect, it } from 'vitest'
import { frozenPlanCandidates, isLegacyExecution, isStepGraphExecution } from './execution-cli-seam.js'

/** 升级前创建的在途 default 任务冻结的计划：快照里记着 phase-manifest。 */
function legacyPlan(): EffectiveWorkflowPlan {
  return compileEffectiveWorkflowPlan('default', undefined, { track: 'backend', executionModel: 'phase-manifest' })
}

/** 新建任务的计划：一律按 YAML 的步骤图执行。 */
function graphPlan(): EffectiveWorkflowPlan {
  return compileEffectiveWorkflowPlan('default', undefined, { track: 'backend' })
}

describe('CLI 执行模型接缝', () => {
  it('快照记着旧模型的计划走旧引擎，不是步骤图', () => {
    const plan = legacyPlan()
    expect(isLegacyExecution(plan)).toBe(true)
    expect(isStepGraphExecution(plan)).toBe(false)
  })

  it('新建任务的计划是步骤图，不是旧引擎', () => {
    const plan = graphPlan()
    expect(isLegacyExecution(plan)).toBe(false)
    expect(isStepGraphExecution(plan)).toBe(true)
  })

  it('两个判断恒互斥，且与内核接缝选出的适配器同源', () => {
    for (const plan of [legacyPlan(), graphPlan()]) {
      expect(isLegacyExecution(plan)).toBe(selectExecution(plan).kind === 'legacy-phase-manifest')
      expect(isStepGraphExecution(plan)).toBe(selectExecution(plan).kind === 'step-graph')
      expect(isLegacyExecution(plan)).not.toBe(isStepGraphExecution(plan))
    }
  })

  // artifact 的 producerPolicy 核对与技能门的 manifest 叠加分支曾直接读 skills.source：它在 planFromIr 里与
  // execution.model 出自同一个入参，改读接缝要求两者恒等价——新建、冻结快照恢复、平铺工作流都得成立。
  it('技能策略 manifest-overlay 恒等价于旧引擎执行（新建 / 快照恢复 / 平铺工作流）', () => {
    const frozenLegacy = effectiveWorkflowPlanFromSnapshot(workflowPlanSnapshot(legacyPlan()), 'backend')
    const frozenGraph = effectiveWorkflowPlanFromSnapshot(workflowPlanSnapshot(graphPlan()), 'backend')
    const flat = loadEffectiveWorkflowPlan('/repo', 'design-system')
    for (const plan of [legacyPlan(), graphPlan(), frozenLegacy, frozenGraph, flat]) {
      expect(plan.capabilities.skills.source === 'manifest-overlay').toBe(isLegacyExecution(plan))
      expect(plan.skillPolicy).toBe(plan.capabilities.skills.source)
    }
    expect(isLegacyExecution(frozenLegacy)).toBe(true)
    expect(isStepGraphExecution(frozenGraph)).toBe(true)
    expect(isStepGraphExecution(flat)).toBe(true)
  })

  it('补快照的候选覆盖两种执行模型，每种恰好一份', () => {
    const candidates = frozenPlanCandidates('default', undefined, 'backend')
    expect(candidates.map((plan) => plan.capabilities.execution.model).sort()).toEqual(['phase-manifest', 'step-graph'])
    expect(candidates.filter(isLegacyExecution)).toHaveLength(1)
    expect(candidates.filter(isStepGraphExecution)).toHaveLength(1)
  })

  it('候选里能按冻结指纹认出旧任务的计划', () => {
    const frozen = legacyPlan()
    const match = frozenPlanCandidates('default', undefined, 'backend')
      .find((candidate) => candidate.workflowFingerprint === frozen.workflowFingerprint)
    expect(match === undefined ? undefined : isLegacyExecution(match)).toBe(true)
    const fresh = graphPlan()
    const freshMatch = frozenPlanCandidates('default', undefined, 'backend')
      .find((candidate) => candidate.workflowFingerprint === fresh.workflowFingerprint)
    expect(freshMatch === undefined ? undefined : isStepGraphExecution(freshMatch)).toBe(true)
  })
})
