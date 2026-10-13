/**
 * 验证轮次上限的强制层：受约束步骤（评审门且有回退边）上，回退边的转换按轮次分三态——
 *   - `not-limited`：不是受约束步骤上的回退边（前进边、放弃边、无评审门的步骤），或宿主没接线（没有 `roundsOf`，失败关闭：
 *     调用方照旧要求评审回执）；
 *   - `within-budget`：轮次还没用完。回退不越过任何质量门，代价由上限封顶，调用方据此免评审回执；
 *   - `exhausted`：轮次已用完，回退边被拒（带 `rounds-exhausted` 拒绝）。
 *
 * `next` 只是投影，agent 也可以直接 `tenon transition <回退事件>`（或经 Dashboard 的写回端点）；上限只靠 `next`
 * 给出的动作就拦不住。所以 CLI 与 Dashboard 服务共调的这个用例在 commit 之前、同一把 Change 锁内再核对一次，
 * 免回执与拒绝共用同一次轮次读取。
 * 前进边、放弃边与不受约束步骤（如 build 的 `requirements-changed`）永远是 `not-limited`，也不去读轮次。
 */
import type { PipelineState } from '../types.js'
import { isForwardExit } from './agent-verdict.js'
import { isAbandonEvent } from './implicit-completion.js'
import type { EffectiveWorkflowPlan } from './effective-plan-types.js'
import { isRoundsLimited } from './step-rounds.js'
import { roundsExhausted, type StepRounds } from './step-rounds-read.js'
import type { TransitionApplicationDeps, TransitionRejection } from './transition-application-types.js'

/**
 * 「轮次内回退免评审回执」的唯一判定，内核转换用例（`backEdgeRounds`）与 CLI `next`（statusStepExits.ts）共用：
 * 这条出边是回退边、不是放弃边，且受约束步骤的轮次已知、还没用完。
 * `back` 由调用方按各自掌握的计划判（内核：不是前进边；`next`：出口投影的 direction）。`rounds` 只在步骤受上限约束时
 * 才有值：步骤不受约束、宿主没接线或读不到都是 null / undefined，失败关闭——照旧要求评审回执。
 */
export function backEdgeSkipsReview(input: {
  readonly event: string
  readonly back: boolean
  readonly rounds: Pick<StepRounds, 'current' | 'max'> | null | undefined
}): boolean {
  return input.back && !isAbandonEvent(input.event) && input.rounds !== null && input.rounds !== undefined
    && !roundsExhausted(input.rounds)
}

export type BackEdgeRounds =
  | { readonly kind: 'not-limited' }
  | { readonly kind: 'within-budget' }
  | { readonly kind: 'exhausted'; readonly rejection: TransitionRejection }

/** 受约束步骤上回退边的轮次结论：不受约束（含宿主没接线）/ 轮次内（可免评审回执）/ 已用完（拒绝）。 */
export async function backEdgeRounds(input: {
  readonly deps: Pick<TransitionApplicationDeps, 'roundsOf'>
  readonly changeDir: string
  readonly workflowName: string
  readonly plan: EffectiveWorkflowPlan
  readonly state: PipelineState
  readonly from: string
  readonly to: string
  readonly event: string
}): Promise<BackEdgeRounds> {
  const { deps, plan, from, event } = input
  if (deps.roundsOf === undefined || isAbandonEvent(event)) return { kind: 'not-limited' }
  if (isForwardExit(plan, from, input.to, event) || !isRoundsLimited(plan, from)) return { kind: 'not-limited' }
  const rounds = await deps.roundsOf({ changeDir: input.changeDir, plan, state: input.state, stepId: from })
  if (rounds === null) return { kind: 'not-limited' }
  if (backEdgeSkipsReview({ event, back: true, rounds })) return { kind: 'within-budget' }
  return {
    kind: 'exhausted',
    rejection: {
      kind: 'rounds-exhausted', workflowName: input.workflowName, stepId: from, event,
      current: rounds.current, max: rounds.max, source: rounds.source,
    },
  }
}
