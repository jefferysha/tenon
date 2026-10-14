/**
 * 步骤的「必须产出」路径模式（文档机制重做 §6）：`required-output` 守卫写在步骤自己的 `guards` 或出边的 `guards` 上，
 * 谁要知道「这一步必须写出哪些文件」（`tenon status` 的 required、验证报告路径、规格校验归属判定、Dashboard）都读这一份，
 * 不各自再扫一遍守卫。
 *
 * 取法：步骤自身的守卫在前，其后是每条非放弃出边的守卫（前进与回退都算，它们同样是离开这一步的条件；放弃边只看它自己，
 * 任务要被放弃了，没写完的产出不该拦它）。带 `when` 的按轨道过滤，同一个模式只留第一次，保持声明顺序。
 * 只读冻结的计划，不碰文件系统，也不判定满足与否（那是 `requiredOutputSatisfied` 的事）。
 */
import type { EffectiveWorkflowPlan } from './effective-plan-types.js'
import { isAbandonEvent } from './abandon-event.js'
import { matchesTrackPredicate } from './predicates.js'

export function stepRequiredOutputs(plan: EffectiveWorkflowPlan, stepId: string, track: string): readonly string[] {
  const step = plan.workflow.steps.find((candidate) => candidate.id === stepId)
  if (step === undefined) return []
  const guards = [
    ...step.guards,
    ...step.transitions.filter((transition) => !isAbandonEvent(transition.event)).flatMap((transition) => transition.guards),
  ]
  const patterns: string[] = []
  for (const guard of guards) {
    if (guard.type !== 'required-output') continue
    if (guard.when !== undefined && !matchesTrackPredicate(guard.when, track)) continue
    if (!patterns.includes(guard.path)) patterns.push(guard.path)
  }
  return patterns
}
