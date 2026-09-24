import { useEffect, useState } from 'react'
import { useT } from '../i18n'
import { getToken } from '../api/transport'
import type { TemplateDocument, TemplateRef } from '../api/instructionsDecoders'
import { DetailColumn } from '../shell/ThreeColumns'
import { SheetTabs, type SheetDef } from '../shared/DetailSheets'
import { Markdown } from '../shared/Markdown'
import { BUTTON_GHOST, BUTTON_SOLID, TEXTAREA } from '../shared/uiRecipes'
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog'
import { CopyAsCustomButton, DeleteMenu, DetailTitle, ReadOnlyNote } from './libraryChrome'

type Sheet = 'preview' | 'edit'

/**
 * 右列：模板正文、变量表、解析错误。动作在标题右侧：内建模板只有「复制为自定义」；自定义模板多出
 * 预览 / 编辑页签、「保存」（未修改时禁用）与 ⋯ 里的删除。只有一个视图时不渲染页签。
 */
export function TemplateDetail({
  ref_, document, busy, errorKey, onSave, onCopy, onDelete, onReload,
}: {
  ref_: TemplateRef
  document: TemplateDocument | null
  busy: boolean
  errorKey: string | null
  onSave: (text: string) => void
  onCopy: () => void
  onDelete: () => void
  onReload: () => void
}): JSX.Element {
  const { t } = useT()
  const custom = ref_.source === 'custom'
  const sheets: SheetDef<Sheet>[] = [{ id: 'preview', label: t('library.preview') }, { id: 'edit', label: t('library.edit') }]
  const [sheet, setSheet] = useState<Sheet>('preview')
  const [draft, setDraft] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  useEffect(() => {
    setDraft(document?.text ?? '')
    setSheet('preview')
  }, [document])
  const canWrite = getToken() !== ''
  const dirty = document !== null && draft !== document.text

  return (
    <DetailColumn
      testId="lib-tpl-detail"
      panelId="lib-tpl-panel"
      labelledBy={custom ? `lib-tpl-tab-${sheet}` : undefined}
      header={(
        <DetailTitle
          testId="lib-tpl"
          title={document?.block?.title ?? ref_.id}
          hint={`${ref_.category}/${ref_.id}`}
          builtin={!custom}
          actions={(
            <>
              {!canWrite && <ReadOnlyNote testId="lib-tpl-no-token" />}
              <CopyAsCustomButton testId="lib-tpl-copy" disabled={!canWrite || busy} onClick={onCopy} />
              {custom && (
                <>
                  <button
                    type="button"
                    className={BUTTON_SOLID}
                    data-testid="lib-tpl-save"
                    disabled={!canWrite || busy || !dirty}
                    onClick={() => onSave(draft)}
                  >
                    {t('library.save')}
                  </button>
                  <DeleteMenu testId="lib-tpl-more" disabled={!canWrite || busy} onDelete={() => setConfirmDelete(true)} />
                </>
              )}
            </>
          )}
        />
      )}
      sheets={custom ? <SheetTabs sheets={sheets} active={sheet} onChange={setSheet} ariaLabel={t('library.templates')} idPrefix="lib-tpl" /> : undefined}
    >
      {errorKey !== null && (
        <div className="mb-4 grid gap-2 rounded-md border border-red-b bg-red-t px-4 py-3" role="alert" data-testid="lib-tpl-error">
          <span className="text-body font-semibold text-red-d">{t(`library.errors.${errorKey}`)}</span>
          <button type="button" className={`${BUTTON_GHOST} justify-self-start`} data-testid="lib-tpl-reload" onClick={onReload}>
            {t('library.reload')}
          </button>
        </div>
      )}
      {document !== null && document.errors.length > 0 && (
        <div className="mb-4 grid gap-1 rounded-md border border-red-b bg-red-t px-4 py-3" data-testid="lib-tpl-block-errors">
          <span className="text-caption font-semibold text-red-d">{t('library.errors_title')}</span>
          <ul className="grid gap-1">
            {document.errors.map((message) => (
              <li key={message} className="font-mono text-caption text-red-d">{message}</li>
            ))}
          </ul>
        </div>
      )}
      {sheet === 'edit' && custom ? (
        <textarea
          className={`${TEXTAREA} min-h-[420px] font-mono text-caption`}
          value={draft}
          spellCheck={false}
          data-testid="lib-tpl-editor"
          onChange={(event) => setDraft(event.target.value)}
        />
      ) : (
        <Markdown text={document?.text ?? ''} testId="lib-tpl-preview" density="compact" />
      )}
      {document?.block !== null && document?.block !== undefined && document.block.variables.length > 0 && (
        <table className="mt-5 w-full table-fixed border-collapse text-base" data-testid="lib-tpl-variables">
          <caption className="pb-2 text-left text-caption font-semibold text-text-2">{t('library.variables')}</caption>
          <thead>
            <tr className="border-b border-border text-caption text-text-3">
              <th scope="col" className="py-2 text-left font-semibold">{t('library.key')}</th>
              <th scope="col" className="py-2 text-left font-semibold">{t('library.default_value')}</th>
            </tr>
          </thead>
          <tbody>
            {document.block.variables.map((variable) => (
              <tr key={variable.key} className="border-b border-border" data-testid={`lib-tpl-var-${variable.key}`}>
                <td className="py-2 font-mono text-caption whitespace-nowrap text-text">{variable.key}</td>
                <td className="py-2 font-mono text-caption whitespace-nowrap text-text-2">{variable.default ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {confirmDelete && (
        <ConfirmDeleteDialog
          name={document?.block?.title ?? ref_.id}
          detail={`${ref_.category}/${ref_.id}.md`}
          busy={busy}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => { setConfirmDelete(false); onDelete() }}
        />
      )}
    </DetailColumn>
  )
}
