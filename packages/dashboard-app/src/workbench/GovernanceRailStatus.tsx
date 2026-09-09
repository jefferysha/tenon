import type { LoopsState } from './useLoops'
import { GovernanceRailHead } from './GovernanceRailHead'
import { GCARD_TW, RAIL_TW } from './governanceModel'
import { WB_TW } from './loopCardModel'

type Tr = (key: string, vars?: Record<string, string | number>) => string

export function GovernanceRailStatus({
  loops,
  t,
}: {
  loops: LoopsState
  t: Tr
}): JSX.Element | null {
  if (loops.loadError) {
    return (
      <aside className={RAIL_TW} data-testid="wb-gov-rail">
        <GovernanceRailHead />
        <div className={GCARD_TW}>
          <p className={WB_TW.loadError} data-tone="error" data-testid="wb-gov-load-error" role="alert">
            {loops.loadError}
          </p>
        </div>
      </aside>
    )
  }
  if (loops.rows === null) {
    return (
      <aside className={RAIL_TW} data-testid="wb-gov-rail">
        <GovernanceRailHead />
        <div className={GCARD_TW}>
          <p className={WB_TW.loading} role="status" aria-live="polite">{t('common.loading')}</p>
        </div>
      </aside>
    )
  }
  if (!loops.selected) {
    return (
      <aside className={RAIL_TW} data-testid="wb-gov-rail">
        <GovernanceRailHead />
        <div className={GCARD_TW} data-testid="wb-gov-empty" role="status" aria-live="polite">
          <p className="mb-1 text-base font-bold text-text">{t('workbench.lp_empty_title')}</p>
          <p className={WB_TW.note}>{t('workbench.lp_empty_go')}</p>
        </div>
      </aside>
    )
  }
  return null
}
