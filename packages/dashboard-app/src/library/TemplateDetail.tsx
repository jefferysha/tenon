import { useEffect, useState } from 'react'
import { useT } from '../i18n'
import { getToken } from '../api/transport'
import type { TemplateDocument, TemplateRef } from '../api/instructionsDecoders'
import { DetailColumn, StatusPill } from '../shell/ThreeColumns'
import { SheetTabs, type SheetDef } from '../shared/DetailSheets'
import { Markdown } from '../shared/Markdown'
import { BUTTON_DANGER, BUTTON_GHOST, BUTTON_SOLID, TEXTAREA } from '../shared/uiRecipes'

type Sheet = 'preview' | 'edit'

/** 右列：模板正文（预览 / 编辑）、变量表、解析错误，底部动作条。内建模板只有「复制」。 */
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
  const sheets: SheetDef<Sheet>[] = custom
    ? [{ id: 'preview', label: t('library.preview') }, { id: 'edit', label: t('library.edit') }]
    : [{ id: 'preview', label: t('library.preview') }]
  const [sheet, setSheet] = useState<Sheet>('preview')
  const [draft, setDraft] = useState('')
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
      labelledBy={`lib-tpl-tab-${sheet}`}
      header={(
        <div className="grid gap-2">
          <p className="text-caption font-semibold uppercase tracking-[.08em] text-(--accent)" data-testid="lib-tpl-eyebrow">
            {t(`library.categories.${ref_.category}`)}
          </p>
          <h1 className="text-page font-bold tracking-[-.01em] text-text" data-testid="lib-tpl-title">
            {document?.block?.title ?? ref_.id}
          </h1>
          <p className="font-mono text-caption whitespace-nowrap overflow-x-auto text-text-3" data-testid="lib-tpl-path">
            {`${ref_.source}/${ref_.category}/${ref_.id}.md`}
          </p>
          <StatusPill tone={custom ? 'running' : 'neutral'} testId="lib-tpl-source">
            {t(custom ? 'library.custom' : 'library.builtin')}
          </StatusPill>
        </div>
      )}
      sheets={<SheetTabs sheets={sheets} active={sheet} onChange={setSheet} ariaLabel={t('library.templates')} idPrefix="lib-tpl" />}
      footer={(
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={BUTTON_GHOST} data-testid="lib-tpl-copy" disabled={!canWrite || busy} onClick={onCopy}>
            {t('library.copy')}
          </button>
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
              <button type="button" className={BUTTON_DANGER} data-testid="lib-tpl-delete" disabled={!canWrite || busy} onClick={onDelete}>
                {t('library.delete')}
              </button>
            </>
          )}
          {!canWrite && <span className="text-caption text-text-3" data-testid="lib-tpl-no-token">{t('library.no_token')}</span>}
        </div>
      )}
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
    </DetailColumn>
  )
}
