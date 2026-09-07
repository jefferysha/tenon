import { AlertTriangle, Check, CircleDashed, RefreshCw, ShieldCheck, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  fetchSkillInvocations,
  type SkillInvocationList,
  type SkillInvocationField,
  type SkillInvocationReadItem,
  type SkillInvocationStatus,
  type SkillInvocationValidatorStatus,
} from '../api/skillInvocationClient'
import { useT } from '../i18n'

interface SkillInvocationEvidenceCardProps {
  readonly root: string
  readonly change: string
  readonly workItemId?: string
}

interface SkillInvocationScope {
  readonly root: string
  readonly change: string
  readonly workItemId?: string
}

type LoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly value: SkillInvocationList; readonly scope: SkillInvocationScope }
  | { readonly kind: 'error'; readonly scope: SkillInvocationScope }

function sameScope(left: SkillInvocationScope, right: SkillInvocationScope): boolean {
  return left.root === right.root && left.change === right.change && left.workItemId === right.workItemId
}

const statusTone: Record<SkillInvocationStatus, string> = {
  completed: 'border-green-b bg-green-t text-green-d',
  failed: 'border-red-b bg-red-t text-red-d',
  interrupted: 'border-amber-b bg-amber-t text-amber-d',
  incomplete: 'border-border bg-fill text-text-3',
  corrupt: 'border-red-b bg-red-t text-red-d',
}

const validatorTone: Record<SkillInvocationValidatorStatus, string> = {
  pass: 'text-green-d',
  fail: 'text-red-d',
  unknown: 'text-amber-d',
}

function StatusIcon({ status }: { readonly status: SkillInvocationStatus }): JSX.Element {
  if (status === 'completed') return <Check className="size-3.5" aria-hidden="true" />
  if (status === 'failed' || status === 'corrupt') return <X className="size-3.5" aria-hidden="true" />
  if (status === 'interrupted') return <AlertTriangle className="size-3.5" aria-hidden="true" />
  return <CircleDashed className="size-3.5" aria-hidden="true" />
}

function validatorText(
  validator: SkillInvocationField['validator'],
  translate: (key: string, values?: Record<string, string | number>) => string,
): string {
  return translate('skillInvocation.validator_evidence', {
    id: validator.id,
    status: translate(`skillInvocation.validator_${validator.status}`),
    code: validator.code === undefined ? '' : ` · ${validator.code}`,
  })
}

function FieldEvidenceList({
  label,
  fields,
}: {
  readonly label: string
  readonly fields: readonly SkillInvocationField[]
}): JSX.Element | null {
  const { t } = useT()
  if (fields.length === 0) return null
  return (
    <ul className="m-0 grid list-none gap-1 p-0" aria-label={label}>
      {fields.map((field) => (
        <li
          className={`rounded-md border border-border bg-fill/50 px-2.5 py-1.5 font-mono text-[10.5px] ${validatorTone[field.validator.status]}`}
          key={field.name}
        >
          {t('skillInvocation.field_evidence', {
            name: field.name,
            classification: t(`skillInvocation.classification_${field.classification}`),
            validator: validatorText(field.validator, t),
          })}
        </li>
      ))}
    </ul>
  )
}

