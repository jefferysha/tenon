/**
 * CLI 里区分执行模型的唯一入口。
 *
 * 新任务按 YAML 的步骤图执行；快照里记着旧阶段清单（phase-manifest）模型的在途任务走旧引擎，旧引擎下个版本
 * 整体删除。选哪个适配器由 kernel 的 `selectExecution` 决定（`kind` 是闭集），命令层要区分两者时只调这里，
 * 不自己拿模型名比较（tools/execution-model-seam.mjs 在 check:architecture 里守这条）。计划里的技能策略
 * `skills.source`（旧模型 manifest-overlay / 新模型 step-declared）是执行模型的投影，同样问这里，不直接比较。旧引擎删除时，
 * `isLegacyExecution` 为 true 的分支随之失效，按这两个函数的引用就能一次找全。
 */
import {
  compileEffectiveWorkflowPlan,
  selectExecution,
  type EffectiveWorkflowPlan,
  type ExecutionKind,
  type WorkflowDef,
} from '@tenon/kernel'

// Record 要求每个 kind 都有取值：kernel 将来新增适配器时，这里编译不过，而不是悄悄归入"不是旧的就是新的"。
const IS_LEGACY: Readonly<Record<ExecutionKind, boolean>> = {
  'legacy-phase-manifest': true,
  'step-graph': false,
}

/** 计划按旧阶段清单引擎执行（只有快照记着旧模型的在途任务）。 */
export function isLegacyExecution(plan: EffectiveWorkflowPlan): boolean {
  return IS_LEGACY[selectExecution(plan).kind]
}

/** 计划按 YAML 的步骤图执行（所有新建任务）。 */
export function isStepGraphExecution(plan: EffectiveWorkflowPlan): boolean {
  return !isLegacyExecution(plan)
}

/**
 * 补快照时的候选计划：任务创建时的执行模型没有记录，两种模型各编译一份，由调用方按任务绑定的指纹认出
 * 属于哪一份。顺序固定为新模型在前，指纹对不上时的报错取第一份的指纹。
 */
export function frozenPlanCandidates(
  workflowId: string,
  definition: WorkflowDef | undefined,
  track: string,
): readonly EffectiveWorkflowPlan[] {
  return (['step-graph', 'phase-manifest'] as const).map((executionModel) =>
    compileEffectiveWorkflowPlan(workflowId, definition, { track, executionModel }))
}
