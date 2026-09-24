import { useState } from 'react'
import { useT } from '../i18n'
import { formatApiError, getToken } from '../api/transport'
import { saveUser, type CurrentUserState, type UserSource } from '../api/userClient'
import { Dialog } from '../shared/Dialog'
import { BUTTON_GHOST, BUTTON_SOLID, FIELD_HELP, FIELD_LABEL, INPUT } from '../shared/uiRecipes'

export interface UserDialogProps {
  /** Prefill from the current user, when one is set; `source: 'config'` means it already is `user.json`. */
  initial?: { id: string; name: string; source?: UserSource } | null
  onClose: () => void
  onSaved: (state: CurrentUserState) => void
}

/** Machine-local declared identity (`user.json`, shared by every project); saving needs the page token, a non-empty email and a change. */
export function UserDialog({ initial = null, onClose, onSaved }: UserDialogProps): JSX.Element {
  const { t } = useT()
  const [id, setId] = useState(initial?.id ?? '')
  const [name, setName] = useState(initial?.name ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // An env / git identity is worth writing down as-is; an existing user.json is only rewritten when edited.
  const unchanged = initial?.source === 'config' && id.trim() === initial.id && name.trim() === initial.name
  const canSave = getToken() !== '' && id.trim() !== '' && !unchanged && !saving

  async function save(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      onSaved(await saveUser({ id: id.trim(), name: name.trim() }))
    } catch (caught) {
      setError(formatApiError(caught, t))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      title={t('shell.user')}
      onClose={onClose}
      testid="user-dialog"
      actions={(
        <>
          <button type="button" className={BUTTON_GHOST} onClick={onClose}>{t('workflow.cancel')}</button>
          <button type="button" className={BUTTON_SOLID} disabled={!canSave} data-testid="user-dialog-save" onClick={() => { void save() }}>
            {t('workflow.save')}
          </button>
        </>
      )}
    >
      <div className="grid gap-3">
        <p className={FIELD_HELP} data-testid="user-dialog-scope">{t('shell.user_scope')}</p>
        <label className={FIELD_LABEL}>
          {t('shell.user_id')}
          <input className={INPUT} type="email" value={id} autoComplete="email" data-testid="user-dialog-id" onChange={(event) => setId(event.target.value)} />
        </label>
        <label className={FIELD_LABEL}>
          {t('shell.user_name')}
          <input className={INPUT} value={name} autoComplete="name" data-testid="user-dialog-name" onChange={(event) => setName(event.target.value)} />
        </label>
        {error !== null && <p className="text-caption text-red" role="alert" data-testid="user-dialog-error">{error}</p>}
      </div>
    </Dialog>
  )
}
