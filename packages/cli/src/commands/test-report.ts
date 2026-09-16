/**
 * `tenon test report <change> [--step <id>] [--write <path>] [--locale zh-CN|en]` ——
 * 验证报告的测试段由登记结果生成（R12），不再手写。`--write` 替换标记区间，没有就在文末追加一节。
 */
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import {
  evaluateTestEvidence, renderTestsRegion, replaceTestsRegion,
  type ReportLocale, type TestsRegionItem,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { str } from '../render.js'
import { testEvidenceContextFor, testEvidenceReaderFor } from '../testEvidenceContext.js'
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
  const region = renderTestsRegion({ changeName: change, locale, items })
  if (opts.write === undefined) {
    deps.io.out(region)
    return 0
  }
  const target = await writableReport(deps.cwd, opts.write)
  if (target === undefined) {
    deps.io.err(`ERROR: --write 必须指向仓库内已存在的普通文件（≤1 MiB）: '${opts.write}'`)
    return 1
  }
  try {
    const markdown = await readFile(target, 'utf8')
    await writeFile(target, replaceTestsRegion(markdown, region, locale), 'utf8')
  } catch (e) {
    deps.io.err(`ERROR: ${errMsg(e)}`)
    return 1
  }
  deps.io.out(`[TEST] ${change} 报告测试段已写入 ${opts.write}（${items.length} 项）`)
  return 0
}
