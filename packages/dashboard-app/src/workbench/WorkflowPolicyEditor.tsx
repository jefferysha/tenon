import { useRef, type FormEvent, type KeyboardEvent } from 'react'
import {
  DEFAULT_WB_DECOMPOSITION_POLICY,
  DEFAULT_WB_INTERACTION_POLICY,
  DEFAULT_WB_REVIEW_BUDGET_POLICY,
  type WbDecompositionAskWhen,
  type WbDecompositionAutoWhen,
  type WbDecompositionMode,
  type WbDecompositionPolicy,
  type WbDecompositionStrategy,
  type WbDecompositionTarget,
  type WbInteractionMode,
} from '../api/governanceTypes'
import { useT } from '../i18n'
import type { WbWorkflowDef } from './workbenchDefinition'
import { BTN_GHOST, BTN_SOLID, MOBILE_TAP } from './workbenchStyles'
import { INPUT } from '../shared/uiRecipes'

export interface WorkflowPolicyEditorProps {
  definition: WbWorkflowDef | null
  readonly: boolean
  loading: boolean
  error: string | null
  dirty: boolean
  saving: boolean
  saveStatus: 'idle' | 'success'
  onChange: (definition: WbWorkflowDef) => void
  onSave: () => void
  onCancel: () => void
  onRetry: () => void
}

const AUTO_CONDITIONS: ReadonlyArray<[WbDecompositionAutoWhen, string]> = [
  ['independent-work-items', 'workbench.policy_auto_independent'],
  ['cross-component-boundary', 'workbench.policy_auto_component'],
  ['context-budget-risk', 'workbench.policy_auto_budget'],
]
const ASK_CONDITIONS: ReadonlyArray<[WbDecompositionAskWhen, string]> = [
  ['ambiguous-requirements', 'workbench.policy_ask_ambiguous'],
  ['hard-boundary', 'workbench.policy_ask_hard_boundary'],
  ['missing-authorization', 'workbench.policy_ask_missing_authorization'],
  ['limit-exceeded', 'workbench.policy_ask_limit'],
]
const DECOMPOSITION_MODES = ['off', 'suggest', 'auto-safe', 'require-review'] as const satisfies readonly WbDecompositionMode[]
const DECOMPOSITION_TARGETS = ['work-items', 'child-pipelines'] as const satisfies readonly WbDecompositionTarget[]
const DECOMPOSITION_STRATEGIES = ['balanced', 'breadth-first', 'depth-first'] as const satisfies readonly WbDecompositionStrategy[]
const INTERACTION_MODES = ['interactive', 'recommended-defaults', 'afk'] as const satisfies readonly WbInteractionMode[]

const LABEL = 'grid gap-1.5 text-caption font-semibold text-text-2'
const CONTROL = `${INPUT} text-body ${MOBILE_TAP}`

function currentDecomposition(definition: WbWorkflowDef): WbDecompositionPolicy {
  return definition.decomposition ?? {
    ...DEFAULT_WB_DECOMPOSITION_POLICY,
    auto_when: [],
    ask_when: [],
  }
}

function closedSelection<T extends string>(value: string, values: readonly T[]): T | null {
  return values.find((candidate) => candidate === value) ?? null
}

