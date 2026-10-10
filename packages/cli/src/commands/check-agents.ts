/**
 * `tenon check` 的 agent 预览：与转换拦截同一份判定，只渲染、不写盘。
 *
 * 给了 `--event` 且那条边是退回边时不查 agent（转换本身也不查）；没给 event 时按「本步存在任一
 * 前进出边」预览，让缺的评审在被门禁堵住之前就可见。
 */
import { evaluateStepAgents, isForwardExit, renderAgentBlocker, stepExitTransitions } from '@tenon/kernel'
import type { EffectiveWorkflowPlan, PipelineState } from '@tenon/kernel'
import { agentEvaluationInput, stepAgentBlockersFor } from '../agentGate.js'
import type { CliDeps } from '../deps.js'
import { str } from '../render.js'

/**
 * 用户已接受的剩余阻断的提示行（评审者仍不通过，但接受记录绑定的运行与候选都对得上，不再阻断）。
 * 只出提示，不影响退出码；与 `stepAgentLines` 同一个「本步是否有前进出边」口径。
 */
export async function acceptedResidualLines(
  deps: CliDeps,
  name: string,
  dir: string,
  state: PipelineState,
  plan: EffectiveWorkflowPlan,
  event: string | undefined,
): Promise<readonly string[]> {
  const stepId = str(state.fields.phase)
  const forward = stepExitTransitions(plan, stepId, state)
    .filter((transition) => isForwardExit(plan, stepId, transition.to, transition.event))
  if (event === undefined ? forward.length === 0 : !forward.some((transition) => transition.event === event)) return []
  const evaluation = await agentEvaluationInput({ deps, name, dir, stepId, plan, state })
  if (evaluation === undefined || 'invalid' in evaluation) return []
  return (evaluateStepAgents(evaluation).accepted ?? []).map((note) =>
    `评审者 '${note.agent}' 仍不通过（${note.findings} 个阻断级发现），但用户已接受这个剩余阻断（运行 ${note.runId}，只对这次运行与当时的代码有效）`)
}

export async function stepAgentLines(
  deps: CliDeps,
  name: string,
  dir: string,
  state: PipelineState,
  plan: EffectiveWorkflowPlan,
  event: string | undefined,
  /**
   * review request 专用：验证轮次用完后，必需评审者「不通过」随这次评审请求交给用户接受（冻结成待接受的剩余阻断），
   * 不拦请求；评审者缺失 / 过期 / 进行中等其它阻断照旧拦。transition 与普通 check 不放行。
   */
  options: { readonly releaseFailedReviewers?: boolean } = {},
): Promise<readonly string[]> {
  const stepId = str(state.fields.phase)
  const exits = stepExitTransitions(plan, stepId, state)
  const forward = exits.filter((transition) => isForwardExit(plan, stepId, transition.to, transition.event))
  if (event === undefined ? forward.length === 0 : !forward.some((transition) => transition.event === event)) {
    return []
  }
  const blockers = await stepAgentBlockersFor({ deps, name, dir, stepId, plan, state })
  return blockers
    .filter((blocker) => options.releaseFailedReviewers !== true || blocker.kind !== 'reviewer-failed')
    .map((blocker) => renderAgentBlocker(blocker, name))
}
