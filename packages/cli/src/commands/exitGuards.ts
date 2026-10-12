/**
 * 「离开本步」的条件：步骤自己的 guards 加上每条前进出边的 guards（含固定生命周期补充的那几条）。
 *
 * default.yaml 把离开条件写在前进边上（build-complete 要实现前评审通过、任务已勾选……），`step.guards` 往往是空的。
 * 只读 `step.guards` 的预览——`tenon check <c>`（不带 event）、`status` 的字段投影、结论字段写入闸——于是看不见它们，
 * 与 transition 在锁内求值的集合分歧。三处都经这里取，口径只此一份；带 event 的 check 与 transition 仍按那一条边求值。
 *
 * 前进出边 = 既不是回退边、也不是放弃边：
 *   · 回退边（目标在步骤序里更靠前）要一直开着，它的 guards 不拦前进，也不该出现在「离开条件」里；
 *   · 放弃边（`scope-expanded`）任务要被放弃了，只看它自己的 guards。
 * 两者都用 kernel 已有的判定（`isForwardExit`、`isAbandonEvent`），不按事件名写死。
 */
import { isDeepStrictEqual } from 'node:util'
import {
  effectiveLifecyclePolicy, isAbandonEvent, isForwardExit, isRevisionGuard, mergeLifecycleGuards, stepExitTransitions,
  type CompiledGuardConfig, type EffectiveWorkflowPlan, type PipelineState, type StepIR, type StepTransitionIR,
} from '@tenon/kernel'

/**
 * 当前步的前进出边（含没有前进边的步骤推导出的隐式完结边），按声明顺序。传 `state` 是为了已完结的运行
 * 不再给出完结边（见 `implicitCompletionTransition`）；调用方已自行处理完结时可省略。
 */
export function advancingExits(
  plan: EffectiveWorkflowPlan,
  step: StepIR,
  state?: PipelineState,
): readonly StepTransitionIR[] {
  return stepExitTransitions(plan, step.id, state)
    .filter((transition) => !isAbandonEvent(transition.event) && isForwardExit(plan, step.id, transition.to, transition.event))
}

function lifecycleOf(plan: EffectiveWorkflowPlan, step: StepIR, transition: StepTransitionIR) {
  return effectiveLifecyclePolicy(
    plan.capabilities.documents.governed,
    step,
    transition,
    plan.workflow.steps.find((candidate) => candidate.id === transition.to),
  )
}

/** 结构比较：对象键序不同、内容相同的 guard 是同一条（不能像 JSON.stringify 那样按键序判成不同）。 */
const sameGuard = (a: CompiledGuardConfig, b: CompiledGuardConfig): boolean => isDeepStrictEqual(a, b)

/**
 * 步骤 guards ∪ 前进出边 guards，结构相同的只留一条。
 *
 * 前进边只有一条（default 的每一步都是）时，它的 guards 就是离开条件。有多条前进边是分岔：各条边是互斥的出路，
 * 把它们的 guards 并在一起会要求同时满足彼此矛盾的条件（一条要 `=pass`、另一条要 `=pending`），预览永远过不了；
 * 所以分岔只留各条前进边共有的条件，某条边专属的条件看那一条边（`check <c> --event`、`status` 的 exits[].blockers）。
 *
 * 构建修订守卫（build_sha 未被改动）沿用既有口径：只要有一条非回退出边需要它就保留一份，位置在步骤声明它的地方
 * （没声明就排在步骤 guards 之后）；只有回退边的步骤不要求前进证明，修问题的路必须一直开着。
 */
export function leaveGuards(
  plan: EffectiveWorkflowPlan,
  step: StepIR,
  state: PipelineState,
): readonly CompiledGuardConfig[] {
  const policies = stepExitTransitions(plan, step.id, state).map((transition) => lifecycleOf(plan, step, transition))
  const revisionGuard = policies
    .filter((policy) => !policy.rollback)
    .flatMap((policy) => policy.guards)
    .find(isRevisionGuard)
  const nonRevision = step.guards.filter((guard) => !isRevisionGuard(guard))
  let own: readonly CompiledGuardConfig[] = nonRevision
  if (revisionGuard !== undefined) {
    const firstRevisionIndex = step.guards.findIndex(isRevisionGuard)
    const insertionIndex = firstRevisionIndex < 0 ? nonRevision.length : Math.min(firstRevisionIndex, nonRevision.length)
    own = [...nonRevision.slice(0, insertionIndex), revisionGuard, ...nonRevision.slice(insertionIndex)]
  }
  const perExit = advancingExits(plan, step, state)
    .map((transition) => lifecycleOf(plan, step, transition))
    .filter((policy) => !policy.rollback)
    .map((policy) => policy.guards.filter((guard) => !isRevisionGuard(guard)))
  const fromEdges = perExit.reduce<readonly CompiledGuardConfig[] | undefined>(
    (common, guards) => common === undefined ? guards : common.filter((guard) => guards.some((other) => sameGuard(guard, other))),
    undefined,
  ) ?? []
  return mergeLifecycleGuards(own, fromEdges)
}
