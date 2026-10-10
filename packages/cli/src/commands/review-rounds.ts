/**
 * `tenon review request` 里的验证轮次上限：
 *
 *   · 强制层：受约束步骤（评审门且有回退边）上限用完后，回退边的评审请求被拒（写出已用轮次、上限与调高上限的命令）。
 *     前进边、放弃边与不受约束的步骤（如 build 的 `requirements-changed`）不受影响。
 *   · 剩余阻断：用完后前进边的评审请求在必需评审者「不通过」时放行，并在 Change 锁内把这些评审者（`reviewer:<agent>`）连同
 *     运行 id、当前候选、阻断级发现冻结成待接受的剩余阻断（kernel review-residual.ts），逐条列给用户；用户确认这道评审门就接受了它们。
 *     未用完时必需评审者不通过，前进边的评审请求照旧被拒。
 */
import {
  evaluateStepAgents, isAbandonEvent, isForwardExit, residualFromBlockers, roundsExhausted, stepExitTransitions,
  type EffectiveWorkflowPlan, type FrozenResidual, type PipelineState, type StepRounds,
} from '@tenon/kernel'
import { agentEvaluationInput, stepAgentBlockersFor } from '../agentGate.js'
import type { CliDeps } from '../deps.js'
import { msg } from '../i18n/messages.js'
import { str } from '../render.js'
import { effectiveWorkflowForState } from './effective-workflow.js'
import { stepRounds } from './statusStepRounds.js'

export interface ReviewRoundsInfo {
  readonly plan: EffectiveWorkflowPlan | null
  readonly stepId: string
  /** 受上限约束的步骤的验证轮次；不受约束为 null。 */
  readonly rounds: StepRounds | null
  /** 这条边是回退边（不是前进边、也不是放弃边）。 */
  readonly backEdge: boolean
  readonly exhausted: boolean
}

export async function reviewRoundsInfo(
  deps: CliDeps,
  dir: string,
  state: PipelineState,
  event: string,
): Promise<ReviewRoundsInfo> {
  const plan = effectiveWorkflowForState(deps, state)
  const stepId = str(state.fields.phase)
  if (plan === null) return { plan, stepId, rounds: null, backEdge: false, exhausted: false }
  const rounds = await stepRounds(deps, dir, state, plan, stepId)
  const edge = stepExitTransitions(plan, stepId, state).find((transition) => transition.event === event)
  const backEdge = edge !== undefined && !isAbandonEvent(event) && !isForwardExit(plan, stepId, edge.to, event)
  return { plan, stepId, rounds, backEdge, exhausted: roundsExhausted(rounds) }
}

/** 用完后回退边的评审请求被拒：调用方抛出它（锁内）或打印后 exit 1（预检）。 */
export function roundsExhaustedMessage(deps: CliDeps, name: string, info: ReviewRoundsInfo, event: string): string {
  const rounds = info.rounds as StepRounds
  return msg(deps, 'transition.roundsExhausted', {
    step: info.stepId, current: rounds.current, max: rounds.max, source: rounds.source, event, name,
  })
}

/** 回退边在上限用完的受约束步骤上：拒绝。 */
export function backEdgeRefused(info: ReviewRoundsInfo): boolean {
  return info.exhausted && info.backEdge
}

/** 用完后的前进边：评审者的「不通过」随评审请求交给用户接受，不拦请求。 */
export function releasesFailedReviewers(info: ReviewRoundsInfo, event: string): boolean {
  return info.exhausted && !info.backEdge && !isAbandonEvent(event)
}

/**
 * 当前候选上不通过的必需评审者 → 待接受的剩余阻断（用完后的前进边才有）。
 *
 * 判定时不带已有的接受记录：撤回回执后重新请求，仍然不通过的评审者要再次列给用户确认，不能因为「之前接受过」
 * 就悄悄不再出现（接受记录本身仍然绑定运行与候选，对得上时继续有效）。
 */
export async function pendingResidual(
  deps: CliDeps,
  name: string,
  dir: string,
  state: PipelineState,
  info: ReviewRoundsInfo,
  event: string,
): Promise<readonly FrozenResidual[]> {
  if (!releasesFailedReviewers(info, event) || info.plan === null) return []
  const input = { deps, name, dir, stepId: info.stepId, plan: info.plan, state }
  if (deps.stepAgents !== undefined) return residualFromBlockers(await stepAgentBlockersFor(input))
  const evaluation = await agentEvaluationInput(input)
  if (evaluation === undefined || 'invalid' in evaluation) return []
  return residualFromBlockers(evaluateStepAgents({ ...evaluation, accepted: [] }).blockers)
}
