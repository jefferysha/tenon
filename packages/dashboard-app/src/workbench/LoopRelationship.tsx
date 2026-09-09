import { ArrowRight } from 'lucide-react'
import type { WbLoopRow } from '../api/client'
import { Dialog } from '../shared/Dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { CHIP_TW, WB_TW } from './loopCardModel'

type Tr = (key: string, vars?: Record<string, string | number>) => string

export function LoopRelationship({
  row,
  open,
  onOpen,
  t,
}: {
  row: WbLoopRow
  open: boolean
  onOpen: (open: boolean) => void
  t: Tr
}): JSX.Element {
  const prefix = row.change_prefix ?? t('workbench.lp_rel_prefix_unset')
  return (
    <>
      <div className={WB_TW.sec} data-sec="">
        <div className={WB_TW.secH}>
          {t('workbench.lp_rel_sec')}
          <span className={WB_TW.hint}>{t('workbench.lp_rel_sec_hint')}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2.5" data-testid="lp-rel">
          <span
            className="max-w-[280px] overflow-hidden rounded-sm bg-fill-2 px-2 py-1 font-mono text-caption font-bold text-ellipsis whitespace-nowrap"
            data-testid="lp-rel-root"
            title={row.root}
          >
            {row.root}
          </span>
          <span className="text-micro text-text-3">{t('workbench.lp_rel_root_note')}</span>
          <ArrowRight className="size-3.5 flex-none text-text-3" strokeWidth={1.75} aria-hidden="true" />
          <button
            type="button"
            className="h-[26px] cursor-pointer rounded-full border border-border bg-fill px-2.5 font-mono text-caption text-text-2 transition-colors duration-[120ms] hover:border-(--accent) hover:bg-accent-t hover:text-accent-d"
            data-testid="lp-rel-prefix-btn"
            onClick={() => onOpen(true)}
          >
            {t('workbench.lp_rel_match_btn', { prefix, n: row.matched_changes.length })}
          </button>
          <span className="text-border-2" aria-hidden="true">·</span>
          <span className="text-caption font-semibold text-text-3">{t('workbench.lp_rel_phases_label')}</span>
          {row.phases.length === 0 ? (
            <span className={WB_TW.note} role="status" aria-live="polite">{t('workbench.lp_rel_phases_empty')}</span>
          ) : (
            row.phases.map((phase) => (
              <span key={phase} className={CHIP_TW} data-testid="lp-rel-phase-chip">{phase}</span>
            ))
          )}
          <p className={cn(WB_TW.note, 'mt-1 basis-full')}>{t('workbench.lp_rel_note')}</p>
        </div>
      </div>
      {open && (
        <Dialog
          title={t('workbench.lp_rel_dialog_title', { prefix })}
          onClose={() => onOpen(false)}
          testid="lp-rel-dialog"
          actions={
            <Button variant="ghost" size="sm" className={WB_TW.btnGhost} onClick={() => onOpen(false)}>
              {t('workbench.lp_rel_dialog_close')}
            </Button>
          }
        >
          {row.matched_changes.length === 0 ? (
            <p className="mb-4 text-caption leading-[1.6] text-text-2" role="status" aria-live="polite">{t('workbench.lp_rel_dialog_empty')}</p>
          ) : (
            <ul className="flex max-h-80 list-none flex-col gap-1.5 overflow-y-auto p-0 text-caption" data-testid="lp-rel-dialog-list">
              {row.matched_changes.map((change) => (
                <li key={change} className="font-mono">{change}</li>
              ))}
            </ul>
          )}
        </Dialog>
      )}
    </>
  )
}
