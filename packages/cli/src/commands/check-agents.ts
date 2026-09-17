/**
 * `tenon check` 的 agent 预览：与转换拦截同一份判定，只渲染、不写盘。
 *
 * 给了 `--event` 且那条边是退回边时不查 agent（转换本身也不查）；没给 event 时按「本步存在任一
 * 前进出边」预览，让缺的评审在被门禁堵住之前就可见。
 */
import { isForwardExit, renderAgentBlocker, stepExitTransitions } from '@tenon/kernel'
import type { EffectiveWorkflowPlan, PipelineState } from '@tenon/kernel'
import { stepAgentBlockersFor } from '../agentGate.js'
import type { CliDeps } from '../deps.js'
import { str } from '../render.js'

export async function stepAgentLines(
  deps: CliDeps,
  name: string,
  dir: string,
  state: PipelineState,
  plan: EffectiveWorkflowPlan,
  event: string | undefined,
): Promise<readonly string[]> {
  const stepId = str(state.fields.phase)
  const exits = stepExitTransitions(plan, stepId, state)
  const forward = exits.filter((transition) => isForwardExit(plan, stepId, transition.to, transition.event))
  if (event === undefined ? forward.length === 0 : !forward.some((transition) => transition.event === event)) {
    return []
  }
  const blockers = await stepAgentBlockersFor({ deps, name, dir, stepId, plan, state })
  return blockers.map((blocker) => renderAgentBlocker(blocker, name))
}
