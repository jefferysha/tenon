import { ChevronDown } from 'lucide-react'
import { useT } from '../i18n'
import { TEMPLATE_CATEGORIES, type TemplateCategory } from '../api/instructionsDecoders'
import { FIELD_LABEL, INPUT, SELECT, TEXTAREA } from '../shared/uiRecipes'

export interface TemplateDraft {
  readonly title: string
  readonly category: TemplateCategory
  readonly body: string
}

/** 自定义模板的编辑表单：名称与分类是字段，正文是 Markdown 编辑区；frontmatter 其余行不在这里改。 */
export function TemplateForm({ draft, disabled, onChange }: {
  draft: TemplateDraft
  disabled: boolean
  onChange: (next: TemplateDraft) => void
}): JSX.Element {
  const { t } = useT()
  return (
    <div className="grid gap-4" data-testid="lib-tpl-form">
      <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-4 max-[900px]:grid-cols-1">
        <label className={FIELD_LABEL}>
          {t('library.name')}
          <input
            className={INPUT}
            value={draft.title}
            maxLength={80}
            autoComplete="off"
            disabled={disabled}
            aria-invalid={draft.title.trim() === ''}
            data-testid="lib-tpl-name"
            onChange={(event) => onChange({ ...draft, title: event.target.value })}
          />
        </label>
        <label className={FIELD_LABEL}>
          {t('library.category')}
          <span className="relative block">
            <select
              className={SELECT}
              value={draft.category}
              disabled={disabled}
              data-testid="lib-tpl-category"
              onChange={(event) => onChange({ ...draft, category: TEMPLATE_CATEGORIES.find((value) => value === event.target.value) ?? draft.category })}
            >
              {TEMPLATE_CATEGORIES.map((value) => (
                <option key={value} value={value}>{t(`library.categories.${value}`)}</option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-text-3" aria-hidden="true" />
          </span>
        </label>
      </div>
      <label className={FIELD_LABEL}>
        {t('library.body')}
        <textarea
          className={`${TEXTAREA} min-h-[420px] font-mono text-caption`}
          value={draft.body}
          spellCheck={false}
          disabled={disabled}
          data-testid="lib-tpl-editor"
          onChange={(event) => onChange({ ...draft, body: event.target.value })}
        />
      </label>
    </div>
  )
}
