/** 计划类命令共用的输入装配：目录、当前计划状态、delta spec 场景、tasks 条目、diff 文件列表。 */
import {
  loadDeltaScenarios, loadTaskItems, readTestPlanState,
  type ChangedFilesReport, type OpenSpecScenario, type StepTestPolicyIR, type TaskItem, type TestPlanState,
} from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import type { TestCommandContext } from '../commands/test-context.js'
import { changedFilesReportFor } from '../testEvidenceContext.js'
import { readCatalogFile, type CatalogFile } from './project-files.js'

export interface PlanInputs {
  readonly catalog: CatalogFile
  readonly planState: TestPlanState
  readonly scenarios: readonly OpenSpecScenario[]
  readonly tasks: readonly TaskItem[]
}

export async function loadPlanInputs(deps: CliDeps, context: TestCommandContext): Promise<PlanInputs> {
  const [catalog, planState, scenarios, tasks] = await Promise.all([
    readCatalogFile(deps.cwd),
    readTestPlanState(context.dir, context.name),
    loadDeltaScenarios(context.dir),
    loadTaskItems(context.dir, context.plan.workflow.steps.map((step) => ({ id: step.id, label: step.label }))),
  ])
  return { catalog, planState, scenarios, tasks }
}

export type ChangedFilesOutcome =
  | {
      readonly ok: true
      readonly files: readonly string[]
      /** 未跟踪文件超过读取上限，只检查了前 `limit` 个（显式标出，不是静默截断）。 */
      readonly untrackedTruncated?: { readonly found: number; readonly limit: number }
    }
  | { readonly ok: false; readonly reason: string }

export async function tryChangedFiles(deps: CliDeps, change: string): Promise<ChangedFilesOutcome> {
  try {
    const source = await changedFilesReportFor(deps, change)()
    if (Array.isArray(source)) return { ok: true, files: source }
    const report = source as ChangedFilesReport
    return { ok: true, files: report.files, ...(report.untrackedTruncated === undefined ? {} : { untrackedTruncated: report.untrackedTruncated }) }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message.slice(0, 200) : '读取失败' }
  }
}

/** 工作流所有步骤的测试策略（计划初稿按整个工作流要求的种类补套件）。 */
export function policiesOf(context: TestCommandContext): readonly StepTestPolicyIR[] {
  return context.plan.workflow.steps.flatMap((step) => (step.test_policy === undefined ? [] : [step.test_policy]))
}
