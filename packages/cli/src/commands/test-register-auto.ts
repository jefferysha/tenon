/**
 * `tenon test register <change> --auto` —— 一条命令把本任务的测试配置补到能往下走：
 *   1. 目录还不存在就先自动识别写入（同 `tenon init`）；
 *   2. 只看本任务改动里没有任何套件认领的测试文件（孤儿），把**精确路径**追加进合适套件的 `files`
 *      （写回 catalog.yaml 只改那几行，注释与排版保留；不放宽 glob、不扫全仓、不碰没改动的文件）。
 *      没有合适的套件就报错并给出补套件的命令，目录一个字节都不写；
 *   3. 生成 / 补全计划初稿（同 `tenon test plan <change> --seed`）。
 * 只增不减，重复运行幂等。场景 / 任务到用例的映射不在这里猜：仍按 `test-plan-map` 逐条 `--case … --test …`。
 */
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { emptyTestPlan, foldDisplayText, updateTestPlan } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { autoDiscoverCatalog } from '../test-system/auto-discover.js'
import { changedTestCandidates, claimOrphans, type OrphanClaim } from '../test-system/claim-orphans.js'
import { loadPlanInputs, policiesOf, tryChangedFiles } from '../test-system/plan-context.js'
import { seedPlan, type SeedResult } from '../test-system/plan-edit.js'
import { readCatalogFile, updateCatalog } from '../test-system/project-files.js'
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

/** 路径是仓库里的文件名，会被 agent 读到：去掉控制与双向字符、折成单行。 */
function unresolvedMessage(change: string, unresolved: readonly string[]): string {
  return `${unresolved.length} 个测试文件没有合适的套件可认领（目录里没有 cwd 覆盖它们所在位置的 unit / integration / e2e / benchmark 套件，或路径里有 glob 元字符、精确写不进 files）：`
    + `${unresolved.map(foldDisplayText).join('、')}；目录没有改动。先补套件：tenon test catalog add <id> --kind <unit|integration|playwright|…> --command '<跑它们的命令>' --file-glob '<它们所在位置的 glob>'，`
    + `再重跑 tenon test register ${change} --auto`
}

function reportClaims(deps: CliDeps, claims: readonly OrphanClaim[]): void {
  const bySuite = new Map<string, string[]>()
  for (const claim of claims) bySuite.set(claim.suite, [...(bySuite.get(claim.suite) ?? []), claim.file])
  for (const [suite, files] of bySuite) {
    deps.io.out(`[TEST] 套件 ${suite} 的 files 增加 ${files.join('、')}（本任务里原先没有套件认领的测试文件 ${files.length} 个）`)
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

  // 2. 本任务改动里没有套件认领的测试文件 → 追加精确路径（锁内以当前目录为准认领，没有改动就不重写文件）。
  const diff = await tryChangedFiles(deps, change)
  const candidates: string[] = []
  for (const path of changedTestCandidates(diff.ok ? diff.files : [])) {
    if (await regularFile(deps, path)) candidates.push(path)
  }
  const outcome = await updateCatalog(deps.cwd, (current) => {
    const result = claimOrphans(current, candidates)
    return result.unresolved.length > 0 ? unresolvedMessage(change, result.unresolved) : { catalog: result.catalog, value: result }
  })
  if (!outcome.ok) return fail(deps, outcome.message)
  const claimed = outcome.value
  const catalog = claimed.catalog
  reportClaims(deps, claimed.claims)

  // 3. 计划初稿（同 tenon test plan --seed）。认领来的文件与它们的套件不写进计划：认领在求值时按改动现算，
  // 认领文件所属的套件随之进入阶段运行集（stageRunSet），不需要在计划里登记或升成全量。
  const inputs = await loadPlanInputs(deps, context)
  const seen: { result?: SeedResult; resetTampered?: boolean } = {}
  const written = await updateTestPlan(context.dir, change, { actor: context.actor, recordedAt: deps.clock(), op: 'register' }, (state) => {
    seen.resetTampered = state.state === 'tampered'
    const seeded = seedPlan({
      catalog, plan: state.state === 'ok' ? state.plan : emptyTestPlan(change),
      changedFiles: diff.ok ? diff.files : [],
      policies: policiesOf(context, catalog), scenarios: inputs.scenarios, tasks: inputs.tasks,
    })
    seen.result = seeded
    return { plan: seeded.plan }
  })
  const result = seen.result
  if ('rejected' in written || result === undefined) return fail(deps, 'rejected' in written ? written.rejected : '计划登记失败')
  if (seen.resetTampered === true) deps.io.out('  注意：旧计划文件被手工改动过，已丢弃并重新生成')
  printSeed(deps, change, result)
  if (!diff.ok) deps.io.out(`  注意：读不到 diff（${diff.reason}），没有认领任何测试文件；解决后重跑 tenon test register ${change} --auto`)
  else if (diff.untrackedTruncated !== undefined) {
    deps.io.out(`  注意：未跟踪文件有 ${diff.untrackedTruncated.found} 个，只检查了前 ${diff.untrackedTruncated.limit} 个；把构建产物、依赖目录加入 .gitignore 后重跑 tenon test register ${change} --auto`)
  }
  return 0
}
