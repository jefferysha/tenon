import { useMemo } from 'react'
import type { PolicyReport, TestPlanBrief } from '../api/testSystemTypes'
import { TestsTabIntegrity } from './TestsTabIntegrity'
import { TestsTabBlockers, TestsTabFiles, TestsTabNotices, TestsTabTrace } from './TestsTabLists'
import { TestsTabMatrix } from './TestsTabMatrix'
import { TestsTabStats } from './TestsTabStats'
import { buildMatrix, extraBlockers, fileRows, reportNotices, summarize, type MatrixSuite } from './testsTabModel'
import type { TestRow } from './stageTests'

/**
 * 工作台任务「测试」页签：汇总数字 → 未登记文件（置顶于表格之上）→ 策略矩阵 → 完整性 → 阻塞（只有真阻塞）→ 提示 → 场景/任务追溯。
 * 只展示服务端的判定（与转换拦截同一份），不登记也不执行。套件名可点则打开运行详情。
 */
export function TaskTestsTab({ report, plan, legacyRows, activeSuite, onOpenSuite, stageLabelOf, recordedBy }: {
  report: PolicyReport
  plan: TestPlanBrief | undefined
  /** 旧步骤测试的行：内联套件（`step:` 前缀）凭它打开旧式运行详情。 */
  legacyRows: readonly TestRow[]
  activeSuite: string | null
  onOpenSuite: (suite: string) => void
  /** 阶段 id → 工作流里的阶段名（追溯表里任务条目所在的阶段）。 */
  stageLabelOf: (stage: string) => string
  /** 记录属于谁（任务负责人）：汇总行末尾多一个「· 名字」，别人打开页面时知道看的是谁的测试。 */
  recordedBy?: string
}): JSX.Element {
  const summary = useMemo(() => summarize(report), [report])
  const rows = useMemo(() => buildMatrix(report, plan), [report, plan])
  const blockers = useMemo(() => extraBlockers(report, rows), [report, rows])
  const notices = useMemo(() => reportNotices(report), [report])
  const files = useMemo(() => fileRows(report), [report])
  const openable = (suite: MatrixSuite): boolean => {
    const verdict = suite.verdict
    if (verdict === undefined) return false
    if (verdict.origin === 'step') return legacyRows.some((row) => row.id === suite.suite.replace(/^step:/u, '') && row.run !== undefined)
    return verdict.runId !== undefined
  }
  return (
    <div className="grid gap-6" data-testid="task-tests">
      <TestsTabStats summary={summary} pass={report.pass} {...(recordedBy === undefined ? {} : { recordedBy })} />
      <TestsTabFiles rows={files} />
      <TestsTabMatrix rows={rows} openable={openable} activeSuite={activeSuite} onOpen={onOpenSuite} />
      <TestsTabIntegrity integrity={report.integrity} />
      <TestsTabBlockers items={blockers} />
      <TestsTabNotices items={notices} />
      <TestsTabTrace report={report} stageLabelOf={stageLabelOf} />
    </div>
  )
}
