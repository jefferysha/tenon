import { useCallback, useState } from 'react'
import type { ChangeHistoryEntry } from '../api/client'
import { useT } from '../i18n'
import { Dialog } from '../shared/Dialog'
import { UnsavedDraftDialog, useDiscardGuard } from '../shared/UnsavedDraftDialog'
import type { LoopsState } from './useLoops'
import { WorkbenchSideRail } from './WorkbenchSideRail'
import { BTN_GHOST, NOTE, SIDE_BODY, SIDE_CARD, SIDE_HEAD, SIDE_HEAD_B, SIDE_ROW, SIDE_ROW_LABEL, SIDE_ROW_VALUE } from './workbenchStyles'

export function WorkbenchGovernanceDialog({ root, loops, summary, recent, recentSilent, onClose, onDirtyChange }: {
  root: string
  loops: LoopsState
  summary: { stages: number; gates: number; skills: number; hooks: number | null } | null
  recent: Array<ChangeHistoryEntry & { change: string }> | null
  recentSilent: number
  onClose: () => void
  onDirtyChange?: (source: 'loop' | 'automation' | 'secrets', dirty: boolean) => void
}): JSX.Element {
  const { t } = useT()
  const [nonce, setNonce] = useState(0)
  const [drafts, setDrafts] = useState({ loop: false, automation: false, secrets: false })
  const [mutations, setMutations] = useState({ loop: false, automation: false, secrets: false })
  const discardGuard = useDiscardGuard()
  const reportDirty = useCallback((source: 'loop' | 'automation' | 'secrets', dirty: boolean) => {
    setDrafts((current) => current[source] === dirty ? current : { ...current, [source]: dirty })
    onDirtyChange?.(source, dirty)
  }, [onDirtyChange])
  const reportBusy = useCallback((source: 'loop' | 'automation' | 'secrets', busy: boolean) => {
    setMutations((current) => current[source] === busy ? current : { ...current, [source]: busy })
  }, [])
  const requestClose = useCallback(() => {
    if (Object.values(mutations).some(Boolean)) return
    discardGuard.request(Object.values(drafts).some(Boolean), onClose)
  }, [discardGuard, drafts, mutations, onClose])
  const mutationBusy = Object.values(mutations).some(Boolean)
  return (
    <>
      <Dialog title={t('workbench.governance_dialog_title')} onClose={requestClose} closeLabel={t('workbench.track_cancel')} closeTestid="wb-governance-close-icon" testid="wb-advanced-orchestration" panelClassName="w-[min(900px,94vw)]" variant="workspace" actions={<button className={BTN_GHOST} data-testid="wb-governance-close-action" disabled={mutationBusy} onClick={requestClose}>{t('workbench.track_cancel')}</button>}>
        <aside className="mx-auto w-full max-w-[820px]" data-testid="wb-side-col">
          <WorkbenchSideRail root={root} loops={loops} rdNonce={nonce} onSecretsChanged={() => setNonce((value) => value + 1)} onDirtyChange={reportDirty} onBusyChange={reportBusy}>
          <div className={SIDE_CARD}>
            <div className={SIDE_HEAD}><b className={SIDE_HEAD_B}>{t('workbench.summary_title')}</b></div>
            <div className={`${SIDE_BODY} divide-y divide-border`}>
              {[
                [t('workbench.sum_stages'), summary?.stages ?? '—', 'wb-sum-stages'],
                [t('workbench.sum_gates'), summary?.gates ?? '—', 'wb-sum-gates'],
                [t('workbench.sum_skills'), summary?.skills ?? '—', 'wb-sum-skills'],
                [t('workbench.sum_hooks'), summary?.hooks ?? '—', 'wb-sum-hooks'],
              ].map(([label, value, testId]) => <div className={SIDE_ROW} key={testId}><span className={SIDE_ROW_LABEL}>{label}</span><span className={SIDE_ROW_VALUE} data-testid={testId}>{value}</span></div>)}
              <div className={SIDE_ROW}><span className={SIDE_ROW_LABEL}>{t('workbench.lp_sum')}</span><span className={SIDE_ROW_VALUE} data-testid="wb-sum-loop">{loops.rows === null ? '—' : loops.selected === null ? t('workbench.lp_sum_none') : t(loops.selected.status === 'active' ? 'workbench.lp_sum_on' : 'workbench.lp_sum_off', { n: loops.selected.budget.runsToday, max: loops.selected.budget_decl.max_runs_per_day })}</span></div>
            </div>
          </div>
          <div className={SIDE_CARD} data-testid="wb-side-safegate"><div className={SIDE_HEAD}><b className={SIDE_HEAD_B}>{t('workbench.sg_title')}</b></div><div className={SIDE_BODY}><p className={NOTE}>{t('workbench.sg_locked_body')}</p><p className={NOTE}>{t('workbench.sg_pending_body')}</p></div></div>
          <div className={SIDE_CARD} data-testid="wb-recent">
            <div className={SIDE_HEAD}><b className={SIDE_HEAD_B}>{t('workbench.recent_title')}</b><span className="ml-auto text-caption font-normal text-text-3">{t('workbench.recent_note')}</span></div>
            <div className={SIDE_BODY}>
              {recent === null && <p className={NOTE} role="status" aria-live="polite">{t('common.loading')}</p>}
              {recent !== null && recent.length === 0 && <p className={NOTE} data-testid="wb-recent-empty" role="status" aria-live="polite">{t('workbench.recent_empty')}</p>}
              {recent !== null && recent.length > 0 && <ul className="flex list-none flex-col gap-2" data-testid="wb-recent-list">{recent.map((entry, index) => <li key={`${entry.change}-${entry.ts}-${index}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-caption leading-[1.45]"><span className="flex-none text-micro text-text-3">{entry.ts.slice(5, 16).replace('T', ' ')}</span><span className="flex-none text-micro text-text-2">{entry.change}</span><span className="text-text">{entry.kind === 'transition' ? `${entry.from ?? '?'} → ${entry.to ?? '?'}` : entry.field ? t('workbench.recent_set', { field: entry.field }) : (entry.raw ?? entry.kind)}</span></li>)}</ul>}
              {recent !== null && recentSilent > 0 && <p className={NOTE} data-testid="wb-recent-legacy">{t('workbench.recent_legacy', { n: recentSilent })}</p>}
            </div>
          </div>
          </WorkbenchSideRail>
        </aside>
      </Dialog>
      <UnsavedDraftDialog
        open={discardGuard.confirmOpen}
        testid="wb-governance-unsaved-draft"
        onStay={discardGuard.stay}
        onDiscard={discardGuard.discard}
      />
    </>
  )
}