export function WorkflowPolicyEditor(props: WorkflowPolicyEditorProps): JSX.Element {
  const { t } = useT()
  const firstControlRef = useRef<HTMLSelectElement>(null)
  const disabled = props.readonly || props.saving

  if (props.loading) {
    return <section className="mb-4 rounded-lg border border-border bg-card p-4" aria-label={t('workbench.policy_title')}><p className="m-0 text-base text-text-3" role="status" aria-live="polite">{t('workbench.policy_loading')}</p></section>
  }
  if (props.error !== null) {
    return <section className="mb-4 rounded-lg border border-red-b bg-red-t p-4" aria-label={t('workbench.policy_title')}>
      <p className="mt-0 mb-3 text-base text-red-d" role="alert">{props.error}</p>
      <button type="button" className={`${BTN_GHOST} ${MOBILE_TAP}`} onClick={props.onRetry}>{t('workbench.policy_retry')}</button>
    </section>
  }
  if (props.definition === null) {
    return <section className="mb-4 rounded-lg border border-border bg-card p-4" aria-label={t('workbench.policy_title')}><p className="m-0 text-base text-text-3" role="status">{t('workbench.policy_empty')}</p></section>
  }

  const definition = props.definition
  const decomposition = currentDecomposition(definition)
  const interaction = definition.interaction ?? DEFAULT_WB_INTERACTION_POLICY
  const reviewBudget = definition.reviewBudget ?? DEFAULT_WB_REVIEW_BUDGET_POLICY

  function changeDecomposition(patch: Partial<WbDecompositionPolicy>): void {
    props.onChange({
      ...definition,
      decomposition: { ...decomposition, ...patch },
      interaction: { ...interaction },
      reviewBudget: { ...reviewBudget },
    })
  }

  function toggleCondition<T extends WbDecompositionAutoWhen | WbDecompositionAskWhen>(
    values: readonly T[],
    value: T,
    checked: boolean,
  ): T[] {
    return checked ? [...values, value] : values.filter((candidate) => candidate !== value)
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (!props.readonly && props.dirty && !props.saving) props.onSave()
  }

  function keyDown(event: KeyboardEvent<HTMLFormElement>): void {
    if (event.key === 'Escape' && !props.readonly && props.dirty && !props.saving) {
      event.preventDefault()
      props.onCancel()
      firstControlRef.current?.focus()
      return
    }
    if (event.key === 'Enter' && event.target instanceof HTMLSelectElement) {
      event.preventDefault()
      if (!props.readonly && props.dirty && !props.saving) props.onSave()
    }
  }

  return (
    <section className="mb-4 rounded-lg border border-border bg-card p-4 shadow-sm" aria-labelledby="workflow-policy-title" data-testid="workflow-policy-editor">
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 id="workflow-policy-title" className="m-0 text-title font-extrabold tracking-[-0.01em] text-text">{t('workbench.policy_title')}</h2>
          <p className="mt-1 mb-0 max-w-3xl text-caption leading-5 text-text-3">{t('workbench.policy_desc')}</p>
        </div>
        {props.readonly && <p className="m-0 rounded-full bg-fill-2 px-3 py-1.5 text-caption font-semibold text-text-3">{t('workbench.policy_readonly')}</p>}
      </div>
      <form data-testid="workflow-policy-form" className="grid gap-4" onSubmit={submit} onKeyDown={keyDown}>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(280px,.75fr)]">
          <fieldset className="min-w-0 rounded-md border border-border bg-bg/50 p-4" disabled={disabled}>
            <legend className="px-1 text-base font-extrabold text-text">{t('workbench.policy_decomposition')}</legend>
            <p className="mt-0 mb-4 text-caption leading-5 text-text-3">{t('workbench.policy_decomposition_desc')}</p>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <label className={LABEL}>{t('workbench.policy_decomposition_mode')}
                <select ref={firstControlRef} className={CONTROL} value={decomposition.mode} aria-label={t('workbench.policy_decomposition_mode')} onChange={(event) => {
                  const mode = closedSelection(event.target.value, DECOMPOSITION_MODES)
                  if (mode !== null) changeDecomposition({ mode })
                }}>
                  <option value="off">{t('workbench.policy_decomposition_mode_off')}</option>
                  <option value="suggest">{t('workbench.policy_decomposition_mode_suggest')}</option>
                  <option value="auto-safe">{t('workbench.policy_decomposition_mode_auto_safe')}</option>
                  <option value="require-review">{t('workbench.policy_decomposition_mode_require_review')}</option>
                </select>
              </label>
              <label className={LABEL}>{t('workbench.policy_decomposition_target')}
                <select className={CONTROL} value={decomposition.target} aria-label={t('workbench.policy_decomposition_target')} onChange={(event) => {
                  const target = closedSelection(event.target.value, DECOMPOSITION_TARGETS)
                  if (target !== null) changeDecomposition({ target })
                }}>
                  <option value="work-items">{t('workbench.policy_decomposition_target_work_items')}</option>
                  <option value="child-pipelines">{t('workbench.policy_decomposition_target_child_pipelines')}</option>
                </select>
              </label>
              <label className={LABEL}>{t('workbench.policy_decomposition_strategy')}
                <select className={CONTROL} value={decomposition.strategy} aria-label={t('workbench.policy_decomposition_strategy')} onChange={(event) => {
                  const strategy = closedSelection(event.target.value, DECOMPOSITION_STRATEGIES)
                  if (strategy !== null) changeDecomposition({ strategy })
                }}>
                  <option value="balanced">{t('workbench.policy_decomposition_strategy_balanced')}</option>
                  <option value="breadth-first">{t('workbench.policy_decomposition_strategy_breadth')}</option>
                  <option value="depth-first">{t('workbench.policy_decomposition_strategy_depth')}</option>
                </select>
              </label>
              <label className={LABEL}>{t('workbench.policy_max_items')}
                <input className={CONTROL} type="number" min={1} max={32} step={1} value={decomposition.max_items} aria-label={t('workbench.policy_max_items')} onChange={(event) => {
                  const value = event.currentTarget.valueAsNumber
                  if (Number.isInteger(value) && value >= 1 && value <= 32) changeDecomposition({ max_items: value })
                }} />
              </label>
              <label className={LABEL}>{t('workbench.policy_max_depth')}
                <input className={CONTROL} type="number" min={0} max={4} step={1} value={decomposition.max_depth} aria-label={t('workbench.policy_max_depth')} onChange={(event) => {
                  const value = event.currentTarget.valueAsNumber
                  if (Number.isInteger(value) && value >= 0 && value <= 4) changeDecomposition({ max_depth: value })
                }} />
              </label>
            </div>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <div role="group" aria-label={t('workbench.policy_auto_when')}>
                <h3 className="mt-0 mb-2 text-caption font-bold text-text-2">{t('workbench.policy_auto_when')}</h3>
                <div className="grid gap-2">{AUTO_CONDITIONS.map(([value, key]) => <label key={value} className="flex min-h-9 items-center gap-2 rounded-md border border-border bg-card px-3 text-caption text-text-2 mobile:min-h-11"><input type="checkbox" className="mobile:size-5" checked={decomposition.auto_when.includes(value)} onChange={(event) => changeDecomposition({ auto_when: toggleCondition(decomposition.auto_when, value, event.target.checked) })} />{t(key)}</label>)}</div>
              </div>
              <div role="group" aria-label={t('workbench.policy_ask_when')}>
                <h3 className="mt-0 mb-2 text-caption font-bold text-text-2">{t('workbench.policy_ask_when')}</h3>
                <div className="grid gap-2">{ASK_CONDITIONS.map(([value, key]) => <label key={value} className="flex min-h-9 items-center gap-2 rounded-md border border-border bg-card px-3 text-caption text-text-2 mobile:min-h-11"><input type="checkbox" className="mobile:size-5" checked={decomposition.ask_when.includes(value)} onChange={(event) => changeDecomposition({ ask_when: toggleCondition(decomposition.ask_when, value, event.target.checked) })} />{t(key)}</label>)}</div>
              </div>
            </div>
          </fieldset>
          <fieldset className="min-w-0 rounded-md border border-border bg-bg/50 p-4" disabled={disabled}>
            <legend className="px-1 text-base font-extrabold text-text">{t('workbench.policy_interaction')}</legend>
            <p className="mt-0 mb-4 text-caption leading-5 text-text-3">{t('workbench.policy_interaction_desc')}</p>
            <label className={LABEL}>{t('workbench.policy_interaction_mode')}
              <select className={CONTROL} value={interaction.mode} aria-label={t('workbench.policy_interaction_mode')} onChange={(event) => {
                const mode = closedSelection(event.target.value, INTERACTION_MODES)
                if (mode !== null) props.onChange({ ...definition, decomposition: { ...decomposition }, interaction: { version: 'v1', mode } })
              }}>
                <option value="interactive">{t('workbench.policy_interaction_interactive')}</option>
                <option value="recommended-defaults">{t('workbench.policy_interaction_recommended')}</option>
                <option value="afk">{t('workbench.policy_interaction_afk')}</option>
              </select>
            </label>
            <p className="mt-3 mb-0 rounded-md border border-border bg-card px-3 py-2.5 text-micro leading-5 text-text-3">{t('workbench.policy_interaction_afk_note')}</p>
            <div className="mt-4 border-t border-border pt-4">
              <h3 className="mt-0 mb-1 text-base font-extrabold text-text">{t('workbench.policy_review_budget')}</h3>
              <p className="mt-0 mb-3 text-caption leading-5 text-text-3">{t('workbench.policy_review_budget_desc')}</p>
              <label className={LABEL}>{t('workbench.policy_review_max_attempts')}
                <input className={CONTROL} type="number" min={1} max={20} step={1} value={reviewBudget.max_attempts} aria-label={t('workbench.policy_review_max_attempts')} onChange={(event) => {
                  const value = event.currentTarget.valueAsNumber
                  if (Number.isInteger(value) && value >= 1 && value <= 20) {
                    props.onChange({
                      ...definition,
                      decomposition: { ...decomposition },
                      interaction: { ...interaction },
                      reviewBudget: { version: 'v1', max_attempts: value },
                    })
                  }
                }} />
              </label>
            </div>
          </fieldset>
        </div>
        {!props.readonly && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
          {props.saving && <span role="status" aria-live="polite" className="mr-auto text-caption font-semibold text-text-3">{t('workbench.policy_saving')}</span>}
          {!props.saving && props.saveStatus === 'success' && !props.dirty && <span role="status" aria-live="polite" className="mr-auto text-caption font-semibold text-green-d">{t('workbench.policy_saved')}</span>}
          <button type="button" className={`${BTN_GHOST} ${MOBILE_TAP}`} disabled={!props.dirty || props.saving} onClick={props.onCancel}>{t('workbench.policy_cancel')}</button>
          <button type="submit" className={`${BTN_SOLID} ${MOBILE_TAP}`} disabled={!props.dirty || props.saving}>{t('workbench.policy_save')}</button>
        </div>}
      </form>
    </section>
  )
}
