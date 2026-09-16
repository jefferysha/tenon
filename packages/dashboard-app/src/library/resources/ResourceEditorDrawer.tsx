import { useEffect, useState } from 'react'
import { useT } from '../../i18n'
import { getToken } from '../../api/transport'
import { Drawer } from '../../shared/Drawer'
import { BUTTON_GHOST, BUTTON_SOLID, TEXTAREA } from '../../shared/uiRecipes'

/** 自定义条目的 YAML 编辑抽屉：保存交给 server 校验，错误逐条列在文本框下面。 */
export function ResourceEditorDrawer({
  open, id, yaml, busy, errors, errorKey, onSave, onClose, onReload,
}: {
  open: boolean
  id: string
  yaml: string
  busy: boolean
  errors: readonly string[]
  errorKey: string | null
  onSave: (text: string) => void
  onClose: () => void
  onReload: () => void
}): JSX.Element | null {
  const { t } = useT()
  const [draft, setDraft] = useState(yaml)
  useEffect(() => { setDraft(yaml) }, [yaml, open])
  const canWrite = getToken() !== ''

  return (
    <Drawer open={open} onClose={onClose} title={id} ariaLabel={t('resources.edit')} testId="res-drawer">
      <div className="grid gap-3">
        <textarea
          className={`${TEXTAREA} min-h-[420px] font-mono text-caption`}
          value={draft}
          spellCheck={false}
          data-testid="res-yaml"
          onChange={(event) => setDraft(event.target.value)}
        />
        {errorKey !== null && (
          <div className="grid gap-2 rounded-md border border-red-b bg-red-t px-4 py-3" role="alert" data-testid="res-drawer-error">
            <span className="text-body font-semibold text-red-d">{t(`resources.errors.${errorKey}`)}</span>
            {errorKey === 'conflict' && (
              <button type="button" className={`${BUTTON_GHOST} justify-self-start`} data-testid="res-drawer-reload" onClick={onReload}>
                {t('resources.reload')}
              </button>
            )}
          </div>
        )}
        {errors.length > 0 && (
          <ul className="grid gap-1" data-testid="res-drawer-errors">
            {errors.map((message) => (
              <li key={message} className="font-mono text-caption text-red-d">{message}</li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={BUTTON_SOLID} data-testid="res-save" disabled={!canWrite || busy} onClick={() => onSave(draft)}>
            {t('resources.save')}
          </button>
          <button type="button" className={BUTTON_GHOST} data-testid="res-cancel" onClick={onClose}>
            {t('resources.cancel')}
          </button>
        </div>
      </div>
    </Drawer>
  )
}
