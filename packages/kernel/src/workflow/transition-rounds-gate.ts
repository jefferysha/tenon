/**
 * 验证轮次上限的强制层：受约束步骤（评审门且有回退边）当前轮次已达上限时，回退边的转换被拒。
 *
 * `next` 只是投影，agent 也可以直接 `tenon transition <回退事件>`（或经 Dashboard 的写回端点）；上限只靠 `next`
 * 给出的动作就拦不住。所以 CLI 与 Dashboard 服务共调的这个用例在 commit 之前、同一把 Change 锁内再核对一次。
 * 前进边、放弃边与不受约束步骤（如 build 的 `requirements-changed`）不受影响；宿主没接线（没有 `roundsOf`）时不拦。
 */
import type { PipelineState } from '../types.js'
import { isForwardExit } from './agent-verdict.js'
import { isAbandonEvent } from './implicit-completion.js'
import type { EffectiveWorkflowPlan } from './effective-plan-types.js'
import { isRoundsLimited } from './step-rounds.js'
import { roundsExhausted } from './step-rounds-read.js'
import type { TransitionApplicationDeps, TransitionRejection } from './transition-application-types.js'

export async function rejectOnRoundsExhausted(input: {
  readonly deps: Pick<TransitionApplicationDeps, 'roundsOf'>
  readonly changeDir: string
  readonly workflowName: string
  readonly plan: EffectiveWorkflowPlan
  readonly state: PipelineState
  readonly from: string
  readonly to: string
  readonly event: string
}): Promise<TransitionRejection | undefined> {
  const { deps, plan, from, event } = input
  if (deps.roundsOf === undefined || isAbandonEvent(event)) return undefined
  if (isForwardExit(plan, from, input.to, event) || !isRoundsLimited(plan, from)) return undefined
  const rounds = await deps.roundsOf({ changeDir: input.changeDir, plan, state: input.state, stepId: from })
  if (rounds === null || !roundsExhausted(rounds)) return undefined
  return {
    kind: 'rounds-exhausted', workflowName: input.workflowName, stepId: from, event,
    current: rounds.current, max: rounds.max, source: rounds.source,
  }
}
