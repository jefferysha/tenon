import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, CornerUpLeft, RefreshCw } from 'lucide-react'
import { fetchPendingDecisions, postReviewAcknowledge, type PendingDecision } from '../api/decisionClient'
import { ApiError, formatApiError } from '../api/transport'
import { useT } from '../i18n'
import type { WorkflowRules } from '../model/workflowModel'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { BUTTON_GHOST } from '../shared/uiRecipes'
import { reviewRequestCommand } from './taskCommands'
import { stageLabel } from './taskModel'

type Translate = (key: string, vars?: Record<string, string | number>) => string

export interface ReviewDecisionPanelProps {
  root: string
  change: string
  /** Changes whenever the snapshot for this change changes; a new value reloads pending decisions. */
  snapshotSignature?: string
  /** 冻结计划的规则：事件显示为它通向的阶段名，退回选项取当前阶段的退回边。 */
  rules: WorkflowRules
  /** 任务当前阶段。 */
  phase: string
  onRefresh?: () => void | Promise<void>
  onToast?: (message: string) => void
}

/** Maps the server's stable decision codes to copy; HTTP 500 carries no code and uses the generic text. */
export function decisionErrorText(error: unknown, t: Translate): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'review-approval-required': return t('review_console.error_review_required')
      case 'revision-conflict': return t('review_console.error_revision_conflict')
      case 'idempotency-conflict': return t('review_console.error_idempotency_conflict')
      default: break
    }
    if (error.status === undefined) return formatApiError(error, t)
  }
  return t('common.request_failed')
}

/**
 * The Dashboard review surface is deliberately narrow: it acknowledges an existing
 * terminal review request. It never starts a Skill, answers a Skill question, or calls a model.
 */
