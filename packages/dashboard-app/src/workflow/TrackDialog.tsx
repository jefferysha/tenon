import { useRef, useState } from 'react'
import { useT } from '../i18n'
import { Dialog } from '../shared/Dialog'

const TRACK_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/
const FIELD_CLS = 'min-h-10 w-full rounded-sm border border-border bg-card px-3 text-base text-text outline-none focus:border-accent-b'

export interface TrackDialogProps {
  open: boolean
  existing: readonly string[]
  onClose: () => void
  onSubmit: (id: string, label: string) => void
}

/** 新建轨道分支：id（YAML 键）+ 可选名称；分支内容复制通用分支。 */
export function TrackDialog({ open, existing, onClose, onSubmit }: TrackDialogProps): JSX.Element | null {
  const { t } = useT()
  const [id, setId] = useState('')
  const [label, setLabel] = useState('')
  const idRef = useRef<HTMLInputElement>(null)
  if (!open) return null
  const trimmed = id.trim()
  const invalid = trimmed !== '' && !TRACK_ID_RE.test(trimmed)
  const duplicate = trimmed !== '' && existing.includes(trimmed)
  const canSubmit = trimmed !== '' && !invalid && !duplicate
  function close(): void {
    setId('')
    setLabel('')
    onClose()
  }
  function submit(): void {
    if (!canSubmit) return
    onSubmit(trimmed, label.trim())
    setId('')
    setLabel('')
  }
  return (
    <Dialog
      title={t('workflow.new_track')}
      onClose={close}
      testid="track-dialog"
      closeLabel={t('workflow.cancel')}
      initialFocusRef={idRef}
      actions={(
        <>
          <button type="button" className="min-h-10 rounded-md px-3 text-base text-text-2 hover:bg-fill" onClick={close}>{t('workflow.cancel')}</button>
          <button type="button" className="min-h-10 rounded-md bg-(--accent) px-4 text-base font-semibold text-btn-fg hover:bg-accent-d disabled:opacity-50" disabled={!canSubmit} data-testid="track-dialog-submit" onClick={submit}>{t('workflow.create_submit')}</button>
        </>
      )}
    >
      <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); submit() }}>
        <label className="grid gap-1.5 text-body text-text-2">
          <span>{t('workflow.track_id')}</span>
          <input ref={idRef} className={`${FIELD_CLS} font-mono`} value={id} data-testid="track-dialog-id" onChange={(event) => setId(event.target.value)} />
          {invalid && <span className="text-caption text-red-d" role="alert">{t('workflow.track_id_invalid')}</span>}
          {duplicate && <span className="text-caption text-red-d" role="alert">{t('workflow.track_id_dup')}</span>}
        </label>
        <label className="grid gap-1.5 text-body text-text-2">
          <span>{t('workflow.track_label')}</span>
          <input className={FIELD_CLS} value={label} data-testid="track-dialog-label" onChange={(event) => setLabel(event.target.value)} />
        </label>
      </form>
    </Dialog>
  )
}
