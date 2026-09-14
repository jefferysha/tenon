import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, RefreshCw } from 'lucide-react'
import { fetchPendingDecisions, postReviewAcknowledge, type PendingDecision } from '../api/decisionClient'
import { formatApiError } from '../api/transport'
import { useT } from '../i18n'

export interface ReviewDecisionPanelProps {
  root: string
  change: string
  onRefresh?: () => void | Promise<void>
  onToast?: (message: string) => void
}

/**
 * The Dashboard review surface is deliberately narrow: it acknowledges an existing
 * terminal review request. It never starts a Skill, answers a Skill question, or calls a model.
 */
export function ReviewDecisionPanel({ root, change, onRefresh, onToast }: ReviewDecisionPanelProps): JSX.Element {
  const { t } = useT()
  const [view, setView] = useState<{ revision: number | null; items: readonly PendingDecision[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    try {
      const next = await fetchPendingDecisions(root, change, signal)
      setView(next)
      setError(null)
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') return
      setError(reason)
    } finally { if (!signal?.aborted) setLoading(false) }
  }, [change, root])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const review = useMemo(() => view?.items.find((item) => item.type === 'review' && item.status === 'pending') ?? null, [view])
  const retry = (): void => { void load() }

  async function approve(): Promise<void> {
    const revision = view?.revision
    if (review === null || revision === null || revision === undefined || submitting) return
    setSubmitting(true); setError(null)
    try {
      const result = await postReviewAcknowledge({ root, change, ref: review.ref.id, expectedRevision: revision })
      onToast?.(result.idempotent ? t('review_console.approved_idempotent') : t('review_console.approved'))
      await load()
      await onRefresh?.()
    } catch (reason) { setError(reason) } finally { setSubmitting(false) }
  }

  if (loading && view === null) return <section className="mb-6 rounded-md border border-border bg-card p-4" data-testid="review-console-loading" role="status">{t('review_console.loading')}</section>
  if (error !== null && view === null) return (
    <section className="mb-6 rounded-md border border-red-b bg-red-t p-4 text-red-d" data-testid="review-console-error" role="alert">
      <p>{formatApiError(error, t)}</p>
      <button type="button" className="mt-3 inline-flex min-h-9 items-center gap-2 rounded-sm border border-red-b bg-card px-3 text-caption font-semibold" onClick={retry}>
        <RefreshCw className="size-3.5" aria-hidden="true" />{t('review_console.retry')}
      </button>
    </section>
  )
  if (review === null) return <></>

  return (
    <section className="mb-6 rounded-md border border-amber-b bg-amber-t p-4" data-testid="review-console" aria-labelledby="review-console-title">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 id="review-console-title" className="flex items-center gap-2 text-title font-semibold text-text"><CheckCircle2 className="size-4 text-amber-d" aria-hidden="true" />{t('review_console.title')}</h2>
          <p className="mt-1 text-body text-text-2">{t('review_console.description')}</p>
        </div>
        <span className="shrink-0 rounded-full bg-card px-2 py-1 font-mono text-micro text-text-2">{review.anchor.phase ?? review.ref.anchor}</span>
      </div>
      <dl className="mt-3 grid gap-1 text-caption text-text-2">
        <div className="flex gap-2"><dt className="font-semibold">{t('review_console.event')}</dt><dd className="font-mono">{review.anchor.event ?? '—'}</dd></div>
        <div className="flex gap-2"><dt className="font-semibold">{t('review_console.evidence')}</dt><dd>{review.evidence.join(' · ')}</dd></div>
      </dl>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" className="inline-flex min-h-10 items-center gap-2 rounded-md bg-ink px-4 text-base font-semibold text-ink-fg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent) disabled:cursor-wait disabled:opacity-60" disabled={submitting || view?.revision === null} onClick={() => void approve()} data-testid="review-console-approve">
          <CheckCircle2 className="size-4" aria-hidden="true" />{submitting ? t('review_console.submitting') : t('review_console.approve')}
        </button>
        <span className="text-caption text-text-3" data-testid="review-console-boundary">{t('review_console.boundary')}</span>
      </div>
      {error !== null && <p className="mt-3 text-caption font-semibold text-red-d" role="alert" data-testid="review-console-submit-error">{formatApiError(error, t)}</p>}
    </section>
  )
}
