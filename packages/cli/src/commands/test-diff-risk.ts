/**
 * `tenon test diff-risk [change] [--json]` —— standard 通道的改动风险探针，内建 `diff-risk` 测试方向背后的命令。
 * 只读 git，输出一行 JSON 指标；阈值不在这里，是工作流里这条步骤测试的 `pass.metrics`（改工作流 YAML 即可调整）。
 *
 * 指标：files_changed（代码类改动文件数）、contract_files / auth_files / dependency_files / migration_files
 * （命中对应路径类的文件数）、deleted_tests（被删的测试文件）、protected_test_files（受保护的测试配置改动：
 * 目录、基线、已知失败清单、项目工作流）。口径与路径分类见 kernel workspace/diff-risk.ts。
 *
 * 任务名取位置参数，缺省取 `TENON_CHANGE_NAME`（`tenon test run` 起测试进程时设置）；起点是任务起点
 * （merge-base / 创建前最后一次提交），所以已提交与未提交的任务改动都算。读不出 git 就失败（exit 1），
 * 绝不当作「没有改动」。
 */
import { assessDiffRisk, type DiffRiskMetrics } from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { diffChangesFor } from '../diffRisk.js'
import { msg, type MessageCode } from '../i18n/messages.js'
import { isValidChangeName } from '../paths.js'
import { protectedChangesFor } from '../testEvidenceContext.js'

const LABELS: Readonly<Record<keyof DiffRiskMetrics, MessageCode>> = {
  files_changed: 'diffRisk.label.filesChanged',
  contract_files: 'diffRisk.label.contractFiles',
  auth_files: 'diffRisk.label.authFiles',
  dependency_files: 'diffRisk.label.dependencyFiles',
  migration_files: 'diffRisk.label.migrationFiles',
  deleted_tests: 'diffRisk.label.deletedTests',
  protected_test_files: 'diffRisk.label.protectedTestFiles',
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
  let metrics: DiffRiskMetrics
  try {
    const changes = await diffChangesFor(deps, name)()
    // 项目第一次建测试目录（`tenon init` 自动识别写出）不是改动既有的信任根：它仍会列进评审请求等用户确认，
    // 但不该让每个新项目的第一个任务都升级。已有目录的修改 / 删除，基线、已知失败清单、项目工作流的任何改动照常计数。
    const protectedFiles = (await protectedChangesFor(deps, name)())
      .filter((item) => !(item.kind === 'catalog' && item.status === 'added'))
    metrics = assessDiffRisk(changes, protectedFiles.length)
  } catch (error) {
    deps.io.err(`ERROR: ${msg(deps, 'diffRisk.readFailed', { name, error: errMsg(error) })}`)
    return 1
  }
  if (opts.json === true) {
    deps.io.out(JSON.stringify(metrics))
    return 0
  }
  for (const key of Object.keys(LABELS) as (keyof DiffRiskMetrics)[]) deps.io.out(`${msg(deps, LABELS[key])}  ${metrics[key]}`)
  return 0
}
