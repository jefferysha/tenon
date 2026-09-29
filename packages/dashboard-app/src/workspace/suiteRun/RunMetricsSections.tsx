import { ArrowDown, ArrowUp } from 'lucide-react'
import { useT } from '../../i18n'
import { StatusPill } from '../../shell/ThreeColumns'
import { TestSection } from '../../tests/TestSection'
import { blockerLabel, noticeLabel } from '../../tests/testLabels'
import { formatDelta, formatMetric, formatPercent } from '../../tests/testFormat'
import { TABLE_HEAD, TABLE_ROW, gridRow } from '../../tests/testStyles'
import type { BenchmarkVerdict, RunMetric, SuiteRun, TestCoverage } from '../../api/testSystemTypes'
import { cn } from '@/lib/utils'

const COVERAGE_KEYS = ['lines', 'branches', 'changedLines', 'functions', 'statements'] as const
const COVERAGE_COLUMNS = 'grid-cols-[minmax(0,1fr)_6rem_6rem]'

/** 覆盖率：指标 · 实际 · 门槛。低于门槛（或门槛要求却没报告）的行用危险色。 */
export function RunCoverageSection({ coverage, thresholds }: { coverage: SuiteRun['coverage']; thresholds: TestCoverage | undefined }): JSX.Element | null {
  const { t } = useT()
  const rows = COVERAGE_KEYS
    .map((key) => ({ key, actual: coverage?.[key], threshold: thresholds?.[key] }))
    .filter((row) => row.actual !== undefined || row.threshold !== undefined)
  if (rows.length === 0) return null
  return (
    <TestSection title={t('tests.run.section.coverage')} testId="run-coverage">
      <div role="table" aria-label={t('tests.run.section.coverage')}>
        <div className={`${gridRow(COVERAGE_COLUMNS)} ${TABLE_HEAD}`} role="row">
          <span role="columnheader">{t('tests.run.coverage.metric')}</span>
          <span role="columnheader">{t('tests.run.coverage.actual')}</span>
          <span role="columnheader">{t('tests.run.coverage.threshold')}</span>
        </div>
        {rows.map((row) => {
          const below = row.threshold !== undefined && (row.actual === undefined || row.actual < row.threshold)
          return (
            <div key={row.key} className={`${gridRow(COVERAGE_COLUMNS)} ${TABLE_ROW}`} role="row" data-testid={`run-coverage-${row.key}`} data-below={below}>
              <span className="truncate" role="cell">{t(`tests.run.coverage.${row.key}`)}</span>
              <span className={cn('flex items-center gap-1.5 font-mono', below ? 'text-red-d' : 'text-text')} role="cell">
                {below && <i className="size-1.5 flex-none rounded-full bg-red" aria-hidden="true" />}
                {row.actual === undefined ? '—' : formatPercent(row.actual)}
              </span>
              <span className="font-mono text-text-2" role="cell">{row.threshold === undefined ? '—' : formatPercent(row.threshold)}</span>
            </div>
          )
        })}
      </div>
    </TestSection>
  )
}

const BENCH_COLUMNS = 'grid-cols-[minmax(0,1.2fr)_5.5rem_5.5rem_5.5rem_6.5rem_minmax(0,1.4fr)]'

/** 基准：指标 · 中位数 · p95 · 基线 · 变化 · 方向；越限的行用危险色。基线与变化只来自本次运行对应的判定。 */
export function RunBenchmarkSection({ metrics, verdicts }: { metrics: readonly RunMetric[]; verdicts: readonly BenchmarkVerdict[] | undefined }): JSX.Element | null {
  const { t, lang } = useT()
  if (metrics.length === 0) return null
  return (
    <TestSection title={t('tests.run.section.benchmark')} count={metrics.length} testId="run-benchmark">
      <div role="table" aria-label={t('tests.run.section.benchmark')}>
        <div className={`${gridRow(BENCH_COLUMNS)} ${TABLE_HEAD}`} role="row">
          <span role="columnheader">{t('tests.run.benchmark.metric')}</span>
          <span role="columnheader">{t('tests.run.benchmark.median')}</span>
          <span role="columnheader">{t('tests.run.benchmark.p95')}</span>
          <span role="columnheader">{t('tests.word.baseline')}</span>
          <span role="columnheader">{t('tests.run.benchmark.delta')}</span>
          <span role="columnheader">{t('tests.run.benchmark.direction')}</span>
        </div>
        {metrics.map((metric) => {
          const verdict = verdicts?.find((item) => item.name === metric.name)
          const failed = verdict?.failed === true
          const unit = metric.unit === undefined ? '' : ` ${metric.unit}`
          return (
            <div key={metric.name} className={`${gridRow(BENCH_COLUMNS)} ${TABLE_ROW}`} role="row" data-testid={`run-metric-${metric.name}`} data-failed={failed}>
              <span className="truncate font-mono text-text" role="cell" title={metric.name}>{metric.name}</span>
              <span className="font-mono text-text" role="cell">{formatMetric(metric.median)}{unit}</span>
              <span className="font-mono text-text-2" role="cell">{formatMetric(metric.p95)}</span>
              <span className="font-mono text-text-2" role="cell" data-testid={`run-metric-baseline-${metric.name}`}>
                {verdict === undefined ? '—' : verdict.baseline === null ? '—' : formatMetric(verdict.baseline)}
              </span>
              <span className={cn('flex items-center gap-1.5 font-mono', failed ? 'text-red-d' : 'text-text-2')} role="cell" data-testid={`run-metric-delta-${metric.name}`}>
                {failed && <i className="size-1.5 flex-none rounded-full bg-red" aria-hidden="true" />}
                {verdict === undefined ? '—' : formatDelta(verdict.deltaPct)}
              </span>
              <span className="flex min-w-0 items-center gap-2 truncate text-caption text-text-2" role="cell">
                {metric.better === 'lower' ? <ArrowDown className="size-3.5 flex-none" aria-hidden="true" /> : <ArrowUp className="size-3.5 flex-none" aria-hidden="true" />}
                <span className="truncate" title={verdict?.details.join('；') || undefined}>{t(`tests.run.benchmark.${metric.better}`)}</span>
                {verdict?.baselineMissing === true && <StatusPill tone="pending" title={t('tests.run.benchmark.baseline_hint')} testId={`run-metric-nobaseline-${metric.name}`}>{blockerLabel('baseline-missing', lang)}</StatusPill>}
                {verdict?.noisy === true && <StatusPill tone="pending" title={t('tests.run.benchmark.noisy_hint')} testId={`run-metric-noisy-${metric.name}`}>{noticeLabel('benchmark-noisy', lang)}</StatusPill>}
              </span>
            </div>
          )
        })}
      </div>
    </TestSection>
  )
}
