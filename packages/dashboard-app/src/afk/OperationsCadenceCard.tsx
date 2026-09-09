import { Clock3 } from 'lucide-react'
import type { WbCadenceStatus } from '../api/client'
import { useT } from '../i18n'
import { shortTime } from '../model/time'

interface OperationsCadenceCardProps {
  cadence: WbCadenceStatus | null
  compact: boolean
}

export function OperationsCadenceCard({ cadence, compact }: OperationsCadenceCardProps): JSX.Element {
  const { lang, t } = useT()
  return (
    <article className={`rounded-md border border-border bg-fill/40 px-3.5 py-3 ${compact ? '' : 'lg:col-span-2'}`} data-testid="ops-cadence-status" data-enabled={cadence?.enabled === true}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2"><Clock3 size={15} aria-hidden="true" /><h3 className="font-bold text-text">{t('operations.cadence_title')}</h3></div>
        <span className="rounded-full border border-border bg-bg px-2 py-1 font-mono text-micro text-text-3" role="status" aria-live="polite">
          {cadence === null ? t('operations.cadence_loading') : `${t('operations.cadence_poll', { seconds: cadence.poll_interval_ms / 1000 })} · ${cadence.running ? t('operations.cadence_running') : t('operations.cadence_online')}`}
        </span>
      </div>
      <p className="mt-1 text-caption text-text-3">{t('operations.cadence_note')}</p>
      {cadence !== null && cadence.loops.length === 0 && <p className="mt-3 text-caption text-text-3" role="status" aria-live="polite">{t('operations.cadence_empty')}</p>}
      {cadence !== null && cadence.loops.length > 0 && (
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {cadence.loops.map((item) => (
            <div key={`${item.root}:${item.loop_id}`} data-testid={`ops-cadence-loop-${item.loop_id}`} data-state={item.state} className="rounded-md border border-border bg-bg px-3 py-2.5 text-caption">
              <div className="flex items-center justify-between gap-3"><b className="font-mono text-text">{item.loop_id}</b><span className="font-mono text-text-2">{item.state}</span></div>
              <div className="mt-1 text-text-3">{item.runner} · {item.cadence}{item.due_at ? ` · ${t('operations.cadence_next', { time: shortTime(item.due_at, lang) })}` : ''}</div>
              {item.error && <div className="mt-1 text-red-d" role="alert">{lang === 'zh' ? item.error : t('operations.cadence_loop_error')}</div>}
            </div>
          ))}
        </div>
      )}
    </article>
  )
}
