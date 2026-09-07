import { AlertTriangle, GitBranch, Layers3, ShieldAlert } from 'lucide-react'
import { useT } from '../i18n'
import type { CanonicalTaskPlanReadModelV1, TaskPlanCoverageEntry } from '../api/taskPlanClient'

export interface TaskPlanDiagnosticsProps {
  readonly plan: CanonicalTaskPlanReadModelV1
}

const boundedList = 'max-h-48 overflow-y-auto rounded-lg border border-border bg-fill/35 p-2'
const code = 'break-all font-mono text-[11px] text-text-2 [overflow-wrap:anywhere]'
const empty = 'text-xs text-text-3'

function IdList({ ids, label, none }: { readonly ids: readonly string[]; readonly label: string; readonly none: string }): JSX.Element {
  if (ids.length === 0) return <p className={empty}>{none}</p>
  return (
    <ul className="max-h-32 overflow-y-auto rounded-lg border border-border bg-fill/35 p-2 flex flex-wrap gap-1.5" aria-label={label}>
      {ids.map((id) => <li key={id} className={`${code} rounded-md bg-card px-2 py-1`}>{id}</li>)}
    </ul>
  )
}

function CoverageList({ entries, label }: { readonly entries: readonly TaskPlanCoverageEntry[]; readonly label: string }): JSX.Element {
  const { t } = useT()
  if (entries.length === 0) return <p className={empty}>{t('task_plan.none')}</p>
  return (
    <ul className={`${boundedList} space-y-1.5`} aria-label={label}>
      {entries.map((entry) => (
        <li key={entry.id} className="min-w-0 rounded-md bg-card px-2.5 py-2">
          <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
            <code className={`${code} font-semibold`}>{entry.id}</code>
            <span className="text-[11px] text-text-3">{t('task_plan.coverage_item_count', { count: entry.work_item_ids.length })}</span>
          </div>
          {entry.work_item_ids.length > 0 && (
            <p className={`${code} mt-1 m-0`}>{entry.work_item_ids.join(' · ')}</p>
          )}
        </li>
      ))}
    </ul>
  )
}

