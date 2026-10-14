/**
 * 测试文件检查（从 evaluate-v2 拆出）：本任务改动里的测试文件按套件 glob 认领，没人认领的像测试的文件是孤儿；
 * 认领文件在跑过的认领套件报告里都没有执行过的用例时，汇总成 registered-test-not-executed。
 * 档位策略（changed / full）与旧 `files: registered` 同一口径；认领在求值时现算，不读也不写计划里的 files。
 */
import { shellQuote, testBlocker, testNotice } from './blockers.js'
import { claimChangedTestFiles, claimedByPath, orphansNotInPlan } from './claim.js'
import type { CatalogSuite } from './catalog-types.js'
import { NODE_TEST_FILE_HINT } from './evaluate-suite.js'
import type { Collector, TestPolicyEvaluationInput, TestPolicyReport } from './evaluate-types.js'
import type { TestPlan } from './plan.js'
import { policyChecksChangedFiles } from './resolve-policy.js'
import type { OwnedTestFile } from './test-files.js'

const NOT_CHECKED: TestPolicyReport['files'] = { checked: false, unregistered: [], orphans: [], claimed: [] }

/** 本任务改动过、被套件认领的测试文件（按路径排序，认领它的套件按目录顺序）。 */
export interface ClaimedFiles {
  readonly byPath: readonly OwnedTestFile[]
  /** 套件 id → 它认领的文件。 */
  readonly bySuite: ReadonlyMap<string, readonly string[]>
}

const NO_CLAIMS: ClaimedFiles = { byPath: [], bySuite: new Map() }

export function checkFiles(
  input: TestPolicyEvaluationInput,
  plan: TestPlan | undefined,
  out: Collector,
): { readonly files: TestPolicyReport['files']; readonly claims: ClaimedFiles } {
  const skipped = { files: NOT_CHECKED, claims: NO_CLAIMS }
  if (!policyChecksChangedFiles(input.policy)) return skipped
  if (input.changedFilesError !== undefined) {
    out.blockers.push(testBlocker('files-diff-unavailable', `无法读取本任务的改动文件列表（${input.changedFilesError}），不能确认改动的测试文件都被套件认领`, {
      fix: `tenon test sync ${input.change}`,
    }))
    return skipped
  }
  if (input.changedFiles === undefined) {
    out.notices.push(testNotice('files-unchecked', '宿主没有提供本任务的 diff 文件列表，未检查改动的测试文件'))
    return skipped
  }
  if (input.catalog.state !== 'ok') return skipped
  if (input.changedFilesTruncated !== undefined) {
    const { found, limit } = input.changedFilesTruncated
    out.notices.push(testNotice('files-truncated', `未跟踪文件有 ${found} 个，只检查了前 ${limit} 个；其余的测试文件没有核对是否被套件认领。把构建产物、依赖目录加入 .gitignore 后重新检查`))
  }
  const claim = claimChangedTestFiles(input.changedFiles, input.catalog.catalog)
  const orphans = orphansNotInPlan(claim.orphans, plan)
  for (const path of orphans) {
    out.blockers.push(testBlocker('test-file-orphan', `测试文件 ${path} 没有任何目录套件认领；把它并进对应套件的文件 glob（tenon test register --auto 追加该文件的精确路径；没有可用的套件就先在目录里加）`, {
      fix: `tenon test register ${input.change} --auto`, subject: path,
    }))
  }
  const byPath = claimedByPath(claim.claimed)
  return { files: { checked: true, unregistered: [], orphans, claimed: byPath }, claims: { byPath, bySuite: claim.claimed } }
}

/** 本阶段运行集里跑过（新鲜、能判定）的套件对认领文件的核对结果。 */
export interface ClaimedCheck {
  readonly suite: CatalogSuite
  readonly checked: readonly string[]
  readonly missing: readonly string[]
}

/**
 * 认领文件的执行检查：只对「每个跑过的认领套件里都没执行」的文件出阻塞。一个文件被多个套件认领时，在其中任一
 * 跑过的套件里执行过即可；没跑过的认领套件不参与（它本身另出 test-not-run）。同一个文件只在第一个核对过它的套件名下报一次。
 * 返回被点名的套件 id：调用方据此把这些套件的判定状态改成 failed。
 */
export function claimedNotExecuted(change: string, checks: readonly ClaimedCheck[], out: Collector): ReadonlySet<string> {
  const executed = new Set(checks.flatMap((check) => check.checked.filter((path) => !check.missing.includes(path))))
  const reported = new Set<string>()
  const failed = new Set<string>()
  for (const check of checks) {
    const lost = check.missing.filter((path) => !executed.has(path) && !reported.has(path))
    if (lost.length === 0) continue
    for (const path of lost) reported.add(path)
    failed.add(check.suite.id)
    const name = check.suite.label === undefined ? check.suite.id : `${check.suite.label}（${check.suite.id}）`
    const hint = check.suite.runner === 'node-test' ? NODE_TEST_FILE_HINT : ''
    out.blockers.push(testBlocker('registered-test-not-executed', `套件 ${name} 的报告里没有本任务改动的测试文件（目录 glob 认领了它，运行器却没收录）：${lost.slice(0, 5).join('；')}${lost.length > 5 ? ' …' : ''}${hint}`, {
      fix: `tenon test run ${change} --suite ${shellQuote(check.suite.id)}`, subject: check.suite.id,
    }))
  }
  return failed
}
