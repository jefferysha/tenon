import { useRef, useState } from 'react'
import { useT } from '../i18n'
import { FormDialog, FormField } from '../shared/FormDialog'
import { INPUT } from '../shared/uiRecipes'

const TRACK_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/

export interface TrackDialogProps {
  open: boolean
  existing: readonly string[]
  onClose: () => void
  onSubmit: (id: string, label: string) => void
}

/**
 * 新建轨道分支：id（YAML 键）+ 可选名称；分支内容复制通用分支。
 * 外壳是共享的 FormDialog（Enter 提交、有输入时关闭先二次确认、主体固定高度），校验错误贴在字段下方。
 */
export function TrackDialog({ open, existing, onClose, onSubmit }: TrackDialogProps): JSX.Element | null {
  const { t } = useT()
  const [id, setId] = useState('')
  const [label, setLabel] = useState('')
  const idRef = useRef<HTMLInputElement>(null)
  if (!open) return null
  const trimmed = id.trim()
  const invalid = trimmed !== '' && !TRACK_ID_RE.test(trimmed)
  const duplicate = trimmed !== '' && existing.includes(trimmed)
  const error = invalid ? t('workflow.track_id_invalid') : duplicate ? t('workflow.track_id_dup') : null
  const canSubmit = trimmed !== '' && error === null
  function reset(): void {
    setId('')
    setLabel('')
  }
  return (
    <FormDialog
      title={t('workflow.new_track')}
      testid="track-dialog"
      dirty={id !== '' || label !== ''}
      canSubmit={canSubmit}
      submitLabel={t('workflow.create_submit')}
      onSubmit={() => { onSubmit(trimmed, label.trim()); reset() }}
      onClose={() => { reset(); onClose() }}
      initialFocusRef={idRef}
      panelClassName="w-[min(420px,92vw)]"
      bodyClassName="h-[176px]"
    >
      <div className="grid content-start gap-4">
        <FormField label={t('workflow.track_id')} htmlFor="track-dialog-id" error={error} testid="track-dialog-id-field">
          <input
            ref={idRef}
            id="track-dialog-id"
            className={`${INPUT} font-mono`}
            value={id}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={error !== null}
            aria-describedby={error === null ? undefined : 'track-dialog-id-error'}
            data-testid="track-dialog-id"
            onChange={(event) => setId(event.target.value)}
          />
        </FormField>
        <FormField label={t('workflow.track_label')} htmlFor="track-dialog-label">
          <input
            id="track-dialog-label"
            className={INPUT}
            value={label}
            autoComplete="off"
            data-testid="track-dialog-label"
            onChange={(event) => setLabel(event.target.value)}
          />
        </FormField>
      </div>
    </FormDialog>
  )
}
