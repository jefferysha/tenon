import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { useT } from '../i18n'
import { Drawer } from '../shared/Drawer'
import type { WbStepTest, WbTestInput, WbTestOutput } from '../api/governanceTypes'

const FIELD = 'min-h-10 w-full rounded-sm border border-border bg-card px-3 text-body text-text outline-none focus-visible:ring-2 focus-visible:ring-(--accent) disabled:opacity-60'
const LABEL = 'grid gap-1.5 text-caption text-text-2'
const SMALL = 'inline-flex min-h-8 items-center gap-1.5 rounded-sm border border-border bg-card px-2.5 text-caption text-text hover:border-text-3'

function number(value: string): number | undefined {
  const parsed = Number(value)
  return value === '' || !Number.isFinite(parsed) ? undefined : parsed
}

/** 一个测试项的编辑面板。Esc 关闭不写回，「应用」把整份改动交给草稿。 */
export function TestEditorDrawer({
  test,
  editable,
  onApply,
  onDelete,
  onClose,
}: {
  test: WbStepTest | null
  editable: boolean
  onApply: (next: WbStepTest) => void
  onDelete: (id: string) => void
  onClose: () => void
}): JSX.Element | null {
  const { t } = useT()
  const [draft, setDraft] = useState<WbStepTest | null>(test)
  const [confirm, setConfirm] = useState(false)
  const [editing, setEditing] = useState(test?.id ?? null)
  if (test === null) return null
  if (editing !== test.id) {
    setEditing(test.id)
    setDraft(test)
    setConfirm(false)
  }
  const current = draft ?? test
  const patch = (next: Partial<WbStepTest>): void => setDraft({ ...current, ...next })
  const setInputs = (inputs: WbTestInput[]): void => patch({ inputs })
  const setOutputs = (outputs: WbTestOutput[]): void => patch({ outputs })

  return (
    <Drawer
      open
      onClose={onClose}
      testId="test-editor-drawer"
      ariaLabel={current.label ?? current.id}
      title={<span className="truncate">{current.label ?? current.id}</span>}
    >
      <div className="grid gap-4">
        <label className={LABEL}>
          {t('workflow.test_label')}
          <input className={FIELD} data-testid="wb-test-label" disabled={!editable} value={current.label ?? ''} onChange={(event) => patch({ label: event.target.value })} />
        </label>
        <p className={LABEL}>
          {t('workflow.test_direction')}
          <span className="inline-flex min-h-10 items-center rounded-sm border border-border bg-fill px-3 font-mono text-body text-text-2" data-testid="wb-test-direction">{current.direction}</span>
        </p>
        <label className={LABEL}>
          {t('workflow.test_command')}
          <input className={`${FIELD} font-mono`} data-testid="wb-test-command" disabled={!editable} value={current.command} onChange={(event) => patch({ command: event.target.value })} />
        </label>
        <div className="grid grid-cols-2 gap-4">
          <label className={LABEL}>
            {t('workflow.test_cwd')}
            <input className={`${FIELD} font-mono`} data-testid="wb-test-cwd" disabled={!editable} value={current.cwd ?? ''} onChange={(event) => patch({ cwd: event.target.value })} />
          </label>
          <label className={LABEL}>
            {t('workflow.test_timeout')}
            <input className={FIELD} type="number" data-testid="wb-test-timeout" disabled={!editable} value={current.timeout_s ?? ''} onChange={(event) => patch({ timeout_s: number(event.target.value) })} />
          </label>
          <label className={LABEL}>
            {t('workflow.test_keep')}
            <input className={FIELD} type="number" data-testid="wb-test-keep" disabled={!editable} value={current.keep_runs ?? ''} onChange={(event) => patch({ keep_runs: number(event.target.value) })} />
          </label>
          <label className={LABEL}>
            {t('workflow.test_exit_code')}
            <input
              className={FIELD}
              type="number"
              data-testid="wb-test-exit"
              disabled={!editable}
              value={current.pass?.exit_code ?? ''}
              onChange={(event) => patch({ pass: { ...current.pass, exit_code: number(event.target.value) } })}
            />
          </label>
          <label className={LABEL}>
            {t('workflow.test_scope')}
            <select className={FIELD} data-testid="wb-test-scope" disabled={!editable} value={current.scope ?? ''} onChange={(event) => patch({ scope: event.target.value === '' ? undefined : event.target.value as 'full' | 'known' })}>
              <option value="">{t('workflow.test_scope_none')}</option>
              <option value="full">{t('workflow.test_scope_full')}</option>
              <option value="known">{t('workflow.test_scope_known')}</option>
            </select>
          </label>
          <label className={LABEL}>
            {t('workflow.test_metrics_path')}
            <input className={`${FIELD} font-mono`} data-testid="wb-test-metrics-path" disabled={!editable} value={current.metrics_path ?? ''} onChange={(event) => patch({ metrics_path: event.target.value })} />
          </label>
        </div>
        <label className="flex items-center gap-2 text-caption text-text-2">
          <input type="checkbox" data-testid="wb-test-required" disabled={!editable} checked={current.required !== false} onChange={(event) => patch({ required: event.target.checked })} />
          {t('workflow.test_required')}
        </label>

        <section className="grid gap-2" data-testid="wb-test-inputs">
          <span className="flex items-center justify-between text-caption text-text-2">
            {t('workflow.test_inputs')}
            {editable && (
              <button type="button" className={SMALL} data-testid="wb-test-input-add" onClick={() => setInputs([...(current.inputs ?? []), { kind: 'file', path: '' }])}>
                <Plus className="size-3" aria-hidden="true" />
              </button>
            )}
          </span>
          {(current.inputs ?? []).map((input, index) => (
            <span key={index} className="flex items-center gap-2" data-testid={`wb-test-input-${index}`}>
              <span className="w-20 flex-none font-mono text-caption text-text-3">{t(`workflow.test_input_kind_${input.kind}`)}</span>
              <input
                className={`${FIELD} font-mono`}
                disabled={!editable}
                value={input.kind === 'document' ? input.ref : input.kind === 'file' ? input.path : input.name}
                onChange={(event) => setInputs((current.inputs ?? []).map((item, at) => at === index
                  ? item.kind === 'document' ? { kind: 'document', ref: event.target.value }
                    : item.kind === 'file' ? { kind: 'file', path: event.target.value }
                      : { ...item, name: event.target.value }
                  : item))}
              />
              {editable && (
                <button type="button" className={SMALL} data-testid={`wb-test-input-remove-${index}`} onClick={() => setInputs((current.inputs ?? []).filter((_, at) => at !== index))}>
                  <Trash2 className="size-3" aria-hidden="true" />
                </button>
              )}
            </span>
          ))}
        </section>

        <section className="grid gap-2" data-testid="wb-test-outputs">
          <span className="flex items-center justify-between text-caption text-text-2">
            {t('workflow.test_outputs')}
            {editable && (
              <button type="button" className={SMALL} data-testid="wb-test-output-add" onClick={() => setOutputs([...(current.outputs ?? []), { path: '', kind: 'report', required: false }])}>
                <Plus className="size-3" aria-hidden="true" />
              </button>
            )}
          </span>
          {(current.outputs ?? []).map((output, index) => (
            <span key={index} className="flex items-center gap-2" data-testid={`wb-test-output-${index}`}>
              <input
                className={`${FIELD} font-mono`}
                disabled={!editable}
                value={output.path}
                onChange={(event) => setOutputs((current.outputs ?? []).map((item, at) => at === index ? { ...item, path: event.target.value } : item))}
              />
              <label className="flex flex-none items-center gap-1 text-caption text-text-2">
                <input
                  type="checkbox"
                  disabled={!editable}
                  checked={output.required === true}
                  onChange={(event) => setOutputs((current.outputs ?? []).map((item, at) => at === index ? { ...item, required: event.target.checked } : item))}
                />
                {t('workflow.test_required')}
              </label>
              {editable && (
                <button type="button" className={SMALL} data-testid={`wb-test-output-remove-${index}`} onClick={() => setOutputs((current.outputs ?? []).filter((_, at) => at !== index))}>
                  <Trash2 className="size-3" aria-hidden="true" />
                </button>
              )}
            </span>
          ))}
        </section>

        {editable && (
          <div className="flex items-center justify-between gap-2 border-t border-border pt-4">
            {confirm ? (
              <button type="button" className={`${SMALL} border-red-b text-red-d`} data-testid="wb-test-delete-confirm" onClick={() => { onDelete(current.id); onClose() }}>
                {t('workflow.test_delete')}
              </button>
            ) : (
              <button type="button" className={`${SMALL} text-red-d`} data-testid="wb-test-delete" onClick={() => setConfirm(true)}>
                <Trash2 className="size-3" aria-hidden="true" />
                {t('workflow.test_delete')}
              </button>
            )}
            <button
              type="button"
              className="min-h-10 rounded-md border border-accent-b bg-accent-t px-4 text-base font-semibold text-(--accent)"
              data-testid="wb-test-apply"
              onClick={() => { onApply(current); onClose() }}
            >
              {t('workflow.test_apply')}
            </button>
          </div>
        )}
      </div>
    </Drawer>
  )
}
