import { useT } from '../i18n'
import type { OperationMutationKind } from './useOperationMutationIdentity'
import { operationButton, operationCard, operationInput } from './operationsPresentation'

interface OperationTriageCardProps {
  rootReady: boolean
  busy: OperationMutationKind | null
  source: 'git-commits' | 'loop-run-terminals'
  model: string
  confirmed: boolean
  onSourceChange: (source: 'git-commits' | 'loop-run-terminals') => void
  onModelChange: (model: string) => void
  onConfirmChange: (confirmed: boolean) => void
  onSubmit: () => void
}

export function OperationTriageCard(props: OperationTriageCardProps): JSX.Element {
  const { t } = useT()
  return (
    <article className={operationCard}>
      <h3 className="font-bold text-text">{t('operations.triage_title')}</h3>
      <p className="mt-1 text-caption text-text-3">{t('operations.triage_note')}</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <select name="triage-source" aria-label={t('operations.triage_source')} className={operationInput} data-testid="ops-triage-source" value={props.source} onChange={(event) => {
          const source = event.target.value
          if (source === 'git-commits' || source === 'loop-run-terminals') props.onSourceChange(source)
        }}>
          <option value="git-commits">git-commits</option><option value="loop-run-terminals">loop-run-terminals</option>
        </select>
        <input className={operationInput} aria-label={t('operations.triage_model')} data-testid="ops-triage-model" name="triage-model" autoComplete="off" value={props.model} onChange={(event) => props.onModelChange(event.target.value)} placeholder={t('operations.model_default')} />
      </div>
      <label className="mt-3 flex items-start gap-2 text-caption text-text-2"><input name="confirm-triage" className="mt-0.5" type="checkbox" data-testid="ops-confirm-triage" checked={props.confirmed} onChange={(event) => props.onConfirmChange(event.target.checked)} />{t('operations.triage_confirm')}</label>
      <button type="button" className={`${operationButton} mt-3`} data-testid="ops-triage-submit" disabled={!props.rootReady || props.busy !== null || !props.confirmed} onClick={props.onSubmit}>
        {props.busy === 'triage' ? t('operations.running') : t('operations.triage_run')}
      </button>
    </article>
  )
}
