/**
 * 验证报告的测试体系段落（纯函数）：追溯矩阵（场景 / 任务 → 用例 → 最近结果）、套件汇总（含覆盖率）、基准对比、
 * flaky 与已知失败、还在挡出口的项。输入是 kernel 的 TestPolicyReport（与门禁同一份判定），所以报告里写的就是门禁看到的。
 * 中英两套文案；表格单元格里的竖线转义。规格标题、套件名与 label、登记者写的豁免理由、用例 ref、测试 id、指标名与基准 details、阻断 message 都是不可信文本：
 * 行内文字走 escapedInline（不截短）或 escapedWaiverText（截短），放进行内代码的走 inCodeSpan，渲染后既没有链接、图片，也不会换行或撑破表格。
 */
import {
  displaySafeText, foldDisplayText, formatWaiverMetrics, waiverReasonText,
  type BenchmarkMetricVerdict, type ReportLocale, type SuiteVerdict, type TestPolicyReport, type TraceRow, type TraceTest,
} from '@tenon/kernel'

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
  /** 不要求映射用例（非实现阶段的任务）且没有映射：不是缺口，写「可选」而不是「未覆盖」。 */
  readonly optional: string
  readonly caseState: Readonly<Record<TraceTest['status'], string>>
  readonly suiteState: Readonly<Record<SuiteVerdict['state'], string>>
  readonly waived: string
  readonly unapproved: string
  readonly baselineMissing: string
  /** 档位不要求映射时，未映射的场景 / 任务收成的一行统计。 */
  readonly unmapped: (count: number) => string
  readonly stepWaivers: string
  readonly waiverApproved: string
  readonly waiverPending: string
  readonly selfReported: string
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
    optional: '可选',
    caseState: { pass: '通过', fail: '失败', skip: '跳过', flaky: 'flaky', 'known-fail': '已知失败', 'not-run': '未运行' },
    suiteState: { passed: '通过', failed: '失败', stale: '过期', missing: '未运行', running: '运行中', waived: '已豁免', 'waiver-pending': '豁免待批准' },
    waived: '豁免（已批准）',
    unapproved: '豁免（未批准）',
    baselineMissing: '无同画像基线',
    unmapped: (count) => `另有 ${count} 条场景 / 任务未映射（本步不要求映射）`,
    stepWaivers: '### 步骤测试豁免',
    waiverApproved: '已批准',
    waiverPending: '待评审批准',
    selfReported: '理由为登记者自述、未经核实',
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
    optional: 'optional',
    caseState: { pass: 'pass', fail: 'fail', skip: 'skip', flaky: 'flaky', 'known-fail': 'known failure', 'not-run': 'not run' },
    suiteState: { passed: 'pass', failed: 'fail', stale: 'stale', missing: 'not run', running: 'running', waived: 'waived', 'waiver-pending': 'waiver pending' },
    waived: 'waived (approved)',
    unapproved: 'waived (unapproved)',
    baselineMissing: 'no baseline for this machine',
    unmapped: (count) => `${count} more scenarios / tasks are not mapped (this step does not require mapping)`,
    stepWaivers: '### Step-test waivers',
    waiverApproved: 'approved',
    waiverPending: 'awaiting review approval',
    selfReported: 'the reason is self-reported by the registrant, unverified',
  },
}

/**
 * 单元格文本：换行折成空格，竖线补转义。反斜杠连同后一个字符原样保留：escapedWaiverText 已经把竖线转成 `\|`，
 * 再转一次会得到 `\\|`，反斜杠自己被转义后竖线反而成了列分隔，登记者就能撑出多余的列。
 */
function cell(value: string): string {
  return value.replace(/\n/gu, ' ').replace(/\\[\s\S]|\|/gu, (token) => (token === '|' ? '\\|' : token))
}

