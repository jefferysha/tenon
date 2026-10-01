/**
 * `tenon test sync <change> [--json]` —— 对账：自任务起点以来 diff 里的测试文件是否都登记了计划。
 * 列出未登记的文件（带套件与命令）、没有任何套件认领的孤儿文件、已登记但文件已不存在的条目、未映射的场景。
 * 与门禁同一份判定（testFileRegistration），所以这里干净就是 test-file-unregistered / orphan 不会挡。
 * 退出码：0 干净，2 有要处理的项，1 读不到 diff 或目录（环境错误）。
 */
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { shellQuote, testFileRegistration, type TestPlan } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { loadPlanInputs, tryChangedFiles } from '../test-system/plan-context.js'
import { resolveTestCommand } from './test-context.js'

const MAX_LISTED = 15

async function missingOnDisk(deps: CliDeps, plan: TestPlan): Promise<readonly string[]> {
  const gone: string[] = []
  for (const file of plan.files) {
    try {
      if ((await lstat(join(deps.cwd, file.path))).isFile()) continue
    } catch {
      // 读不到就当不存在。
    }
    gone.push(file.path)
  }
  return gone
}

export async function cmdTestSync(deps: CliDeps, change: string, opts: { readonly json?: boolean } = {}): Promise<number> {
  const context = await resolveTestCommand(deps, change, { requireOwner: false })
  if (typeof context === 'number') return context
  const inputs = await loadPlanInputs(deps, context)
  if (inputs.catalog.state !== 'ok') {
    deps.io.err(`ERROR: ${inputs.catalog.state === 'missing' ? '还没有测试目录；先 tenon test discover --write' : 'catalog.yaml 无效；先 tenon test catalog validate'}`)
    return 1
  }
  const diff = await tryChangedFiles(deps, change)
  if (!diff.ok) {
    deps.io.err(`ERROR: 读不到本任务的改动文件列表（${diff.reason}）；门禁对此按 files-diff-unavailable 阻塞`)
    return 1
  }
  const plan = inputs.planState.state === 'ok' ? inputs.planState.plan : undefined
  const registration = testFileRegistration({ changedFiles: diff.files, catalog: inputs.catalog.catalog, plan })
  const gone = plan === undefined ? [] : await missingOnDisk(deps, plan)
  const mapped = new Set(plan?.cases.map((item) => item.covers) ?? [])
  const unmapped = [...inputs.scenarios.map((item) => item.covers), ...inputs.tasks.filter((item) => item.required).map((item) => item.covers)].filter((covers) => !mapped.has(covers))
  const optional = inputs.tasks.filter((item) => !item.required && !mapped.has(item.covers)).map((item) => item.covers)
  const register = (path: string, suites: readonly string[]): string =>
    `tenon test register ${change} --file ${shellQuote(path)}${suites.length === 1 ? ` --suite ${shellQuote(suites[0] ?? '')}` : ''}`
  const dirty = registration.unregistered.length + registration.orphans.length + gone.length > 0
  if (opts.json === true) {
    deps.io.out(JSON.stringify({
      change, planState: inputs.planState.state, changed: diff.files.length,
      ...(diff.untrackedTruncated === undefined ? {} : { untrackedTruncated: diff.untrackedTruncated }),
      unregistered: registration.unregistered.map((file) => ({ ...file, fix: register(file.path, file.suites) })),
      orphans: registration.orphans, registeredButMissing: gone, unmapped, optionalUnmapped: optional,
    }, null, 2))
    return dirty ? 2 : 0
  }
  deps.io.out(`[TEST] sync ${change}：diff 里 ${diff.files.length} 个文件；未登记的测试文件 ${registration.unregistered.length} 个，无套件认领 ${registration.orphans.length} 个`)
  if (diff.untrackedTruncated !== undefined) {
    deps.io.out(`  提示：未跟踪文件有 ${diff.untrackedTruncated.found} 个，只检查了前 ${diff.untrackedTruncated.limit} 个；其余的测试文件没有核对是否已登记。把构建产物、依赖目录加入 .gitignore 后重新检查`)
  }
  if (inputs.planState.state !== 'ok') deps.io.out(`  计划${inputs.planState.state === 'missing' ? '还没有登记' : '不可信'}：tenon test plan ${change} --seed`)
  for (const file of registration.unregistered) deps.io.out(`  未登记  ${file.path}\n    ${register(file.path, file.suites)}`)
  for (const path of registration.orphans) deps.io.out(`  无套件  ${path}\n    先在目录里加套件（tenon test discover --write），再 tenon test register ${change} --file ${shellQuote(path)}`)
  for (const path of gone) deps.io.out(`  文件已不存在  ${path}\n    tenon test unregister ${change} --file ${shellQuote(path)}`)
  if (unmapped.length > 0) {
    deps.io.out(`  未映射的场景 / 任务 ${unmapped.length} 个：`)
    for (const covers of unmapped.slice(0, MAX_LISTED)) deps.io.out(`    ${covers}`)
    if (unmapped.length > MAX_LISTED) deps.io.out(`    … 另有 ${unmapped.length - MAX_LISTED} 个`)
  }
  if (optional.length > 0) {
    deps.io.out(`  可选的任务 ${optional.length} 个（不在实现阶段小节，不要求映射用例，不挡出口）：`)
    for (const covers of optional.slice(0, MAX_LISTED)) deps.io.out(`    ${covers}`)
    if (optional.length > MAX_LISTED) deps.io.out(`    … 另有 ${optional.length - MAX_LISTED} 个`)
  }
  if (!dirty) deps.io.out('  测试文件都已登记')
  return dirty ? 2 : 0
}
