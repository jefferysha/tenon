/**
 * `tenon test sync <change> [--prune] [--json]` —— 对账：自任务起点以来 diff 里的测试文件是否都有套件认领。
 * 列出自动认领的文件（认领不用登记，只作信息）、没有任何套件认领的孤儿文件、已登记但文件已不存在的条目、
 * 已登记但目录不再认领的条目（提示 --prune）、未映射的场景。
 * 与门禁同一份判定（claimChangedTestFiles），所以这里干净就是 test-file-orphan 不会挡。
 * 退出码：0 干净，2 有要处理的项，1 读不到 diff 或目录（环境错误）。
 * --prune 是另一种模式（test-sync-prune.ts）：不读 diff，只把目录不再认领的登记从计划里删掉。
 */
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { claimChangedTestFiles, claimedByPath, orphansNotInPlan, shellQuote, type TestPlan } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { catalogErrorLine, loadPlanInputs, tryChangedFiles } from '../test-system/plan-context.js'
import { unclaimedRegistrations } from '../test-system/plan-edit.js'
import { resolveTestCommand } from './test-context.js'
import { cmdTestSyncPrune, describeUnclaimed } from './test-sync-prune.js'

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

export async function cmdTestSync(
  deps: CliDeps, change: string, opts: { readonly json?: boolean; readonly prune?: boolean } = {},
): Promise<number> {
  if (opts.prune === true) return cmdTestSyncPrune(deps, change, { json: opts.json === true })
  const context = await resolveTestCommand(deps, change, { requireOwner: false })
  if (typeof context === 'number') return context
  const inputs = await loadPlanInputs(deps, context)
  if (inputs.catalog.state !== 'ok') {
    deps.io.err(catalogErrorLine(inputs.catalog))
    return 1
  }
  const diff = await tryChangedFiles(deps, change)
  if (!diff.ok) {
    deps.io.err(`ERROR: 读不到本任务的改动文件列表（${diff.reason}）；门禁对此按 files-diff-unavailable 阻塞`)
    return 1
  }
  const plan = inputs.planState.state === 'ok' ? inputs.planState.plan : undefined
  // 与门禁同一份判定：改动过的测试文件按套件 glob 认领（不用登记，只列出来），没人认领的才是孤儿。
  const claim = claimChangedTestFiles(diff.files, inputs.catalog.catalog)
  const orphans = orphansNotInPlan(claim.orphans, plan)
  const claimed = claimedByPath(claim.claimed)
  const gone = plan === undefined ? [] : await missingOnDisk(deps, plan)
  const unclaimed = plan === undefined ? [] : unclaimedRegistrations(plan, inputs.catalog.catalog)
  const mapped = new Set(plan?.cases.map((item) => item.covers) ?? [])
  const unmapped = [...inputs.scenarios.map((item) => item.covers), ...inputs.tasks.filter((item) => item.required).map((item) => item.covers)].filter((covers) => !mapped.has(covers))
  const optional = inputs.tasks.filter((item) => !item.required && !item.placeholder && !mapped.has(item.covers)).map((item) => item.covers)
  const dirty = orphans.length + gone.length + unclaimed.length > 0
  if (opts.json === true) {
    deps.io.out(JSON.stringify({
      change, planState: inputs.planState.state, changed: diff.files.length,
      ...(diff.untrackedTruncated === undefined ? {} : { untrackedTruncated: diff.untrackedTruncated }),
      // 旧字段：认领取代逐个登记，恒为空。
      unregistered: [],
      claimed, orphans, registeredButMissing: gone, registeredButUnclaimed: unclaimed, unmapped, optionalUnmapped: optional,
    }, null, 2))
    return dirty ? 2 : 0
  }
  deps.io.out(`[TEST] sync ${change}：diff 里 ${diff.files.length} 个文件；自动认领的测试文件 ${claimed.length} 个（不用登记），无套件认领 ${orphans.length} 个`)
  if (diff.untrackedTruncated !== undefined) {
    deps.io.out(`  提示：未跟踪文件有 ${diff.untrackedTruncated.found} 个，只检查了前 ${diff.untrackedTruncated.limit} 个；其余的测试文件没有核对是否被套件认领。把构建产物、依赖目录加入 .gitignore 后重新检查`)
  }
  if (inputs.planState.state !== 'ok') deps.io.out(`  计划${inputs.planState.state === 'missing' ? '还没有登记' : '不可信'}：tenon test plan ${change} --seed`)
  for (const file of claimed) deps.io.out(`  已认领  ${file.path}  → 套件 ${file.suites.join('、')}`)
  for (const path of orphans) deps.io.out(`  无套件  ${path}\n    tenon test register ${change} --auto（把该文件的精确路径并进对应套件的 files；没有可用的套件就先 tenon test discover --write）`)
  for (const path of gone) deps.io.out(`  文件已不存在  ${path}\n    tenon test unregister ${change} --file ${shellQuote(path)}`)
  for (const item of unclaimed) deps.io.out(`  已登记无人认领  ${item.path}（${describeUnclaimed(item)}）`)
  if (unclaimed.length > 0) deps.io.out(`    tenon test sync ${change} --prune  一次删掉这些登记（只动测试文件登记，不动用例映射）`)
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
  if (!dirty) deps.io.out('  测试文件都已被套件认领，没有需要处理的登记')
  return dirty ? 2 : 0
}
