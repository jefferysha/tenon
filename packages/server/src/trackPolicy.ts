import { join } from 'node:path'
import {
  loadCompiledWorkflow,
  planAutomationPolicy,
  requireRunPlan,
  resolveWorkflowName,
  type AutomationPolicyBits,
  type PipelineState,
  type StateStore,
} from '@tenon/kernel'

/**
 * 某个任务的 AFK 策略位解析器（转换成功后「规格完成自动入队」用）：工作流与轨道取自该任务自己的状态与
 * 冻结快照，策略位读计划里选中分支的 `automation`，不查登记表。转换流程要求同步回调，所以在转换前读一次
 * 状态；状态读不出时回调抛错，由后置编排按「自动挂队失败」处理，不影响已提交的转换。
 */
export async function resolveTrackPolicyFor(
  store: Pick<StateStore, 'read'>,
  root: string,
  change: string,
): Promise<(trackId: string) => AutomationPolicyBits> {
  let state: PipelineState | undefined
  try {
    state = await store.read(join(root, 'openspec', 'changes', change))
  } catch {
    state = undefined
  }
  return (trackId) => {
    if (state === undefined) throw new Error(`任务 '${change}' 的状态不可读`)
    return planAutomationPolicy(requireRunPlan(
      resolveWorkflowName(state), trackId, state.runMetadata?.workflowPlanSnapshot,
      (workflowName) => loadCompiledWorkflow(root, workflowName),
    ))
  }
}
