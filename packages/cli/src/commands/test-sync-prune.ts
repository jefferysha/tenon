/**
 * `tenon test sync <change> --prune [--json]` —— 从任务测试计划的 files[] 删掉目录不再认领的登记，其余原样。
 * 登记只增不减（register / plan --seed 只加、sync 只报告），而套件出口判定对带显式套件的登记一律检查「报告里有没有执行」，
 * 不看套件 glob 还认不认领：目录的 glob 曾被放宽又收回之后，那段时间登记进来的文件会一直挡在出口。
 *
 * 为什么安全：合法的测试文件总被它的套件 glob 认领，只有目录已不认领的登记会被删；要让合法登记落到这一步必须先改目录里的 glob，
 * 而任务改动过的测试配置文件会在评审请求里列出、由用户批准。此外：只有负责人能写；目录缺失 / 无效 / 没有任何套件时拒绝
 * （否则每条登记都成了「无人认领」）；计划被手改时拒绝；只动 files[]（套件、用例映射、豁免不动）；
 * 写入与 register 同一条路径（Change 锁 + 摘要台账 + test:plan-write 审计行），删多少由持锁时读到的计划重新算。
 * 退出码：0 删了或没有可删的，1 拒绝或环境错误。
 */
import { readTestPlanState, updateTestPlan } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { catalogErrorLine } from '../test-system/plan-context.js'
import { unclaimedRegistrations, withoutRegistrations, type UnclaimedRegistration } from '../test-system/plan-edit.js'
import { readCatalogFile } from '../test-system/project-files.js'
import { resolveTestCommand } from './test-context.js'

/** 一条登记为什么没被认领，给人看的短句（sync 的报告与 --prune 的输出共用）。 */
export function describeUnclaimed(item: UnclaimedRegistration): string {
  if (item.reason === 'suite-missing') return `套件 '${item.suite}' 不在目录中`
  return item.reason === 'glob-mismatch' ? `套件 '${item.suite}' 的 files glob 不再认领它` : '没有套件认领'
}

function fail(deps: CliDeps, message: string): number {
  deps.io.err(`ERROR: ${message}`)
  return 1
}

function nothingToPrune(deps: CliDeps, change: string, json: boolean, why: string): number {
  deps.io.out(json ? JSON.stringify({ change, pruned: [] }, null, 2) : `[TEST] sync --prune ${change}：${why}`)
  return 0
}

export async function cmdTestSyncPrune(deps: CliDeps, change: string, opts: { readonly json?: boolean }): Promise<number> {
  const json = opts.json === true
  const context = await resolveTestCommand(deps, change, { requireOwner: true })
  if (typeof context === 'number') return context
  const file = await readCatalogFile(deps.cwd)
  if (file.state !== 'ok') {
    deps.io.err(catalogErrorLine(file))
    return 1
  }
  const catalog = file.catalog
  if (catalog.suites.length === 0) return fail(deps, '目录里没有任何套件；不按空目录裁剪登记（那样每条登记都会被当作无人认领）')
  const state = await readTestPlanState(context.dir, change)
  if (state.state === 'tampered') return fail(deps, `测试计划不可信：${state.reason}；执行 tenon test plan ${change} --seed 重新登记`)
  if (state.state === 'missing') return nothingToPrune(deps, change, json, '还没有登记测试计划，没有可删的项')
  if (unclaimedRegistrations(state.plan, catalog).length === 0) return nothingToPrune(deps, change, json, '计划里的测试文件登记都有目录里的套件认领，没有可删的项')

  let pruned: readonly UnclaimedRegistration[] = []
  const written = await updateTestPlan(context.dir, change, { actor: context.actor, recordedAt: deps.clock(), op: 'prune' }, (locked) => {
    if (locked.state !== 'ok') return { reject: `测试计划${locked.state === 'missing' ? '已被删除' : `不可信：${locked.reason}`}；先 tenon test plan ${change} --seed 重新登记` }
    pruned = unclaimedRegistrations(locked.plan, catalog)
    return { plan: withoutRegistrations(locked.plan, pruned.map((item) => item.path)) }
  })
  if ('rejected' in written) return fail(deps, written.rejected)
  if (json) {
    deps.io.out(JSON.stringify({ change, digest: written.digest, pruned }, null, 2))
    return 0
  }
  deps.io.out(`[TEST] sync --prune ${change}：删了 ${pruned.length} 条目录不再认领的测试文件登记`)
  for (const item of pruned) deps.io.out(`  已删除  ${item.path}  ${describeUnclaimed(item)}`)
  deps.io.out(`  只动了测试文件登记；套件、用例映射、豁免原样。计划摘要 ${written.digest}`)
  return 0
}
