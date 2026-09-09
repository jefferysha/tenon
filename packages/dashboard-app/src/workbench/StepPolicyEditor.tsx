import type { WbActionConfig, WbArtifactConfig, WbFieldRef, WbGuardConfig, WbStepDef, WbTrackPredicate } from './WorkbenchView'
import { useT } from '../i18n'

export interface StepPolicyEditorProps {
  step: WbStepDef
  allStepIds: string[]
  readonly?: boolean
  onChange: (step: WbStepDef) => void
}

const INPUT = 'min-h-9 w-full rounded-sm border border-border bg-bg px-2.5 py-2 text-caption text-text outline-none focus:border-(--accent) focus:ring-2 focus:ring-accent-t disabled:cursor-not-allowed disabled:bg-fill disabled:text-text-3'
const SELECT = `${INPUT} cursor-pointer disabled:cursor-not-allowed`
const MINI = 'rounded-sm border border-border bg-card px-2 py-1.5 text-micro font-semibold text-text-2 hover:border-border-2 disabled:cursor-not-allowed disabled:opacity-50'
const DANGER = 'rounded-sm border border-red-b bg-transparent px-2 py-1.5 text-micro font-semibold text-red-d hover:bg-red-t disabled:cursor-not-allowed disabled:opacity-50'
const CARD = 'rounded-md border border-border bg-card p-3 shadow-sm'
const SUMMARY = 'cursor-pointer select-none py-3 text-body font-bold text-text marker:text-text-3'

const GUARD_TYPES: WbGuardConfig['type'][] = [
  'tasks-at-least', 'nonempty-output', 'field-nonempty', 'file-exists',
  'field-equals', 'field-in', 'full-direct-override', 'build-head-unchanged',
  'spec-migration-applied',
]
const ACTION_TYPES: WbActionConfig['type'][] = [
  'freeze-build-sha', 'mark-verification-passed', 'mark-verification-failed',
  'reset-pre-verify-review', 'archive-run',
]

