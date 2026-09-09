import type { WbLoopRow } from '../api/client'
import { useT } from '../i18n'
import { Dialog } from '../shared/Dialog'
import { Button } from '@/components/ui/button'
import { WB_TW } from './LoopCard'
import type { GovernanceLevel } from './governanceModel'

export function GovernancePromoteDialog({
  target,
  row,
  bandText,
  onClose,
  onConfirm,
}: {
  target: GovernanceLevel
  row: WbLoopRow
  bandText: string
  onClose: () => void
  onConfirm: (target: GovernanceLevel) => void
}): JSX.Element {
  const { t } = useT()
  return (
    <Dialog
      title={t('loops.promote_confirm_title', { level: target })}
      onClose={onClose}
      testid="wb-gov-promote-confirm"
      actions={<>
        <Button variant="ghost" size="sm" className={WB_TW.btnGhost} data-testid="wb-gov-promote-cancel" onClick={onClose}>
          {t('loops.promote_confirm_no')}
        </Button>
        <Button size="sm" className={WB_TW.btnSolid} data-testid="wb-gov-promote-ok" onClick={() => onConfirm(target)}>
          {t('loops.promote_confirm_yes')}
        </Button>
      </>}
    >
      <p className="mb-4 text-caption leading-[1.6] text-text-2">
        {t('loops.promote_confirm_desc', {
          band: bandText,
          budget: row.budget?.hasBudget
            ? t('loops.budget_summary', {
                spent: row.budget.spentToday,
                max: row.budget.maxTokensPerDay ?? 0,
                remaining: row.budget.remaining ?? 0,
              })
            : t('loops.no_budget'),
          level: target,
        })}
      </p>
    </Dialog>
  )
}
