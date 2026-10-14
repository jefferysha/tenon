/**
 * 工作流执行的单一接缝：按计划里记着的执行模型选适配器，调用方不再自己判断模型。
 *
 * 调用方是 transition-application.ts（转换规划）、transition-readiness.ts（就绪判定）与
 * step-exit-report.ts（出口报告）。两个适配器：step-graph（新任务）与 legacy-phase-manifest
 * （只服务快照里记着旧模型的任务，与 legacy-phase-manifest/ 整目录同生共死）。类型见 execution-seam-types.ts。
 *
 * 命令层要区分两种模型时（CLI 的 advance / check / 字段闸 / 状态投影等）不在这里加方法，而是经
 * packages/cli/src/commands/execution-cli-seam.ts：它同样只读 `selectExecution(plan).kind`。
 * tools/execution-model-seam.mjs 在 check:architecture 里禁止接缝之外拿模型名字面量做比较。
 */
import type { EffectiveWorkflowPlan } from './effective-plan-types.js'
import type { ExecutionAdapter } from './execution-seam-types.js'
import { legacyPhaseManifestExecution } from './legacy-phase-manifest/legacy-execution.js'
import { stepGraphExecution } from './step-graph-execution.js'

export type {
  EdgeGuardBlocker, ExecutionAdapter, ExecutionKind, ExitGuardContext, ExitReportBasis, ExitReportInput,
  ReadinessBasis, ReadinessInput, TransitionInput, TransitionPlanResult,
} from './execution-seam-types.js'

export function selectExecution(plan: EffectiveWorkflowPlan): ExecutionAdapter {
  return plan.capabilities.execution.model === 'phase-manifest' ? legacyPhaseManifestExecution : stepGraphExecution
}