function csv(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

function guardFactory(type: WbGuardConfig['type']): WbGuardConfig {
  switch (type) {
    case 'tasks-at-least': return { type, n: 1 }
    case 'nonempty-output': return { type }
    case 'field-nonempty': return { type, field: 'branch' }
    case 'file-exists': return { type, path: { kind: 'field', field: 'verification_report' } }
    case 'field-equals': return { type, field: 'branch_status', value: 'pending' }
    case 'field-in': return { type, field: 'isolation', values: ['branch'] }
    case 'full-direct-override': return { type }
    case 'build-head-unchanged': return { type, field: 'build_sha' }
    case 'spec-migration-applied': return { type }
  }
}

function withWhen(guard: WbGuardConfig, when: WbTrackPredicate | undefined): WbGuardConfig {
  const { when: _old, ...base } = guard
  return (when === undefined ? base : { ...base, when }) as WbGuardConfig
}

function GuardRow({ guard, readonly, label, onChange, onRemove }: {
  guard: WbGuardConfig
  readonly: boolean
  label: string
  onChange: (guard: WbGuardConfig) => void
  onRemove: () => void
}): JSX.Element {
  const { t } = useT()
  const fieldInput = (field: string, set: (value: string) => WbGuardConfig): JSX.Element => (
    <label className="grid gap-1 text-micro font-semibold text-text-3">
      {t('workbench.step_field')}
      <input className={INPUT} value={field} disabled={readonly} onChange={(event) => onChange(set(event.target.value))} />
    </label>
  )
  return (
    <div className="rounded-sm border border-border bg-bg/60 p-2.5" data-testid={`step-guard-${guard.type}`}>
      <div className="mb-2 flex items-center gap-2">
        <span className="min-w-0 flex-1 font-mono text-micro font-bold text-accent-d">{label}</span>
        {!readonly && <button className={DANGER} type="button" onClick={onRemove}>{t('workbench.step_remove')}</button>}
      </div>
      <div className="grid grid-cols-2 gap-2 mobile:grid-cols-1">
        {guard.type === 'tasks-at-least' && (
          <label className="grid gap-1 text-micro font-semibold text-text-3">
            {t('workbench.step_task_count')}
            <input className={INPUT} type="number" min={0} value={guard.n} disabled={readonly} onChange={(event) => onChange({ ...guard, n: Number(event.target.value) })} />
          </label>
        )}
        {guard.type === 'field-nonempty' && fieldInput(guard.field, (field) => ({ ...guard, field }))}
        {guard.type === 'file-exists' && fieldInput(guard.path.field, (field) => ({ ...guard, path: { kind: 'field', field } }))}
        {guard.type === 'field-equals' && (
          <>
            {fieldInput(guard.field, (field) => ({ ...guard, field }))}
            <label className="grid gap-1 text-micro font-semibold text-text-3">
              {t('workbench.step_expected')}
              <input className={INPUT} value={guard.value} disabled={readonly} onChange={(event) => onChange({ ...guard, value: event.target.value })} />
            </label>
          </>
        )}
        {guard.type === 'field-in' && (
          <>
            {fieldInput(guard.field, (field) => ({ ...guard, field }))}
            <label className="grid gap-1 text-micro font-semibold text-text-3">
              {t('workbench.step_values')}
              <input className={INPUT} value={guard.values.join(', ')} disabled={readonly} onChange={(event) => onChange({ ...guard, values: (csv(event.target.value).length > 0 ? csv(event.target.value) : ['']) as [string, ...string[]] })} />
            </label>
          </>
        )}
        {guard.type === 'build-head-unchanged' && <p className="text-caption text-text-3">build_sha</p>}
        {(guard.type === 'nonempty-output' || guard.type === 'full-direct-override' || guard.type === 'spec-migration-applied') && (
          <p className="col-span-2 text-caption leading-relaxed text-text-3 mobile:col-span-1">{t(`workbench.step_guard_note_${guard.type}`)}</p>
        )}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 mobile:grid-cols-1">
        <label className="grid gap-1 text-micro font-semibold text-text-3">
          {t('workbench.step_track_scope')}
          <select
            className={SELECT}
            value={guard.when?.kind ?? ''}
            disabled={readonly}
            onChange={(event) => onChange(withWhen(guard, event.target.value === '' ? undefined : { kind: event.target.value as WbTrackPredicate['kind'], values: guard.when?.values ?? ['backend'] }))}
          >
            <option value="">{t('workbench.step_all_tracks')}</option>
            <option value="track-in">track-in</option>
            <option value="track-not-in">track-not-in</option>
          </select>
        </label>
        {guard.when && (
          <label className="grid gap-1 text-micro font-semibold text-text-3">
            {t('workbench.step_tracks')}
            <input
              className={INPUT}
              value={guard.when.values.join(', ')}
              disabled={readonly}
              onChange={(event) => {
                const when = guard.when
                if (when) onChange(withWhen(guard, { kind: when.kind, values: csv(event.target.value) }))
              }}
            />
          </label>
        )}
      </div>
    </div>
  )
}

function GuardList({ guards, readonly, addLabel, onChange }: {
  guards: WbGuardConfig[]
  readonly: boolean
  addLabel: string
  onChange: (guards: WbGuardConfig[]) => void
}): JSX.Element {
  const { t } = useT()
  return (
    <div className="grid gap-2">
      {guards.length === 0 && <p className="text-caption text-text-3" role="status" aria-live="polite">{t('workbench.step_none')}</p>}
      {guards.map((guard, index) => (
        <GuardRow
          key={`${guard.type}-${index}`}
          guard={guard}
          readonly={readonly}
          label={t(`workbench.step_guard_${guard.type}`)}
          onChange={(next) => onChange(guards.map((item, i) => i === index ? next : item))}
          onRemove={() => onChange(guards.filter((_, i) => i !== index))}
        />
      ))}
      {!readonly && (
        <select className={SELECT} aria-label={addLabel} value="" onChange={(event) => event.target.value && onChange([...guards, guardFactory(event.target.value as WbGuardConfig['type'])])}>
          <option value="">{t('workbench.step_add_guard')}</option>
          {GUARD_TYPES.map((type) => <option key={type} value={type}>{t(`workbench.step_guard_${type}`)}</option>)}
        </select>
      )}
    </div>
  )
}

export function StepPolicyEditor({ step, allStepIds, readonly = false, onChange }: StepPolicyEditorProps): JSX.Element {
  const { t } = useT()
  const updateRefs = (kind: 'inputs' | 'outputs', refs: WbFieldRef[]): void => {
    if (kind === 'inputs') {
      onChange({ ...step, inputs: refs })
      return
    }
    const validArtifacts = (step.artifacts ?? []).filter((artifact) => refs.some((ref) => ref.field === artifact.field && ref.type === 'file_path'))
    onChange({ ...step, outputs: refs, ...(step.artifacts === undefined ? {} : { artifacts: validArtifacts }) })
  }
  const renderRefs = (kind: 'inputs' | 'outputs', refs: WbFieldRef[]): JSX.Element => (
    <div className="grid gap-2">
      {refs.map((ref, index) => (
        <div key={`${ref.field}-${index}`} className="grid grid-cols-[minmax(0,1fr)_150px_auto] gap-2 mobile:grid-cols-1">
          <input className={INPUT} aria-label={`${ref.field} ${t('workbench.step_field')}`} value={ref.field} disabled={readonly} onChange={(event) => updateRefs(kind, refs.map((item, i) => i === index ? { ...item, field: event.target.value } : item))} />
          <select
            className={SELECT}
            aria-label={`${ref.field} ${t('workbench.step_field_type')}`}
            value={ref.type}
            disabled={readonly}
            onChange={(event) => updateRefs(kind, refs.map((item, i) => i === index ? { ...item, type: event.target.value as WbFieldRef['type'] } : item))}
          >
            <option value="string">string</option><option value="file_path">file_path</option><option value="boolean">boolean</option>
          </select>
          {!readonly && <button className={DANGER} type="button" onClick={() => updateRefs(kind, refs.filter((_, i) => i !== index))}>{t('workbench.step_remove')}</button>}
        </div>
      ))}
      {!readonly && <button className={MINI} type="button" onClick={() => updateRefs(kind, [...refs, { field: `${kind === 'inputs' ? 'input' : 'output'}_${refs.length + 1}`, type: 'string' }])}>{t('workbench.step_add_field')}</button>}
    </div>
  )

  const artifacts = step.artifacts ?? []
  const eligibleArtifactFields = step.outputs.filter((ref) => ref.type === 'file_path' && !artifacts.some((artifact) => artifact.field === ref.field))
  const updateArtifact = (index: number, next: WbArtifactConfig): void => onChange({ ...step, artifacts: artifacts.map((item, i) => i === index ? next : item) })

  return (
    <section className="mt-4 rounded-md border border-border bg-fill/40 p-4" data-testid="step-policy-editor" aria-label={t('workbench.step_editor_label', { id: step.id })}>
      <div className="mb-1 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-micro font-bold tracking-[.12em] text-accent-d">{t('workbench.step_settings_kicker')}</p>
          <h3 className="mt-1 text-title font-bold text-text">{step.label || step.id}</h3>
          <p className="mt-1 text-caption leading-relaxed text-text-3">{t('workbench.step_settings_note')}</p>
        </div>
      </div>

      <details open className="border-t border-border">
        <summary className={SUMMARY}>{t('workbench.step_prompt_title')}</summary>
        <textarea
          className={`${INPUT} min-h-32 resize-y font-mono leading-relaxed`}
          aria-label={t('workbench.step_prompt_label')}
          value={step.prompt ?? ''}
          disabled={readonly}
          placeholder={t('workbench.step_prompt_placeholder')}
          onChange={(event) => {
            const value = event.target.value
            if (value === '') {
              const { prompt: _prompt, ...withoutPrompt } = step
              onChange(withoutPrompt)
            } else onChange({ ...step, prompt: value })
          }}
        />
        <p className="mt-2 text-caption leading-relaxed text-text-3">{t('workbench.step_prompt_note')}</p>
      </details>

      <details className="border-t border-border">
        <summary className={SUMMARY}>{t('workbench.step_contracts_title', { inputs: step.inputs.length, outputs: step.outputs.length })}</summary>
        <div className="grid grid-cols-2 gap-4 max-[900px]:grid-cols-1">
          <div className={CARD}><h4 className="mb-2 text-caption font-bold">{t('workbench.step_inputs_heading')}</h4>{renderRefs('inputs', step.inputs)}</div>
          <div className={CARD}><h4 className="mb-2 text-caption font-bold">{t('workbench.step_outputs_heading')}</h4>{renderRefs('outputs', step.outputs)}</div>
        </div>
        <div className={`${CARD} mt-3`}>
          <h4 className="mb-2 text-caption font-bold">{t('workbench.step_artifacts_heading')}</h4>
          <div className="grid gap-2">
            {artifacts.length === 0 && <p className="text-caption text-text-3" role="status" aria-live="polite">{t('workbench.step_none')}</p>}
            {artifacts.map((artifact, index) => (
              <div key={`${artifact.field}-${index}`} className="grid grid-cols-[minmax(0,1fr)_190px_140px_minmax(0,1fr)_auto] gap-2 max-[1000px]:grid-cols-2 mobile:grid-cols-1">
                <input className={INPUT} value={artifact.field} disabled={readonly} aria-label={t('workbench.step_artifact_field_label', { field: artifact.field })} onChange={(event) => updateArtifact(index, { ...artifact, field: event.target.value })} />
                <select className={SELECT} value={artifact.producerPolicy} disabled={readonly} aria-label={t('workbench.step_artifact_producer_policy_label', { field: artifact.field })} onChange={(event) => updateArtifact(index, { ...artifact, producerPolicy: event.target.value as WbArtifactConfig['producerPolicy'] })}>
                  <option value="effective-step-skills">effective-step-skills</option>
                  <option value="effective-phase-skills">effective-phase-skills</option>
                </select>
                <select className={SELECT} value={artifact.requiredWhen?.kind ?? ''} disabled={readonly} onChange={(event) => updateArtifact(index, { ...artifact, requiredWhen: event.target.value === '' ? undefined : { kind: event.target.value as WbTrackPredicate['kind'], values: artifact.requiredWhen?.values ?? ['backend'] } })}>
                  <option value="">{t('workbench.step_all_tracks')}</option><option value="track-in">track-in</option><option value="track-not-in">track-not-in</option>
                </select>
                <input className={INPUT} value={artifact.requiredWhen?.values.join(', ') ?? ''} disabled={readonly || !artifact.requiredWhen} aria-label={t('workbench.step_artifact_tracks_label', { field: artifact.field })} onChange={(event) => updateArtifact(index, { ...artifact, requiredWhen: artifact.requiredWhen ? { ...artifact.requiredWhen, values: csv(event.target.value) } : undefined })} />
                {!readonly && <button className={DANGER} type="button" onClick={() => onChange({ ...step, artifacts: artifacts.filter((_, i) => i !== index) })}>{t('workbench.step_remove')}</button>}
              </div>
            ))}
            {!readonly && eligibleArtifactFields.length > 0 && (
              <select className={SELECT} value="" aria-label={t('workbench.step_add_artifact')} onChange={(event) => event.target.value && onChange({ ...step, artifacts: [...artifacts, { field: event.target.value, type: 'file_path', producerPolicy: 'effective-step-skills' }] })}>
                <option value="">{t('workbench.step_add_artifact')}</option>
                {eligibleArtifactFields.map((ref) => <option key={ref.field} value={ref.field}>{ref.field}</option>)}
              </select>
            )}
          </div>
        </div>
      </details>

      <details className="border-t border-border">
        <summary className={SUMMARY}>{t('workbench.step_guards_title', { n: step.guards.length })}</summary>
        <GuardList guards={step.guards} readonly={readonly} addLabel={t('workbench.step_add_stage_guard')} onChange={(guards) => onChange({ ...step, guards })} />
      </details>

      <details className="border-t border-border">
        <summary className={SUMMARY}>{t('workbench.step_transitions_title', { n: step.transitions.length })}</summary>
        <div className="grid gap-3">
          {step.transitions.length === 0 && <p className="text-caption text-text-3" role="status" aria-live="polite">{t('workbench.step_terminal')}</p>}
          {step.transitions.map((transition, index) => {
            const update = (patch: Partial<typeof transition>): void => onChange({ ...step, transitions: step.transitions.map((item, i) => i === index ? { ...item, ...patch } : item) })
            return (
              <div className={CARD} key={`${transition.event}-${index}`}>
                <div className="grid grid-cols-[minmax(0,1fr)_180px_auto] gap-2 mobile:grid-cols-1">
                  <label className="grid gap-1 text-micro font-semibold text-text-3">{t('workbench.step_event_label')}<input className={INPUT} value={transition.event} disabled={readonly} aria-label={`${transition.event} ${t('workbench.step_event_label')}`} onChange={(event) => update({ event: event.target.value })} /></label>
                  <label className="grid gap-1 text-micro font-semibold text-text-3">{t('workbench.step_target')}<select className={SELECT} value={transition.to} disabled={readonly} aria-label={`${transition.event} ${t('workbench.step_target')}`} onChange={(event) => update({ to: event.target.value })}>{allStepIds.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
                  {!readonly && <button className={`${DANGER} self-end`} type="button" onClick={() => onChange({ ...step, transitions: step.transitions.filter((_, i) => i !== index) })}>{t('workbench.step_remove')}</button>}
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3 max-[900px]:grid-cols-1">
                  <div><h5 className="mb-2 text-caption font-bold">{t('workbench.step_edge_guards_heading')}</h5><GuardList guards={transition.guards ?? []} readonly={readonly} addLabel={`${transition.event} ${t('workbench.step_add_action_guard')}`} onChange={(guards) => update({ guards })} /></div>
                  <div>
                    <h5 className="mb-2 text-caption font-bold">{t('workbench.step_actions_heading')}</h5>
                    <div className="grid gap-2">
                      {(transition.actions ?? []).map((action, actionIndex) => <div key={`${action.type}-${actionIndex}`} className="flex items-center gap-2 rounded-sm border border-border bg-bg/60 p-2"><code className="min-w-0 flex-1 text-micro text-accent-d">{action.type}</code>{!readonly && <button className={DANGER} type="button" onClick={() => update({ actions: (transition.actions ?? []).filter((_, i) => i !== actionIndex) })}>{t('workbench.step_remove')}</button>}</div>)}
                      {!readonly && <select className={SELECT} value="" aria-label={`${transition.event} ${t('workbench.step_add_action')}`} onChange={(event) => event.target.value && update({ actions: [...(transition.actions ?? []), { type: event.target.value as WbActionConfig['type'] }] })}><option value="">{t('workbench.step_add_action')}</option>{ACTION_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}</select>}
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
          {!readonly && allStepIds.length > 0 && <button className={MINI} type="button" onClick={() => onChange({ ...step, transitions: [...step.transitions, { event: `${step.id}-complete`, to: allStepIds.find((id) => id !== step.id) ?? step.id, guards: [], actions: [] }] })}>{t('workbench.step_add_transition')}</button>}
        </div>
      </details>
    </section>
  )
}
