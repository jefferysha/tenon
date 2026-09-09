import { RefreshCcw } from 'lucide-react'
import type { ReactNode } from 'react'
import { useT } from '../i18n'
import type { CanonicalTaskPlanReadModelV1, TaskPlanReadModelV1 } from '../api/taskPlanClient'
import { filterTaskPlanItems, groupTitle, type TaskPlanItem } from './taskPlanPresentation'
import { TaskPlanDiagnostics } from './TaskPlanDiagnostics'

export interface TaskPlanContentProps {
  readonly plan: TaskPlanReadModelV1
  readonly filter: string
  readonly selectedItemId: string | undefined
  readonly refreshing: boolean
  readonly stale: boolean
  readonly onFilterChange: (value: string) => void
  readonly onRefresh: () => void
  readonly onSelectWorkItem: (id: string, trigger: HTMLButtonElement) => void
}

const valueClass = 'break-all font-mono text-micro text-text-2 [overflow-wrap:anywhere]'
const summaryValue = 'min-w-0 rounded-md border border-border bg-fill/35 px-2.5 py-2'

function SummaryField({ label, value }: { readonly label: string; readonly value: ReactNode }): JSX.Element {
  return (
    <div className={summaryValue}>
      <dt className="text-micro font-semibold uppercase tracking-[0.08em] text-text-3">{label}</dt>
      <dd className="mt-1 min-w-0 text-caption font-semibold text-text">{value}</dd>
    </div>
  )
}

function revisionStatus(plan: CanonicalTaskPlanReadModelV1, t: (key: string) => string): string {
  return plan.revision_status === 'frozen' ? t('task_plan.revision_frozen') : t('task_plan.revision_draft')
}

function completenessLabel(plan: TaskPlanReadModelV1, t: (key: string) => string): string {
  if (plan.source === 'legacy') return t('task_plan.unknown_value')
  return plan.completeness.state === 'complete' ? t('task_plan.complete') : t('task_plan.incomplete')
}

function projectionLabel(plan: TaskPlanReadModelV1, t: (key: string) => string): string {
  if (plan.projection.state === 'legacy') return t('task_plan.projection_legacy')
  if (plan.projection.state === 'current') return t('task_plan.projection_current')
  return plan.projection.state === 'pending' ? t('task_plan.projection_pending') : t('task_plan.projection_drift')
}

function CanonicalSummary({ plan }: { readonly plan: CanonicalTaskPlanReadModelV1 }): JSX.Element {
  const { t } = useT()
  const validation = plan.validation
  return (
    <dl className="mt-4 grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-3">
      <SummaryField label={t('task_plan.source')} value={t('task_plan.source_canonical')} />
      <SummaryField label={t('task_plan.plan_id')} value={<code className={valueClass}>{plan.plan_id}</code>} />
      <SummaryField label={t('task_plan.revision_id')} value={<code className={valueClass}>{plan.revision_id}</code>} />
      <SummaryField label={t('task_plan.revision_number')} value={plan.revision_number} />
      <SummaryField label={t('task_plan.revision_status')} value={revisionStatus(plan, t)} />
      <SummaryField label={t('task_plan.fingerprint')} value={<code className={valueClass}>{plan.fingerprint}</code>} />
      <SummaryField label={t('task_plan.schedulable')} value={plan.schedulable ? t('task_plan.yes') : t('task_plan.no')} />
      <SummaryField label={t('task_plan.completeness')} value={completenessLabel(plan, t)} />
      <SummaryField
        label={t('task_plan.validation')}
        value={`${validation.valid ? t('task_plan.valid') : t('task_plan.invalid')} · ${validation.freezable ? t('task_plan.freezable') : t('task_plan.not_freezable')} · ${validation.truncated ? t('task_plan.truncated') : t('task_plan.not_truncated')} · ${t('task_plan.issue_count', { count: validation.issues.length })}`}
      />
      <SummaryField
        label={t('task_plan.projection')}
        value={(
          <span className="min-w-0">
            {projectionLabel(plan, t)}
            {(plan.projection.state === 'pending' || plan.projection.state === 'drift') && plan.projection.reason !== undefined && (
              <span className="mt-1 block break-words text-micro font-normal text-text-3 [overflow-wrap:anywhere]">
                {t('task_plan.projection_reason', { reason: plan.projection.reason })}
              </span>
            )}
          </span>
        )}
      />
      <SummaryField label={t('task_plan.issue_count', { count: validation.issues.length })} value={validation.issues.length} />
    </dl>
  )
}

