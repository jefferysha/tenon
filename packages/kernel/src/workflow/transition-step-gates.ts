/**
 * 离开步骤前的两道步骤级门禁：本步必需技能的证据，和本步 agent 的结论。
 *
 * 两者都只在宿主接了对应注入面时求值（缺省 = 该门禁未接线，不产生拦截），都在 commit 之前、
 * 同一把 Change 锁内。agent 只查前进出边——退回边是修问题的路，必须一直开着。
 */
import type { PipelineState } from '../types.js'
import { isForwardExit } from './agent-verdict.js'
import type { EffectiveWorkflowPlan } from './effective-plan-types.js'
import type { TransitionApplicationDeps, TransitionRejection } from './transition-application-types.js'

export async function rejectOnStepGates(input: {
  readonly deps: Pick<TransitionApplicationDeps, 'missingStepSkills' | 'stepAgentBlockers'>
  readonly changeDir: string
  readonly workflowName: string
  readonly plan: EffectiveWorkflowPlan
  readonly state: PipelineState
  readonly from: string
  readonly to: string
  readonly event: string
}): Promise<TransitionRejection | undefined> {
  const { deps, plan, workflowName, from } = input
  if (deps.missingStepSkills !== undefined) {
    const missing = await deps.missingStepSkills({
      changeDir: input.changeDir,
      stepId: from,
      capability: plan.capabilities.skills,
    })
    if (missing.length > 0) return { kind: 'step-skills-incomplete', workflowName, stepId: from, missing }
  }
  if (deps.stepAgentBlockers !== undefined && isForwardExit(plan, from, input.to, input.event)) {
    const blockers = await deps.stepAgentBlockers({
      changeDir: input.changeDir,
      stepId: from,
      plan,
      state: input.state,
    })
    if (blockers.length > 0) return { kind: 'step-agents-incomplete', workflowName, stepId: from, blockers }
  }
  return undefined
}
