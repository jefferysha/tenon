/**
 * `tenon verify --ci` 怎样认出「被放弃的任务」：一个任务沿放弃边（`scope-expanded`）转入终态（standard 与 simple 里的
 * `escalated`），之后另起一个 default 任务接手。放弃一个任务不要求任何测试证据，所以它的记录链、测试登记与候选指纹
 * 本来就不描述任何交付物；CI 对它只留一条提示，不判定。
 *
 * 这条判断是放行的口子，所以只认「真的走过放弃边」的任务，而不是「看起来像被放弃」的任务：
 *   · 状态里的当前步骤必须是冻结工作流里没有任何出边的终态；
 *   · 链头 TransitionRecord（经 canonical 状态校验过的那一条，不是 `.pipeline.yaml` 里可手改的字段）必须是放弃事件，
 *     且它转入的正是这个终态；
 *   · 冻结的工作流里必须真的声明过这条边（来源步骤、事件、目标都对得上）。
 * 状态里只写着 `phase: escalated`、链头却是别的事件（或链头缺失、读不出）的任务不算：照常判定，照常失败。
 */
import type { EffectiveWorkflowPlan } from '../workflow/effective-plan-types.js'
import { isAbandonEvent } from '../workflow/implicit-completion.js'
import type { TransitionRecord } from '../workflow/run-types.js'

export interface AbandonedChange {
  /** 放弃时所在的步骤。 */
  readonly from: string
  /** 转入的终态步骤（`escalated`）。 */
  readonly to: string
  readonly event: string
  /** 放弃发生的时刻（链头记录的观察时间）。 */
  readonly at: string
}

export function abandonedTerminal(input: {
  /** 本次判定用的状态里的当前步骤。 */
  readonly phase: string
  /** canonical 状态（经校验的 run revision）里的当前步骤；必须与 `phase` 一致。 */
  readonly canonicalPhase: string
  readonly plan: Pick<EffectiveWorkflowPlan, 'workflow'>
  /** canonical 状态校验过的链头 TransitionRecord。 */
  readonly head: Pick<TransitionRecord, 'event' | 'from' | 'to' | 'observedAt'> | undefined
}): AbandonedChange | undefined {
  const { head } = input
  if (head === undefined || input.canonicalPhase !== input.phase) return undefined
  if (!isAbandonEvent(head.event) || head.to !== input.phase) return undefined
  const steps = input.plan.workflow.steps
  const terminal = steps.find((step) => step.id === input.phase)
  if (terminal === undefined || terminal.transitions.length > 0) return undefined
  const declared = steps.find((step) => step.id === head.from)
    ?.transitions.some((transition) => transition.event === head.event && transition.to === input.phase)
  if (declared !== true) return undefined
  return { from: head.from, to: head.to, event: head.event, at: head.observedAt }
}
