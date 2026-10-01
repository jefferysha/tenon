import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useT } from '../i18n'
import { CountRoll } from '../shared/CountRoll'
import { StatusPill, type PillTone } from '../shell/ThreeColumns'
import { FixCommand } from '../tests/FixCommand'
import { TestSection } from '../tests/TestSection'
import { blockerLabel, kindLabel, noticeLabel } from '../tests/testLabels'
import { dataMessage } from '../tests/testText'
import { COUNT_BADGE, SUBGRID_ROW, TABLE_HEAD, TABLE_ROW, contentTable, gridRow } from '../tests/testStyles'
import type { PolicyReport, TestBlocker, TestNotice, TraceRow } from '../api/testSystemTypes'
import { traceLabel, traceNeedsMapping, traceRows, type FileRow } from './testsTabModel'

/** 文件 · 套件 · 阻塞短标签（按内容定宽，中英文各取各的）· 修复命令；文件路径与命令吃剩余宽度并截断。 */
const FILE_COLUMNS = 'grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_auto_minmax(0,2fr)]'

/** 未登记文件：置顶于矩阵之上；每行带阻塞短标签与登记命令（孤儿文件没有命令）。 */
export function TestsTabFiles({ rows }: { rows: readonly FileRow[] }): JSX.Element | null {
  const { t, lang } = useT()
  if (rows.length === 0) return null
  return (
    <TestSection title={t('tests.task.section.files')} count={rows.length} testId="tests-files">
      <div role="table" className={contentTable(FILE_COLUMNS)} aria-label={t('tests.task.section.files')}>
        <div className={`${SUBGRID_ROW} ${TABLE_HEAD}`} role="row">
          <span role="columnheader">{t('tests.word.file')}</span>
          <span role="columnheader">{t('tests.word.suite')}</span>
          <span role="columnheader">{t('tests.task.blockers.label')}</span>
          <span role="columnheader">{t('tests.task.blockers.fix')}</span>
        </div>
        {rows.map((row) => (
          <div key={row.path} className={`${SUBGRID_ROW} ${TABLE_ROW}`} role="row" data-testid={`tests-file-${row.path}`} data-orphan={row.orphan}>
            <span className="truncate font-mono text-text" role="cell" title={row.path}>{row.path}</span>
            <span className="truncate font-mono text-text-2" role="cell" title={row.suites.join(', ')}>{row.suites.length === 0 ? '—' : row.suites.join(', ')}</span>
            <span className="truncate font-semibold text-red-d" role="cell" title={row.blocker === undefined ? t('tests.task.files.orphan_hint') : dataMessage(row.blocker)}>
              {blockerLabel(row.blocker?.code ?? (row.orphan ? 'test-file-orphan' : 'test-file-unregistered'), lang)}
            </span>
            <span className="min-w-0" role="cell">
              {row.blocker?.fix === undefined ? <span className="text-text-3">—</span> : <FixCommand command={row.blocker.fix} testId={`tests-file-fix-${row.path}`} />}
            </span>
          </div>
        ))}
      </div>
    </TestSection>
  )
}

/** 短标签（按内容定宽：英文最长的 Config change unapproved 也完整）· 对象 · 修复命令；对象与命令吃剩余宽度并截断。 */
const BLOCKER_COLUMNS = 'grid-cols-[auto_minmax(0,1fr)_minmax(0,2fr)]'

/** 阻塞：没被矩阵行、文件表用上的真阻塞（`blocking: true`）。提示不进这张表，也不计入这里的数。 */
export function TestsTabBlockers({ items }: { items: readonly TestBlocker[] }): JSX.Element | null {
  const { t, lang } = useT()
  if (items.length === 0) return null
  return (
    <TestSection title={t('tests.task.section.blockers')} count={items.length} testId="tests-blockers">
      <div role="table" className={contentTable(BLOCKER_COLUMNS)} aria-label={t('tests.task.section.blockers')}>
        <div className={`${SUBGRID_ROW} ${TABLE_HEAD}`} role="row">
          <span role="columnheader">{t('tests.task.blockers.label')}</span>
          <span role="columnheader">{t('tests.task.blockers.subject')}</span>
          <span role="columnheader">{t('tests.task.blockers.fix')}</span>
        </div>
        {items.map((item, index) => (
          <div key={`${item.code}-${item.subject ?? ''}-${index}`} className={`${SUBGRID_ROW} ${TABLE_ROW}`} role="row" data-testid="tests-blocker">
            <span className="truncate font-semibold text-red-d" role="cell" title={dataMessage(item)} data-testid="tests-blocker-code">
              {blockerLabel(item.code, lang)}
            </span>
            <span className="truncate font-mono text-text-2" role="cell" title={item.subject}>{item.subject === undefined ? '—' : kindLabel(item.subject, t)}</span>
            <span className="min-w-0" role="cell">
              {item.fix === undefined ? <span className="text-text-3">—</span> : <FixCommand command={item.fix} testId={`tests-blocker-fix-${index}`} />}
            </span>
          </div>
        ))}
      </div>
    </TestSection>
  )
}