function InvocationDetails({ item }: { readonly item: SkillInvocationReadItem }): JSX.Element {
  const { t } = useT()
  return (
    <details className="group rounded-lg border border-border bg-card" data-testid={`skill-invocation-${item.invocation_id}`}>
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-(--accent) [&::-webkit-details-marker]:hidden">
        <ShieldCheck className="size-4 text-blue-d" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-text">{item.skill.id}</span>
        {item.subject.work_item_id !== undefined && (
          <span className="max-w-[180px] truncate font-mono text-[10.5px] text-text-3">{item.subject.work_item_id}</span>
        )}
        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-semibold ${statusTone[item.status]}`}>
          <StatusIcon status={item.status} />
          {t(`skillInvocation.status_${item.status}`)}
        </span>
      </summary>
      <div className="grid gap-2 border-t border-border px-3 py-2.5 text-xs text-text-2">
        <div className="grid gap-1 sm:grid-cols-3">
          <span><b>{t('skillInvocation.step')}</b> · {item.subject.step_id}</span>
          <span><b>{t('skillInvocation.input')}</b> · {item.input.fields.length}</span>
          <span><b>{t('skillInvocation.output')}</b> · {item.output?.fields.length ?? 0}</span>
        </div>
        <FieldEvidenceList label={t('skillInvocation.input_details')} fields={item.input.fields} />
        <FieldEvidenceList label={t('skillInvocation.output_details')} fields={item.output?.fields ?? []} />
        {item.questions.length === 0 ? (
          <p className="m-0 text-text-3">{t('skillInvocation.no_questions')}</p>
        ) : (
          <ul className="m-0 grid list-none gap-1 p-0" aria-label={t('skillInvocation.questions')}>
            {item.questions.map((question) => {
              const decision = item.decisions.find((candidate) => candidate.question_id === question.id)
              return (
                <li className="rounded-md border border-border bg-fill/50 px-2.5 py-2" key={question.id}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <code className="text-[11px] text-text">{question.key}</code>
                    <span className="text-[10.5px] text-text-3">
                      {question.shown ? t('skillInvocation.shown') : t('skillInvocation.not_shown')}
                    </span>
                    <span className="text-[10.5px] text-text-3">{t(`skillInvocation.required_${question.requiredness}`)}</span>
                  </div>
                  {decision !== undefined && (
                    <div className="mt-1 grid gap-0.5 text-[11px] text-text-2">
                      <p className="m-0">
                        {decision.mode === 'recommended-default'
                          ? t('skillInvocation.default_decision', {
                              value: decision.selected_option_ids.join(', '),
                              rule: decision.policy?.rule_id ?? 'unknown',
                              reason: decision.rationale_code ?? 'unknown',
                            })
                          : t('skillInvocation.user_decision', { value: decision.selected_option_ids.join(', ') })}
                      </p>
                      {decision.free_text_classification !== undefined && (
                        <p className="m-0 text-text-3">
                          {t('skillInvocation.free_text_present', {
                            classification: t(`skillInvocation.classification_${decision.free_text_classification}`),
                          })}
                        </p>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        {item.artifacts.length > 0 && (
          <ul className="m-0 grid list-none gap-1.5 p-0" aria-label={t('skillInvocation.artifacts')}>
            {item.artifacts.map((artifact) => (
              <li className="rounded-md border border-border bg-fill px-2 py-1.5 font-mono text-[10.5px]" key={artifact.binding_id}>
                <div>{artifact.output_id} · {t(`skillInvocation.artifact_${artifact.state}`)}</div>
                {artifact.validators.length > 0 && (
                  <ul className="m-0 mt-0.5 grid list-none gap-0.5 p-0" aria-label={t('skillInvocation.artifact_validators')}>
                    {artifact.validators.map((validator) => (
                      <li className={validatorTone[validator.status]} key={validator.id}>
                        {validatorText(validator, t)}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  )
}

export function SkillInvocationEvidenceCard({ root, change, workItemId }: SkillInvocationEvidenceCardProps): JSX.Element {
  const { t } = useT()
  const requestId = useRef(0)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  useEffect(() => {
    const id = ++requestId.current
    const controller = new AbortController()
    const scope: SkillInvocationScope = { root, change, workItemId }
    setState({ kind: 'loading' })
    fetchSkillInvocations(root, change, controller.signal)
      .then((value) => {
        if (requestId.current === id && !controller.signal.aborted) setState({ kind: 'ready', value, scope })
      })
      .catch(() => {
        if (requestId.current === id && !controller.signal.aborted) setState({ kind: 'error', scope })
      })
    return () => controller.abort()
  }, [attempt, change, root, workItemId])

  const currentScope: SkillInvocationScope = { root, change, workItemId }
  const stateMatchesScope = state.kind === 'loading' || sameScope(state.scope, currentScope)
  const filteredItems = state.kind === 'ready' && stateMatchesScope
    ? state.value.items.filter((item) => workItemId === undefined || item.subject.work_item_id === workItemId)
    : []
  const emptyText = workItemId === undefined
    ? t('skillInvocation.empty')
    : t('skillInvocation.empty_work_item', { id: workItemId })

  return (
    <section className="border-b border-border py-[13px] last:border-b-0" aria-label={t('skillInvocation.region')} data-testid="skill-invocation-evidence">
      <div className="mb-2.5">
        <h3 className="m-0 text-[12.5px] font-bold text-text">{t('skillInvocation.heading')}</h3>
        <p className="mt-0.5 mb-0 text-[11px] text-text-3">{t('skillInvocation.read_only')}</p>
      </div>
      {(!stateMatchesScope || state.kind === 'loading') && (
        <div className="flex items-center gap-2 text-xs text-text-3" role="status">
          <RefreshCw className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          {t('skillInvocation.loading')}
        </div>
      )}
      {state.kind === 'error' && stateMatchesScope && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-red-b bg-red-t px-3 py-2.5" role="alert">
          <span className="text-xs text-red-d">{t('skillInvocation.error')}</span>
          <button type="button" className="rounded-md border border-red-b bg-card px-2.5 py-1 text-xs font-semibold text-red-d focus-visible:ring-2 focus-visible:ring-(--accent)" onClick={() => setAttempt((value) => value + 1)}>
            {t('skillInvocation.retry')}
          </button>
        </div>
      )}
      {state.kind === 'ready' && stateMatchesScope && filteredItems.length === 0 && (
        <p className="m-0 rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-text-3" role="status">
          {emptyText}
        </p>
      )}
      {state.kind === 'ready' && stateMatchesScope && filteredItems.length > 0 && (
        <div className="grid gap-2">{filteredItems.map((item) => <InvocationDetails item={item} key={item.invocation_id} />)}</div>
      )}
    </section>
  )
}
