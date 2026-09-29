/**
 * 有效计划 → 编排投影。计划已按 change 的 track 选中分支；冻结计划用它自己冻结的文档契约，
 * 所以工作台看到的是任务开始时的那份编排，而不是之后被改过的定义。
 */
import type { EffectiveWorkflowPlan } from './effective-plan-types.js'
import { materializeWorkflowIo, type WorkflowEffectiveIo } from './effective-io.js'
import { resolveRequiredSkillSlots, type EffectiveSkillResolver } from './effective-skill-resolver.js'
import { orchestrate, type OrchestrationStepSource, type WorkflowOrchestration } from './orchestration.js'

/**
 * 每步 manifest 叠加的必需技能 token（runner 的必需槽位减去阶段自己声明的那些）。resolver 缺席或轨道
 * 不走矩阵时为空——与技能门同一个 resolveRequiredSkillSlots。
 */
export function manifestSkillOverlay(
  plan: EffectiveWorkflowPlan,
  resolver: EffectiveSkillResolver | undefined,
): Readonly<Record<string, readonly string[]>> {
  const capability = plan.capabilities.skills
  const overlay: Record<string, readonly string[]> = {}
  for (const step of capability.steps) {
    const own = new Set(step.requiredSkillIds)
    const extra = resolveRequiredSkillSlots(resolver, capability, step.stepId)
      .map((slot) => slot.token)
      .filter((token) => !own.has(token))
    if (extra.length > 0) overlay[step.stepId] = extra
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
