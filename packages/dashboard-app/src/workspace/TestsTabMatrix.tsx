import { useT } from '../i18n'
import { StatusPill } from '../shell/ThreeColumns'
import { Hint } from '../workflow/Hint'
import { FixCommand } from '../tests/FixCommand'
import { KindIcon } from '../tests/KindIcon'
import { SuiteStateMark } from '../tests/TestState'
import { TestSection } from '../tests/TestSection'
import { blockerLabel } from '../tests/testLabels'
import { dataMessage } from '../tests/testText'
import { TABLE_HEAD, TABLE_ROW, gridRow } from '../tests/testStyles'
import { LIST_SELECTED } from '../shared/uiRecipes'
import { cn } from '@/lib/utils'
import type { MatrixRow, MatrixSuite } from './testsTabModel'

const COLUMNS = 'grid-cols-[minmax(0,1fr)_5rem_minmax(0,1.6fr)_6rem_minmax(0,2.4fr)]'

function SuiteCell({ row, openable, activeSuite, onOpen }: {
  row: MatrixRow
  openable: (suite: MatrixSuite) => boolean
  activeSuite: string | null
  onOpen: (suite: string) => void
}): JSX.Element {
  const { t } = useT()
  const waiver = row.waiver
  return (
    <span className="flex min-w-0 flex-nowrap items-center gap-3 overflow-hidden" role="cell" data-testid={`tests-registered-${row.kind}`}>
      {row.suites.map((suite) => (openable(suite)
        ? (
          <button
            key={suite.suite}
            type="button"
            className={cn('min-w-0 max-w-full truncate rounded-xs px-0.5 text-left font-semibold text-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-(--accent)', activeSuite === suite.suite && LIST_SELECTED)}
            aria-pressed={activeSuite === suite.suite}
            title={suite.suite}
            data-testid={`tests-suite-${suite.suite}`}
            onClick={() => onOpen(suite.suite)}
          >
            {suite.name}
          </button>
        )
        : <span key={suite.suite} className="min-w-0 truncate text-text-2" title={suite.suite} data-testid={`tests-suite-${suite.suite}`}>{suite.name}</span>))}
      {waiver !== null && (
        <span className="flex flex-none items-center gap-1.5 whitespace-nowrap text-text-2" data-testid={`tests-waiver-${row.kind}`}>
          {t('tests.word.waiver')}
          <StatusPill tone={waiver.approved ? 'done' : 'pending'}>{t(`tests.task.waiver.${waiver.approved ? 'approved' : 'pending'}`)}</StatusPill>
        </span>
      )}
      {row.suites.length === 0 && waiver === null && <span className="text-text-3">—</span>}
    </span>
  )
}

/** 策略矩阵：要求的种类 × 是否登记 × 最近结果；缺项直接给短标签和可复制的修复命令。 */
export function TestsTabMatrix({ rows, openable, activeSuite, onOpen }: {
  rows: readonly MatrixRow[]
  openable: (suite: MatrixSuite) => boolean
  activeSuite: string | null
  onOpen: (suite: string) => void
}): JSX.Element | null {
  const { t, lang } = useT()
  if (rows.length === 0) return null
  return (
    <TestSection title={t('tests.task.section.matrix')} count={rows.length} testId="tests-matrix">
      <div role="table" aria-label={t('tests.task.section.matrix')}>
        <div className={`${gridRow(COLUMNS)} ${TABLE_HEAD}`} role="row" data-testid="tests-matrix-head">
          <span role="columnheader">{t('tests.word.kind')}</span>
          <span role="columnheader">{t('tests.task.matrix.requirement')}</span>
          <span role="columnheader">{t('tests.task.matrix.registered')}</span>
          <span role="columnheader">{t('tests.task.matrix.result')}</span>
          <span role="columnheader">{t('tests.task.matrix.blocker')}</span>
        </div>
        {rows.map((row) => (
          <div key={row.kind} className={`${gridRow(COLUMNS)} ${TABLE_ROW}`} role="row" data-testid={`tests-kind-${row.kind}`} data-met={row.met}>
            <span className="flex min-w-0 items-center gap-2" role="cell">
              <KindIcon kind={row.kind} />
              <span className="truncate font-mono text-text" title={row.kind}>{row.kind}</span>
            </span>
            <span role="cell">
              <Hint label={t(`tests.task.requirement_hint.${row.requirement.replace('-', '_')}`)}>
                <button type="button" className="whitespace-nowrap rounded-xs text-text-2 outline-none focus-visible:ring-2 focus-visible:ring-(--accent)" data-testid={`tests-requirement-${row.kind}`}>
                  {t(`tests.task.requirement.${row.requirement.replace('-', '_')}`)}
                </button>
              </Hint>
            </span>
            <SuiteCell row={row} openable={openable} activeSuite={activeSuite} onOpen={onOpen} />
            <span role="cell" data-testid={`tests-result-${row.kind}`}>
              {row.result === null ? <span className="text-text-3">—</span> : <SuiteStateMark state={row.result} />}
            </span>
            <span className="flex min-w-0 items-center gap-2" role="cell" data-testid={`tests-blocker-${row.kind}`}>
              {row.blocker !== null && (
                <>
                  <span className="flex-none whitespace-nowrap text-body font-semibold text-red-d" title={dataMessage(row.blocker)} data-testid={`tests-blocker-label-${row.kind}`}>
                    {blockerLabel(row.blocker.code, lang)}
                  </span>
                  {row.blocker.fix !== undefined && <FixCommand command={row.blocker.fix} testId={`tests-fix-${row.kind}`} />}
                </>
              )}
            </span>
          </div>
        ))}
      </div>
    </TestSection>
  )
}