function LegacySummary({ plan }: { readonly plan: Extract<TaskPlanReadModelV1, { source: 'legacy' }> }): JSX.Element {
  const { t } = useT()
  return (
    <>
      <div className="mt-4 rounded-md border border-amber-b bg-amber-t px-3 py-2.5 text-caption leading-5 text-amber-d">{t('task_plan.legacy_notice')}</div>
      <dl className="mt-4 grid min-w-0 gap-2 sm:grid-cols-2">
        <SummaryField label={t('task_plan.source')} value={t('task_plan.source_legacy')} />
        <SummaryField label={t('task_plan.schedulable')} value={t('task_plan.no')} />
        <SummaryField label={t('task_plan.completeness')} value={t('task_plan.unknown_value')} />
        <SummaryField label={t('task_plan.projection')} value={projectionLabel(plan, t)} />
      </dl>
      <p className="mt-3 text-caption font-semibold text-text-2">{t('task_plan.relationships_unknown')}</p>
    </>
  )
}

function ItemRow({
  plan,
  item,
  selected,
  onSelect,
}: {
  readonly plan: TaskPlanReadModelV1
  readonly item: TaskPlanItem
  readonly selected: boolean
  readonly onSelect: (id: string, trigger: HTMLButtonElement) => void
}): JSX.Element {
  const { t } = useT()
  const label = t('task_plan.select_item', { title: item.title })
  return (
    <li className="min-w-0">
      <button
        type="button"
        className={`w-full min-w-0 rounded-md border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent) ${selected ? 'border-(--accent) bg-accent-t' : 'border-border bg-fill/25 hover:border-border-2 hover:bg-fill'}`}
        aria-label={label}
        aria-pressed={selected}
        data-testid={`task-plan-item-${item.id}`}
        onClick={(event) => onSelect(item.id, event.currentTarget)}
      >
        <span className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1">
          <span className="min-w-0 flex-1 break-words text-caption font-semibold text-text [overflow-wrap:anywhere]">{item.title}</span>
          <code className={`${valueClass} min-w-0 max-w-[48%] shrink`}>{item.id}</code>
        </span>
        <ItemRowMeta plan={plan} item={item} />
      </button>
    </li>
  )
}

function ItemRowMeta({ plan, item }: { readonly plan: TaskPlanReadModelV1; readonly item: TaskPlanItem }): JSX.Element {
  const { t } = useT()
  if (plan.source === 'canonical' && item.identity_quality === 'canonical') {
    const group = groupTitle(plan, item.group_id)
    return (
      <span className="mt-1 flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-micro text-text-3">
        <span>{t('task_plan.group')}: {item.group_id}{group === undefined ? '' : ` · ${group}`}</span>
        <span>{t('task_plan.requirement_refs')}: {item.requirement_refs.length}</span>
        <span>{t('task_plan.acceptance_refs')}: {item.acceptance_refs.length}</span>
      </span>
    )
  }
  if (plan.source === 'legacy' && item.identity_quality === 'legacy-derived') {
    return (
      <span className="mt-1 flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-micro text-text-3">
        <span>{t('task_plan.stage')}: {item.stage ?? t('task_plan.unknown_value')}</span>
        <span>{t('task_plan.completed')}: {item.completed ? t('task_plan.completed_yes') : t('task_plan.completed_no')}</span>
        <span>{t('task_plan.order')}: {item.order}</span>
      </span>
    )
  }
  return <span className="mt-1 text-micro text-text-3">{t('task_plan.unknown_value')}</span>
}

