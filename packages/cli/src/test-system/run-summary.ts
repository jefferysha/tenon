/** `tenon test run` 的人类可读摘要：每个套件一行（结果、计数、范围、耗时）、失败原因、前 10 条失败用例、产物位置。 */
import { isUnknownCaseFile, type CaseResultV2, type ServiceRunV2, type SuiteRunV2, type TestNotice } from '@tenon/kernel'

const MAX_FAILURES = 10

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

function firstLine(text: string): string {
  return (text.split('\n').find((line) => line.trim() !== '') ?? '').trim().slice(0, 200)
}

function counts(run: SuiteRunV2): string {
  const { totals } = run
  const parts = [`${totals.pass} 通过`, `${totals.fail} 失败`]
  if (totals.flaky > 0) parts.push(`${totals.flaky} flaky`)
  if (totals.known_fail > 0) parts.push(`${totals.known_fail} 已知失败`)
  if (totals.skip > 0) parts.push(`${totals.skip} 跳过`)
  return parts.join(' / ')
}

function metricLine(run: SuiteRunV2): string {
  return run.metrics.map((metric) => `${metric.name} 中位数 ${Number(metric.median.toFixed(4))}${metric.unit ?? ''}（${metric.samples.length} 个样本）`).join('；')
}

/** 报告没给文件的用例，记录里存的是哨兵值 `(unknown)`；给人看的地方写「未报告文件」。 */
function caseLabel(item: CaseResultV2): string {
  return [isUnknownCaseFile(item.file) ? '未报告文件' : item.file, ...item.suite_path, item.name].join(' › ')
}

function failedCases(run: SuiteRunV2): CaseResultV2[] {
  return run.cases.filter((item) => item.status === 'fail')
}

export function suiteLines(run: SuiteRunV2): string[] {
  const mark = run.result === 'pass' ? 'PASS' : 'FAIL'
  const lines = [`  [${mark}] ${run.suite}  ${run.kind}/${run.runner}  scope=${run.scope}  ${seconds(run.duration_ms)}  ${run.report.format === 'exit-code' ? `退出码 ${run.exit_code ?? run.signal ?? '?'}` : run.metrics.length > 0 ? metricLine(run) : counts(run)}`]
  if (run.coverage !== null) {
    lines.push(`         覆盖率：${Object.entries(run.coverage).map(([key, value]) => `${key} ${value}%`).join('  ')}`)
  }
  if (run.projects.length > 0) lines.push(`         浏览器：${run.projects.join(', ')}`)
  for (const reason of run.reasons) lines.push(`         · ${reason.code}${reason.detail === undefined ? '' : `：${firstLine(reason.detail)}`}`)
  const failed = failedCases(run)
  for (const item of failed.slice(0, MAX_FAILURES)) {
    lines.push(`         ✗ ${caseLabel(item)}${item.project === null ? '' : ` [${item.project}]`}${item.failure === undefined ? '' : ` — ${firstLine(item.failure.message)}`}`)
  }
  if (failed.length > MAX_FAILURES) lines.push(`         … 另有 ${failed.length - MAX_FAILURES} 个失败用例（见记录）`)
  const flaky = run.cases.filter((item) => item.status === 'flaky')
  for (const item of flaky.slice(0, 5)) lines.push(`         ~ flaky（${item.attempts} 次尝试）${caseLabel(item)}`)
  return lines
}

export function serviceLines(services: readonly ServiceRunV2[]): string[] {
  return services.map((service) => `  服务 ${service.id}：${service.exit === 'stopped' ? '已回收' : service.exit}${service.ready_ms === null ? '' : `，就绪 ${service.ready_ms}ms`}${service.leaked_pids.length > 0 ? `，残留进程 ${service.leaked_pids.join(',')}` : ''}`)
}

export function noticeLines(notices: readonly TestNotice[]): string[] {
  return notices.flatMap((notice) => [`  提示：${notice.message}`, ...(notice.fix === undefined ? [] : [`         ${notice.fix}`])])
}