function table(head: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`)]
}

/** 能和相邻文字组成链接、图片、引用或表格的 Markdown 元字符（反斜杠自己也要转义）。 */
const MARKDOWN_SPECIAL = /[\\[\]()!*|]/gu

/**
 * 行内的不可信文本（规格标题、套件名与 label、登记者写的豁免理由、测试 id、用例 ref、阻断 message、探针输出里的指标名）：先走 `displaySafeText`
 * （折成单行、去控制字符、反引号与尖括号换全角），再把 Markdown 元字符转义成字面文字，渲染后既没有链接、图片，也不会换行或撑破表格。
 * 不截短：矩阵里的标题与套件名要完整。下划线、井号、波浪线不转义：它们组不成链接或图片，指标名里的下划线（`lines_added`）要保持原样。
 */
function escapedInline(text: string): string {
  return markdownEscaped(displaySafeText(text))
}

/** 同 escapedInline，但按 `waiverReasonText` 截短：登记者自述的理由、ref、message 这类长文只展示开头。 */
function escapedWaiverText(text: string): string {
  return markdownEscaped(waiverReasonText(text))
}

/** 只做转义：调用方要先完成单行化与截短，转义序列才不会被截在中间。 */
function markdownEscaped(text: string): string {
  return text.replace(MARKDOWN_SPECIAL, '\\$&')
}

/**
 * 行内代码里的不可信文本：折成单行、去控制字符与双向字符，反引号换成全角，闭合不了代码段；代码段里的其余字符按字面显示，不必转义。
 * 不截短、不动尖括号：`fix` 是要原样复制的命令（含 `<日期>` 占位）。
 */
function inCodeSpan(text: string): string {
  return foldDisplayText(text).replace(/`/gu, '｀')
}

function matrixRows(rows: readonly TraceRow[], words: Words): string[][] {
  return rows.map((row) => {
    const cases = row.tests.map((test) => `\`${inCodeSpan(test.ref)}\``).join('<br>')
    const results = row.tests.map((test) => `${words.caseState[test.status]}${test.suite === undefined ? '' : `（${escapedInline(test.suite)}）`}`).join('<br>')
    const waiver = row.waiver === undefined ? '' : ` ${row.waiver.approved ? words.waived : words.unapproved}：${escapedWaiverText(row.waiver.reason)}`
    const state = !row.required && row.state === 'uncovered' ? words.optional : words.rowState[row.state]
    return [`${escapedInline(row.title)} \`${inCodeSpan(row.covers)}\``, cases === '' ? '—' : cases, results === '' ? '—' : results, `${state}${waiver}`]
  })
}

/**
 * 追溯矩阵段。本步不要求映射（scenarios: off）时只列已映射（或有豁免）的行，其余收成一行统计，不逐条写「未覆盖」；
 * 要求映射时每一行照旧。
 */
function matrixSection(report: TestPolicyReport, words: Words): string[] {
  if (report.trace.length === 0) return []
  const collapse = report.scenarios === 'off'
  const listed = collapse ? report.trace.filter((row) => row.state !== 'uncovered' || row.waiver !== undefined) : report.trace
  const hidden = report.trace.length - listed.length
  return [
    words.matrix,
    ...(listed.length === 0 ? [] : table(words.matrixHead, matrixRows(listed, words))),
    ...(hidden === 0 ? [] : [words.unmapped(hidden)]),
    '',
  ]
}

