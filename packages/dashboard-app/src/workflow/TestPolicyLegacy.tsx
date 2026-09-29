import { Info } from 'lucide-react'
import { kindForDirection } from '@tenon/kernel/test-system/vocabulary'
import { useT } from '../i18n'
import type { WbStepTest } from '../api/governanceTypes'
import { shellQuote } from '../shared/shellQuote'
import { FixCommand } from '../tests/FixCommand'
import { KindLabel } from '../tests/KindLabel'
import { TABLE_HEAD, TABLE_ROW, gridRow } from '../tests/testStyles'
import { Hint } from './Hint'

const COLUMNS = 'grid-cols-[minmax(0,1fr)_7rem_minmax(0,1.4fr)_minmax(0,2fr)]'

/** 旧的步骤测试（tests[]）：只读一行一项；行尾给出转成目录套件的可复制命令。 */
export function TestPolicyLegacy({ tests }: { tests: readonly WbStepTest[] }): JSX.Element | null {
  const { t } = useT()
  if (tests.length === 0) return null
  return (
    <div role="table" aria-label={t('tests.policy.legacy.hint')} data-testid="wb-tests">
      <div className={`${gridRow(COLUMNS)} ${TABLE_HEAD}`} role="row">
        <span role="columnheader">{t('tests.policy.legacy.name')}</span>
        <span role="columnheader">{t('tests.policy.legacy.kind')}</span>
        <span role="columnheader">{t('tests.policy.legacy.command')}</span>
        <span role="columnheader">
          <Hint label={t('tests.policy.legacy.hint')}>
            <button type="button" className="grid size-6 place-items-center rounded-sm text-text-3 outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent)" aria-label={t('tests.policy.legacy.hint')} data-testid="wb-tests-legacy-hint">
              <Info className="size-3.5" aria-hidden="true" />
            </button>
          </Hint>
        </span>
      </div>
      {tests.map((test) => (
        <div key={test.id} className={`${gridRow(COLUMNS)} ${TABLE_ROW}`} role="row" data-testid={`wb-test-${test.id}`}>
          <span className="truncate text-text" role="cell" title={test.id}>{test.label ?? test.id}</span>
          <span className="flex min-w-0 items-center text-caption text-text-2" role="cell" data-direction={test.direction}>
            <KindLabel kind={kindForDirection(test.direction)} />
          </span>
          <span className="truncate font-mono text-caption text-text-2" role="cell" title={test.command}>{test.command}</span>
          <span className="min-w-0" role="cell">
            <FixCommand command={`tenon test catalog add --from ${shellQuote(test.direction)}`} testId={`wb-test-convert-${test.id}`} />
          </span>
        </div>
      ))}
    </div>
  )
}
