import './progress.css'
import { useT } from '../i18n'
import { BUTTON_GHOST } from '../shared/uiRecipes'

export interface SnapshotInlineErrorProps {
  error: string
  loading: boolean
  onRefresh?: () => void | Promise<void>
}

export function SnapshotInlineError({
  error,
  loading,
  onRefresh,
}: SnapshotInlineErrorProps): JSX.Element {
  const { t } = useT()
  return (
    <div
      className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-b bg-red-t px-4 py-3 text-body text-red-d"
      role="alert"
      data-testid="prg-error"
    >
      <p className="min-w-0 break-words">{error}</p>
      {onRefresh && (
        <button
          type="button"
          className={`${BUTTON_GHOST} border-red-b bg-card text-red-d hover:border-red-b hover:bg-red-t hover:text-red-d`}
          disabled={loading}
          onClick={() => { void onRefresh() }}
        >
          {t('common.snapshot_retry')}
        </button>
      )}
    </div>
  )
}
