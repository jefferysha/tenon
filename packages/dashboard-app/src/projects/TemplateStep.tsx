import { useEffect } from 'react'
import { Check, LoaderCircle } from 'lucide-react'
import { useT } from '../i18n'
import { TEMPLATE_CATEGORIES, type TemplateCategory, type TemplateDocument, type TemplateRef, type TemplateSummary } from '../api/instructionsDecoders'
import { Markdown } from '../shared/Markdown'
import { BUTTON_GHOST, BUTTON_SOLID, FIELD_LABEL, INPUT, LIST_SELECTED_ARIA } from '../shared/uiRecipes'
import { cn } from '@/lib/utils'

export type TemplateSelection = TemplateRef

export const selectionKey = (selection: TemplateRef): string => `${selection.source}/${selection.category}/${selection.id}`

const NESTED: readonly TemplateCategory[] = ['state', 'styling']

/** 状态管理 / 样式块要与已加入的前端块框架相交才能加入（拼合时 server 同样校验）。 */
export function compatible(row: TemplateSummary, templates: readonly TemplateSummary[], selected: readonly TemplateSelection[]): boolean {
  if (!NESTED.includes(row.category)) return true
  const frameworks = selected
    .filter((item) => item.category === 'frontend')
    .flatMap((item) => templates.find((candidate) => selectionKey(candidate) === selectionKey(item))?.frameworks ?? [])
  return row.frameworks.some((framework) => frameworks.includes(framework))
}

export interface TemplateStepProps {
  templates: readonly TemplateSummary[]
  selected: readonly TemplateSelection[]
  /** 正在预览的模板。 */
  focused: TemplateSelection | null
  documents: Readonly<Record<string, TemplateDocument>>
  values: Readonly<Record<string, string>>
  onFocus: (selection: TemplateSelection) => void
  onToggle: (selection: TemplateSelection) => void
  onValue: (path: string, value: string) => void
}

/** 模板：左列与「库」同一份模板（按分类），点行在右侧预览，预览头部「加入 / 移除」；可以一个都不选。 */
export function TemplateStep({ templates, selected, focused, documents, values, onFocus, onToggle, onValue }: TemplateStepProps): JSX.Element {
  const { t } = useT()
  const selectedKeys = new Set(selected.map(selectionKey))
  const row = focused === null ? undefined : templates.find((candidate) => selectionKey(candidate) === selectionKey(focused))
  const document = focused === null ? undefined : documents[selectionKey(focused)]
  const added = row !== undefined && selectedKeys.has(selectionKey(row))
  const allowed = row !== undefined && (added || compatible(row, templates, selected))
  // 进入时默认预览第一个模板，右侧不留空框。
  const first = TEMPLATE_CATEGORIES.flatMap((category) => templates.filter((candidate) => candidate.category === category))[0]
  useEffect(() => {
    if (focused === null && first !== undefined) onFocus({ source: first.source, category: first.category, id: first.id })
  }, [focused, first, onFocus])
  return (
    <div className="grid h-full min-h-0 grid-cols-[208px_minmax(0,1fr)] gap-3" data-testid="np-templates">
      <div className="min-h-0 overflow-y-auto pr-1" aria-label={t('projects.templates')} role="group">
        {TEMPLATE_CATEGORIES.map((category) => {
          const rows = templates.filter((candidate) => candidate.category === category)
          if (rows.length === 0) return null
          return (
            <section key={category} className="grid gap-0.5 pb-2" data-testid={`np-cat-${category}`}>
              <h3 className="px-2 py-1 text-micro font-semibold text-text-3">{t(`library.categories.${category}`)}</h3>
              {rows.map((candidate) => {
                const key = selectionKey(candidate)
                return (
                  <button
                    key={key}
                    type="button"
                    aria-current={focused !== null && selectionKey(focused) === key}
                    aria-label={selectedKeys.has(key) ? `${candidate.title} · ${t('projects.added')}` : candidate.title}
                    className={cn('flex min-h-9 items-center gap-2 rounded-sm px-2 text-left text-caption whitespace-nowrap text-text outline-none transition-colors duration-(--dur-fast) hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent)', LIST_SELECTED_ARIA)}
                    data-testid={`np-block-${candidate.source}-${candidate.category}-${candidate.id}`}
                    onClick={() => onFocus({ source: candidate.source, category: candidate.category, id: candidate.id })}
                  >
                    <span className="min-w-0 flex-1 truncate" title={candidate.title}>{candidate.title}</span>
                    {selectedKeys.has(key) && <Check className="size-4 flex-none text-(--accent)" strokeWidth={2.5} aria-hidden="true" />}
                  </button>
                )
              })}
            </section>
          )
        })}
      </div>
      <div className="flex min-h-0 flex-col rounded-md border border-border bg-card" data-testid="np-template-preview">
        {row !== undefined && (
          <>
            <div className="flex min-h-12 flex-none items-center gap-2 border-b border-border px-3">
              <span className="min-w-0 flex-1 truncate text-body font-semibold text-text" title={row.title}>{row.title}</span>
              <span title={allowed ? undefined : t('projects.template_needs_frontend')}>
                <button
                  type="button"
                  className={added ? BUTTON_GHOST : BUTTON_SOLID}
                  disabled={!allowed}
                  data-testid="np-template-toggle"
                  onClick={() => onToggle({ source: row.source, category: row.category, id: row.id })}
                >
                  {t(added ? 'projects.remove' : 'projects.add')}
                </button>
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
              {added && (document?.block?.variables ?? []).length > 0 && (
                <div className="grid gap-2 pb-3" data-testid={`np-vars-${row.category}-${row.id}`}>
                  {(document?.block?.variables ?? []).map((variable) => {
                    const path = `${selectionKey(row)}::${variable.key}`
                    return (
                      <label key={path} className={FIELD_LABEL}>
                        <span className="font-mono text-caption whitespace-nowrap">{variable.key}</span>
                        <input
                          className={INPUT}
                          value={values[path] ?? ''}
                          placeholder={variable.default ?? ''}
                          autoComplete="off"
                          data-testid={`np-var-${row.category}-${row.id}-${variable.key}`}
                          onChange={(event) => onValue(path, event.target.value)}
                        />
                      </label>
                    )
                  })}
                </div>
              )}
              {document === undefined
                ? <LoaderCircle className="mx-auto mt-6 size-5 animate-spin text-text-3 motion-reduce:animate-none" aria-label={t('common.loading')} />
                : <Markdown text={document.text} density="compact" testId="np-template-markdown" />}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
