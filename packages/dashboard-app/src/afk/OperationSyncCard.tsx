import { useT } from '../i18n'
import type { OperationMutationKind } from './useOperationMutationIdentity'
import { operationButton, operationCard, operationInput } from './operationsPresentation'

interface OperationSyncCardProps {
  rootReady: boolean
  busy: OperationMutationKind | null
  selectorReady: boolean
  mode: 'dry-run' | 'apply'
  confirmed: boolean
  onModeChange: (mode: 'dry-run' | 'apply') => void
  onConfirmChange: (confirmed: boolean) => void
  onSubmit: () => void
}

export function OperationSyncCard(props: OperationSyncCardProps): JSX.Element {
  const { t } = useT()
  const ready = props.mode === 'dry-run' || props.confirmed
  return (
    <article className={operationCard}>
      <h3 className="font-bold text-text">{t('operations.sync_title')}</h3>
      <p className="mt-1 text-caption text-text-3">{t('operations.sync_note')}</p>
      <div className="mt-3 flex gap-2">
        <select name="sync-mode" aria-label={t('operations.sync_mode')} className={operationInput} data-testid="ops-sync-mode" value={props.mode} onChange={(event) => {
          const mode = event.target.value
          if (mode === 'dry-run' || mode === 'apply') props.onModeChange(mode)
        }}>
          <option value="dry-run">dry-run</option><option value="apply">apply</option>
        </select>
        {props.mode === 'apply' && <label className="flex items-center gap-1.5 whitespace-nowrap text-caption"><input name="confirm-sync" type="checkbox" data-testid="ops-confirm-sync" checked={props.confirmed} onChange={(event) => props.onConfirmChange(event.target.checked)} />{t('operations.confirm_apply')}</label>}
      </div>
      <button type="button" className={`${operationButton} mt-3`} data-testid="ops-sync-submit" disabled={!props.rootReady || props.busy !== null || !props.selectorReady || !ready} onClick={props.onSubmit}>
        {props.busy === 'sync' ? t('operations.running') : props.mode === 'apply' ? t('operations.apply') : t('operations.preview')}
      </button>
    </article>
  )
}
