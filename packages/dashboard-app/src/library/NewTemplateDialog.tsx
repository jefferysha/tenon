import { useMemo, useState } from 'react'
import { useT } from '../i18n'
import type { TemplateCategory } from '../api/instructionsDecoders'
import { FormDialog } from '../shared/FormDialog'
import { TemplateForm, type BodyMode } from './TemplateForm'
import { hasErrors, knownPlaceholders, slugOf, starterBody, validateTemplateDraft, type TemplateDraft } from './templateDraft'
import { newTemplateText } from './templateText'

export interface NewTemplateDialogProps {
  busy: boolean
  /** 已有自定义模板的 `<分类>/<标识>`：同分类下标识不能重复。 */
  taken: ReadonlySet<string>
  /** 最近一次写入失败的词典键后缀（`library.errors.<key>`）；只在本对话框提交过之后显示。 */
  errorKey: string | null
  onClose: () => void
  onCreate: (category: TemplateCategory, id: string, text: string) => void
}

/**
 * 新建自定义模板：名称 · 标识（随名称生成，可改）· 分类 · 适用框架 · 正文，一次写成完整模板。
 * 外壳是共享的 FormDialog（固定高度、Enter 提交、有输入时 Esc 先确认）。
 */
export function NewTemplateDialog({ busy, taken, errorKey, onClose, onCreate }: NewTemplateDialogProps): JSX.Element {
  const { t } = useT()
  const starter = (category: TemplateCategory): string => starterBody(category, t(`library.categories.${category}`))
  const [draft, setDraft] = useState<TemplateDraft>(() => ({ title: '', category: 'common', frameworks: [], body: starter('common') }))
  const [id, setId] = useState('')
  const [idTouched, setIdTouched] = useState(false)
  const [bodyMode, setBodyMode] = useState<BodyMode>('edit')
  const [submitted, setSubmitted] = useState(false)
  const placeholders = useMemo(() => knownPlaceholders(null), [])
  const takenIds = useMemo(() => new Set([...taken].filter((key) => key.startsWith(`${draft.category}/`)).map((key) => key.slice(draft.category.length + 1))), [taken, draft.category])
  const errors = validateTemplateDraft(draft, { known: new Set(placeholders), id, takenIds })
  const dirty = draft.title !== '' || id !== '' || draft.frameworks.length > 0 || draft.category !== 'common' || draft.body !== starter('common')

  const onChange = (next: TemplateDraft): void => {
    // 正文还是起始骨架时，换分类连骨架一起换（标题级别与分类名跟着变）。
    const body = next.category !== draft.category && draft.body === starter(draft.category) ? starter(next.category) : next.body
    setDraft({ ...next, body })
    if (!idTouched && next.title !== draft.title) setId(slugOf(next.title))
  }

  return (
    <FormDialog
      title={t('library.new')}
      testid="lib-tpl-new-dialog"
      dirty={dirty}
      busy={busy}
      canSubmit={!hasErrors(errors)}
      submitLabel={t('library.confirm')}
      onSubmit={() => {
        setSubmitted(true)
        onCreate(draft.category, id, newTemplateText({ id, title: draft.title.trim(), category: draft.category, frameworks: draft.frameworks, body: draft.body }))
      }}
      onClose={onClose}
      panelClassName="w-[min(880px,94vw)]"
      bodyClassName="h-[560px]"
      footer={submitted && errorKey !== null && (
        <p className="truncate whitespace-nowrap text-caption font-semibold text-red-d" role="alert" data-testid="lib-tpl-new-error">{t(`library.errors.${errorKey}`)}</p>
      )}
    >
      <TemplateForm
        prefix="lib-tpl-new"
        draft={draft}
        disabled={busy}
        errors={errors}
        placeholders={placeholders}
        id={{ value: id, onChange: (value) => { setIdTouched(true); setId(value) } }}
        bodyMode={bodyMode}
        onBodyMode={setBodyMode}
        onChange={onChange}
        fill
      />
    </FormDialog>
  )
}
