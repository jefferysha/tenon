import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useT } from '../i18n'
import { StatusPill } from '../shell/ThreeColumns'
import { Hint } from '../workflow/Hint'
import { FixCommand } from '../tests/FixCommand'
import { KindLabel } from '../tests/KindLabel'
import { SuiteStateMark } from '../tests/TestState'
import { TestSection } from '../tests/TestSection'
import { blockerLabel } from '../tests/testLabels'
import { dataMessage } from '../tests/testText'
import { TABLE_HEAD, gridRow } from '../tests/testStyles'
import { LIST_SELECTED } from '../shared/uiRecipes'
import { cn } from '@/lib/utils'
import type { MatrixRow, MatrixSuite } from './testsTabModel'

const COLUMNS = 'grid-cols-[minmax(0,1fr)_5rem_minmax(0,1.6fr)_6rem_minmax(0,2.4fr)]'
/** 说明浮层不换行，原因再长也不撑出视口：超过这个长度截断（原文留在目录文件里）。 */
const MAX_REASON_CHARS = 160

function brief(reason: string): string {
  return reason.length > MAX_REASON_CHARS ? `${reason.slice(0, MAX_REASON_CHARS - 1)}…` : reason
}

/** 目录声明的「本项目不适用」：原因收在 Tooltip 里；未批准的另标「待批准」。 */
function NotApplicableMark({ kind, entry }: { kind: string; entry: { reason: string; approved: boolean } }): JSX.Element {
  const { t } = useT()
  return (
    <span className="flex flex-none items-center gap-1.5 whitespace-nowrap text-text-2" data-testid={`tests-na-${kind}`} data-approved={entry.approved}>
      <Hint label={brief(entry.reason)}>
        <button type="button" className="whitespace-nowrap rounded-xs text-text-2 outline-none focus-visible:ring-2 focus-visible:ring-(--accent)" data-testid={`tests-na-label-${kind}`}>
          {t('tests.word.not_applicable')}
        </button>
      </Hint>
      {!entry.approved && <StatusPill tone="pending">{t('tests.task.waiver.pending')}</StatusPill>}
    </span>
  )
}

function SuiteCell({ row, openable, activeSuite, onOpen }: {
  row: MatrixRow
  openable: (suite: MatrixSuite) => boolean
  activeSuite: string | null
  onOpen: (suite: string) => void
}): JSX.Element {
  const { t } = useT()
  const waiver = row.waiver
  const notApplicable = row.notApplicable
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
      {notApplicable !== null && <NotApplicableMark kind={row.kind} entry={notApplicable} />}
      {waiver !== null && (
        <span className="flex flex-none items-center gap-1.5 whitespace-nowrap text-text-2" data-testid={`tests-waiver-${row.kind}`}>
          {t('tests.word.waiver')}
          <StatusPill tone={waiver.approved ? 'done' : 'pending'}>{t(`tests.task.waiver.${waiver.approved ? 'approved' : 'pending'}`)}</StatusPill>
        </span>
      )}
      {row.suites.length === 0 && waiver === null && notApplicable === null && <span className="text-text-3">—</span>}
    </span>
  )
}

/**
 * 一行 = 一个种类。缺项只写短标签（红字）；修复命令收进行展开——点标签旁的箭头才在行下显示可复制的命令，
 * 表里不再堆截断的命令。
 */
function MatrixRowView({ row, openable, activeSuite, onOpen }: {
  row: MatrixRow
  openable: (suite: MatrixSuite) => boolean
  activeSuite: string | null
  onOpen: (suite: string) => void
}): JSX.Element {
  const { t, lang } = useT()
  const [open, setOpen] = useState(false)
  const fix = row.blocker?.fix
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <div className="border-b border-border last:border-0" role="rowgroup" data-testid={`tests-group-${row.kind}`}>
      <div className={`${gridRow(COLUMNS)} min-h-10 px-1 py-1 text-body`} role="row" data-testid={`tests-kind-${row.kind}`} data-met={row.met}>
        <span className="flex min-w-0 items-center text-text" role="cell">
          <KindLabel kind={row.kind} testId={`tests-kind-label-${row.kind}`} />
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
        <span className="flex min-w-0 items-center gap-1" role="cell" data-testid={`tests-blocker-${row.kind}`}>
          {row.blocker !== null && (
            <>
              <span className="min-w-0 truncate whitespace-nowrap text-body font-semibold text-red-d" title={dataMessage(row.blocker)} data-testid={`tests-blocker-label-${row.kind}`}>
                {blockerLabel(row.blocker.code, lang)}
              </span>
              {fix !== undefined && (
                <button
                  type="button"
                  className="relative grid size-8 flex-none place-items-center rounded-sm text-text-3 outline-none after:absolute after:-inset-1 after:content-[''] hover:bg-fill-2 hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent)"
                  aria-expanded={open}
                  aria-label={t(open ? 'tests.task.matrix.fix_hide' : 'tests.task.matrix.fix_show')}
                  title={t(open ? 'tests.task.matrix.fix_hide' : 'tests.task.matrix.fix_show')}
                  data-testid={`tests-fix-toggle-${row.kind}`}
                  onClick={() => setOpen((value) => !value)}
                >
                  <Chevron className="size-4" aria-hidden="true" />
                </button>
              )}
            </>
          )}
        </span>
      </div>
      {fix !== undefined && open && (
        <div className="min-w-0 px-1 pb-2" role="row" data-testid={`tests-fix-row-${row.kind}`}>
          <span className="block min-w-0 rounded-sm bg-(--code-bg) pl-3" role="cell">
            <FixCommand command={fix} testId={`tests-fix-${row.kind}`} />
          </span>
        </div>
      )}
    </div>
  )
}

/** 策略矩阵：要求的种类 × 是否登记 × 最近结果；缺项给短标签，可复制的修复命令收在行展开里。 */
export function TestsTabMatrix({ rows, openable, activeSuite, onOpen }: {
  rows: readonly MatrixRow[]
  openable: (suite: MatrixSuite) => boolean
  activeSuite: string | null
  onOpen: (suite: string) => void
}): JSX.Element | null {
  const { t } = useT()
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
        {rows.map((row) => <MatrixRowView key={row.kind} row={row} openable={openable} activeSuite={activeSuite} onOpen={onOpen} />)}
      </div>
    </TestSection>
  )
}
