/** 计划类命令共用的输入装配：目录、当前计划状态、delta spec 场景、tasks 条目、diff 文件列表。 */
import {
  loadDeltaScenarios, loadTaskItems, readTestPlanState, resolveStepTestPolicy, stepHasTestPolicy,
  type ChangedFilesReport, type OpenSpecScenario, type StepIR, type StepTestPolicyIR, type TaskItem, type TestCatalog, type TestPlanState,
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

/** 目录读不到或无效时给用户的错误行（含下一步命令）。 */
export function catalogErrorLine(catalog: Exclude<CatalogFile, { readonly state: 'ok' }>): string {
  return `ERROR: ${catalog.state === 'missing' ? '还没有测试目录；先 tenon test discover --write' : 'catalog.yaml 无效；先 tenon test catalog validate'}`
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

/**
 * 一个步骤的有效测试策略：旧 `test_policy` 原样，档位按项目测试目录的 `levels` 求值（目录读不到按内建缺省）；
 * 步骤没有测试声明时 undefined。只读 integrity / coverage 阈值这类展示用途的调用方走这里，不再各自读 `step.test_policy`。
 */
export async function stepPolicyFor(deps: CliDeps, step: Pick<StepIR, 'test' | 'test_policy'>): Promise<StepTestPolicyIR | undefined> {
  if (!stepHasTestPolicy(step)) return undefined
  if (step.test_policy !== undefined) return step.test_policy
  const catalog = await readCatalogFile(deps.cwd)
  return resolveStepTestPolicy(step, catalog.state === 'ok' ? catalog.catalog : undefined)
}

/** 工作流所有步骤的有效测试策略（档位按目录求值；计划初稿按整个工作流要求的种类补套件）。 */
export function policiesOf(context: TestCommandContext, catalog: TestCatalog): readonly StepTestPolicyIR[] {
  return context.plan.workflow.steps.flatMap((step) => resolveStepTestPolicy(step, catalog) ?? [])
}
