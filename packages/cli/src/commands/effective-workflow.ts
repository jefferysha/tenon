import {
  compileWorkflow,
  loadCompiledWorkflow,
  loadWorkflow,
  planAutomationPolicy,
  requireRunPlan,
  resolveBoundEffectiveWorkflowPlan,
  resolveWorkflowName,
  type AutomationPolicyBits,
  type EffectiveWorkflowPlan,
  type PipelineState,
} from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { changeDir } from '../paths.js'

/**
 * CLI compatibility adapter for the kernel's capability plan. Workflow identity handling stays
 * inside the kernel resolver; commands consume only the resulting runtime policies and IR.
 *
 * 计划按任务记着的轨道选分支，取自任务冻结的快照（没有快照才读现行工作流），不查任何登记表：
 * 快照记着旧执行模型的在途任务（含 standard / simple / chat / free）在模板或登记表删除后照样能走完。
 */
export function effectiveWorkflowForState(
  deps: CliDeps,
  state: PipelineState,
): EffectiveWorkflowPlan | null {
  const workflowName = resolveWorkflowName(state)
  const trackValue = state.fields.track
  const trackId = Array.isArray(trackValue) ? trackValue.join(',') : (trackValue ?? '')
  return resolveBoundEffectiveWorkflowPlan(workflowName, {
    documentProfile: state.runMetadata?.documentProfile,
    documentGovernanceFingerprint: state.runMetadata?.documentGovernanceFingerprint,
    workflowPlanFingerprint: state.runMetadata?.workflowPlanFingerprint,
  }, (name) => {
    const definition = loadWorkflow(deps.cwd, name)
    return definition === null ? null : compileWorkflow(definition)
  }, trackId, state.runMetadata?.workflowPlanSnapshot)
}

/**
 * 某个任务的 AFK 策略位解析器（AFK 挂队、规格完成后自动入队用）：工作流与轨道都取自该任务自己的状态与
 * 冻结快照，传入的轨道 id 即任务状态里记的那个；策略位读计划里选中分支的 `automation`。
 * 到被调用时才读状态，没用到就不产生任何读取。
 */
export function trackPolicyResolverFor(
  deps: Pick<CliDeps, 'cwd' | 'store'>,
  change: string,
): (trackId: string) => Promise<AutomationPolicyBits> {
  return async (trackId) => {
    const state = await deps.store.read(changeDir(deps.cwd, change))
    return planAutomationPolicy(requireRunPlan(
      resolveWorkflowName(state),
      trackId,
      state.runMetadata?.workflowPlanSnapshot,
      (name) => loadCompiledWorkflow(deps.cwd, name),
    ))
  }
}