/** 提示：中性信息（已修好的已知失败、基准波动、映射失效…），与阻塞分开成段、分开计数。 */
export function TestsTabNotices({ items }: { items: readonly TestNotice[] }): JSX.Element | null {
  const { t, lang } = useT()
  if (items.length === 0) return null
  return (
    <TestSection title={t('tests.task.section.notices')} count={items.length} testId="tests-notices">
      <div role="table" className={contentTable(BLOCKER_COLUMNS)} aria-label={t('tests.task.section.notices')}>
        <div className={`${SUBGRID_ROW} ${TABLE_HEAD}`} role="row">
          <span role="columnheader">{t('tests.task.blockers.notice')}</span>
          <span role="columnheader">{t('tests.task.blockers.subject')}</span>
          <span role="columnheader">{t('tests.task.blockers.fix')}</span>
        </div>
        {items.map((item, index) => (
          <div key={`${item.code}-${item.subject ?? ''}-${index}`} className={`${SUBGRID_ROW} ${TABLE_ROW}`} role="row" data-testid="tests-notice">
            <span className="truncate text-text-2" role="cell" title={dataMessage(item)} data-testid="tests-notice-code">{noticeLabel(item.code, lang)}</span>
            <span className="truncate font-mono text-text-2" role="cell" title={item.subject}>{item.subject === undefined ? '—' : kindLabel(item.subject, t)}</span>
            <span className="min-w-0" role="cell">
              {item.fix === undefined ? <span className="text-text-3">—</span> : <FixCommand command={item.fix} testId={`tests-notice-fix-${index}`} />}
            </span>
          </div>
        ))}
      </div>
    </TestSection>
  )
}

const TRACE_COLUMNS = 'grid-cols-[minmax(0,1.4fr)_minmax(0,2fr)_6.5rem]'
const SHOWN_REFS = 2

function traceTone(report: PolicyReport, row: TraceRow): PillTone {
  switch (row.state) {
    case 'passing': return 'done'
    case 'failing': return 'blocked'
    case 'uncovered': return traceNeedsMapping(report, row) ? 'blocked' : 'neutral'
    case 'mapped': return 'pending'
    case 'waived': return row.waiver?.approved === false ? 'pending' : 'neutral'
  }
}

function TraceLine({ report, row, stageLabelOf }: { report: PolicyReport; row: TraceRow; stageLabelOf: (stage: string) => string }): JSX.Element {
  const { t } = useT()
  const refs = row.tests.map((test) => test.ref)
  const label = traceLabel(row, stageLabelOf)
  return (
    <div className={`${gridRow(TRACE_COLUMNS)} ${TABLE_ROW}`} role="row" data-testid={`tests-trace-${row.covers}`} data-state={row.state}>
      <span className="truncate whitespace-nowrap text-text" role="cell" title={label} data-testid="tests-trace-title">{label}</span>
      <span className="flex min-w-0 flex-nowrap items-center gap-2" role="cell" title={refs.join('\n')} data-testid="tests-trace-cases">
        {refs.length === 0 && <span className="text-text-3">—</span>}
        {refs.slice(0, SHOWN_REFS).map((ref) => <span key={ref} className="min-w-0 truncate font-mono text-caption text-text-2">{ref}</span>)}
        {refs.length > SHOWN_REFS && <span className={COUNT_BADGE} data-testid="tests-trace-more">+{refs.length - SHOWN_REFS}</span>}
      </span>
      <span role="cell">
        <StatusPill tone={traceTone(report, row)} testId={`tests-trace-state-${row.covers}`}>
          {row.state === 'waived' ? t('tests.word.waiver') : row.state === 'uncovered' && !row.required ? t('tests.task.trace.optional') : t(`tests.task.trace.${row.state}`)}
        </StatusPill>
      </span>
    </div>
  )
}

/**
 * 场景/任务追溯：场景或任务条目 · 映射的用例 · 结果。失败排最前；没有映射也不要求映射的骨架任务
 * 合并成表尾一行「N 可选」，点开才逐条列出（默认收起，不用七行一样的「将本阶段目标拆成…」占满页面）。
 */
export function TestsTabTrace({ report, stageLabelOf }: { report: PolicyReport; stageLabelOf: (stage: string) => string }): JSX.Element | null {
  const { t } = useT()
  const [showOptional, setShowOptional] = useState(false)
  if (report.trace.length === 0) return null
  const { shown, optional } = traceRows(report)
  const Chevron = showOptional ? ChevronDown : ChevronRight
  return (
    <TestSection title={t('tests.task.section.trace')} count={report.trace.length} testId="tests-trace">
      <div role="table" aria-label={t('tests.task.section.trace')}>
        <div className={`${gridRow(TRACE_COLUMNS)} ${TABLE_HEAD}`} role="row">
          <span role="columnheader">{t('tests.word.scenario')}</span>
          <span role="columnheader">{t('tests.word.case')}</span>
          <span role="columnheader">{t('tests.word.result')}</span>
        </div>
        {shown.map((row) => <TraceLine key={row.covers} report={report} row={row} stageLabelOf={stageLabelOf} />)}
        {optional.length > 0 && (
          <div role="row" className={TABLE_ROW} data-testid="tests-trace-optional">
            <div role="cell">
              <button
                type="button"
                className="flex min-h-10 w-full items-center gap-2 rounded-xs text-left text-text-2 outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent)"
                aria-expanded={showOptional}
                data-testid="tests-trace-optional-toggle"
                onClick={() => setShowOptional((value) => !value)}
              >
                <Chevron className="size-4 flex-none text-text-3" aria-hidden="true" />
                <span className="tabular-nums"><CountRoll value={optional.length} /> {t('tests.task.trace.optional')}</span>
              </button>
            </div>
          </div>
        )}
        {showOptional && optional.map((row) => <TraceLine key={row.covers} report={report} row={row} stageLabelOf={stageLabelOf} />)}
      </div>
    </TestSection>
  )
}
