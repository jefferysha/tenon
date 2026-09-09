import { Check, CircleAlert, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { WbLoopRow } from '../api/client'
import { useT } from '../i18n'
import { Dialog } from '../shared/Dialog'
import { ERR_BLOCK_TW, WB_TW } from './loopCardModel'

type Level = 'L1' | 'L2' | 'L3'

export function LoopCardActions({
  row,
  pendingReview,
  reviewBusy,
  actionDisabled,
  reviewError,
  confirmLevel,
  onReview,
  onClosePromotion,
  onConfirmPromotion,
}: {
  row: WbLoopRow
  pendingReview: boolean
  reviewBusy: boolean
  actionDisabled: boolean
  reviewError: string | null
  confirmLevel: Level | null
  onReview: (status: 'active' | 'paused') => void
  onClosePromotion: () => void
  onConfirmPromotion: (level: Level) => void
}): JSX.Element {
  const { t } = useT()
  return <>
    {pendingReview && (
      <div className="mt-4 flex flex-wrap items-center gap-2.5 border-t border-border pt-3.5" data-testid="lp-draft-actions">
        <Button size="sm" className="border border-accent-b bg-accent-t px-4 text-caption font-bold text-accent-d" data-testid="lp-draft-approve" disabled={reviewBusy || actionDisabled} title={actionDisabled ? t('workbench.lp_action_dirty') : undefined} onClick={() => onReview('active')}>
          <Check className="size-3.5" aria-hidden="true" /> {t('workbench.lp_draft_approve')}
        </Button>
        <Button size="sm" className="border border-red-b bg-red-t px-4 text-caption font-bold text-red-d" data-testid="lp-draft-reject" disabled={reviewBusy || actionDisabled} title={actionDisabled ? t('workbench.lp_action_dirty') : undefined} onClick={() => onReview('paused')}>
          <X className="size-3.5" aria-hidden="true" /> {t('workbench.lp_draft_reject')}
        </Button>
        {reviewError && <p className={cn(ERR_BLOCK_TW, 'mt-0.5 basis-full')} data-tone="error" data-testid="lp-draft-error" role="alert"><CircleAlert className="mr-1 inline size-3.5" aria-hidden="true" />{reviewError}</p>}
      </div>
    )}
    {confirmLevel !== null && (
      <Dialog
        title={t('loops.promote_confirm_title', { level: confirmLevel })}
        onClose={onClosePromotion}
        testid="lp-promote-confirm"
        actions={<>
          <Button variant="ghost" size="sm" className={WB_TW.btnGhost} data-testid="lp-promote-cancel" onClick={onClosePromotion}>{t('loops.promote_confirm_no')}</Button>
          <Button size="sm" className={WB_TW.btnSolid} data-testid="lp-promote-submit" disabled={actionDisabled} onClick={() => onConfirmPromotion(confirmLevel)}>{t('loops.promote_confirm_yes')}</Button>
        </>}
      >
        <p className="mb-4 text-caption leading-[1.6] text-text-2">
          {t('loops.promote_confirm_desc', {
            band: row.readiness.band,
            budget: row.budget.hasBudget
              ? t('loops.budget_summary', { spent: row.budget.spentToday, max: row.budget.maxTokensPerDay ?? 0, remaining: row.budget.remaining ?? 0 })
              : t('loops.no_budget'),
            level: confirmLevel,
          })}
        </p>
      </Dialog>
    )}
  </>
}
