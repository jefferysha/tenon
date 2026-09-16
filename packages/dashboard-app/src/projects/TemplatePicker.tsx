import { useT } from '../i18n'
import { TEMPLATE_CATEGORIES, type TemplateCategory, type TemplateSummary, type TemplateVariable } from '../api/instructionsDecoders'
import { FIELD_LABEL, INPUT } from '../shared/uiRecipes'

export interface TemplateSelection { source: TemplateSummary['source']; category: TemplateCategory; id: string }

const NESTED: readonly TemplateCategory[] = ['state', 'styling']

export const selectionKey = (selection: TemplateSelection): string => `${selection.source}/${selection.category}/${selection.id}`

/** 状态管理 / 样式只列出与已选前端块 frameworks 相交的块。 */
function visible(row: TemplateSummary, frontendFrameworks: readonly string[]): boolean {
  if (!NESTED.includes(row.category)) return true
  return row.frameworks.some((framework) => frontendFrameworks.includes(framework))
}

/**
 * 模板选择：按分类分行，行内是模板芯片；勾选前端块后才出现状态管理与样式两行。
 * 变量来自各块详情（variablesByKey），值按 `<source>/<category>/<id>::<key>` 记。
 */
export function TemplatePicker({
  templates, selected, variablesByKey, values, onToggle, onValue,
}: {
  templates: readonly TemplateSummary[]
  selected: readonly TemplateSelection[]
  variablesByKey: Readonly<Record<string, readonly TemplateVariable[]>>
  values: Readonly<Record<string, string>>
  onToggle: (selection: TemplateSelection) => void
  onValue: (path: string, value: string) => void
}): JSX.Element {
  const { t } = useT()
  const selectedKeys = new Set(selected.map(selectionKey))
  const frontendFrameworks = selected
    .filter((item) => item.category === 'frontend')
    .flatMap((item) => templates.find((row) => selectionKey(row) === selectionKey(item))?.frameworks ?? [])
  const rows = templates.filter((row) => visible(row, frontendFrameworks))
  const withVariables = selected.filter((item) => (variablesByKey[selectionKey(item)] ?? []).length > 0)

  return (
    <div className="grid gap-4">
      {TEMPLATE_CATEGORIES.map((category) => {
        const inCategory = rows.filter((row) => row.category === category)
        if (inCategory.length === 0) return null
        return (
          <section key={category} className="grid gap-2" data-testid={`np-cat-${category}`}>
            <h3 className="text-caption font-semibold text-text-2">{t(`library.categories.${category}`)}</h3>
            <div className="flex flex-wrap gap-2">
              {inCategory.map((row) => {
                const on = selectedKeys.has(selectionKey(row))
                return (
                  <button
                    key={selectionKey(row)}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-caption whitespace-nowrap text-text-2 outline-none hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent) aria-checked:border-accent-b aria-checked:bg-accent-t aria-checked:text-(--accent)"
                    data-testid={`np-block-${row.source}-${row.category}-${row.id}`}
                    onClick={() => onToggle({ source: row.source, category: row.category, id: row.id })}
                  >
                    <span className="truncate">{row.title}</span>
                    <span className="rounded-full bg-fill px-1.5 text-micro font-bold text-text-3">{t(`library.${row.source}`)}</span>
                  </button>
                )
              })}
            </div>
          </section>
        )
      })}
      {withVariables.length > 0 && (
        <section className="grid gap-3" data-testid="np-variables">
          <h3 className="text-caption font-semibold text-text-2">{t('projects.variables')}</h3>
          {withVariables.map((item) => (
            <div key={selectionKey(item)} className="grid gap-2" data-testid={`np-vars-${item.category}-${item.id}`}>
              {(variablesByKey[selectionKey(item)] ?? []).map((variable) => {
                const path = `${selectionKey(item)}::${variable.key}`
                return (
                  <label key={path} className={FIELD_LABEL}>
                    <span className="font-mono text-caption whitespace-nowrap">{`${item.id} · ${variable.key}`}</span>
                    <input
                      className={INPUT}
                      value={values[path] ?? ''}
                      placeholder={variable.default ?? ''}
                      autoComplete="off"
                      data-testid={`np-var-${item.category}-${item.id}-${variable.key}`}
                      onChange={(event) => onValue(path, event.target.value)}
                    />
                  </label>
                )
              })}
            </div>
          ))}
        </section>
      )}
    </div>
  )
}
