import { useId, useState, type ReactNode } from 'react'
import { CircleHelp, Plus, Trash2 } from 'lucide-react'
import { useT } from '../i18n'
import { Drawer } from '../shared/Drawer'
import type { WbStepTest, WbTestInput, WbTestOutput } from '../api/governanceTypes'
import { Hint } from './Hint'

const FIELD = 'min-h-10 w-full rounded-sm border border-border bg-card px-3 text-body text-text outline-none focus-visible:ring-2 focus-visible:ring-(--accent) disabled:opacity-60'
const LABEL = 'grid gap-1.5 text-caption text-text-2'
const SMALL = 'inline-flex min-h-8 items-center gap-1.5 rounded-sm border border-border bg-card px-2.5 text-caption text-text hover:border-text-3'

function number(value: string): number | undefined {
  const parsed = Number(value)
  return value === '' || !Number.isFinite(parsed) ? undefined : parsed
}

/** 问号：字段说明只在 Tooltip（悬停与键盘聚焦）。 */
function HelpIcon({ help }: { help: string }): JSX.Element {
  return (
    <Hint label={help}>
      <button type="button" className="grid size-5 place-items-center rounded-xs text-text-3 outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent)" aria-label={help}>
        <CircleHelp className="size-3.5" aria-hidden="true" />
      </button>
    </Hint>
  )
}

/** 字段名 + 问号。 */
function FieldName({ text, help, htmlFor }: { text: string; help: string; htmlFor?: string }): JSX.Element {
  return (
    <span className="flex items-center gap-1 whitespace-nowrap">
      {htmlFor === undefined ? <span>{text}</span> : <label htmlFor={htmlFor}>{text}</label>}
      <HelpIcon help={help} />
    </span>
  )
}

function Field({ name, help, children }: { name: string; help: string; children: (id: string) => ReactNode }): JSX.Element {
  const id = useId()
  return (
    <div className={LABEL}>
      <FieldName text={name} help={help} htmlFor={id} />
      {children(id)}
    </div>
  )
}

/**
 * 一个测试项的编辑面板：改动即时进入工作流草稿（与右栏其它编辑一致），真正写盘仍走页面保存条；
 * 没有单独的「应用」。删除要二次确认。
 */
