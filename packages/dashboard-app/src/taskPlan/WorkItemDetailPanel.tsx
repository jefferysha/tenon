import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useT } from '../i18n'
import type { CanonicalTaskPlanReadModelV1, TaskPlanReadModelV1 } from '../api/taskPlanClient'
import { groupTitle } from './taskPlanPresentation'

export interface WorkItemDetailPanelProps {
  readonly plan: TaskPlanReadModelV1
  readonly itemId: string
  readonly onClose: () => void
}

const valueClass = 'break-words font-mono text-micro leading-5 text-text-2 [overflow-wrap:anywhere]'
const panelClass = 'min-w-0 rounded-md border border-border bg-card p-4'

function ValueList({ values, none }: { readonly values: readonly string[]; readonly none: string }): JSX.Element {
  if (values.length === 0) return <span className="text-caption text-text-3">{none}</span>
  return (
    <ul className="max-h-48 min-w-0 space-y-1 overflow-y-auto">
      {values.map((value, index) => <li key={`${value}:${index}`} className={valueClass}>{value}</li>)}
    </ul>
  )
}

function DetailField({ label, children }: { readonly label: string; readonly children: ReactNode }): JSX.Element {
  return (
    <div className="min-w-0 border-t border-border/70 pt-3 first:border-t-0 first:pt-0">
      <dt className="text-micro font-semibold text-text-3">{label}</dt>
      <dd className="mt-1 min-w-0">{children}</dd>
    </div>
  )
}

function canonicalDetail(
  plan: CanonicalTaskPlanReadModelV1,
  itemId: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
): JSX.Element | null {
  const item = plan.items.find((candidate) => candidate.id === itemId)
  if (item === undefined) return null
  const groupLabel = groupTitle(plan, item.group_id)
  return (
    <dl className="mt-4 grid min-w-0 gap-3">
      <DetailField label={t('task_plan.identity_quality')}>
        <span className={valueClass}>{t('task_plan.identity_canonical')}</span>
      </DetailField>
      <DetailField label={t('task_plan.item_id')}>
        <span className={valueClass}>{item.id}</span>
      </DetailField>
      <DetailField label={t('task_plan.description')}>
        <p className={`${valueClass} m-0`}>{item.description ?? t('task_plan.none')}</p>
      </DetailField>
      <DetailField label={t('task_plan.group')}>
        <span className={valueClass}>{item.group_id}{groupLabel === undefined ? '' : ` · ${groupLabel}`}</span>
      </DetailField>
      <DetailField label={t('task_plan.requirement_refs')}>
        <ValueList values={item.requirement_refs} none={t('task_plan.none')} />
      </DetailField>
      <DetailField label={t('task_plan.acceptance_refs')}>
        <ValueList values={item.acceptance_refs} none={t('task_plan.none')} />
      </DetailField>
      <DetailField label={t('task_plan.depends_on')}>
        <ValueList values={item.depends_on} none={t('task_plan.none')} />
      </DetailField>
      <DetailField label={t('task_plan.resource_claims')}>
        <ValueList
          values={item.resource_claims.map((claim) => `${claim.access} ${claim.kind}:${claim.key}`)}
          none={t('task_plan.none')}
        />
      </DetailField>
      <DetailField label={t('task_plan.expected_outputs')}>
        <ValueList values={item.expected_outputs.map((output) => `${output.id} · ${output.kind} · ${output.ref}`)} none={t('task_plan.none')} />
      </DetailField>
      <DetailField label={t('task_plan.validators')}>
        <ValueList values={item.validators.map((validator) => `${validator.id} · ${validator.kind} · v${validator.version} · ${validator.output_ids.join(' · ') || t('task_plan.none')}`)} none={t('task_plan.none')} />
      </DetailField>
    </dl>
  )
}

function legacyDetail(
  plan: Extract<TaskPlanReadModelV1, { source: 'legacy' }>,
  itemId: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
): JSX.Element | null {
  const item = plan.items.find((candidate) => candidate.id === itemId)
  if (item === undefined) return null
  return (
    <dl className="mt-4 grid min-w-0 gap-3">
      <DetailField label={t('task_plan.identity_quality')}>
        <span className={valueClass}>{t('task_plan.identity_legacy')}</span>
      </DetailField>
      <DetailField label={t('task_plan.item_id')}>
        <span className={valueClass}>{item.id}</span>
      </DetailField>
      <DetailField label={t('task_plan.description')}>
        <span className="text-caption text-text-3">{t('task_plan.unknown_value')}</span>
      </DetailField>
      <DetailField label={t('task_plan.stage')}>
        <span className={valueClass}>{item.stage ?? t('task_plan.unknown_value')}</span>
      </DetailField>
      <DetailField label={t('task_plan.completed')}>
        <span className="text-caption text-text-2">{item.completed ? t('task_plan.completed_yes') : t('task_plan.completed_no')}</span>
      </DetailField>
      <DetailField label={t('task_plan.order')}>
        <span className={valueClass}>{item.order}</span>
      </DetailField>
      <DetailField label={t('task_plan.relationships_unknown')}>
        <span className="text-caption text-text-3">{t('task_plan.unknown_value')}</span>
      </DetailField>
    </dl>
  )
}

export function WorkItemDetailPanel({ plan, itemId, onClose }: WorkItemDetailPanelProps): JSX.Element | null {
  const { t } = useT()
  const content = plan.source === 'canonical'
    ? canonicalDetail(plan, itemId, t)
    : legacyDetail(plan, itemId, t)
  if (content === null) return null

  const item = plan.items.find((candidate) => candidate.id === itemId)
  if (item === undefined) return null
  return (
    <aside className={panelClass} data-testid="work-item-detail" aria-labelledby="work-item-detail-title">
      <header className="flex min-w-0 items-start justify-between gap-3 border-b border-border pb-3">
        <div className="min-w-0">
          <p className="m-0 text-micro font-semibold uppercase tracking-[0.12em] text-text-3">{t('task_plan.work_items')}</p>
          <h3 id="work-item-detail-title" className="mt-1 break-words text-base font-semibold text-text [overflow-wrap:anywhere]">{item.title}</h3>
        </div>
        <button
          type="button"
          className="inline-flex flex-none items-center justify-center rounded-sm border border-transparent p-1.5 text-text-3 transition-colors hover:border-border hover:bg-fill hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent)"
          aria-label={t('task_plan.close_detail')}
          onClick={onClose}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </header>
      {content}
    </aside>
  )
}