/** 失败后带豁免的步骤测试：理由（登记者自述）下方另起一行，写该测试在当前候选上最新失败记录的实测值。 */
function stepWaiverSection(suites: readonly SuiteVerdict[], words: Words, locale: ReportLocale): string[] {
  const waived = suites.filter((suite) => suite.origin === 'step' && (suite.state === 'waived' || suite.state === 'waiver-pending'))
  if (waived.length === 0) return []
  const colon = locale === 'en' ? ': ' : '：'
  return [
    words.stepWaivers,
    ...waived.flatMap((suite) => [
      // 测试 id 在行内代码里：这里转义反而会把反斜杠原样显示出来，只需保证反引号闭合不了它、也不会换行。
      `- \`${waiverReasonText(suite.suite.replace(/^step:/u, ''))}\`${colon}${suite.state === 'waived' ? words.waiverApproved : words.waiverPending}`
        + `${locale === 'en' ? ` (${words.selfReported})` : `（${words.selfReported}）`}${colon}${escapedWaiverText(suite.waiverReason ?? '')}`,
      // 指标名由 formatWaiverMetrics 先单行化、截短，再交给 markdownEscaped：转义序列不会被截在中间。
      `  ${formatWaiverMetrics(suite.failedMetrics ?? [], locale, markdownEscaped)}`,
    ]),
    '',
  ]
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
    escapedInline(suite.suite),
    escapedInline(metric.name),
    metric.summary === null ? '—' : `${Number(metric.summary.median.toFixed(4))}${metric.unit ?? ''}`,
    metric.baseline === null ? words.baselineMissing : `${Number(metric.baseline.toFixed(4))}${metric.unit ?? ''}`,
    metric.delta_pct === null ? '—' : `${metric.delta_pct >= 0 ? '+' : ''}${metric.delta_pct.toFixed(2)}%`,
    metric.failed ? escapedInline(metric.details.join('；')) || 'fail' : metric.baselineMissing ? words.baselineMissing : 'ok',
  ]))
}

/** 写进报告 `tenon:test-report:*` 块的正文：标题 + 各节。 */
export function renderV2Block(report: TestPolicyReport, locale: ReportLocale): string {
  return `${WORDS[locale].title}\n\n${renderV2Sections(report, locale)}`
}

export function renderV2Sections(report: TestPolicyReport, locale: ReportLocale): string {
  const words = WORDS[locale]
  const out: string[] = []
  out.push(...matrixSection(report, words))
  const catalogSuites = report.suites.filter((suite) => suite.origin === 'catalog')
  if (catalogSuites.length > 0) {
    out.push(words.suites, ...table(words.suitesHead, catalogSuites.map((suite) => [
      suite.label === undefined ? suite.suite : `${escapedInline(suite.label)} \`${inCodeSpan(suite.suite)}\``, suite.kind, words.suiteState[suite.state],
      totalsText(suite), coverageText(suite), suite.run_id === undefined ? '—' : `\`${suite.run_id}\``,
    ])), '')
  }
  out.push(...stepWaiverSection(report.suites, words, locale))
  const bench = benchmarkRows(report.suites, words)
  if (bench.length > 0) out.push(words.benchmark, ...table(words.benchmarkHead, bench), '')
  const flaky = catalogSuites.flatMap((suite) => (suite.flaky ?? []).map((ref) => `- flaky（${escapedInline(suite.suite)}）：${escapedWaiverText(ref)}`))
  const failing = catalogSuites.flatMap((suite) => (suite.failing ?? []).map((ref) => `- ${locale === 'en' ? 'failing' : '失败'}（${escapedInline(suite.suite)}）：${escapedWaiverText(ref)}`))
  const knownCount = catalogSuites.reduce((sum, suite) => sum + (suite.totals?.known_fail ?? 0), 0)
  if (flaky.length + failing.length > 0 || knownCount > 0) {
    out.push(words.flaky, ...flaky, ...failing, ...(knownCount > 0 ? [locale === 'en' ? `- known failures: ${knownCount}` : `- 已知失败：${knownCount} 个`] : []), '')
  }
  const blocking = report.blockers.filter((item) => item.blocking)
  out.push(words.blockers)
  if (blocking.length === 0) out.push(`- ${words.none}`)
  for (const item of blocking) out.push(`- [${item.code}] ${escapedWaiverText(item.message)}${item.fix === undefined ? '' : ` → \`${inCodeSpan(item.fix)}\``}`)
  return out.join('\n')
}
