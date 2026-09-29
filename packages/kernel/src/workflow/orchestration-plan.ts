/**
 * 有效计划 → 编排投影。计划已按 change 的 track 选中分支；冻结计划用它自己冻结的文档契约，
 * 所以工作台看到的是任务开始时的那份编排，而不是之后被改过的定义。
 */
import type { EffectiveWorkflowPlan } from './effective-plan-types.js'
import { materializeWorkflowIo, type WorkflowEffectiveIo } from './effective-io.js'
import { resolveRequiredSkillSlots, type EffectiveSkillResolver } from './effective-skill-resolver.js'
import { orchestrate, type OrchestrationStepSource, type WorkflowOrchestration } from './orchestration.js'

/**
 * 每步 manifest 叠加的必需技能 token（与声明去重之前的原样）。取法与技能门同一个
 * resolveRequiredSkillSlots——只是把阶段自己声明的槽位清空，剩下的就是叠加层；resolver 缺席或轨道
 * 不走矩阵时为空。去重交给 orchestrate，编辑中的草稿与已保存的定义因此同一口径。
 */
export function manifestSkillOverlay(
  plan: EffectiveWorkflowPlan,
  resolver: EffectiveSkillResolver | undefined,
): Readonly<Record<string, readonly string[]>> {
  const capability = plan.capabilities.skills
  const overlayOnly = { ...capability, steps: capability.steps.map((step) => ({ ...step, requiredSkillIds: [], declared: [] })) }
  const overlay: Record<string, readonly string[]> = {}
  for (const step of capability.steps) {
    const tokens = resolveRequiredSkillSlots(resolver, overlayOnly, step.stepId).map((slot) => slot.token)
    if (tokens.length > 0) overlay[step.stepId] = tokens
  }
  return overlay
}

export function planStepSources(plan: EffectiveWorkflowPlan): readonly OrchestrationStepSource[] {
  return plan.workflow.steps.map((step) => ({
    id: step.id,
    label: step.label,
    gate: step.gate,
    skills: step.skills,
    ...(step.agents === undefined ? {} : { agents: step.agents }),
    ...(step.tests === undefined ? {} : { tests: step.tests }),
    transitions: step.transitions,
  }))
}

/** 计划自己的物化 IO：冻结的文档契约优先（null = 不受文档治理）。 */
export function planEffectiveIo(plan: EffectiveWorkflowPlan): WorkflowEffectiveIo {
  return materializeWorkflowIo(plan.workflow, plan.documentPolicy ?? null)
}

export function buildOrchestration(
  plan: EffectiveWorkflowPlan,
  resolver?: EffectiveSkillResolver,
  io: WorkflowEffectiveIo = planEffectiveIo(plan),
): WorkflowOrchestration {
  return orchestrate({ steps: planStepSources(plan), io, overlay: manifestSkillOverlay(plan, resolver) })
}
