import type { WbLoopGraduation } from '../api/client'
import type { Lang } from '../i18n/translations'
import { cn } from '@/lib/utils'

type Translate = (key: string, vars?: Record<string, string | number>) => string

export function GovernanceGraduation({
  graduation,
  lang,
  t,
}: {
  graduation: WbLoopGraduation
  lang: Lang
  t: Translate
}): JSX.Element {
  return (
    <div
      className={cn(
        'mt-2.5 rounded-[10px] border px-3 py-2.5 text-xs',
        graduation.canGraduate ? 'border-green-b bg-green-t' : 'border-amber-b bg-amber-t',
      )}
      data-can-graduate={String(graduation.canGraduate)}
      data-testid="wb-gov-graduation"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <b className="text-text">
          {graduation.canGraduate ? t('workbench.gov_preflight_ready') : t('workbench.gov_preflight_blocked')}
        </b>
        <span className="font-mono text-text-2">{graduation.current} → {graduation.recommended}</span>
      </div>
      <p className="mt-1 font-mono text-[11px] text-text-2">
        {t('workbench.gov_metric_runs')} {graduation.runs} · {t('workbench.gov_metric_drift')} {graduation.driftCount} · {t('workbench.gov_metric_fail_streak')} {graduation.failStreak} · {t('workbench.gov_metric_breaker')} {graduation.breaker}
      </p>
      {lang === 'zh' && graduation.blockers.length > 0 && (
        <ul className="mt-2 space-y-1 pl-4 text-text-2">
          {graduation.blockers.map((blocker) => <li key={blocker} className="list-disc">{blocker}</li>)}
        </ul>
      )}
      {graduation.demotionSignals.length > 0 && (
        <p className="mt-2 text-red-d">
          {t('workbench.gov_preflight_demote')}
          {lang === 'zh' ? `: ${graduation.demotionSignals.join('；')}` : ''}
        </p>
      )}
    </div>
  )
}
