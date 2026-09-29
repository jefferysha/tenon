import { useT } from '../i18n'
import { fetchSuiteBaselines } from '../api/testSystemClient'
import type { CatalogSuite, SuiteBaseline } from '../api/testSystemTypes'
import { formatApiError } from '../api/transport'
import { TestSection } from '../tests/TestSection'
import { formatMetric, formatTime } from '../tests/testFormat'
import { TABLE_HEAD, TABLE_ROW, gridRow } from '../tests/testStyles'
import { useRemote } from '../tests/useRemote'
import { HistoryChart } from './HistoryChart'
import { Hinted } from './projectBits'

const COLUMNS = 'grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_5.5rem_5.5rem_3.5rem_5.5rem_7.5rem]'

function rowsOf(baseline: SuiteBaseline): Array<{ name: string; unit?: string; better: 'lower' | 'higher'; median: number; p95: number; samples: number; trend: number[] }> {
  return Object.entries(baseline.metrics).map(([name, metric]) => ({
    name,
    ...(metric.unit === undefined ? {} : { unit: metric.unit }),
    better: metric.better,
    median: metric.median,
    p95: metric.p95,
    samples: metric.samples,
    // 历史新的在前：走势从旧到新，最后是当前值。
    trend: [...baseline.history].reverse().flatMap((entry) => {
      const past = entry.metrics[name]
      return past === undefined ? [] : [past.median]
    }).concat(metric.median),
  }))
}

/** 基线：按机器画像分行，每个指标一行（中位数 · p95 · 样本 · 更新时间）并带中位数走势小折线；只给声明了基准的套件。 */
export function SuiteBaselines({ root, suite }: { root: string; suite: CatalogSuite }): JSX.Element | null {
  const { t } = useT()
  const { state } = useRemote((signal) => fetchSuiteBaselines(root, suite.id, signal), [root, suite.id], suite.benchmark !== undefined)
  if (suite.benchmark === undefined) return null
  if (state.status === 'loading') return null
  if (state.status === 'error') {
    return (
      <TestSection title={t('tests.word.baseline')} testId="proj-baselines">
        <p className="truncate whitespace-nowrap text-body text-red-d" role="alert" data-testid="proj-baselines-error">{formatApiError(state.error, t)}</p>
      </TestSection>
    )
  }
  const { baselines, corrupt } = state.data
  if (baselines.length === 0 && corrupt.length === 0) return null
  return (
    <TestSection title={t('tests.word.baseline')} count={baselines.length} testId="proj-baselines">
      {corrupt.length > 0 && (
        <p className="truncate whitespace-nowrap text-body text-red-d" role="alert" title={corrupt.join(', ')} data-testid="proj-baselines-corrupt">
          {t('tests.project.baseline.corrupt')} {corrupt.length}
        </p>
      )}
      {baselines.length > 0 && (
        <div role="table" aria-label={t('tests.word.baseline')}>
          <div className={`${gridRow(COLUMNS)} ${TABLE_HEAD}`} role="row">
            <span role="columnheader">{t('tests.project.baseline.profile')}</span>
            <span role="columnheader">{t('tests.project.baseline.metric')}</span>
            <span role="columnheader">{t('tests.project.baseline.median')}</span>
            <span role="columnheader">{t('tests.project.baseline.p95')}</span>
            <span role="columnheader">{t('tests.project.baseline.samples')}</span>
            <span role="columnheader">{t('tests.project.baseline.updated')}</span>
            <span role="columnheader">{t('tests.project.baseline.trend')}</span>
          </div>
          {baselines.flatMap((baseline) => rowsOf(baseline).map((row) => (
            <div key={`${baseline.profile}/${row.name}`} className={`${gridRow(COLUMNS)} ${TABLE_ROW}`} role="row" data-testid={`proj-baseline-${baseline.profile}-${row.name}`}>
              <span className="truncate font-mono text-caption text-text-2" role="cell" title={baseline.profile}>{baseline.profileLabel}</span>
              <span className="truncate font-mono text-text" role="cell">
                <Hinted hint={t(`tests.project.baseline.better_${row.better}`)}><span>{row.name}</span></Hinted>
              </span>
              <span className="font-mono text-text" role="cell">{formatMetric(row.median)}{row.unit === undefined ? '' : ` ${row.unit}`}</span>
              <span className="font-mono text-text-2" role="cell">{formatMetric(row.p95)}</span>
              <span className="font-mono text-text-2" role="cell">{row.samples}</span>
              <span className="font-mono text-caption text-text-2" role="cell">{formatTime(baseline.updatedAt)}</span>
              <span role="cell">
                <HistoryChart values={row.trend} label={`${row.name} ${formatMetric(row.trend[0] ?? row.median)} → ${formatMetric(row.median)}`} testId={`proj-baseline-chart-${baseline.profile}-${row.name}`} />
              </span>
            </div>
          )))}
        </div>
      )}
    </TestSection>
  )
}
