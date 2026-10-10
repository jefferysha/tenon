/**
 * 评审者提示词里的 v2 测试摘要：最新运行里失败的用例、flaky、覆盖率对照策略门槛、基准相对基线的变化。
 * 数据全部来自 kernel 的策略判定（`TestEvidenceReport.policy`，与门禁、`tenon status` 同一份），评审者
 * 自己不跑测试，也不必去翻记录目录。只在评审者声明了 `reads_tests` 时附带（agent.ts）。
 */
import {
  COVERAGE_METRICS, type BenchmarkMetricVerdict, type CoverageMetric, type SuiteVerdict, type TestPolicyReport,
} from '@tenon/kernel'

const STATE_WORD: Readonly<Record<SuiteVerdict['state'], string>> = {
  passed: '通过',
  failed: '不通过',
  stale: '过期',
  missing: '未运行',
  running: '运行中',
  // 豁免只出现在旧步骤内联测试上；摘要只列目录套件，这两项不会用到，类型要求闭集。
  waived: '已豁免',
  'waiver-pending': '豁免待批准',
}

/** 单行里最多列出的用例数；其余折成「等 N 个」，提示词不随大型套件膨胀。 */
const MAX_LISTED = 10

function listed(refs: readonly string[]): string {
  const shown = refs.slice(0, MAX_LISTED).join('；')
  return refs.length > MAX_LISTED ? `${shown}；等 ${refs.length} 个` : shown
}

function percent(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`
}

function coverageLine(
  verdict: SuiteVerdict,
  thresholds: Readonly<Partial<Record<CoverageMetric, number>>>,
): string | undefined {
  const coverage = verdict.coverage
  if (coverage === undefined || coverage === null) return undefined
  const parts: string[] = []
  for (const metric of COVERAGE_METRICS) {
    const actual = coverage[metric]
    if (actual === undefined) continue
    const floor = thresholds[metric]
    parts.push(floor === undefined
      ? `${metric} ${percent(actual)}`
      : `${metric} ${percent(actual)}（门槛 ${percent(floor)}${actual < floor ? '，不足' : ''}）`)
  }
  return parts.length === 0 ? undefined : `覆盖率 ${parts.join('，')}`
}

function benchmarkLine(metric: BenchmarkMetricVerdict): string {
  const unit = metric.unit ?? ''
  const value = metric.summary === null ? '无样本' : `${metric.summary.median}${unit}`
  const base = metric.baseline === null ? '无同画像基线' : `基线 ${metric.baseline}${unit}`
  const delta = metric.delta_pct === null ? '' : `，${metric.delta_pct >= 0 ? '+' : ''}${metric.delta_pct.toFixed(1)}%`
  return `${metric.name} ${value}（${base}${delta}${metric.failed ? '，退化' : ''}${metric.noisy ? '，波动大' : ''}）`
}

/**
 * 每个目录套件一行（旧步骤内联测试走原有的逐项结果，不在这里）。策略没有目录套件在跑 = 空数组。
 */
export function renderTestPolicySummary(
  report: TestPolicyReport | undefined,
  thresholds: Readonly<Partial<Record<CoverageMetric, number>>> = {},
): readonly string[] {
  const suites = (report?.suites ?? []).filter((suite) => suite.origin === 'catalog')
  if (suites.length === 0) return []
  const lines: string[] = ['测试摘要（目录套件的最新运行）：']
  for (const suite of suites) {
    const name = suite.label === undefined ? suite.suite : `${suite.label}（${suite.suite}）`
    const parts: string[] = [`${name} ${suite.kind} ${STATE_WORD[suite.state]}`]
    if (suite.detail !== undefined && suite.detail !== '') parts.push(suite.detail)
    if (suite.staleBecause !== undefined && suite.staleBecause.length > 0) parts.push(`过期项 ${suite.staleBecause.join('、')}`)
    const totals = suite.totals
    if (totals !== undefined) {
      const counts = [`${totals.pass}/${totals.cases} 通过`]
      if (totals.fail > 0) counts.push(`${totals.fail} 失败`)
      if (totals.flaky > 0) counts.push(`${totals.flaky} flaky`)
      if (totals.known_fail > 0) counts.push(`${totals.known_fail} 已知失败`)
      if (totals.skip > 0) counts.push(`${totals.skip} 跳过`)
      parts.push(counts.join('，'))
    }
    const coverage = coverageLine(suite, thresholds)
    if (coverage !== undefined) parts.push(coverage)
    lines.push(`- ${parts.join('；')}`)
    if (suite.failing !== undefined && suite.failing.length > 0) lines.push(`  失败用例：${listed(suite.failing)}`)
    if (suite.flaky !== undefined && suite.flaky.length > 0) lines.push(`  flaky 用例：${listed(suite.flaky)}`)
    if (suite.benchmark !== undefined && suite.benchmark.length > 0) {
      lines.push(`  基准：${suite.benchmark.map(benchmarkLine).join('；')}`)
    }
  }
  return lines
}
