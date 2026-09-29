import { useT } from '../../i18n'
import { fetchTestRecords } from '../../api/testSystemClient'
import type { RecordSummary } from '../../api/testSystemTypes'
import { StatusPill } from '../../shell/ThreeColumns'
import { Tip } from '../../tests/Tip'
import { TestSection } from '../../tests/TestSection'
import { blockerLabel } from '../../tests/testLabels'
import { formatDuration, formatTime } from '../../tests/testFormat'
import { TABLE_HEAD, TABLE_ROW, gridRow } from '../../tests/testStyles'
import { ResultMark } from '../../tests/TestState'
import { useRemote } from '../../tests/useRemote'
import { LIST_SELECTED } from '../../shared/uiRecipes'
import { cn } from '@/lib/utils'

const COLUMNS = 'grid-cols-[6rem_minmax(0,1fr)_5rem_5rem_minmax(0,1.4fr)]'

/** 历史：这个套件在本任务里的全部运行（新的在前）；点一行换看那次运行。读取失败只藏本段。 */
export function RunHistorySection({ root, change, suite, current, stageLabelOf, onSelect }: {
  root: string
  change: string
  suite: string
  current: string
  /** 阶段 id → 任务冻结工作流里的阶段名；缺省 = 原样显示 id。 */
  stageLabelOf?: (stage: string) => string
  onSelect: (run: RecordSummary) => void
}): JSX.Element | null {
  const { t, lang } = useT()
  const { state } = useRemote((signal) => fetchTestRecords(root, change, suite, signal), [root, change, suite])
  if (state.status !== 'ready') return null
  const runs = state.data.runs
  if (runs.length === 0) return null
  return (
    <TestSection title={t('tests.run.section.history')} count={runs.length} testId="run-history">
      <div role="table" aria-label={t('tests.run.section.history')}>
        <div className={`${gridRow(COLUMNS)} ${TABLE_HEAD}`} role="row">
          <span role="columnheader">{t('tests.run.history.time')}</span>
          <span role="columnheader">{t('tests.word.step')}</span>
          <span role="columnheader">{t('tests.word.result')}</span>
          <span role="columnheader">{t('tests.word.duration')}</span>
          <span role="columnheader">{t('tests.run.field.totals')}</span>
        </div>
        {runs.map((run) => {
          const suiteRun = run.suites.find((item) => item.suite === suite)
          const selected = run.runId === current
          return (
            <div
              key={`${run.user}/${run.runId}`}
              className={cn(gridRow(COLUMNS), TABLE_ROW, 'cursor-pointer hover:bg-fill', selected && LIST_SELECTED)}
              role="row"
              aria-current={selected ? 'true' : undefined}
              data-testid={`run-history-${run.runId}`}
              onClick={() => onSelect(run)}
            >
              <span role="cell">
                <button
                  type="button"
                  className="rounded-xs font-mono text-caption text-text-2 outline-none focus-visible:ring-2 focus-visible:ring-(--accent)"
                  data-testid={`run-history-open-${run.runId}`}
                  onClick={(event) => { event.stopPropagation(); onSelect(run) }}
                >
                  {formatTime(run.finishedAt)}
                </button>
              </span>
              <span className="truncate text-caption text-text-2" role="cell" data-testid={`run-history-step-${run.runId}`}>
                <Tip tip={<span className="font-mono">{run.step}</span>}>{stageLabelOf?.(run.step) ?? run.step}</Tip>
              </span>
              <span role="cell">
                {run.trusted
                  ? <ResultMark result={suiteRun?.result ?? run.result} />
                  : <StatusPill tone="blocked" title={t('tests.run.untrusted_hint')} testId={`run-history-untrusted-${run.runId}`}>{blockerLabel('record-chain-broken', lang)}</StatusPill>}
              </span>
              <span className="font-mono text-caption text-text-2" role="cell">{formatDuration(run.durationMs)}</span>
              <span className="truncate font-mono text-caption text-text-2" role="cell">
                {suiteRun === undefined ? '—' : `${suiteRun.totals.pass}/${suiteRun.totals.cases}`}
              </span>
            </div>
          )
        })}
      </div>
    </TestSection>
  )
}
