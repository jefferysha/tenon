/**
 * 工作台「测试」页签的行数据：从 snapshot 的 tests 投影取当前步骤的每项测试。
 * 状态词走 i18n，不在这里拼中文。
 */
import type { ChangeSnapshot, TestItemStatus, TestItemWaiver, TestRunSummary } from '../types'

export interface TestRow {
  id: string
  name: string
  direction: string
  required: boolean
  status: TestItemStatus
  /** 失败后带 `test:<id>` 豁免时的豁免状态（`status` 仍是失败）；显示以它为准。 */
  waiver?: TestItemWaiver
  durationMs?: number
  finishedAt?: string
  actorName?: string
  run?: TestRunSummary
}

export function stageTestRows(change: ChangeSnapshot, stepId: string): TestRow[] {
  const step = change.tests?.find((entry) => entry.stepId === stepId)
  return (step?.items ?? []).map((item) => ({
    id: item.id,
    name: item.label ?? item.id,
    direction: item.direction,
    required: item.required,
    status: item.status,
    ...(item.waiver === undefined ? {} : { waiver: item.waiver }),
    ...(item.run === undefined ? {} : {
      durationMs: item.run.durationMs,
      finishedAt: item.run.finishedAt,
      actorName: item.run.actor.name,
      run: item.run,
    }),
  }))
}

export function stageTestCount(rows: readonly TestRow[]): string {
  return `${rows.filter((row) => row.status === 'passed').length}/${rows.length}`
}

export function testStatusWord(status: TestItemStatus | TestItemWaiver, t: (key: string) => string): string {
  return t(`workspace.test_status_${status.replace('-', '_')}`)
}
