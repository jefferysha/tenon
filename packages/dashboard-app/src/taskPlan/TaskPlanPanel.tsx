import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, RefreshCcw } from 'lucide-react'
import { useT } from '../i18n'
import { fetchTaskPlan, TaskPlanApiError, type TaskPlanReadModelV1 } from '../api/taskPlanClient'
import { ApiError, isAbortError } from '../api/transport'
import { TaskPlanContent } from './TaskPlanContent'
import { WorkItemDetailPanel } from './WorkItemDetailPanel'

export interface TaskPlanPanelProps {
  readonly root: string
  readonly change: string
  readonly onSelectedWorkItemChange?: (id: string | undefined) => void
}

type PanelState =
  | { readonly kind: 'loading'; readonly queryKey: string }
  | { readonly kind: 'empty'; readonly queryKey: string }
  | { readonly kind: 'error'; readonly queryKey: string }
  | { readonly kind: 'unknown'; readonly queryKey: string }
  | {
    readonly kind: 'ready'
    readonly queryKey: string
    readonly plan: TaskPlanReadModelV1
    readonly stale: boolean
    readonly refreshing: boolean
  }

function queryKey(root: string, change: string): string {
  return `${root}\u0000${change}`
}

function failureKind(error: unknown): 'empty' | 'unknown' | 'error' {
  if (error instanceof TaskPlanApiError && error.code === 'TASK_PLAN_NOT_FOUND') return 'empty'
  if (error instanceof ApiError && error.status === 200) return 'unknown'
  return 'error'
}

export function TaskPlanPanel({ root, change, onSelectedWorkItemChange }: TaskPlanPanelProps): JSX.Element {
  const { t } = useT()
  const currentQueryKey = queryKey(root, change)
  const [state, setState] = useState<PanelState>({ kind: 'loading', queryKey: currentQueryKey })
  const [filter, setFilter] = useState('')
  const [selectedItemId, setSelectedItemId] = useState<string | undefined>(undefined)
  const generation = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const cache = useRef<{ readonly queryKey: string; readonly plan: TaskPlanReadModelV1 } | null>(null)
  const selectedId = useRef<string | undefined>(undefined)
  const selectedTrigger = useRef<HTMLButtonElement | null>(null)
  const callback = useRef(onSelectedWorkItemChange)
  callback.current = onSelectedWorkItemChange
  selectedId.current = selectedItemId

  const clearSelection = useCallback((): void => {
    const hadSelection = selectedId.current !== undefined
    selectedId.current = undefined
    selectedTrigger.current = null
    setSelectedItemId(undefined)
    if (hadSelection) callback.current?.(undefined)
  }, [])

  const load = useCallback((mode: 'initial' | 'refresh'): void => {
    const requestQueryKey = queryKey(root, change)
    const request = ++generation.current
    controller.current?.abort()
    const nextController = new AbortController()
    controller.current = nextController
    const cached = cache.current?.queryKey === requestQueryKey ? cache.current.plan : null
    if (mode === 'refresh' && cached !== null) {
      setState((current) => ({
        kind: 'ready',
        queryKey: requestQueryKey,
        plan: cached,
        stale: current.kind === 'ready' && current.queryKey === requestQueryKey && current.stale,
        refreshing: true,
      }))
    } else {
      setState({ kind: 'loading', queryKey: requestQueryKey })
    }

    void fetchTaskPlan(root, change, nextController.signal)
      .then((plan) => {
        if (request !== generation.current) return
        cache.current = { queryKey: requestQueryKey, plan }
        setState({ kind: 'ready', queryKey: requestQueryKey, plan, stale: false, refreshing: false })
        clearSelection()
      })
      .catch((error: unknown) => {
        if (request !== generation.current || isAbortError(error)) return
        if (mode === 'refresh' && cached !== null) {
          setState({ kind: 'ready', queryKey: requestQueryKey, plan: cached, stale: true, refreshing: false })
          return
        }
        const kind = failureKind(error)
        setState({ kind, queryKey: requestQueryKey })
      })
      .finally(() => {
        if (request !== generation.current) return
        setState((current) => current.kind === 'ready' && current.queryKey === requestQueryKey
          ? { ...current, refreshing: false }
          : current)
      })
  }, [change, clearSelection, root])

  useEffect(() => {
    cache.current = null
    setFilter('')
    clearSelection()
    load('initial')
    return () => {
      ++generation.current
      controller.current?.abort()
      controller.current = null
    }
  }, [change, clearSelection, load, root])

  const closeDetail = useCallback((): void => {
    const trigger = selectedTrigger.current
    clearSelection()
    trigger?.focus()
  }, [clearSelection])

  const selectWorkItem = useCallback((id: string, trigger: HTMLButtonElement): void => {
    selectedTrigger.current = trigger
    selectedId.current = id
    setSelectedItemId(id)
    callback.current?.(id)
  }, [])

  const renderError = (kind: 'error' | 'unknown'): JSX.Element => {
    const message = kind === 'unknown' ? t('task_plan.unknown') : t('task_plan.load_error')
    return (
      <section className="min-w-0 rounded-md border border-red-b bg-red-t/35 px-4 py-4" role="status" aria-live="polite" data-testid="task-plan-panel" data-state={kind}>
        <div className="flex min-w-0 items-start gap-2 text-base font-semibold text-text">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-none text-red" aria-hidden="true" />
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">{message}</span>
        </div>
        <button
          type="button"
          className="mt-3 inline-flex min-h-9 items-center gap-2 rounded-md border border-border bg-card px-3 text-caption font-semibold text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent)"
          aria-label={t('task_plan.retry_load')}
          onClick={() => load('initial')}
        >
          <RefreshCcw className="h-3.5 w-3.5" aria-hidden="true" />
          {t('task_plan.retry_load')}
        </button>
      </section>
    )
  }

  if (state.queryKey !== currentQueryKey || state.kind === 'loading') {
    return <section className="min-w-0 rounded-md border border-border bg-fill/40 px-4 py-5 text-base text-text-2" role="status" aria-live="polite" data-testid="task-plan-panel" data-state="loading">{t('task_plan.loading')}</section>
  }
  if (state.kind === 'empty') {
    return <section className="min-w-0 rounded-md border border-dashed border-border px-4 py-5 text-base text-text-3" role="status" aria-live="polite" data-testid="task-plan-panel" data-state="empty">{t('task_plan.not_found')}</section>
  }
  if (state.kind === 'error' || state.kind === 'unknown') return renderError(state.kind)

  const selectedExists = state.plan.items.some((item) => item.id === selectedItemId)
  return (
    <section className="min-w-0 max-w-full overflow-hidden rounded-md border border-border bg-card px-4 py-4" data-testid="task-plan-panel" data-state={state.stale ? 'stale' : 'ready'} aria-labelledby="task-plan-title">
      <div className={selectedExists ? 'grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,0.62fr)]' : 'min-w-0'}>
        <TaskPlanContent
          plan={state.plan}
          filter={filter}
          selectedItemId={selectedItemId}
          refreshing={state.refreshing}
          stale={state.stale}
          onFilterChange={setFilter}
          onRefresh={() => load('refresh')}
          onSelectWorkItem={selectWorkItem}
        />
        {selectedExists && selectedItemId !== undefined && (
          <WorkItemDetailPanel plan={state.plan} itemId={selectedItemId} onClose={closeDetail} />
        )}
      </div>
    </section>
  )
}
