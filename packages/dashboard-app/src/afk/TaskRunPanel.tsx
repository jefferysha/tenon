import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, GitBranch, RefreshCcw, RotateCcw, Square, Undo2 } from 'lucide-react'
import { useT } from '../i18n'
import {
  fetchTaskRun,
  postTaskRunOperation,
  type TaskRunDto,
  type TaskRunOperation,
} from '../api/taskRunClient'
import { ApiError } from '../api/transport'
import { taskRunPresentation } from './taskRunModel'

interface TaskRunPanelProps {
  readonly root: string
  readonly change: string
  readonly readOnly?: boolean
}

export function TaskRunPanel({ root, change, readOnly = false }: TaskRunPanelProps): JSX.Element {
  const { t } = useT()
  const [run, setRun] = useState<TaskRunDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [operationBusy, setOperationBusy] = useState<string | null>(null)
  const [operationError, setOperationError] = useState(false)
  const generation = useRef(0)
  const operationGeneration = useRef(0)

  const load = useCallback(() => {
    const request = ++generation.current
    const controller = new AbortController()
    setLoading(true)
    setLoadError(false)
    setOperationError(false)
    setOperationBusy(null)
    ++operationGeneration.current
    void fetchTaskRun(root, change, controller.signal)
      .then((value) => {
        if (request === generation.current) setRun(value)
      })
      .catch((error: unknown) => {
        if (request === generation.current && !(error instanceof DOMException && error.name === 'AbortError')) {
          setRun(null)
          setLoadError(!(error instanceof ApiError && error.status === 404))
        }
      })
      .finally(() => {
        if (request === generation.current) setLoading(false)
      })
    return () => controller.abort()
  }, [root, change])

  useEffect(() => {
    const cancel = load()
    return () => {
      ++generation.current
      ++operationGeneration.current
      cancel()
    }
  }, [load])

  const presentation = useMemo(() => run === null ? null : taskRunPresentation(run), [run])

  async function submit(operation: TaskRunOperation): Promise<void> {
    const key = `${operation.operation}:${operation.work_item_id ?? 'run'}`
    if (readOnly || operationBusy !== null) return
    const request = ++operationGeneration.current
    setOperationBusy(key)
    setOperationError(false)
    try {
      const updated = await postTaskRunOperation(root, change, operation)
      if (request === operationGeneration.current) setRun(updated)
      try {
        const refreshed = await fetchTaskRun(root, change)
        if (request === operationGeneration.current) setRun(refreshed)
      } catch {
        // The mutation response is already an authoritative task-run/v1 snapshot.
      }
    } catch {
      if (request === operationGeneration.current) {
        setOperationError(true)
        try {
          const refreshed = await fetchTaskRun(root, change)
          if (request === operationGeneration.current) setRun(refreshed)
        } catch {
          // Preserve the last safe snapshot together with the operation error.
        }
      }
    } finally {
      if (request === operationGeneration.current) setOperationBusy(null)
    }
  }

  const stateLabel = (state: string): string => t(`afk.task_run.state_${state.split('-').join('_')}`)

  if (loading) {
    return <section className="mt-5 rounded-md border border-border bg-fill/40 px-4 py-5" role="status">{t('afk.task_run.loading')}</section>
  }
  if (loadError) {
    return (
      <section className="mt-5 rounded-md border border-red-b bg-red-t/35 px-4 py-4" role="status" aria-live="polite">
        <div className="flex items-center gap-2 text-base font-semibold text-text"><AlertTriangle className="h-4 w-4 text-red" aria-hidden="true" />{t('afk.task_run.load_error')}</div>
        <button type="button" className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-md border border-border bg-card px-3 text-caption font-semibold text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)" onClick={load} aria-label={t('afk.task_run.retry_load')}><RefreshCcw className="h-3.5 w-3.5" aria-hidden="true" />{t('afk.task_run.retry_load')}</button>
      </section>
    )
  }
  if (run === null || run.items.length === 0) {
    return <section className="mt-5 rounded-md border border-dashed border-border px-4 py-6 text-center text-caption text-text-3" role="status">{t('afk.task_run.empty')}</section>
  }
  if (presentation === null) {
    return <section className="mt-5 rounded-md border border-dashed border-border px-4 py-6 text-center text-caption text-text-3" role="status">{t('afk.task_run.empty')}</section>
  }

  return (
    <section className="mt-5 rounded-md border border-border bg-card px-4 py-4" data-testid="task-run-panel" data-state={run.state} aria-labelledby="task-run-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="task-run-title" className="flex items-center gap-2 text-base font-semibold text-text"><GitBranch className="h-4 w-4 text-(--accent)" aria-hidden="true" />{t('afk.task_run.title')}</h3>
          <p className="mt-1 text-micro text-text-3">{t('afk.task_run.identity', { plan: run.plan.plan_id, revision: run.plan.revision_id, fingerprint: run.plan.fingerprint.slice(0, 15) })}</p>
        </div>
        <div className="flex flex-wrap gap-2 text-micro font-semibold">
          <span className={`rounded-full px-2.5 py-1 ${run.admission.status === 'admitted' ? 'bg-green-t text-green-d' : 'bg-red-t text-red-d'}`}>{t(`afk.task_run.admission_${run.admission.status}`)}</span>
          <span className="rounded-full bg-fill px-2.5 py-1 text-text-2">{t('afk.task_run.parallelism', { count: run.parallelism })}</span>
          <span className="rounded-full bg-fill px-2.5 py-1 font-mono text-text-2">{t('afk.task_run.revision', { revision: run.run_revision })}</span>
        </div>
      </div>

      {run.blockers.length > 0 && (
        <div className="mt-4 rounded-md border border-red-b bg-red-t/30 px-3 py-3">
          <h4 className="text-caption font-semibold text-text">{t('afk.task_run.blockers')}</h4>
          <ul className="mt-2 space-y-2">
            {run.blockers.map((blocker, index) => <li key={`${blocker.code}:${index}`}><code className="text-micro font-bold text-red-d">{blocker.code}</code><p className="mt-0.5 text-caption leading-5 text-text-2">{blocker.detail}</p><p className="text-micro text-text-3">{t('afk.task_run.remediation', { value: blocker.remediation })}</p></li>)}
          </ul>
        </div>
      )}

      <div className="mt-4">
        <h4 className="text-caption font-semibold text-text">{t('afk.task_run.waves')}</h4>
        <ol className="mt-2 grid gap-2">
          {presentation.orderedWaves.map((wave) => (
            <li key={wave.index} className="rounded-md bg-fill px-3 py-2.5">
              <div className="flex items-center justify-between gap-3"><strong className="text-caption text-text">{t('afk.task_run.wave', { number: wave.index + 1 })}</strong><span className="text-micro text-text-3">{t('afk.task_run.parallelism', { count: wave.parallelism })}</span></div>
              <ul className="mt-2 flex flex-wrap gap-1.5">{wave.work_item_ids.map((id) => { const item = presentation.itemById.get(id); return <li key={id} className="rounded-sm border border-border bg-card px-2 py-1 text-micro"><span className="font-semibold text-text">{item?.title ?? id}</span><span className="ml-1.5 text-text-3">{stateLabel(item?.state ?? 'unknown')}</span></li> })}</ul>
            </li>
          ))}
        </ol>
      </div>

      {run.serialized_resource_conflicts.length > 0 && <div className="mt-4"><h4 className="text-caption font-semibold text-text">{t('afk.task_run.serialized_conflicts')}</h4><ul className="mt-2 space-y-1.5">{run.serialized_resource_conflicts.map((conflict) => <li key={`${conflict.resource}:${conflict.before_work_item_id}:${conflict.after_work_item_id}`} className="rounded-sm bg-amber-t/45 px-2.5 py-2 text-micro text-text-2">{t('afk.task_run.serialized_conflict', { resource: conflict.resource, before: conflict.before_work_item_id, after: conflict.after_work_item_id })}</li>)}</ul></div>}

      <div className="mt-4">
        <h4 className="text-caption font-semibold text-text">{t('afk.task_run.work_items')}</h4>
        <ul className="mt-2 grid gap-2 lg:grid-cols-2">
          {run.items.map((item) => (
            <li key={item.work_item_id} className="rounded-md border border-border bg-fill/35 px-3 py-3">
              <div className="flex items-center justify-between gap-3"><strong className="text-caption text-text">{item.title}</strong><span className="text-micro font-semibold text-text-2">{stateLabel(item.state)}</span></div>
              <p className="mt-1.5 text-micro text-text-3">{t('afk.task_run.dependencies', { value: item.depends_on.length === 0 ? t('afk.task_run.none') : item.depends_on.join(', ') })}</p>
              <p className="mt-1 text-micro text-text-3">{t('afk.task_run.resource_claims', { value: item.resource_claims.length === 0 ? t('afk.task_run.none') : item.resource_claims.map((claim) => `${claim.access} ${claim.kind}:${claim.key}`).join(', ') })}</p>
              {item.latest_attempt !== null && <p className="mt-1 font-mono text-micro text-text-3">{t('afk.task_run.latest_attempt', { number: item.latest_attempt.attempt_number, status: stateLabel(item.latest_attempt.status) })}</p>}
            </li>
          ))}
        </ul>
      </div>

      {run.attempts.length > 0 && <div className="mt-4"><h4 className="text-caption font-semibold text-text">{t('afk.task_run.attempts', { count: run.attempts.length })}</h4><ol className="mt-2 space-y-1.5">{run.attempts.map((attempt, index) => <li key={`${attempt.attempt_id}:${index}`} className="flex flex-wrap items-center gap-x-2 rounded-sm bg-fill px-2.5 py-2 text-micro text-text-2"><code className="font-bold text-text">{attempt.work_item_id} #{attempt.attempt_number}</code><span>{stateLabel(attempt.status)}</span>{attempt.error_code !== undefined && <code className="text-red-d">{attempt.error_code}</code>}</li>)}</ol></div>}

      {run.invalidations.length > 0 && <div className="mt-4"><h4 className="text-caption font-semibold text-text">{t('afk.task_run.invalidations')}</h4><ul className="mt-2 space-y-1 text-caption text-text-2">{run.invalidations.map((entry) => <li key={`${entry.work_item_id}:${entry.caused_by_work_item_id}`}>{t('afk.task_run.invalidated_by', { item: entry.work_item_id, upstream: entry.caused_by_work_item_id })}</li>)}</ul></div>}
      {run.validator_verdicts.length > 0 && <div className="mt-4"><h4 className="text-caption font-semibold text-text">{t('afk.task_run.validators')}</h4><ul className="mt-2 flex flex-wrap gap-2">{run.validator_verdicts.map((verdict) => <li key={`${verdict.scope}:${verdict.validator_id}`} className="rounded-sm bg-fill px-2 py-1 font-mono text-micro text-text-2">{verdict.validator_id} · {verdict.status}</li>)}</ul></div>}

      {!readOnly && operationError && <p className="mt-3 text-caption text-red" role="alert">{t('afk.task_run.operation_error')}</p>}
      {!readOnly && presentation.operations.length > 0 && <div className="mt-4 flex flex-wrap gap-2">{presentation.operations.map(({ operation, itemTitle }) => {
        const key = `${operation.operation}:${operation.work_item_id ?? 'run'}`
        const label = operation.operation === 'resume'
          ? t('afk.task_run.operation_resume')
          : t(`afk.task_run.operation_${operation.operation}`, { item: itemTitle ?? operation.work_item_id ?? '' })
        const Icon = operation.operation === 'retry' ? RotateCcw : operation.operation === 'cancel' ? Square : Undo2
        return <button key={key} type="button" disabled={operationBusy !== null} className="inline-flex min-h-10 items-center gap-2 rounded-md border border-border bg-card px-3 text-caption font-semibold text-text hover:bg-fill focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent) disabled:opacity-50" aria-label={label} onClick={() => void submit(operation)}><Icon className="h-3.5 w-3.5" aria-hidden="true" />{operationBusy === key ? t('afk.task_run.operation_busy') : label}</button>
      })}</div>}
    </section>
  )
}
