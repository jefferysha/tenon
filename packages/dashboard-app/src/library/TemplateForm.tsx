import { useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { useT } from '../i18n'
import { TEMPLATE_CATEGORIES } from '../api/instructionsDecoders'
import { RESOURCE_FRAMEWORKS } from '../api/resourceTypes'
import { FormField } from '../shared/FormDialog'
import { Markdown } from '../shared/Markdown'
import { SegmentTabs } from '../shared/SegmentTabs'
import { INPUT, SELECT, TEXTAREA } from '../shared/uiRecipes'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import type { FieldError, TemplateDraft, TemplateErrors, TemplateField } from './templateDraft'
import { protectEscapes, remarkTemplatePlaceholders } from './templatePlaceholders'
import { hasFrameworks } from './templateText'

export type BodyMode = 'edit' | 'render'

/** 预览里的占位符显示成它的含义（catalog.icons → 图标）；其余显示原名。 */
export function usePlaceholderPlugins(): ReturnType<typeof remarkTemplatePlaceholders>[] {
  const { t } = useT()
  return useMemo(() => [remarkTemplatePlaceholders((name) => {
    const key = name.startsWith('catalog.') ? `resources.category.${name.slice('catalog.'.length)}` : ''
    const label = key === '' ? key : t(key)
    return label === '' || label === key ? name : label
  })], [t])
}

export interface TemplateFormProps {
  /** 控件 id 与 testid 前缀：详情页 `lib-tpl`，新建对话框 `lib-tpl-new`（两者可能同时挂载）。 */
  prefix: string
  draft: TemplateDraft
  disabled: boolean
  errors: TemplateErrors
  /** 正文能用的占位符（说明 Tooltip 逐个列出）。 */
  placeholders: readonly string[]
  /** 只有新建时有「标识」字段；已有模板的标识改不了。 */
  id?: { value: string; onChange: (id: string) => void }
  bodyMode: BodyMode
  onBodyMode: (mode: BodyMode) => void
  onChange: (next: TemplateDraft) => void
  /** 对话框里正文区撑满剩余高度；详情页给最小高度。 */
  fill?: boolean
}

/**
 * 模板表单：名称（新建时还有标识）· 分类 · 适用框架（多选，只对前端 / 状态管理 / 样式有效）· 正文。
 * 正文右上角「编辑 / 渲染」切换；占位符说明在正文标签旁的 Tooltip 里。错误在各字段下方，
 * 「必填」类错误等字段被动过才显示。
 */
export function TemplateForm({ prefix, draft, disabled, errors, placeholders, id, bodyMode, onBodyMode, onChange, fill = false }: TemplateFormProps): JSX.Element {
  const { t } = useT()
  const plugins = usePlaceholderPlugins()
  const [touched, setTouched] = useState<ReadonlySet<TemplateField>>(new Set())
  const touch = (field: TemplateField): void => setTouched((current) => (current.has(field) ? current : new Set([...current, field])))
  const message = (field: TemplateField): string | null => {
    const error: FieldError | undefined = errors[field]
    if (error === undefined || (error.required === true && !touched.has(field))) return null
    return t(`library.form.${error.key}`, error.vars)
  }
  const describedBy = (field: TemplateField): string | undefined => (message(field) === null ? undefined : `${prefix}-${field}-input-error`)
  const frameworksApply = hasFrameworks(draft.category)
  const options = [...new Set([...RESOURCE_FRAMEWORKS, ...draft.frameworks])]
  const change = (field: TemplateField, next: TemplateDraft): void => { touch(field); onChange(next) }

  return (
    <div className={cn('grid gap-4', fill && 'h-full grid-rows-[auto_auto_minmax(0,1fr)]')} data-testid={`${prefix}-form`}>
      <div className={cn('grid gap-4 max-[640px]:grid-cols-1', id === undefined ? 'grid-cols-1' : 'grid-cols-2')}>
        <FormField label={t('library.name')} htmlFor={`${prefix}-title-input`} error={message('title')} testid={`${prefix}-title-field`}>
          <input
            id={`${prefix}-title-input`}
            className={INPUT}
            value={draft.title}
            maxLength={120}
            autoComplete="off"
            disabled={disabled}
            aria-invalid={message('title') !== null}
            aria-describedby={describedBy('title')}
            data-testid={`${prefix}-name`}
            onChange={(event) => change('title', { ...draft, title: event.target.value })}
          />
        </FormField>
        {id !== undefined && (
          <FormField label={t('library.id')} htmlFor={`${prefix}-id-input`} hint={t('library.form.id_hint')} error={message('id')} testid={`${prefix}-id-field`}>
            <input
              id={`${prefix}-id-input`}
              className={`${INPUT} font-mono`}
              value={id.value}
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              aria-invalid={message('id') !== null}
              aria-describedby={describedBy('id')}
              data-testid={`${prefix}-id`}
              onChange={(event) => { touch('id'); id.onChange(event.target.value) }}
            />
          </FormField>
        )}
      </div>
      <div className="grid grid-cols-2 gap-4 max-[640px]:grid-cols-1">
        <FormField label={t('library.category')} htmlFor={`${prefix}-category-input`} testid={`${prefix}-category-field`}>
          {/* SELECT 是 appearance-none：原生箭头被去掉了，这里补一个，否则看起来像文本框。 */}
          <span className="relative block">
            <select
              id={`${prefix}-category-input`}
              className={SELECT}
              value={draft.category}
              disabled={disabled}
              data-testid={`${prefix}-category`}
              onChange={(event) => {
                const category = TEMPLATE_CATEGORIES.find((value) => value === event.target.value) ?? draft.category
                onChange({ ...draft, category, frameworks: hasFrameworks(category) ? draft.frameworks : [] })
              }}
            >
              {TEMPLATE_CATEGORIES.map((value) => <option key={value} value={value}>{t(`library.categories.${value}`)}</option>)}
            </select>
            <ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-text-3" aria-hidden="true" data-testid={`${prefix}-category-arrow`} />
          </span>
        </FormField>
        <FormField label={t('library.frameworks')} hint={t('library.form.frameworks_hint')} error={message('frameworks')} testid={`${prefix}-frameworks-field`}>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild disabled={disabled || !frameworksApply}>
              <button
                type="button"
                className={cn(SELECT, 'relative text-left')}
                aria-label={t('library.frameworks')}
                aria-invalid={message('frameworks') !== null}
                data-testid={`${prefix}-frameworks`}
              >
                <span className={cn('block truncate', draft.frameworks.length === 0 && 'text-text-3')} title={draft.frameworks.join(', ')}>
                  {draft.frameworks.length === 0 ? '—' : draft.frameworks.join(', ')}
                </span>
                <ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-text-3" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width)" data-testid={`${prefix}-frameworks-menu`}>
              {options.map((framework) => (
                <DropdownMenuCheckboxItem
                  key={framework}
                  className="min-h-9 whitespace-nowrap text-body"
                  checked={draft.frameworks.includes(framework)}
                  data-testid={`${prefix}-framework-${framework}`}
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={(checked) => change('frameworks', {
                    ...draft,
                    frameworks: checked ? options.filter((item) => item === framework || draft.frameworks.includes(item)) : draft.frameworks.filter((item) => item !== framework),
                  })}
                >
                  {framework}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </FormField>
      </div>
      <FormField
        label={t('library.body')}
        htmlFor={bodyMode === 'edit' ? `${prefix}-body-input` : undefined}
        hint={<PlaceholderList names={placeholders} />}
        error={message('body')}
        className={cn(fill && 'min-h-0 grid-rows-[auto_minmax(0,1fr)_auto]')}
        testid={`${prefix}-body-field`}
        action={(
          <SegmentTabs
            sheets={[{ id: 'edit', label: t('library.edit') }, { id: 'render', label: t('library.render') }]}
            active={bodyMode}
            onChange={onBodyMode}
            ariaLabel={t('library.body')}
            idPrefix={`${prefix}-body`}
          />
        )}
      >
        <div id={`${prefix}-body-panel`} role="tabpanel" aria-labelledby={`${prefix}-body-tab-${bodyMode}`} className={cn('min-h-0', fill ? 'h-full' : 'min-h-[420px]')}>
          {bodyMode === 'edit' ? (
            <textarea
              id={`${prefix}-body-input`}
              className={cn(TEXTAREA, 'font-mono text-caption', fill ? 'h-full resize-none' : 'min-h-[420px]')}
              value={draft.body}
              spellCheck={false}
              disabled={disabled}
              aria-invalid={message('body') !== null}
              aria-describedby={describedBy('body')}
              data-testid={`${prefix}-editor`}
              onChange={(event) => change('body', { ...draft, body: event.target.value })}
            />
          ) : (
            <div className={cn('overflow-y-auto rounded-sm border border-border bg-card px-4 py-3', fill ? 'h-full' : 'min-h-[420px]')}>
              <Markdown text={protectEscapes(draft.body)} testId={`${prefix}-preview`} density="compact" plugins={plugins} />
            </div>
          )}
        </div>
      </FormField>
    </div>
  )
}

/** 占位符说明：每行一个 `{{名称}}` 与它的含义，最后一行是字面量写法。 */
function PlaceholderList({ names }: { names: readonly string[] }): JSX.Element {
  const { t } = useT()
  const meaning = (name: string): string => {
    if (name === 'project.name') return t('library.placeholder.project_name')
    if (name === 'directories') return t('library.placeholder.directories')
    if (name === 'catalog.ref') return t('library.placeholder.catalog_ref')
    if (name.startsWith('catalog.')) return t('library.placeholder.catalog', { category: t(`resources.category.${name.slice('catalog.'.length)}`) })
    return t('library.placeholder.variable')
  }
  return (
    <ul className="grid gap-1" data-testid="lib-tpl-placeholders">
      {names.map((name) => (
        <li key={name} className="flex items-baseline gap-3 whitespace-nowrap">
          <code className="font-mono text-micro">{`{{${name}}}`}</code>
          <span>{meaning(name)}</span>
        </li>
      ))}
      <li className="flex items-baseline gap-3 whitespace-nowrap">
        <code className="font-mono text-micro">{'\\{{'}</code>
        <span>{t('library.placeholder.escape')}</span>
      </li>
    </ul>
  )
}
