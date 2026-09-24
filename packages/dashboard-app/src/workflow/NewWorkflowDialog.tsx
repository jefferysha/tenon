import { useT } from '../i18n'
import { Dialog } from '../shared/Dialog'
import { BTN_GHOST, BTN_SOLID, FIELD_INPUT } from '../workbench/workbenchStyles'
import type { CreateMode, CreateState } from '../workbench/useWorkflowEditor'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

const MODES: readonly CreateMode[] = ['copy', 'blank', 'import']

/** 新建工作流：复制当前 / 空白 / 导入 YAML → 命名 → 创建并进入编辑。 */
export function NewWorkflowDialog({ create, currentName }: { create: CreateState; currentName: string | null }): JSX.Element | null {
  const { t } = useT()
  if (!create.open) return null
  return (
    <Dialog title={t('workflow.create_title')} onClose={create.close} testid="wb-workflow-create-dialog" initialFocusRef={create.nameRef} panelClassName="w-[560px] max-w-[calc(100vw-32px)]">
      <form onSubmit={(event) => { event.preventDefault(); void create.submit() }} data-testid="wb-workflow-create-form">
        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label={t('workflow.create_title')}>
          {MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={create.mode === mode}
              className={cn('min-h-10 min-w-0 whitespace-nowrap rounded-sm border px-3 text-body text-text-2 outline-none focus-visible:ring-2 focus-visible:ring-(--accent)', create.mode === mode ? 'border-accent-b bg-accent-t font-semibold text-(--accent)' : 'border-border bg-card hover:bg-fill')}
              data-testid={`wb-new-template-${mode}`}
              onClick={() => create.setMode(mode)}
            >
              <span className="block truncate" title={mode === 'copy' ? t('workflow.create_mode_copy', { name: currentName ?? '' }) : undefined}>
                {mode === 'copy' ? t('workflow.create_mode_copy', { name: currentName ?? '' }) : t(`workflow.create_mode_${mode}`)}
              </span>
            </button>
          ))}
        </div>
        {create.mode !== 'import' && (
          <div className="mt-4 flex items-center gap-2 text-body text-text-2">
            <Switch id="wb-new-openspec" checked={create.openspec} onCheckedChange={create.setOpenspec} data-testid="wb-new-openspec" />
            <label htmlFor="wb-new-openspec">{t('workflow.openspec')}</label>
          </div>
        )}
        {create.mode === 'import' && (
          <div className="mt-4 grid gap-2">
            <textarea
              className={`${FIELD_INPUT} min-h-40 resize-y font-mono text-caption leading-5`}
              value={create.yaml}
              placeholder={t('workflow.create_yaml_placeholder')}
              aria-label={t('workflow.create_yaml')}
              data-testid="wb-import-text"
              onChange={(event) => create.setYaml(event.target.value)}
            />
            <label className="flex items-center gap-2 text-body text-text-2">
              <span>{t('workflow.create_yaml_file')}</span>
              <input
                type="file"
                accept=".yaml,.yml,text/yaml"
                className="text-caption"
                data-testid="wb-import-file"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (!file) return
                  void file.text().then((text) => create.setYaml(text))
                }}
              />
            </label>
          </div>
        )}
        <div className="mt-4 flex flex-col gap-1 text-caption font-semibold text-text-2">
          <label htmlFor="wb-workflow-name">{t('workflow.create_name')}</label>
          <input ref={create.nameRef} id="wb-workflow-name" className={FIELD_INPUT} value={create.name} aria-invalid={create.nameInvalid || create.nameDuplicate} data-testid="wb-workflow-name" onChange={(event) => create.setName(event.target.value)} />
          {create.nameInvalid && <span className="text-caption text-red" role="alert">{t('workflow.name_invalid')}</span>}
          {create.nameDuplicate && <span className="text-caption text-red" role="alert">{t('workflow.name_duplicate')}</span>}
        </div>
        {create.errors.length > 0 && (
          <ul className="mt-3 rounded-sm border border-red-b bg-red-t p-2.5" role="alert" data-testid="wb-import-errors">
            {create.errors.map((error) => <li key={error} className="text-caption text-red-d">{error}</li>)}
          </ul>
        )}
        <div className="mt-4 flex justify-end gap-2 border-t border-border pt-3.5">
          <button type="button" className={BTN_GHOST} onClick={create.close}>{t('workflow.cancel')}</button>
          <button type="submit" className={BTN_SOLID} data-testid="wb-workflow-create-confirm" disabled={!create.canSubmit}>{create.busy ? t('workbench.workflow_working') : t('workflow.create_submit')}</button>
        </div>
      </form>
    </Dialog>
  )
}
