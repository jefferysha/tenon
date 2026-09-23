import { useT } from '../i18n'
import { Dialog } from '../shared/Dialog'
import { BUTTON_DANGER, BUTTON_GHOST } from '../shared/uiRecipes'

/** 库里自定义条目（模板 / 智能体 / 测试方向）删除前的确认；与资源目录的删除对话框同一形状。 */
export function ConfirmDeleteDialog({
  name, detail, busy, onCancel, onConfirm,
}: {
  name: string
  /** 标题下一行：条目的标识或路径。 */
  detail: string
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  const { t } = useT()
  return (
    <Dialog
      title={t('library.delete_title', { name })}
      testid="lib-delete-dialog"
      onClose={onCancel}
      actions={(
        <>
          <button type="button" className={BUTTON_GHOST} data-testid="lib-delete-cancel" onClick={onCancel}>
            {t('library.cancel')}
          </button>
          <button type="button" className={BUTTON_DANGER} data-testid="lib-delete-confirm" disabled={busy} onClick={onConfirm}>
            {t('library.delete')}
          </button>
        </>
      )}
    >
      <p className="font-mono text-body text-text-2">{detail}</p>
    </Dialog>
  )
}
