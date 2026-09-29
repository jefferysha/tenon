/**
 * `tenon test report <change> [--step <id>] [--write <path>] [--locale zh-CN|en]` ——
 * 验证报告的测试段由登记结果生成（R12），不再手写。两块内容各有自己的标记区间，`--write` 只替换区间内的字节：
 *   - 旧步骤测试表（`tenon:tests:*`，v1 记录）——只在有旧步骤测试时写；
 *   - 测试体系 v2 的追溯矩阵 / 套件 / 覆盖率 / 基准（`tenon:test-report:*`，kernel 的 replaceTestReportBlock）——
 *     块里引用每个套件最新运行的 run id，`tenon status` 的 test-report 动作靠它判断报告是否已带上最新运行。
 */
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import {
  renderTestsRegion, replaceTestReportBlock, replaceTestsRegion,
  type ReportLocale, type TestsRegionItem,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { str } from '../render.js'
import { testEvidenceContextFor, testEvidenceReaderFor } from '../testEvidenceContext.js'
import { renderV2Block } from '../test-system/report-md.js'
import { resolveTestCommand } from './test-context.js'

const MAX_REPORT_BYTES = 1024 * 1024

async function writableReport(repoRoot: string, path: string): Promise<string | undefined> {
  if (path === '' || isAbsolute(path) || path.includes('..')) return undefined
  const absolute = resolve(repoRoot, path)
  try {
    const entry = await lstat(absolute)
    return entry.isFile() && entry.size <= MAX_REPORT_BYTES ? absolute : undefined
  } catch {
    return undefined
  }
}

export async function cmdTestReport(
  deps: CliDeps,
  change: string,
  opts: { readonly step?: string; readonly write?: string; readonly locale?: ReportLocale } = {},
): Promise<number> {
  const context = await resolveTestCommand(deps, change, { requireOwner: false })
  if (typeof context === 'number') return context
  const steps = context.plan.workflow.steps
  const untilId = opts.step ?? str(context.state.fields.phase)
  const until = steps.findIndex((step) => step.id === untilId)
  if (until < 0) {
    deps.io.err(`ERROR: step '${untilId}' 不在 workflow '${context.plan.id}' 里`)
    return 1
  }
  const locale: ReportLocale = opts.locale ?? 'zh-CN'
  const evidence = testEvidenceContextFor(deps, change)
  const items: TestsRegionItem[] = []
  for (const step of steps.slice(0, until + 1)) {
    if ((step.tests ?? []).length === 0) continue
    const report = await testEvidenceReaderFor(deps)({
      repoRoot: deps.cwd,
      changeDir: context.dir,
      changeName: change,
      plan: context.plan,
      stepId: step.id,
      context: evidence,
    })
    items.push(...report.items.map((item) => ({ ...item, stepId: step.id, stepLabel: step.label })))
  }
  // 测试体系 v2 段落取「统计范围内最近一个声明了 test_policy 的步骤」的判定，与该步骤的出口检查同一份。
  const policyStep = steps.slice(0, until + 1).reverse().find((step) => step.test_policy !== undefined)
  let extra: string | undefined
  if (policyStep !== undefined) {
    const report = await testEvidenceReaderFor(deps)({
      repoRoot: deps.cwd, changeDir: context.dir, changeName: change, plan: context.plan, stepId: policyStep.id, context: evidence,
    })
    if (report.policy !== undefined) extra = renderV2Block(report.policy, locale)
  }
  // 有旧步骤测试（或根本没有 v2 策略）时才写旧的测试表；只有 v2 时报告里不出现空表头。
  const region = items.length > 0 || extra === undefined ? renderTestsRegion({ changeName: change, locale, items }) : undefined
  if (opts.write === undefined) {
    deps.io.out([region, extra === undefined ? undefined : replaceTestReportBlock('', extra).trim()].filter((part) => part !== undefined).join('\n\n'))
    return 0
  }
  const target = await writableReport(deps.cwd, opts.write)
  if (target === undefined) {
    deps.io.err(`ERROR: --write 必须指向仓库内已存在的普通文件（≤1 MiB）: '${opts.write}'`)
    return 1
  }
  try {
    const markdown = await readFile(target, 'utf8')
    const withRegion = region === undefined ? markdown : replaceTestsRegion(markdown, region, locale)
    await writeFile(target, extra === undefined ? withRegion : replaceTestReportBlock(withRegion, extra), 'utf8')
  } catch (e) {
    deps.io.err(`ERROR: ${errMsg(e)}`)
    return 1
  }
  deps.io.out(`[TEST] ${change} 报告测试段已写入 ${opts.write}（${items.length} 项${extra === undefined ? '' : '，含追溯矩阵'}）`)
  return 0
}