export function TaskPlanDiagnostics({ plan }: TaskPlanDiagnosticsProps): JSX.Element {
  const { t } = useT()
  const coverage = plan.coverage
  const dependencies = plan.dependencies
  const resources = plan.resources

  return (
    <section className="mt-5 min-w-0 border-t border-border pt-4" aria-labelledby="task-plan-diagnostics-title" data-testid="task-plan-diagnostics">
      <h3 id="task-plan-diagnostics-title" className="flex items-center gap-2 text-sm font-semibold text-text">
        <Layers3 className="h-4 w-4 text-(--accent)" aria-hidden="true" />
        {t('task_plan.coverage')} / {t('task_plan.dependencies')} / {t('task_plan.resources')}
      </h3>

      <div className="mt-4 grid min-w-0 gap-4 lg:grid-cols-2">
        <section className="min-w-0 rounded-xl border border-border bg-fill/25 p-3" aria-labelledby="task-plan-coverage-title">
          <h4 id="task-plan-coverage-title" className="text-xs font-semibold text-text">{t('task_plan.coverage')}</h4>
          <p className="mt-1 text-[11px] text-text-3">
            {coverage.complete ? t('task_plan.coverage_complete') : t('task_plan.coverage_incomplete')}
          </p>
          <div className="mt-3 grid min-w-0 gap-3">
            <div className="min-w-0">
              <h5 className="mb-1.5 text-[11px] font-semibold text-text-2">{t('task_plan.requirement_coverage')}</h5>
              <CoverageList entries={coverage.requirements} label={t('task_plan.requirement_coverage')} />
              <p className="mb-1.5 mt-3 text-[11px] font-semibold text-text-2">{t('task_plan.uncovered_requirements')}</p>
              <IdList ids={coverage.uncovered_requirement_ids} label={t('task_plan.uncovered_requirements')} none={t('task_plan.none')} />
            </div>
            <div className="min-w-0">
              <h5 className="mb-1.5 text-[11px] font-semibold text-text-2">{t('task_plan.acceptance_coverage')}</h5>
              <CoverageList entries={coverage.acceptance_criteria} label={t('task_plan.acceptance_coverage')} />
              <p className="mb-1.5 mt-3 text-[11px] font-semibold text-text-2">{t('task_plan.uncovered_acceptance')}</p>
              <IdList ids={coverage.uncovered_acceptance_ids} label={t('task_plan.uncovered_acceptance')} none={t('task_plan.none')} />
            </div>
          </div>
        </section>

        <section className="min-w-0 rounded-xl border border-border bg-fill/25 p-3" aria-labelledby="task-plan-dependencies-title">
          <h4 id="task-plan-dependencies-title" className="flex items-center gap-2 text-xs font-semibold text-text">
            <GitBranch className="h-3.5 w-3.5 text-(--accent)" aria-hidden="true" />
            {t('task_plan.dependencies')}
          </h4>
          <p className="mb-1.5 mt-3 text-[11px] font-semibold text-text-2">{t('task_plan.dependency_edges')}</p>
          {dependencies.edges.length === 0 ? <p className={empty}>{t('task_plan.none')}</p> : (
            <ul className={`${boundedList} space-y-1.5`} aria-label={t('task_plan.dependency_edges')}>
              {dependencies.edges.map((edge) => (
                <li key={`${edge.from_work_item_id}:${edge.to_work_item_id}`} className={`${code} rounded-md bg-card px-2.5 py-2`}>
                  {edge.from_work_item_id} → {edge.to_work_item_id}
                </li>
              ))}
            </ul>
          )}
          <p className="mb-1.5 mt-3 text-[11px] font-semibold text-text-2">{t('task_plan.cyclic_items')}</p>
          <IdList ids={dependencies.cyclic_work_item_ids} label={t('task_plan.cyclic_items')} none={t('task_plan.none')} />
        </section>

        <section className="min-w-0 rounded-xl border border-border bg-fill/25 p-3" aria-labelledby="task-plan-resources-title">
          <h4 id="task-plan-resources-title" className="flex items-center gap-2 text-xs font-semibold text-text">
            <ShieldAlert className="h-3.5 w-3.5 text-(--accent)" aria-hidden="true" />
            {t('task_plan.resources')}
          </h4>
          <p className="mb-1.5 mt-3 text-[11px] font-semibold text-text-2">{t('task_plan.resource_conflicts')}</p>
          {resources.conflicts.length === 0 ? <p className={empty}>{t('task_plan.none')}</p> : (
            <ul className={`${boundedList} space-y-1.5`} aria-label={t('task_plan.resource_conflicts')}>
              {resources.conflicts.map((conflict) => (
                <li key={`${conflict.resource}:${conflict.work_item_ids.join(':')}`} className="min-w-0 rounded-md bg-card px-2.5 py-2">
                  <code className={code}>{conflict.resource}</code>
                  <p className={`${code} mt-1 m-0`}>{conflict.work_item_ids.join(' · ')}</p>
                </li>
              ))}
            </ul>
          )}
          <p className="mb-1.5 mt-3 text-[11px] font-semibold text-text-2">{t('task_plan.serialized_resources')}</p>
          {resources.serialized.length === 0 ? <p className={empty}>{t('task_plan.none')}</p> : (
            <ul className={`${boundedList} space-y-1.5`} aria-label={t('task_plan.serialized_resources')}>
              {resources.serialized.map((entry) => (
                <li key={`${entry.resource}:${entry.before_work_item_id}:${entry.after_work_item_id}`} className="min-w-0 rounded-md bg-card px-2.5 py-2">
                  <code className={code}>{entry.resource}</code>
                  <p className={`${code} mt-1 m-0`}>{entry.before_work_item_id} → {entry.after_work_item_id}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="min-w-0 rounded-xl border border-border bg-fill/25 p-3" aria-labelledby="task-plan-validation-title">
          <h4 id="task-plan-validation-title" className="flex items-center gap-2 text-xs font-semibold text-text">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-d" aria-hidden="true" />
            {t('task_plan.validation_issues')}
          </h4>
          {plan.validation.issues.length === 0 ? <p className={`${empty} mt-3`}>{t('task_plan.none')}</p> : (
            <ul className={`${boundedList} mt-3 space-y-2`} aria-label={t('task_plan.validation_issues')}>
              {plan.validation.issues.map((issue, index) => (
                <li key={`${issue.code}:${issue.path}:${index}`} className="min-w-0 rounded-md bg-card px-2.5 py-2">
                  <code className={`${code} font-semibold`}>{issue.code}</code>
                  <p className={`${code} mt-1 m-0`}>{t('task_plan.issue_path')}: {issue.path}</p>
                  <p className={`${code} mt-1 m-0`}>{t('task_plan.related_ids')}: {issue.related_ids.length === 0 ? t('task_plan.none') : issue.related_ids.join(' · ')}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </section>
  )
}
