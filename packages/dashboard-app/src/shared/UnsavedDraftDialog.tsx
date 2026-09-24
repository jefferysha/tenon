import { useCallback, useRef, useState } from 'react'
import { useT } from '../i18n'
import { Dialog } from './Dialog'

export function useDiscardGuard(): {
  confirmOpen: boolean
  request: (dirty: boolean, action: () => void) => void
  stay: () => void
  discard: () => void
} {
  const pendingAction = useRef<(() => void) | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const stay = useCallback(() => {
    pendingAction.current = null
    setConfirmOpen(false)
  }, [])
  const discard = useCallback(() => {
    const action = pendingAction.current
    pendingAction.current = null
    setConfirmOpen(false)
    action?.()
  }, [])
  const request = useCallback((dirty: boolean, action: () => void) => {
    if (!dirty) {
      action()
      return
    }
    pendingAction.current = action
    setConfirmOpen(true)
  }, [])

  return { confirmOpen, request, stay, discard }
}

export function UnsavedDraftDialog({ open, testid, onStay, onDiscard }: {
  open: boolean
  testid: string
  onStay: () => void
  onDiscard: () => void
}): JSX.Element | null {
  const { t } = useT()
  if (!open) return null
  return (
    <Dialog
      title={t('common.unsaved_navigation_title')}
      onClose={onStay}
      testid={testid}
      role="alertdialog"
      actions={(
        <>
          <button
            type="button"
            className="rounded-md border border-border bg-card px-3.5 py-2 text-body font-bold text-text hover:bg-fill"
            onClick={onStay}
          >
            {t('common.unsaved_navigation_stay')}
          </button>
          <button
            type="button"
            className="rounded-md bg-red px-3.5 py-2 text-body font-bold text-solid-fg hover:opacity-90"
            onClick={onDiscard}
          >
            {t('common.unsaved_navigation_leave')}
          </button>
        </>
      )}
    >
      <p className="text-body leading-6 text-text-2">{t('common.unsaved_navigation_body')}</p>
    </Dialog>
  )
}
