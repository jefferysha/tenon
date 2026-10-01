/**
 * `tenon test register <change> --auto` —— 一条命令把任务的测试计划登记到能往下走：
 *   1. 目录还不存在就先自动识别写入（同 `tenon init`）；
 *   2. 找出仓库里没有任何套件认领的测试文件，把它们并进合适套件的 `files` glob（写回 catalog.yaml，扩展 glob）；
 *   3. 生成 / 补全计划初稿（同 `tenon test plan <change> --seed`），认领来的文件与 diff 里未登记的测试文件一并登记。
 * 只增不减，重复运行幂等。场景 / 任务到用例的映射不在这里猜：仍按 `test-plan-map` 逐条 `--case … --test …`。
 */
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { emptyTestPlan, updateTestPlan } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { autoDiscoverCatalog } from '../test-system/auto-discover.js'
import { claimOrphans, isClaimableTestFile } from '../test-system/claim-orphans.js'
import { loadPlanInputs, policiesOf, tryChangedFiles } from '../test-system/plan-context.js'
import { seedPlan, withSuite, type SeedResult } from '../test-system/plan-edit.js'
import { readCatalogFile, updateCatalog } from '../test-system/project-files.js'
import { listRepoFiles } from '../test-system/repo-files.js'
import { printSeed } from './test-plan.js'
import type { TestCommandContext } from './test-context.js'

function fail(deps: CliDeps, message: string): number {
  deps.io.err(`ERROR: ${message}`)
  return 1
}

async function regularFile(deps: CliDeps, path: string): Promise<boolean> {
  try {
    return (await lstat(join(deps.cwd, path))).isFile()
  } catch {
    return false
  }
}

export async function cmdTestRegisterAuto(deps: CliDeps, change: string, context: TestCommandContext): Promise<number> {
  let catalogFile = await readCatalogFile(deps.cwd)
  if (catalogFile.state === 'invalid') {
    return fail(deps, `catalog.yaml 无效，先修好：${catalogFile.issues.slice(0, 3).join('；')}（tenon test catalog validate 列出全部问题）`)
  }
  if (catalogFile.state === 'missing') {
    const found = await autoDiscoverCatalog(deps.cwd)
    if (found.state === 'failed') return fail(deps, found.message)
    if (found.state !== 'written') {
      return fail(deps, '还没有测试目录，自动识别也没有找到测试工具：用 tenon test catalog add 登记套件；项目确实没有测试就 tenon test catalog not-applicable unit --reason \'<原因>\'')
    }
    deps.io.out(`[TEST] 目录不存在：已自动识别 ${found.suites.length} 个套件并写入 .tenon/tests/catalog.yaml（${found.suites.join('、')}）；请审阅后提交`)
    catalogFile = await readCatalogFile(deps.cwd)
  }
  if (catalogFile.state !== 'ok') return fail(deps, '读不到测试目录')

  // 2. 没有套件认领的测试文件 → 扩展套件的 files glob（锁内以当前目录为准认领，没有改动就不重写文件）。
  const candidates: string[] = []
  for (const path of await listRepoFiles(deps.cwd)) {
    if (isClaimableTestFile(path) && await regularFile(deps, path)) candidates.push(path)
  }
  const outcome = await updateCatalog(deps.cwd, (current) => {
    const result = claimOrphans(current, candidates)
    return { catalog: result.catalog, value: result }
  })
  if (!outcome.ok) return fail(deps, outcome.message)
  const claimed = outcome.value
  const catalog = claimed.catalog
  const byGlob = new Map<string, number>()
  for (const claim of claimed.claims) byGlob.set(`${claim.suite}\u0000${claim.glob}`, (byGlob.get(`${claim.suite}\u0000${claim.glob}`) ?? 0) + 1)
  for (const [key, count] of byGlob) {
    const [suite = '', glob = ''] = key.split('\u0000')
    deps.io.out(`[TEST] 套件 ${suite} 的文件 glob 增加 ${glob}（认领 ${count} 个原先没有套件认领的测试文件）`)
  }
  const claimedPaths = claimed.claims.map((claim) => claim.path)

  // 3. 计划初稿 + 登记（认领来的文件按 diff 里的未登记文件同样处理）。
  const inputs = await loadPlanInputs(deps, context)
  const diff = await tryChangedFiles(deps, change)
  const seen: { result?: SeedResult; resetTampered?: boolean } = {}
  const written = await updateTestPlan(context.dir, change, { actor: context.actor, recordedAt: deps.clock(), op: 'register' }, (state) => {
    seen.resetTampered = state.state === 'tampered'
    const seeded = seedPlan({
      catalog, plan: state.state === 'ok' ? state.plan : emptyTestPlan(change),
      changedFiles: [...new Set([...(diff.ok ? diff.files : []), ...claimedPaths])],
      policies: policiesOf(context), scenarios: inputs.scenarios, tasks: inputs.tasks,
    })
    // 认领来的文件里有任务之前就存在、这次没改的：changed 范围只跑 diff 里的测试文件，会漏掉它们
    // （登记了却没执行）。认领了文件的套件因此按全量登记；用户自己选过 files / grep 的不动。
    let plan = seeded.plan
    for (const id of new Set(claimed.claims.map((claim) => claim.suite))) {
      const entry = plan.suites.find((item) => item.suite === id)
      if (entry === undefined || entry.scope === 'changed') plan = withSuite(plan, { suite: id, scope: 'full' })
    }
    seen.result = { ...seeded, plan }
    return { plan }
  })
  const result = seen.result
  if ('rejected' in written || result === undefined) return fail(deps, 'rejected' in written ? written.rejected : '计划登记失败')
  if (seen.resetTampered === true) deps.io.out('  注意：旧计划文件被手工改动过，已丢弃并重新生成')
  printSeed(deps, change, result)
  for (const path of claimed.unresolved) {
    deps.io.out(`  ! 测试文件 ${path} 没有合适的套件可认领（目录里没有覆盖它所在位置的 unit / e2e 套件）：tenon test catalog add …，再重跑 tenon test register ${change} --auto`)
  }
  if (!diff.ok) deps.io.out(`  注意：读不到 diff（${diff.reason}），只登记了认领来的文件；解决后重跑 tenon test register ${change} --auto`)
  return 0
}
