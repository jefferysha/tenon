import { useMemo } from 'react'
import { useT } from '../i18n'
import type { PolicyReport, TestPlanBrief } from '../api/testSystemTypes'
import { formatPercent } from '../tests/testFormat'
import { TestsTabBlockers, TestsTabFiles, TestsTabTrace } from './TestsTabLists'
import { TestsTabMatrix } from './TestsTabMatrix'
import { buildMatrix, extraItems, fileRows, summarize, type MatrixSuite } from './testsTabModel'
import type { TestRow } from './stageTests'

/**
 * 工作台任务「测试」页签：一行汇总 → 未登记文件（置顶于表格之上）→ 策略矩阵 → 阻塞 → 场景/任务追溯。
 * 只展示服务端的判定（与转换拦截同一份），不登记也不执行。套件名可点则打开运行详情。
 */
export function TaskTestsTab({ report, plan, legacyRows, activeSuite, onOpenSuite }: {
  report: PolicyReport
  plan: TestPlanBrief | undefined
  /** 旧步骤测试的行：内联套件（`step:` 前缀）凭它打开旧式运行详情。 */
  legacyRows: readonly TestRow[]
  activeSuite: string | null
  onOpenSuite: (suite: string) => void
}): JSX.Element {
  const { t } = useT()
  const summary = useMemo(() => summarize(report), [report])
  const rows = useMemo(() => buildMatrix(report, plan), [report, plan])
  const extra = useMemo(() => extraItems(report, rows), [report, rows])
  const files = useMemo(() => fileRows(report), [report])
  const openable = (suite: MatrixSuite): boolean => {
    const verdict = suite.verdict
    if (verdict === undefined) return false
    if (verdict.origin === 'step') return legacyRows.some((row) => row.id === suite.suite.replace(/^step:/u, '') && row.run !== undefined)
    return verdict.runId !== undefined
  }
  const parts = [
    `${t('tests.word.suite')} ${summary.suites}`,
    `${t('tests.word.case')} ${summary.cases}`,
    `${t('tests.case.fail')} ${summary.fail}`,
    `${t('tests.word.flaky')} ${summary.flaky}`,
    ...(summary.coverage === null ? [] : [`${t('tests.word.coverage')} ${formatPercent(summary.coverage)}`]),
  ]
  return (
    <div className="grid gap-6" data-testid="task-tests">
      <p className="truncate whitespace-nowrap font-mono text-body text-text-2" title={parts.join(' · ')} data-testid="tests-summary" data-pass={report.pass}>
        {parts.join(' · ')}
      </p>
      <TestsTabFiles rows={files} />
      <TestsTabMatrix rows={rows} openable={openable} activeSuite={activeSuite} onOpen={onOpenSuite} />
      <TestsTabBlockers items={extra} />
      <TestsTabTrace report={report} />
    </div>
  )
}
