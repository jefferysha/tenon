/**
 * `tenon check` 的技能门预览：与转换拦截同一份判定，只渲染、不写盘。
 *
 * 缺这一项时，check 会对一个 transition 立刻会拒绝的状态打「[PASS] 所有检查通过」——
 * 0.1.0 的真机事故正是这样：check 说全过，下一条 transition 报 step-skills-incomplete 退 2。
 *
 * 指定了退回边（`event`，`review request` 的预检就是这么调的）时，与 transition 一样不要求归属本步 agent 的技能；
 * 不指定边、或指定前进边时按前进边预览。
 */
import { skillsExemptOnExit, stepExitTransitions } from '@tenon/kernel'
import type { EffectiveWorkflowPlan, PipelineState } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { str } from '../render.js'
import { missingStepSkills } from '../stepSkillGate.js'

export async function stepSkillLines(
  deps: CliDeps,
  dir: string,
  state: PipelineState,
  plan: EffectiveWorkflowPlan,
  event?: string,
): Promise<readonly string[]> {
  const stepId = str(state.fields.phase)
  const edge = event === undefined ? undefined : stepExitTransitions(plan, stepId, state).find((transition) => transition.event === event)
  const exclude = edge === undefined || event === undefined
    ? undefined
    : await skillsExemptOnExit({ changeDir: dir, plan, state, stepId, to: edge.to, event })
  const missing = await missingStepSkills({
    deps,
    changeDir: dir,
    stepId,
    capability: plan.capabilities.skills,
    documentPolicy: plan.capabilities.documents.policy,
    recordEvidence: false,
    ...(exclude === undefined || exclude.size === 0 ? {} : { exclude }),
  })
  return missing.map((token) => `step '${stepId}' 尚未完成声明的 skill：${token}`)
}
