import { TriangleAlert } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import { useT } from '../i18n'
import { cn } from '@/lib/utils'
import { LOOP_RUNNERS, ProvBadge, WB_TW, type LoopDraft } from './loopCardModel'

interface LoopGoalFieldsProps {
  draft: LoopDraft
  onEdit: (part: Partial<LoopDraft>) => void
}

export function LoopGoalFields({ draft, onEdit }: LoopGoalFieldsProps): JSX.Element {
  const { t } = useT()
  const customRunner = !(LOOP_RUNNERS as readonly string[]).includes(draft.runner)
  const preventSubmit = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') event.preventDefault()
  }

  return (
    <div className={WB_TW.sec} data-sec="">
      <div className={WB_TW.secH}>
        {t('workbench.lp_sec_goal')}
        <span className={WB_TW.hint}>{t('workbench.lp_sec_goal_hint')}</span>
      </div>
      <div className="mb-1 flex items-center gap-2">
        <label className={WB_TW.flabel} htmlFor="lp-goal">{t('workbench.lp_goal')}</label>
        <ProvBadge field="goal" />
      </div>
      <input
        className={WB_TW.input}
        id="lp-goal"
        name="loop-goal"
        autoComplete="off"
        data-testid="lp-goal"
        value={draft.goal}
        onChange={(event) => onEdit({ goal: event.target.value })}
        onKeyDown={preventSubmit}
      />
      <div className="mt-3 grid grid-cols-3 gap-3.5 mobile:grid-cols-1">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <label className={WB_TW.flabel} htmlFor="lp-doc">{t('workbench.lp_doc')}</label>
            <ProvBadge field="design_doc" />
          </div>
          <input
            className={cn(WB_TW.input, 'font-mono')}
            id="lp-doc"
            name="loop-design-doc"
            autoComplete="off"
            data-testid="lp-doc"
            value={draft.design_doc}
            onChange={(event) => onEdit({ design_doc: event.target.value })}
            onKeyDown={preventSubmit}
          />
        </div>
        <div>
          <div className="mb-1 flex items-center gap-2">
            <label className={WB_TW.flabel} htmlFor="lp-prefix">{t('workbench.lp_prefix')}</label>
            <ProvBadge field="change_prefix" />
          </div>
          <input
            className={cn(WB_TW.input, 'font-mono')}
            id="lp-prefix"
            name="loop-change-prefix"
            autoComplete="off"
            data-testid="lp-prefix"
            value={draft.change_prefix}
            onChange={(event) => onEdit({ change_prefix: event.target.value })}
            onKeyDown={preventSubmit}
          />
          <p className="mt-1 text-micro text-text-3">
            {t('workbench.lp_prefix_eg')}
            <b className="font-mono font-semibold text-text-2" data-testid="lp-prefix-eg">{`${draft.change_prefix}0142-migrate-card`}</b>
          </p>
        </div>
        <div>
          <div className="mb-1 flex items-center gap-2">
            <label className={WB_TW.flabel} htmlFor="lp-risk">{t('workbench.lp_risk')}</label>
            <ProvBadge field="risk" />
          </div>
          <select
            className={WB_TW.input}
            id="lp-risk"
            name="loop-risk"
            data-testid="lp-risk"
            value={draft.risk}
            onChange={(event) => onEdit({ risk: event.target.value })}
          >
            <option value="low">{t('workbench.lp_risk_low')}</option>
            <option value="medium">{t('workbench.lp_risk_medium')}</option>
            <option value="high">{t('workbench.lp_risk_high')}</option>
          </select>
        </div>
        <div>
          <div className="mb-1 flex items-center gap-2">
            <label className={WB_TW.flabel} htmlFor="lp-runner">{t('workbench.lp_runner')}</label>
            <ProvBadge field="runner" />
          </div>
          <select
            className={cn(WB_TW.input, 'font-mono')}
            id="lp-runner"
            name="loop-runner"
            data-testid="lp-runner"
            value={draft.runner}
            onChange={(event) => onEdit({ runner: event.target.value })}
          >
            {customRunner && <option value={draft.runner}>{draft.runner}</option>}
            {LOOP_RUNNERS.map((runner) => <option key={runner} value={runner}>{runner}</option>)}
          </select>
          {customRunner && (
            <p className="mt-1 flex items-start gap-1.5 text-caption leading-[1.55] text-[color-mix(in_srgb,var(--red)_68%,var(--text-2))]" data-testid="lp-runner-warn">
              <TriangleAlert className="mt-0.5 size-3.5 flex-none" aria-hidden="true" />
              {t('workbench.lp_runner_warn', { runner: draft.runner })}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
