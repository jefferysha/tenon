import { isAbandonEvent } from '@tenon/kernel/workflow/abandon-event'
import type { WbGuardConfig, WbStepDef, WbTrackPredicate } from '../api/governanceTypes'

/** 一条离开条件的文案：i18n 键（`workflow.leave_conditions.*`）与占位值。 */
export interface LeaveCondition {
  readonly key: string
  readonly vars?: Readonly<Record<string, string | number>>
}

function appliesTo(when: WbTrackPredicate | undefined, track: string): boolean {
  if (when === undefined) return true
  return when.kind === 'track-in' ? when.values.includes(track) : !when.values.includes(track)
}

/** 约定字段 `pre_verify_review_result = pass` 就是「实现前评审通过」，不显示字段名。 */
const REVIEW_PASSED_FIELD = 'pre_verify_review_result'

function conditionOf(guard: WbGuardConfig): LeaveCondition {
  const base = 'workflow.leave_conditions'
  switch (guard.type) {
    case 'tasks-at-least': return { key: `${base}.tasks-at-least`, vars: { n: guard.n } }
    case 'field-nonempty': return { key: `${base}.field-nonempty`, vars: { field: guard.field } }
    case 'file-exists': return { key: `${base}.file-exists`, vars: { field: guard.path.field } }
    case 'field-equals':
      return guard.field === REVIEW_PASSED_FIELD && guard.value === 'pass'
        ? { key: `${base}.review-passed` }
        : { key: `${base}.field-equals`, vars: { field: guard.field, value: guard.value } }
    case 'field-in': return { key: `${base}.field-in`, vars: { field: guard.field, values: guard.values.join(', ') } }
    case 'nonempty-output':
    case 'full-direct-override':
    case 'build-head-unchanged':
    case 'spec-migration-applied':
    case 'tasks-through-step':
    case 'not-afk-queued':
    case 'dependencies-ended':
      return { key: `${base}.${guard.type}` }
  }
}

/**
 * 离开某一阶段要满足的条件（只读展示）：本阶段自己的 guards，加上通向后面阶段的转换的 guards。退回边不算——
 * 退回是主动选择，没有「离开条件」；放弃边（`scope-expanded`）也不算——任务要被放弃了，CLI 的 check 同样不把它算进去
 * （kernel 的 `isAbandonEvent`）。带 `when` 的条件只在所选轨道命中时算；相同的话只列一次，保持声明顺序。
 */
export function leaveConditionsOf(step: WbStepDef, steps: readonly WbStepDef[], track: string): LeaveCondition[] {
  const index = steps.findIndex((candidate) => candidate.id === step.id)
  const earlier = new Set(steps.slice(0, Math.max(index, 0)).map((candidate) => candidate.id))
  const guards = [
    ...step.guards,
    ...step.transitions
      .filter((transition) => transition.to !== step.id && !earlier.has(transition.to) && !isAbandonEvent(transition.event))
      .flatMap((transition) => transition.guards ?? []),
  ]
  const seen = new Set<string>()
  const out: LeaveCondition[] = []
  for (const guard of guards) {
    if (!appliesTo(guard.when, track)) continue
    const condition = conditionOf(guard)
    const identity = `${condition.key}\u0000${JSON.stringify(condition.vars ?? {})}`
    if (seen.has(identity)) continue
    seen.add(identity)
    out.push(condition)
  }
  return out
}
