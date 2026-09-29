/**
 * 验证报告的测试体系段落（纯函数）：追溯矩阵（场景 / 任务 → 用例 → 最近结果）、套件汇总（含覆盖率）、基准对比、
 * flaky 与已知失败、还在挡出口的项。输入是 kernel 的 TestPolicyReport（与门禁同一份判定），所以报告里写的就是门禁看到的。
 * 中英两套文案；表格单元格里的竖线转义。
 */
import type { BenchmarkMetricVerdict, ReportLocale, SuiteVerdict, TestPolicyReport, TraceRow, TraceTest } from '@tenon/kernel'

interface Words {
  readonly title: string
  readonly matrix: string
  readonly matrixHead: readonly string[]
  readonly suites: string
  readonly suitesHead: readonly string[]
  readonly benchmark: string
  readonly benchmarkHead: readonly string[]
  readonly flaky: string
  readonly blockers: string
  readonly none: string
  readonly rowState: Readonly<Record<TraceRow['state'], string>>
  readonly caseState: Readonly<Record<TraceTest['status'], string>>
  readonly suiteState: Readonly<Record<SuiteVerdict['state'], string>>
  readonly waived: string
  readonly unapproved: string
  readonly baselineMissing: string
}

const WORDS: Readonly<Record<ReportLocale, Words>> = {
  'zh-CN': {
    title: '## 测试体系',
    matrix: '### 追溯矩阵',
    matrixHead: ['场景 / 任务', '用例', '最近结果', '状态'],
    suites: '### 套件',
    suitesHead: ['套件', '种类', '结果', '用例', '覆盖率', '运行'],
    benchmark: '### 基准',
    benchmarkHead: ['套件', '指标', '中位数', '基线', '变化', '结论'],
    flaky: '### flaky 与失败',
    blockers: '### 仍挡出口的项',
    none: '无',
    rowState: { uncovered: '未覆盖', mapped: '已映射未通过', passing: '通过', failing: '有失败', waived: '已豁免' },
    caseState: { pass: '通过', fail: '失败', skip: '跳过', flaky: 'flaky', 'known-fail': '已知失败', 'not-run': '未运行' },
    suiteState: { passed: '通过', failed: '失败', stale: '过期', missing: '未运行', running: '运行中' },
    waived: '豁免（已批准）',
    unapproved: '豁免（未批准）',
    baselineMissing: '无同画像基线',
  },
  en: {
    title: '## Test system',
    matrix: '### Traceability',
    matrixHead: ['Scenario / task', 'Cases', 'Latest result', 'State'],
    suites: '### Suites',
    suitesHead: ['Suite', 'Kind', 'Result', 'Cases', 'Coverage', 'Run'],
    benchmark: '### Benchmarks',
    benchmarkHead: ['Suite', 'Metric', 'Median', 'Baseline', 'Change', 'Verdict'],
    flaky: '### Flaky and failing',
    blockers: '### Still blocking the exit',
    none: 'none',
    rowState: { uncovered: 'uncovered', mapped: 'mapped, not passing', passing: 'passing', failing: 'failing', waived: 'waived' },
    caseState: { pass: 'pass', fail: 'fail', skip: 'skip', flaky: 'flaky', 'known-fail': 'known failure', 'not-run': 'not run' },
    suiteState: { passed: 'pass', failed: 'fail', stale: 'stale', missing: 'not run', running: 'running' },
    waived: 'waived (approved)',
    unapproved: 'waived (unapproved)',
    baselineMissing: 'no baseline for this machine',
  },
}

function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function table(head: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`)]
}

function matrixRows(rows: readonly TraceRow[], words: Words): string[][] {
  return rows.map((row) => {
    const cases = row.tests.map((test) => `\`${test.ref}\``).join('<br>')
    const results = row.tests.map((test) => `${words.caseState[test.status]}${test.suite === undefined ? '' : `（${test.suite}）`}`).join('<br>')
    const waiver = row.waiver === undefined ? '' : ` ${row.waiver.approved ? words.waived : words.unapproved}：${row.waiver.reason}`
    return [`${row.title} \`${row.covers}\``, cases === '' ? '—' : cases, results === '' ? '—' : results, `${words.rowState[row.state]}${waiver}`]
  })
}

