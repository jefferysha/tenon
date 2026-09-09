import { CheckCircle2, Clock3, CircleDashed, ShieldQuestion } from 'lucide-react'
import type { ComponentType, SVGProps } from 'react'
import { useT } from '../i18n'
import type { ChangeSnapshot } from '../types'

export interface ReviewHandshakeStatusProps {
  change: ChangeSnapshot
}

type StatusPresentation = {
  icon: ComponentType<SVGProps<SVGSVGElement>>
  title: string
  detail: string
  tone: string
}

export function ReviewHandshakeStatus({
  change,
}: ReviewHandshakeStatusProps): JSX.Element | null {
  const { t } = useT()
  if (change.workflowRules.gateByStep[change.phase] !== 'review') return null

  const handshake = change.reviewHandshake
  let presentation: StatusPresentation
  if (handshake === undefined) {
    presentation = {
      icon: ShieldQuestion,
      title: t('progress.review_unavailable'),
      detail: t('progress.review_unavailable_next'),
      tone: 'border-border-2 bg-fill text-text-2',
    }
  } else if (handshake.status === 'not-requested') {
    presentation = {
      icon: CircleDashed,
      title: t('progress.review_not_requested'),
      detail: t('progress.review_not_requested_next'),
      tone: 'border-amber-b bg-amber-t text-amber-d',
    }
  } else if (handshake.status === 'pending') {
    presentation = {
      icon: Clock3,
      title: t('progress.review_pending'),
      detail: t('progress.review_pending_next'),
      tone: 'border-amber-b bg-amber-t text-amber-d',
    }
  } else {
    presentation = {
      icon: CheckCircle2,
      title: t('progress.review_approved'),
      detail: t('progress.review_approved_next'),
      tone: 'border-green-b bg-green-t text-green-d',
    }
  }

  const Icon = presentation.icon
  return (
    <section
      className={`mt-4 rounded-md border p-4 ${presentation.tone}`}
      data-testid="review-handshake-status"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 h-4 w-4 flex-none" strokeWidth={1.75} aria-hidden="true" />
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{t('progress.review_title')}</h2>
          <p className="mt-1 text-base font-semibold">{presentation.title}</p>
          <p className="mt-1 text-caption leading-5">{presentation.detail}</p>
        </div>
      </div>

      {handshake !== undefined && handshake.status !== 'not-requested' && (
        <dl className="mt-3 grid gap-2 border-t border-current/15 pt-3 text-caption">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <dt>{t('progress.review_event')}</dt>
            <dd className="break-all font-mono font-semibold">{handshake.event}</dd>
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <dt>{t('progress.review_requested_at')}</dt>
            <dd><time className="font-mono" dateTime={handshake.requestedAt}>{handshake.requestedAt}</time></dd>
          </div>
          {handshake.status === 'approved' && (
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <dt>{t('progress.review_acknowledged_at')}</dt>
              <dd>
                <time className="font-mono" dateTime={handshake.acknowledgedAt}>
                  {handshake.acknowledgedAt}
                </time>
              </dd>
            </div>
          )}
        </dl>
      )}
    </section>
  )
}
