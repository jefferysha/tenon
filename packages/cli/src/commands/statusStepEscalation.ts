/**
 * 风险升级：轻量轨道的改动风险探针（方向 `diff-risk` 的必需步骤测试）不过，说明任务已经超出了轻量轨道——
 * `next` 不再催着把这一步做完，而是下发放弃边 `scope-expanded`（已有机制：转入终态 escalated，之后在同一工作流里另起重型轨道任务）。
 *
 * 探针阈值是工作流里这条测试的 `pass.metrics`，判定与记录都走普通的测试证据；这里只把「探针红了」翻译成
 * 一条 `next` 动作。没有探针的轨道一切照旧：`scope-expanded` 由执行者自己判断。
 */
import {
  DIFF_RISK_DIRECTION, isAbandonEvent, isValidWorkflowName,
  type EffectiveWorkflowPlan, type PipelineState, type TestEvidenceItem,
} from '@tenon/kernel'
import { str } from '../render.js'
import type { StepAction } from './statusStepAction.js'
import type { StepExit } from './stepExitReport.js'
import { siblingTrackIds } from './taskDomain.js'

export interface StepEscalation {
  readonly event: string
  /** 哪些阈值被突破了（探针记录里的 metric-threshold 原因）。 */
  readonly reasons: readonly string[]
  /** 之后怎么另起重型任务（见 `escalationThen`）。 */
  readonly then: string
}

/** 另起重型任务要知道的三件事，都取自任务自己的计划与状态。 */
export interface EscalationSuccessor {
  readonly workflow: string
  /** 任务创建时记下的领域轨道；空串 = 没记。 */
  readonly domain: string
  /** 同一工作流里除本任务轨道之外的分支 id。 */
  readonly siblings: readonly string[]
}

/** 工作流与分支取任务冻结的计划（含全部分支），领域取任务状态——不重新读盘。 */
export function escalationSuccessor(plan: EffectiveWorkflowPlan, state: PipelineState): EscalationSuccessor {
  return {
    workflow: plan.id,
    domain: str(state.fields.domain),
    siblings: siblingTrackIds(plan.definition ?? plan.workflow, str(state.fields.track)),
  }
}

const AFTER_ABANDON = '再 tenon set <新任务> depends_on <本任务>；不要为了让探针通过去拆改动或藏文件'

/**
 * 升级后的指引，会原样交给执行者去跑。记着的领域只有仍是当前可选分支之一才直接写进命令（`domain` 能被
 * `tenon set` 改，不能把任意文本拼进命令）；工作流 id 同理，只有是合法的工作流名才写进命令和说明，
 * 否则不拼，改为请用户指明工作流。
 */
export function escalationThen(successor: EscalationSuccessor): string {
  const { workflow, domain, siblings } = successor
  if (!isValidWorkflowName(workflow)) {
    return '放弃本任务后新建重型轨道任务（任务记着的工作流 id 不是合法名字，没有写进命令：'
      + `请用户指明工作流，再 tenon init <新任务> --workflow <工作流> --preset full），${AFTER_ABANDON}`
  }
  const create = `tenon init <新任务> --workflow ${workflow}`
  const command = siblings.includes(domain)
    ? `${create} --track ${domain} --preset full`
    : siblings.length > 0
      ? `${create} --track <${siblings.join('|')}> --preset full；本任务创建时没有记下领域，轨道请用户选领域`
      : `${create} --preset full`
  return `放弃本任务后新建 ${workflow} 的重型轨道任务（${command}），${AFTER_ABANDON}`
}

/** 探针已跑且不过、本步又有放弃边 → 升级信号；否则 null。 */
export function stepEscalation(
  items: readonly TestEvidenceItem[],
  exits: readonly StepExit[],
  plan: EffectiveWorkflowPlan,
  state: PipelineState,
): StepEscalation | null {
  const abandon = exits.find((exit) => isAbandonEvent(exit.event))
  if (abandon === undefined) return null
  const failed = items.find((item) => item.test.direction === DIFF_RISK_DIRECTION && item.test.required && item.status === 'failed')
  if (failed === undefined) return null
  const reasons = (failed.run?.reasons ?? [])
    .filter((reason) => reason.code === 'metric-threshold')
    .map((reason) => reason.detail ?? reason.code)
  return {
    event: abandon.event,
    reasons: reasons.length > 0 ? reasons : ['改动风险探针未通过'],
    then: escalationThen(escalationSuccessor(plan, state)),
  }
}

/** 升级动作：评审门步骤上放弃边同样要人确认（request → await → transition），其余直接转换。 */
export function escalationActions(
  escalation: StepEscalation,
  gate: string | null,
  review: { readonly status: string; readonly event: string | null },
): readonly StepAction[] {
  const escalate = { reasons: escalation.reasons, then: escalation.then }
  const event = escalation.event
  if (gate === 'review') {
    if (review.event === event && review.status === 'pending') return [{ action: 'await-review', event, escalate }]
    if (review.event === event && review.status === 'approved') return [{ action: 'transition', event, escalate }]
    return [{ action: 'request-review', event, escalate }]
  }
  return [{ action: 'transition', event, escalate }]
}