function coverageText(verdict: SuiteVerdict): string {
  const coverage = verdict.coverage
  return coverage === null || coverage === undefined ? '—' : Object.entries(coverage).map(([key, value]) => `${key} ${value}%`).join(' / ')
}

function totalsText(verdict: SuiteVerdict): string {
  const totals = verdict.totals
  if (totals === undefined) return '—'
  const extra = [totals.flaky > 0 ? `${totals.flaky} flaky` : '', totals.known_fail > 0 ? `${totals.known_fail} known` : '', totals.skip > 0 ? `${totals.skip} skip` : ''].filter((part) => part !== '')
  return `${totals.pass}/${totals.cases}${extra.length === 0 ? '' : ` (${extra.join(', ')})`}${totals.fail > 0 ? ` ✗${totals.fail}` : ''}`
}

function benchmarkRows(suites: readonly SuiteVerdict[], words: Words): string[][] {
  return suites.flatMap((suite) => (suite.benchmark ?? []).map((metric: BenchmarkMetricVerdict) => [
    suite.suite,
    metric.name,
    metric.summary === null ? '—' : `${Number(metric.summary.median.toFixed(4))}${metric.unit ?? ''}`,
    metric.baseline === null ? words.baselineMissing : `${Number(metric.baseline.toFixed(4))}${metric.unit ?? ''}`,
    metric.delta_pct === null ? '—' : `${metric.delta_pct >= 0 ? '+' : ''}${metric.delta_pct.toFixed(2)}%`,
    metric.failed ? metric.details.join('；') || 'fail' : metric.baselineMissing ? words.baselineMissing : 'ok',
  ]))
}

/** 写进报告 `tenon:test-report:*` 块的正文：标题 + 各节。 */
export function renderV2Block(report: TestPolicyReport, locale: ReportLocale): string {
  return `${WORDS[locale].title}\n\n${renderV2Sections(report, locale)}`
}

export function renderV2Sections(report: TestPolicyReport, locale: ReportLocale): string {
  const words = WORDS[locale]
  const out: string[] = []
  if (report.trace.length > 0) out.push(words.matrix, ...table(words.matrixHead, matrixRows(report.trace, words)), '')
  const catalogSuites = report.suites.filter((suite) => suite.origin === 'catalog')
  if (catalogSuites.length > 0) {
    out.push(words.suites, ...table(words.suitesHead, catalogSuites.map((suite) => [
      suite.label === undefined ? suite.suite : `${suite.label} \`${suite.suite}\``, suite.kind, words.suiteState[suite.state],
      totalsText(suite), coverageText(suite), suite.run_id === undefined ? '—' : `\`${suite.run_id}\``,
    ])), '')
  }
  const bench = benchmarkRows(report.suites, words)
  if (bench.length > 0) out.push(words.benchmark, ...table(words.benchmarkHead, bench), '')
  const flaky = catalogSuites.flatMap((suite) => (suite.flaky ?? []).map((ref) => `- flaky（${suite.suite}）：${ref}`))
  const failing = catalogSuites.flatMap((suite) => (suite.failing ?? []).map((ref) => `- ${locale === 'en' ? 'failing' : '失败'}（${suite.suite}）：${ref}`))
  const knownCount = catalogSuites.reduce((sum, suite) => sum + (suite.totals?.known_fail ?? 0), 0)
  if (flaky.length + failing.length > 0 || knownCount > 0) {
    out.push(words.flaky, ...flaky, ...failing, ...(knownCount > 0 ? [locale === 'en' ? `- known failures: ${knownCount}` : `- 已知失败：${knownCount} 个`] : []), '')
  }
  const blocking = report.blockers.filter((item) => item.blocking)
  out.push(words.blockers)
  if (blocking.length === 0) out.push(`- ${words.none}`)
  for (const item of blocking) out.push(`- [${item.code}] ${item.message}${item.fix === undefined ? '' : ` → \`${item.fix}\``}`)
  return out.join('\n')
}
