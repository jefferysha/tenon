import { useEffect, useMemo, useState } from 'react'
import { useT } from '../i18n'
import { getToken } from '../api/transport'
import type { TemplateCategory, TemplateDocument, TemplateRef } from '../api/instructionsDecoders'
import { DetailColumn } from '../shell/ThreeColumns'
import { Markdown } from '../shared/Markdown'
import { BUTTON_GHOST, BUTTON_SOLID } from '../shared/uiRecipes'
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog'
import { CopyAsCustomButton, DeleteMenu, DetailTitle, ReadOnlyNote } from './libraryChrome'
import { protectEscapes } from './templatePlaceholders'
import { hasErrors, knownPlaceholders, validateTemplateDraft, type TemplateDraft } from './templateDraft'
import { TemplateForm, usePlaceholderPlugins, type BodyMode } from './TemplateForm'
import { frontList, rewriteTemplate, splitTemplate } from './templateText'

function draftOf(ref: TemplateRef, document: TemplateDocument | null): TemplateDraft {
  const parts = splitTemplate(document?.text ?? '')
  return {
    title: document?.block?.title ?? ref.id,
    category: ref.category,
    frameworks: document?.block?.frameworks ?? (parts === null ? [] : frontList(parts.front, 'frameworks')),
    body: parts?.body ?? document?.text ?? '',
  }
}

const sameDraft = (a: TemplateDraft, b: TemplateDraft): boolean =>
  a.title === b.title && a.category === b.category && a.body === b.body && a.frameworks.join(',') === b.frameworks.join(',')

/**
 * 右列：模板正文、变量表、解析错误。动作在标题右侧：内建模板只有「复制为自定义」，正文渲染只读；
 * 自定义模板直接是表单（名称 · 分类 · 适用框架 · 正文，正文可在 编辑 / 渲染 间切换），多出「保存」
 * （未修改或有校验错误时禁用）与 ⋯ 里的删除。预览里的 `{{…}}` 占位符渲染成淡色标记。
 */
export function TemplateDetail({
  ref_, document, busy, errorKey, editOnOpen = false, onSave, onCopy, onDelete, onReload,
}: {
  ref_: TemplateRef
  document: TemplateDocument | null
  busy: boolean
  errorKey: string | null
  /** 刚「复制为自定义」/「新建」出来的模板：正文打开即在编辑态。 */
  editOnOpen?: boolean
  onSave: (text: string, category: TemplateCategory) => void
  onCopy: () => void
  onDelete: () => void
  onReload: () => void
}): JSX.Element {
  const { t } = useT()
  const custom = ref_.source === 'custom'
  const original = useMemo(() => draftOf(ref_, document), [ref_, document])
  const [draft, setDraft] = useState<TemplateDraft>(original)
  const [bodyMode, setBodyMode] = useState<BodyMode>('render')
  const [confirmDelete, setConfirmDelete] = useState(false)
  useEffect(() => {
    setDraft(original)
    setBodyMode(editOnOpen && custom ? 'edit' : 'render')
  }, [original, editOnOpen, custom])
  const plugins = usePlaceholderPlugins()
  const canWrite = getToken() !== ''
  const dirty = document !== null && !sameDraft(draft, original)
  const placeholders = useMemo(() => knownPlaceholders(document?.block ?? null), [document])
  // 块本身解析失败（block = null）时占位符无从核对，交给服务端报错。
  const errors = validateTemplateDraft(draft, { known: document?.block ? new Set(placeholders) : null })

  return (
    <DetailColumn
      testId="lib-tpl-detail"
      panelId="lib-tpl-panel"
      header={(
        <DetailTitle
          testId="lib-tpl"
          title={document?.block?.title ?? ref_.id}
          hint={`${ref_.category}/${ref_.id}`}
          custom={custom}
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
                    disabled={!canWrite || busy || !dirty || hasErrors(errors)}
                    onClick={() => onSave(rewriteTemplate(document?.text ?? '', {
                      title: draft.title.trim(), category: draft.category, frameworks: draft.frameworks, body: draft.body,
                    }), draft.category)}
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
      {custom ? (
        <TemplateForm
          key={`${ref_.category}/${ref_.id}`}
          prefix="lib-tpl"
          draft={draft}
          disabled={!canWrite || busy}
          errors={errors}
          placeholders={placeholders}
          bodyMode={bodyMode}
          onBodyMode={setBodyMode}
          onChange={setDraft}
        />
      ) : (
        <Markdown text={protectEscapes(document?.text ?? '')} testId="lib-tpl-preview" density="compact" plugins={plugins} />
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
