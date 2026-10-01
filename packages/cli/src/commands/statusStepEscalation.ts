/**
 * 风险升级：standard 通道的改动风险探针（方向 `diff-risk` 的必需步骤测试）不过，说明任务已经长出了轻量通道——
 * `next` 不再催着把这一步做完，而是下发放弃边 `scope-expanded`（已有机制：转入终态 escalated，之后另起 default 任务）。
 *
 * 探针阈值是工作流里这条测试的 `pass.metrics`，判定与记录都走普通的测试证据；这里只把「探针红了」翻译成
 * 一条 `next` 动作。没有探针的工作流（simple）一切照旧：`scope-expanded` 由执行者自己判断。
 */
import { isAbandonEvent, type TestEvidenceItem } from '@tenon/kernel'
import type { StepAction } from './statusStepAction.js'
import type { StepExit } from './stepExitReport.js'

/** 风险探针的测试方向（templates/test-directions/diff-risk.yaml）。 */
export const DIFF_RISK_DIRECTION = 'diff-risk'

export interface StepEscalation {
  readonly event: string
  /** 哪些阈值被突破了（探针记录里的 metric-threshold 原因）。 */
  readonly reasons: readonly string[]
}

const THEN = '放弃本任务后新建 default 任务（tenon init <新任务> --workflow default --track <backend|frontend|…> --preset full），'
  + '再 tenon set <新任务> depends_on <本任务>；不要为了让探针通过去拆改动或藏文件'

/** 探针已跑且不过、本步又有放弃边 → 升级信号；否则 null。 */
export function stepEscalation(items: readonly TestEvidenceItem[], exits: readonly StepExit[]): StepEscalation | null {
  const abandon = exits.find((exit) => isAbandonEvent(exit.event))
  if (abandon === undefined) return null
  const failed = items.find((item) => item.test.direction === DIFF_RISK_DIRECTION && item.test.required && item.status === 'failed')
  if (failed === undefined) return null
  const reasons = (failed.run?.reasons ?? [])
    .filter((reason) => reason.code === 'metric-threshold')
    .map((reason) => reason.detail ?? reason.code)
  return { event: abandon.event, reasons: reasons.length > 0 ? reasons : ['改动风险探针未通过'] }
}

/** 升级动作：评审门步骤上放弃边同样要人确认（request → await → transition），其余直接转换。 */
export function escalationActions(
  escalation: StepEscalation,
  gate: string | null,
  review: { readonly status: string; readonly event: string | null },
): readonly StepAction[] {
  const escalate = { reasons: escalation.reasons, then: THEN }
  const event = escalation.event
  if (gate === 'review') {
    if (review.event === event && review.status === 'pending') return [{ action: 'await-review', event, escalate }]
    if (review.event === event && review.status === 'approved') return [{ action: 'transition', event, escalate }]
    return [{ action: 'request-review', event, escalate }]
  }
  return [{ action: 'transition', event, escalate }]
}