export function TestEditorDrawer({
  test,
  editable,
  onApply,
  onDelete,
  onClose,
}: {
  test: WbStepTest | null
  editable: boolean
  /** 每次字段改动都交回整份测试项。 */
  onApply: (next: WbStepTest) => void
  onDelete: (id: string) => void
  onClose: () => void
}): JSX.Element | null {
  const { t } = useT()
  const [confirm, setConfirm] = useState<string | null>(null)
  if (test === null) return null
  const current = test
  const patch = (next: Partial<WbStepTest>): void => onApply({ ...current, ...next })
  const setInputs = (inputs: WbTestInput[]): void => patch({ inputs })
  const setOutputs = (outputs: WbTestOutput[]): void => patch({ outputs })
  const confirming = confirm === current.id

  return (
    <Drawer
      open
      onClose={onClose}
      testId="test-editor-drawer"
      ariaLabel={current.label ?? current.id}
      title={<span className="truncate">{current.label ?? current.id}</span>}
    >
      <div className="grid gap-4">
        <Field name={t('workflow.test_label')} help={t('workflow.test_help_label')}>
          {(id) => <input id={id} className={FIELD} data-testid="wb-test-label" disabled={!editable} value={current.label ?? ''} onChange={(event) => patch({ label: event.target.value })} />}
        </Field>
        <div className={LABEL}>
          <FieldName text={t('workflow.test_direction')} help={t('workflow.test_help_direction')} />
          <span className="inline-flex min-h-10 items-center rounded-sm border border-border bg-fill px-3 font-mono text-body text-text-2" data-testid="wb-test-direction">{current.direction}</span>
        </div>
        <Field name={t('workflow.test_command')} help={t('workflow.test_help_command')}>
          {(id) => <input id={id} className={`${FIELD} font-mono`} data-testid="wb-test-command" disabled={!editable} value={current.command} onChange={(event) => patch({ command: event.target.value })} />}
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field name={t('workflow.test_cwd')} help={t('workflow.test_help_cwd')}>
            {(id) => <input id={id} className={`${FIELD} font-mono`} data-testid="wb-test-cwd" disabled={!editable} value={current.cwd ?? ''} onChange={(event) => patch({ cwd: event.target.value })} />}
          </Field>
          <Field name={t('workflow.test_timeout')} help={t('workflow.test_help_timeout')}>
            {(id) => <input id={id} className={FIELD} type="number" data-testid="wb-test-timeout" disabled={!editable} value={current.timeout_s ?? ''} onChange={(event) => patch({ timeout_s: number(event.target.value) })} />}
          </Field>
          <Field name={t('workflow.test_keep')} help={t('workflow.test_help_keep')}>
            {(id) => <input id={id} className={FIELD} type="number" data-testid="wb-test-keep" disabled={!editable} value={current.keep_runs ?? ''} onChange={(event) => patch({ keep_runs: number(event.target.value) })} />}
          </Field>
          <Field name={t('workflow.test_exit_code')} help={t('workflow.test_help_exit_code')}>
            {(id) => (
              <input
                id={id}
                className={FIELD}
                type="number"
                data-testid="wb-test-exit"
                disabled={!editable}
                value={current.pass?.exit_code ?? ''}
                onChange={(event) => patch({ pass: { ...current.pass, exit_code: number(event.target.value) } })}
              />
            )}
          </Field>
          <Field name={t('workflow.test_scope')} help={t('workflow.test_help_scope')}>
            {(id) => (
              <select id={id} className={FIELD} data-testid="wb-test-scope" disabled={!editable} value={current.scope ?? ''} onChange={(event) => patch({ scope: event.target.value === 'full' || event.target.value === 'known' ? event.target.value : undefined })}>
                <option value="">{t('workflow.test_scope_none')}</option>
                <option value="full">{t('workflow.test_scope_full')}</option>
                <option value="known">{t('workflow.test_scope_known')}</option>
              </select>
            )}
          </Field>
          <Field name={t('workflow.test_metrics_path')} help={t('workflow.test_help_metrics_path')}>
            {(id) => <input id={id} className={`${FIELD} font-mono`} data-testid="wb-test-metrics-path" disabled={!editable} value={current.metrics_path ?? ''} onChange={(event) => patch({ metrics_path: event.target.value })} />}
          </Field>
        </div>
        <span className="flex items-center gap-2 text-caption text-text-2">
          <label className="flex items-center gap-2">
            <input type="checkbox" data-testid="wb-test-required" disabled={!editable} checked={current.required !== false} onChange={(event) => patch({ required: event.target.checked })} />
            {t('workflow.test_required')}
          </label>
          <HelpIcon help={t('workflow.test_help_required')} />
        </span>

        <section className="grid gap-2" data-testid="wb-test-inputs">
          <span className="flex items-center justify-between text-caption text-text-2">
            <FieldName text={t('workflow.test_inputs')} help={t('workflow.test_help_inputs')} />
            {editable && (
              <button type="button" className={SMALL} aria-label={t('workflow.test_inputs')} data-testid="wb-test-input-add" onClick={() => setInputs([...(current.inputs ?? []), { kind: 'file', path: '' }])}>
                <Plus className="size-3" aria-hidden="true" />
              </button>
            )}
          </span>
          {(current.inputs ?? []).map((input, index) => (
            <span key={index} className="flex items-center gap-2" data-testid={`wb-test-input-${index}`}>
              <span className="w-20 flex-none truncate whitespace-nowrap font-mono text-caption text-text-3">{t(`workflow.test_input_kind_${input.kind}`)}</span>
              <input
                className={`${FIELD} font-mono`}
                disabled={!editable}
                aria-label={t(`workflow.test_input_kind_${input.kind}`)}
                value={input.kind === 'document' ? input.ref : input.kind === 'file' ? input.path : input.name}
                onChange={(event) => setInputs((current.inputs ?? []).map((item, at) => at === index
                  ? item.kind === 'document' ? { kind: 'document', ref: event.target.value }
                    : item.kind === 'file' ? { kind: 'file', path: event.target.value }
                      : { ...item, name: event.target.value }
                  : item))}
              />
              {editable && (
                <button type="button" className={SMALL} aria-label={t('workflow.test_delete')} data-testid={`wb-test-input-remove-${index}`} onClick={() => setInputs((current.inputs ?? []).filter((_, at) => at !== index))}>
                  <Trash2 className="size-3" aria-hidden="true" />
                </button>
              )}
            </span>
          ))}
        </section>

        <section className="grid gap-2" data-testid="wb-test-outputs">
          <span className="flex items-center justify-between text-caption text-text-2">
            <FieldName text={t('workflow.test_outputs')} help={t('workflow.test_help_outputs')} />
            {editable && (
              <button type="button" className={SMALL} aria-label={t('workflow.test_outputs')} data-testid="wb-test-output-add" onClick={() => setOutputs([...(current.outputs ?? []), { path: '', kind: 'report', required: false }])}>
                <Plus className="size-3" aria-hidden="true" />
              </button>
            )}
          </span>
          {(current.outputs ?? []).map((output, index) => (
            <span key={index} className="flex items-center gap-2" data-testid={`wb-test-output-${index}`}>
              <input
                className={`${FIELD} font-mono`}
                disabled={!editable}
                aria-label={t('workflow.test_outputs')}
                value={output.path}
                onChange={(event) => setOutputs((current.outputs ?? []).map((item, at) => at === index ? { ...item, path: event.target.value } : item))}
              />
              {/* 产物级「必须生成」只留勾选框，名称与说明在 Tooltip，不与测试项的「必需」重复出现。 */}
              <Hint label={t('workflow.test_output_required')}>
                <input
                  type="checkbox"
                  className="flex-none"
                  aria-label={t('workflow.test_output_required')}
                  data-testid={`wb-test-output-required-${index}`}
                  disabled={!editable}
                  checked={output.required === true}
                  onChange={(event) => setOutputs((current.outputs ?? []).map((item, at) => at === index ? { ...item, required: event.target.checked } : item))}
                />
              </Hint>
              {editable && (
                <button type="button" className={SMALL} aria-label={t('workflow.test_delete')} data-testid={`wb-test-output-remove-${index}`} onClick={() => setOutputs((current.outputs ?? []).filter((_, at) => at !== index))}>
                  <Trash2 className="size-3" aria-hidden="true" />
                </button>
              )}
            </span>
          ))}
        </section>

        {editable && (
          <div className="flex items-center gap-2 border-t border-border pt-4">
            {confirming ? (
              <button type="button" className={`${SMALL} border-red-b text-red-d`} data-testid="wb-test-delete-confirm" onClick={() => { onDelete(current.id); onClose() }}>
                {t('workflow.test_delete')}
              </button>
            ) : (
              <button type="button" className={`${SMALL} text-red-d`} data-testid="wb-test-delete" onClick={() => setConfirm(current.id)}>
                <Trash2 className="size-3" aria-hidden="true" />
                {t('workflow.test_delete')}
              </button>
            )}
          </div>
        )}
      </div>
    </Drawer>
  )
}
