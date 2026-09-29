import { LoaderCircle } from 'lucide-react'
import { useT } from '../i18n'
import { FormDialog, FormField } from '../shared/FormDialog'
import { handleRadioKey } from '../shared/radioKeyboard'
import { INPUT, LIST_SELECTED_ARIA } from '../shared/uiRecipes'
import type { CreateSource, CreateState } from '../workbench/useWorkflowCreate'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

const ROW = 'flex min-h-9 w-full min-w-0 items-center rounded-sm px-2.5 text-left text-body whitespace-nowrap text-text outline-none transition-colors duration-(--dur-fast) hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent)'

/**
 * 新建工作流：左栏 名称 · 起点（空白 / 复制 default、simple 或已有工作流）· OpenSpec；右栏起点的阶段预览。
 * 外壳是共享的 FormDialog：固定高度、Enter 提交、有输入时 Esc 先确认、校验错误在字段下方。
 */
export function NewWorkflowDialog({ create }: { create: CreateState }): JSX.Element | null {
  const { t } = useT()
  if (!create.open) return null
  const options: readonly CreateSource[] = [null, ...create.sources]
  const at = options.indexOf(create.source)
  const nameError = create.nameError === null ? null : t(create.nameError === 'invalid' ? 'workflow.name_invalid' : 'workflow.name_duplicate')
  const preview = create.preview
  return (
    <FormDialog
      title={t('workflow.create_title')}
      testid="wb-workflow-create"
      dirty={create.dirty}
      busy={create.busy}
      canSubmit={create.canSubmit}
      submitLabel={create.busy ? t('workbench.workflow_working') : t('workflow.create_submit')}
      onSubmit={() => void create.submit()}
      onClose={create.close}
      initialFocusRef={create.nameRef}
      panelClassName="w-[min(760px,94vw)]"
      bodyClassName="h-[420px]"
      footer={create.errors.length > 0 && (
        <ul className="grid gap-0.5" role="alert" data-testid="wb-workflow-create-errors">
          {create.errors.map((error) => <li key={error} className="truncate whitespace-nowrap text-caption text-red-d" title={error}>{error}</li>)}
        </ul>
      )}
    >
      <div className="grid h-full grid-cols-2 gap-5 max-[640px]:grid-cols-1">
        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-4">
          <FormField label={t('workflow.create_name')} htmlFor="wb-workflow-name" error={nameError} testid="wb-workflow-name-field">
            <input
              ref={create.nameRef}
              id="wb-workflow-name"
              className={INPUT}
              value={create.name}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={create.nameError !== null}
              aria-describedby={nameError === null ? undefined : 'wb-workflow-name-error'}
              data-testid="wb-workflow-name"
              onChange={(event) => create.setName(event.target.value)}
            />
          </FormField>
          <FormField label={t('workflow.create_source')} hint={t('workflow.create_source_hint')} className="min-h-0 grid-rows-[auto_minmax(0,1fr)]" testid="wb-workflow-source-field">
            <div className="min-h-0 overflow-y-auto" role="radiogroup" aria-label={t('workflow.create_source')} data-testid="wb-workflow-sources">
              {options.map((option, index) => {
                const label = option ?? t('workflow.create_mode_blank')
                const checked = option === create.source
                return (
                  <button
                    key={option ?? ''}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    aria-current={checked}
                    tabIndex={checked || (at < 0 && index === 0) ? 0 : -1}
                    className={cn(ROW, LIST_SELECTED_ARIA, checked && 'font-semibold')}
                    title={label}
                    data-testid={`wb-workflow-source-${option ?? 'blank'}`}
                    onClick={() => create.setSource(option)}
                    onKeyDown={(event) => handleRadioKey(event, index, options.length, (next) => create.setSource(options[next] ?? null))}
                  >
                    <span className="truncate">{label}</span>
                  </button>
                )
              })}
            </div>
          </FormField>
          <div className="flex min-h-10 items-center gap-2 text-body text-text-2">
            <Switch id="wb-new-openspec" checked={create.openspec} onCheckedChange={create.setOpenspec} data-testid="wb-new-openspec" />
            <label htmlFor="wb-new-openspec" className="whitespace-nowrap">{t('workflow.openspec')}</label>
          </div>
        </div>
        <section className="flex min-h-0 flex-col rounded-md bg-fill/45" aria-label={t('workflow.create_preview')} data-testid="wb-workflow-preview">
          <header className="flex min-h-10 flex-none items-center gap-2 px-3 whitespace-nowrap">
            <span className="text-caption font-semibold text-text-2">{t('workflow.create_preview')}</span>
            {preview.status === 'ready' && <span className="text-caption tabular-nums text-text-3" data-testid="wb-workflow-preview-count">{preview.stages.length}</span>}
          </header>
          {preview.status === 'loading' && (
            <LoaderCircle className="mx-auto mt-8 size-5 animate-spin text-text-3 motion-reduce:animate-none" aria-label={t('common.loading')} data-testid="wb-workflow-preview-loading" />
          )}
          {preview.status === 'error' && (
            <p className="truncate px-3 text-caption text-red-d" role="alert" title={preview.text} data-testid="wb-workflow-preview-error">{preview.text}</p>
          )}
          {preview.status === 'ready' && (
            <ol className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2" data-testid="wb-workflow-preview-stages">
              {preview.stages.map((stage, index) => (
                <li key={`${index}:${stage}`} className="flex min-h-9 min-w-0 items-center gap-3 px-1.5 whitespace-nowrap">
                  <span className="w-5 flex-none text-right text-caption tabular-nums text-text-3">{index + 1}</span>
                  <span className="truncate text-body text-text" title={stage}>{stage}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </FormDialog>
  )
}