export function TaskPlanContent({
  plan,
  filter,
  selectedItemId,
  refreshing,
  stale,
  onFilterChange,
  onRefresh,
  onSelectWorkItem,
}: TaskPlanContentProps): JSX.Element {
  const { t } = useT()
  const filteredItems = filterTaskPlanItems(plan, filter)
  return (
    <div className="min-w-0" data-testid="task-plan-content">
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="m-0 text-micro font-semibold uppercase tracking-[0.12em] text-text-3">{t('task_plan.title')}</p>
          <h2 id="task-plan-title" className="mt-1 text-title font-semibold text-text">{t('task_plan.summary')}</h2>
        </div>
        <button
          type="button"
          className="inline-flex min-h-9 items-center gap-2 rounded-md border border-border bg-card px-3 text-caption font-semibold text-text transition-colors hover:bg-fill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent) disabled:cursor-wait disabled:opacity-60"
          aria-label={t('task_plan.refresh')}
          disabled={refreshing}
          onClick={onRefresh}
        >
          <RefreshCcw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden="true" />
          {refreshing ? t('task_plan.refreshing') : t('task_plan.refresh')}
        </button>
      </header>

      {stale && (
        <div className="mt-4 flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-md border border-amber-b bg-amber-t px-3 py-2.5 text-caption text-amber-d" role="status" aria-live="polite">
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">{t('task_plan.stale')}</span>
          <button
            type="button"
            className="flex-none rounded-sm border border-amber-b bg-card px-2.5 py-1.5 text-caption font-semibold text-amber-d focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent) disabled:opacity-60"
            aria-label={t('task_plan.retry_refresh')}
            disabled={refreshing}
            onClick={onRefresh}
          >
            {t('task_plan.retry_refresh')}
          </button>
        </div>
      )}

      {plan.source === 'canonical' ? <CanonicalSummary plan={plan} /> : <LegacySummary plan={plan} />}

      <section className="mt-5 min-w-0 border-t border-border pt-4" aria-labelledby="task-plan-items-title">
        <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h3 id="task-plan-items-title" className="text-base font-semibold text-text">{t('task_plan.work_items')}</h3>
            <p className="mt-1 text-micro text-text-3">{t('task_plan.filter_count', { shown: filteredItems.length, total: plan.items.length })}</p>
          </div>
          <div className="min-w-0 flex-1 sm:max-w-[34rem]">
            <label htmlFor="task-plan-filter" className="sr-only">{t('task_plan.filter_label')}</label>
            <input
              id="task-plan-filter"
              type="text"
              value={filter}
              placeholder={t('task_plan.filter_placeholder')}
              aria-label={t('task_plan.filter_label')}
              className="w-full min-w-0 rounded-md border border-border bg-card px-3 py-2 text-caption text-text outline-none placeholder:text-text-3 focus-visible:ring-2 focus-visible:ring-(--accent)"
              onChange={(event) => onFilterChange(event.target.value)}
            />
          </div>
        </div>
        {plan.items.length === 0 ? (
          <p className="mt-4 rounded-md border border-dashed border-border px-3 py-4 text-caption text-text-3" role="status">{t('task_plan.empty')}</p>
        ) : filteredItems.length === 0 ? (
          <p className="mt-4 rounded-md border border-dashed border-border px-3 py-4 text-caption text-text-3" role="status">{t('task_plan.filtered_empty')}</p>
        ) : (
          <ul className="mt-3 grid min-w-0 gap-2" aria-label={t('task_plan.list_label')}>
            {filteredItems.map((item) => (
              <ItemRow key={item.id} plan={plan} item={item} selected={selectedItemId === item.id} onSelect={onSelectWorkItem} />
            ))}
          </ul>
        )}
      </section>
      {plan.source === 'canonical' && <TaskPlanDiagnostics plan={plan} />}
    </div>
  )
}