export function ReviewDecisionPanel({ root, change, snapshotSignature, rules, phase, onRefresh, onToast }: ReviewDecisionPanelProps): JSX.Element {
  const { t } = useT()
  const [view, setView] = useState<{ revision: number | null; items: readonly PendingDecision[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [loadError, setLoadError] = useState<unknown>(null)
  // Kept apart from loadError: a rejected approval stays visible after the refresh it triggers,
  // including when that refresh no longer contains the review.
  const [submitError, setSubmitError] = useState<unknown>(null)
  const loadGeneration = useRef(0)

  const load = useCallback(async (signal?: AbortSignal) => {
    const generation = ++loadGeneration.current
    setLoading(true)
    try {
      const next = await fetchPendingDecisions(root, change, signal)
      if (generation !== loadGeneration.current || signal?.aborted) return
      setView(next)
      setLoadError(null)
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') return
      if (generation === loadGeneration.current) setLoadError(reason)
    } finally { if (!signal?.aborted && generation === loadGeneration.current) setLoading(false) }
  }, [change, root])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load, snapshotSignature])

  const review = useMemo(() => view?.items.find((item) => item.type === 'review' && item.status === 'pending') ?? null, [view])
  const retry = (): void => { setSubmitError(null); void load() }

  async function approve(): Promise<void> {
    const revision = view?.revision
    if (review === null || revision === null || revision === undefined || submitting) return
    setSubmitting(true); setSubmitError(null)
    try {
      const result = await postReviewAcknowledge({ root, change, ref: review.ref.id, expectedRevision: revision })
      onToast?.(result.idempotent ? t('review_console.approved_idempotent') : t('review_console.approved'))
      await load()
      await onRefresh?.()
    } catch (reason) {
      setSubmitError(reason)
      if (reason instanceof ApiError && reason.status === 409) {
        // A stale decision must never be retried against the old ref. Drop it and refresh;
        // the new revision is the only value that can re-enable approval.
        setView(null)
        await load()
      }
    } finally { setSubmitting(false) }
  }

  const inlineError = submitError ?? loadError
  if (review === null) {
    const blocking = submitError ?? (view === null ? loadError : null)
    if (blocking !== null) return (
      <section className="mb-6 flex min-w-0 items-center justify-between gap-4 rounded-md border border-red-b bg-red-t p-4 text-red-d" data-testid="review-console-error" role="alert">
        <p className="min-w-0 truncate font-semibold">{decisionErrorText(blocking, t)}</p>
        <button type="button" className="inline-flex min-h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-sm border border-red-b bg-card px-3 text-caption font-semibold" onClick={retry}>
          <RefreshCw className="size-3.5" aria-hidden="true" />{t('review_console.retry')}
        </button>
      </section>
    )
    if (loading && view === null) return <section className="mb-6 truncate rounded-md border border-border bg-card p-4" data-testid="review-console-loading" role="status">{t('review_console.loading')}</section>
    return <></>
  }

  const evidence = review.evidence.join(' · ')
  const reviewPhase = review.anchor.phase ?? phase
  const edges = rules.transitions[reviewPhase] ?? []
  const target = edges.find((edge) => edge.event === review.anchor.event)?.to
  const eventText = target === undefined ? (review.anchor.event ?? '—') : stageLabel(target, rules)
  const phaseIndex = rules.steps.indexOf(reviewPhase)
  const backEdges = edges.filter((edge) => rules.steps.indexOf(edge.to) >= 0 && rules.steps.indexOf(edge.to) < phaseIndex)
  const sendBack = (event: string, to: string): void => {
    const stage = stageLabel(to, rules)
    void navigator.clipboard?.writeText(reviewRequestCommand(root, change, event))
      .then(() => onToast?.(t('review_console.reject_copied', { stage })), () => undefined)
  }
  return (
    <section className="mb-6 rounded-md border border-amber-b bg-amber-t p-4" data-testid="review-console" aria-labelledby="review-console-title">
      <div className="flex items-start justify-between gap-4">
        <h2 id="review-console-title" className="flex min-w-0 items-center gap-2 whitespace-nowrap text-title font-semibold text-text"><CheckCircle2 className="size-4 shrink-0 text-amber-d" aria-hidden="true" /><span className="truncate">{t('review_console.title')}</span></h2>
        <span className="shrink-0 whitespace-nowrap text-caption text-text-2" data-testid="review-console-stage">{review.anchor.phase === undefined ? review.ref.anchor : stageLabel(review.anchor.phase, rules)}</span>
      </div>
      <dl className="mt-3 grid gap-1 text-caption text-text-2">
        <div className="flex min-w-0 gap-2 whitespace-nowrap"><dt className="shrink-0 font-semibold">{t('review_console.event')}</dt><dd className="truncate" title={review.anchor.event} data-testid="review-console-event">{eventText}</dd></div>
        <div className="flex min-w-0 gap-2 whitespace-nowrap"><dt className="shrink-0 font-semibold">{t('review_console.evidence')}</dt><dd className="truncate" title={evidence}>{evidence}</dd></div>
      </dl>
      <div className="mt-4 flex items-center gap-2">
        <button type="button" className="inline-flex min-h-10 items-center gap-2 whitespace-nowrap rounded-md bg-ink px-4 text-base font-semibold text-ink-fg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent) disabled:cursor-wait disabled:opacity-60" disabled={submitting || view?.revision === null} onClick={() => void approve()} data-testid="review-console-approve">
          <CheckCircle2 className="size-4" aria-hidden="true" />{submitting ? t('review_console.submitting') : t('review_console.approve')}
        </button>
        {backEdges.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger className={BUTTON_GHOST} title={t('review_console.reject_hint')} data-testid="review-console-reject">
              <CornerUpLeft className="size-4" aria-hidden="true" />{t('review_console.reject_to')}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-44" data-testid="review-console-reject-menu">
              {backEdges.map((edge) => (
                <DropdownMenuItem key={edge.event} className="min-h-10 whitespace-nowrap text-body" data-testid={`review-console-reject-${edge.event}`} onSelect={() => sendBack(edge.event, edge.to)}>
                  {stageLabel(edge.to, rules)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {inlineError !== null && <p className="mt-3 truncate text-caption font-semibold text-red-d" role="alert" data-testid="review-console-submit-error">{decisionErrorText(inlineError, t)}</p>}
    </section>
  )
}
