/**
 * `tenon check` 的技能门预览：与转换拦截同一份判定，只渲染、不写盘。
 *
 * 缺这一项时，check 会对一个 transition 立刻会拒绝的状态打「[PASS] 所有检查通过」——
 * 0.1.0 的真机事故正是这样：check 说全过，下一条 transition 报 step-skills-incomplete 退 2。
 */
import type { EffectiveWorkflowPlan, PipelineState } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { str } from '../render.js'
import { missingStepSkills } from '../stepSkillGate.js'

export async function stepSkillLines(
  deps: CliDeps,
  dir: string,
  state: PipelineState,
  plan: EffectiveWorkflowPlan,
): Promise<readonly string[]> {
  const stepId = str(state.fields.phase)
  const missing = await missingStepSkills({
    deps,
    changeDir: dir,
    stepId,
    capability: plan.capabilities.skills,
    documentPolicy: plan.capabilities.documents.policy,
    recordEvidence: false,
  })
  return missing.map((token) => `step '${stepId}' 尚未完成声明的 skill：${token}`)
}
