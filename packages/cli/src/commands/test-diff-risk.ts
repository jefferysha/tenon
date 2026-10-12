/**
 * `tenon test diff-risk [change] [--json]` —— 轻量轨道的改动风险探针，内建 `diff-risk` 测试方向背后的命令。
 * 只读 git，输出一行 JSON：七项指标，外加结论 `exceeded` / `reasons`；阈值不在这里，是工作流里这条步骤测试的
 * `pass.metrics`（改工作流 YAML 即可调整），结论由 kernel 的 `classifyChange` 给出——与实现前的 `tenon assess`
 * 同一份规则。
 *
 * 指标：files_changed（代码类改动文件数）、contract_files / auth_files / dependency_files / migration_files
 * （命中对应路径类的文件数）、deleted_tests（被删的测试文件）、protected_test_files（受保护的测试配置改动：
 * 目录、基线、已知失败清单、项目工作流）。口径与路径分类见 kernel workspace/diff-risk.ts。
 *
 * 任务名取位置参数，缺省取 `TENON_CHANGE_NAME`（`tenon test run` 起测试进程时设置）；起点是任务起点
 * （merge-base / 创建前最后一次提交），所以已提交与未提交的任务改动都算。读不出 git 就失败（exit 1），
 * 绝不当作「没有改动」。退出码不随结论变：超限与否由 `tenon test run` 按 `pass.metrics` 判定并记录，
 * 顶层的七项指标保持原样，`exceeded` / `reasons` 是新增字段（测试运行器只读数值，不受影响）。
 * 任务所在分支读不出 diff-risk 阈值时只给指标，不编造结论。
 */
import {
  classifyChange, protectedTestFileCount, riskThresholdsFor,
  type ChangeRiskVerdict, type DiffRiskMetrics, type MetricThreshold,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { diffChangesFor } from '../diffRisk.js'
import { msg, type MessageCode } from '../i18n/messages.js'
import { isValidChangeName, resolveChangeDir } from '../paths.js'
import { protectedChangesFor } from '../testEvidenceContext.js'
import { effectiveWorkflowForState } from './effective-workflow.js'

const LABELS: Readonly<Record<keyof DiffRiskMetrics, MessageCode>> = {
  files_changed: 'diffRisk.label.filesChanged',
  contract_files: 'diffRisk.label.contractFiles',
  auth_files: 'diffRisk.label.authFiles',
  dependency_files: 'diffRisk.label.dependencyFiles',
  migration_files: 'diffRisk.label.migrationFiles',
  deleted_tests: 'diffRisk.label.deletedTests',
  protected_test_files: 'diffRisk.label.protectedTestFiles',
}

/** 人读报告：七项指标逐行，随后一行结论（探针没有阈值时不带结论，`withVerdict: false`）。探针与 `tenon assess` 共用。 */
export function riskReportLines(deps: Pick<CliDeps, 'locale'>, verdict: ChangeRiskVerdict, withVerdict = true): string[] {
  const lines = (Object.keys(LABELS) as (keyof DiffRiskMetrics)[]).map((key) => `${msg(deps, LABELS[key])}  ${verdict.metrics[key]}`)
  if (!withVerdict) return lines
  lines.push(verdict.exceeded
    ? msg(deps, 'diffRisk.verdict.exceeded', { reasons: verdict.reasons.join('; ') })
    : msg(deps, 'diffRisk.verdict.within'))
  return lines
}

/**
 * 任务所在分支的探针阈值，取自任务冻结的计划；读不出（计划解析失败、分支没有探针）就是没有。
 * 结论只是探针输出的附加信息，读不出阈值不该让指标也读不出来。
 */
async function thresholdsOfChange(deps: CliDeps, name: string): Promise<readonly MetricThreshold[] | undefined> {
  try {
    const plan = effectiveWorkflowForState(deps, await deps.store.read(resolveChangeDir(deps.cwd, name)))
    return plan === null ? undefined : riskThresholdsFor(plan.workflow)
  } catch {
    return undefined
  }
}

export async function cmdTestDiffRisk(
  deps: CliDeps,
  change: string | undefined,
  opts: { readonly json?: boolean } = {},
): Promise<number> {
  const name = change ?? deps.env?.('TENON_CHANGE_NAME') ?? ''
  if (name === '') {
    deps.io.err(`ERROR: ${msg(deps, 'diffRisk.nameRequired')}`)
    return 1
  }
  if (!isValidChangeName(name)) {
    deps.io.err(`ERROR: ${msg(deps, 'diffRisk.nameInvalid', { name })}`)
    return 1
  }
  let verdict: ChangeRiskVerdict
  let thresholds: readonly MetricThreshold[] | undefined
  try {
    const changes = await diffChangesFor(deps, name)()
    // 项目第一次建测试目录（`tenon init` 自动识别写出）不算改动既有的信任根，计数口径见 protectedTestFileCount。
    const protectedCount = protectedTestFileCount(await protectedChangesFor(deps, name)())
    thresholds = await thresholdsOfChange(deps, name)
    verdict = classifyChange(changes, protectedCount, thresholds ?? [])
  } catch (error) {
    deps.io.err(`ERROR: ${msg(deps, 'diffRisk.readFailed', { name, error: errMsg(error) })}`)
    return 1
  }
  if (opts.json === true) {
    deps.io.out(JSON.stringify(thresholds === undefined ? verdict.metrics : { ...verdict.metrics, exceeded: verdict.exceeded, reasons: verdict.reasons }))
    return 0
  }
  for (const line of riskReportLines(deps, verdict, thresholds !== undefined)) deps.io.out(line)
  return 0
}
