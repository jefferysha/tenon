import { useT } from '../i18n'
import { StatusPill } from '../shell/ThreeColumns'
import { TestSection } from '../tests/TestSection'
import { integrityLabel } from '../tests/testLabels'
import { SUBGRID_ROW, TABLE_HEAD, TABLE_ROW, contentTable } from '../tests/testStyles'
import type { IntegrityReport } from '../api/testSystemTypes'

/**
 * 信号 · 对象 · 明细 · 套件 · 策略。信号名、明细（`lines 80 → 60`、`-3 +1`）、套件名、策略词是读这张表的目的，
 * 各按最长的格子定宽（中英文各取各的，不会被截成「lines 80…」）；对象多是路径，是唯一吃剩余宽度的列，
 * 先让位、截断，完整路径在 title。
 */
const COLUMNS = 'grid-cols-[auto_minmax(0,1fr)_auto_auto_auto]'

/**
 * 测试完整性：相对任务起点，证据有没有变弱（用例数、跳过、断言、快照、基线、已知失败、覆盖率门槛）。
 * 一张紧凑的表：信号 · 对象 · 明细 · 套件 · 策略（圆点 + 词：提示 / 阻塞）。没有信号、读得出时整段不出现；
 * 读不出改动行时给一行「未检查」（原因放 Tooltip），文件太多被截断时多一行「截断」。
 */
export function TestsTabIntegrity({ integrity }: { integrity: IntegrityReport | undefined }): JSX.Element | null {
  const { t, lang } = useT()
  if (integrity === undefined) return null
  const { signals, truncated } = integrity
  const unavailable = integrity.state === 'unavailable'
  if (signals.length === 0 && !unavailable && truncated === undefined) return null
  const tone = integrity.mode === 'block' ? 'blocked' : 'neutral'
  const word = t(`tests.task.integrity.${integrity.mode}`)
  const modeCell = (testId: string): JSX.Element => (
    <span role="cell"><StatusPill tone={tone} testId={testId}>{word}</StatusPill></span>
  )
  return (
    <TestSection title={t('tests.task.section.integrity')} count={signals.length} testId="tests-integrity">
      <div role="table" className={contentTable(COLUMNS)} aria-label={t('tests.task.section.integrity')}>
        <div className={`${SUBGRID_ROW} ${TABLE_HEAD}`} role="row">
          <span role="columnheader">{t('tests.task.integrity.signal')}</span>
          <span role="columnheader">{t('tests.task.blockers.subject')}</span>
          <span role="columnheader">{t('tests.task.integrity.detail')}</span>
          <span role="columnheader">{t('tests.word.suite')}</span>
          <span role="columnheader">{t('tests.task.integrity.mode')}</span>
        </div>
        {signals.map((signal, index) => (
          <div
            key={`${signal.code}-${signal.subject}-${index}`}
            className={`${SUBGRID_ROW} ${TABLE_ROW}`}
            role="row"
            data-testid="tests-integrity-row"
            data-code={signal.code}
          >
            <span className={integrity.mode === 'block' ? 'truncate font-semibold text-red-d' : 'truncate text-text'} role="cell" title={signal.code} data-testid="tests-integrity-signal">
              {integrityLabel(signal.code, lang)}
            </span>
            <span className="truncate font-mono text-text-2" role="cell" title={signal.subject}>{signal.subject}</span>
            <span className="truncate font-mono text-text-2" role="cell" title={signal.detail}>{signal.detail}</span>
            <span className="truncate font-mono text-text-2" role="cell" title={signal.suite}>{signal.suite ?? '—'}</span>
            {modeCell('tests-integrity-mode')}
          </div>
        ))}
        {unavailable && (
          <div className={`${SUBGRID_ROW} ${TABLE_ROW}`} role="row" data-testid="tests-integrity-unavailable">
            <span className="truncate text-text-2" role="cell" title={integrity.reason}>{t('tests.task.integrity.unavailable')}</span>
            <span className="text-text-3" role="cell">—</span>
            <span className="text-text-3" role="cell">—</span>
            <span className="text-text-3" role="cell">—</span>
            {modeCell('tests-integrity-unavailable-mode')}
          </div>
        )}
        {truncated !== undefined && (
          <div className={`${SUBGRID_ROW} ${TABLE_ROW}`} role="row" data-testid="tests-integrity-truncated">
            <span className="truncate text-text-2" role="cell">{t('tests.task.integrity.truncated')}</span>
            <span className="text-text-3" role="cell">—</span>
            <span className="truncate font-mono text-text-2" role="cell" title={`${truncated.limit}/${truncated.found}`}>{truncated.limit}/{truncated.found}</span>
            <span className="text-text-3" role="cell">—</span>
            <span role="cell" />
          </div>
        )}
      </div>
    </TestSection>
  )
}
