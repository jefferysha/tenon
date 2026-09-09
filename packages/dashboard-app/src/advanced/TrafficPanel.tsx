import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  actualTokenTotal,
  fetchTraceSessions,
  fetchTraceTimeline,
  filterTimelineEntries,
  type TraceSessionRow,
  type TraceTimelineFilter,
  type TraceTimelineResponse,
} from './trafficData'
import { useT } from '../i18n'
import {
  SessionStatusBadge,
  TimelineEntry,
  TrafficSessionRail,
  trafficButtonClass as buttonClass,
} from './TrafficPanelParts'

export function TrafficPanel(): JSX.Element {
  const { lang, t } = useT()
  const [sessions, setSessions] = useState<TraceSessionRow[] | null>(null)
  const [sessionsError, setSessionsError] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [timeline, setTimeline] = useState<TraceTimelineResponse | null>(null)
  const [timelineError, setTimelineError] = useState(false)
  const [filter, setFilter] = useState<TraceTimelineFilter>('all')
  const requestIdentity = useRef(0)
  const sessionButtons = useRef(new Map<string, HTMLButtonElement>())

  const loadSessions = useCallback(() => {
    setSessions(null)
    setSessionsError(false)
    fetchTraceSessions()
      .then((response) => setSessions(response.sessions))
      .catch(() => setSessionsError(true))
  }, [])

  useEffect(() => {
    loadSessions()
    return () => {
      requestIdentity.current += 1
    }
  }, [loadSessions])

  const loadTimeline = useCallback((id: string, resetFilter = true) => {
    const identity = requestIdentity.current + 1
    requestIdentity.current = identity
    setSelected(id)
    setTimeline(null)
    setTimelineError(false)
    if (resetFilter) setFilter('all')
    fetchTraceTimeline(id)
      .then((response) => {
        if (requestIdentity.current === identity) setTimeline(response)
      })
      .catch(() => {
        if (requestIdentity.current === identity) setTimelineError(true)
      })
  }, [])

  const closeTimeline = useCallback(() => {
    if (!selected) return
    const returnTarget = sessionButtons.current.get(selected)
    requestIdentity.current += 1
    setSelected(null)
    setTimeline(null)
    setTimelineError(false)
    setFilter('all')
    returnTarget?.focus()
  }, [selected])

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || !selected) return
    event.preventDefault()
    closeTimeline()
  }, [closeTimeline, selected])

  const formatNumber = useCallback(
    (value: number | null) => value === null
      ? t('advanced.traffic_unknown')
      : new Intl.NumberFormat(lang === 'zh' ? 'zh-CN' : 'en-US').format(value),
    [lang, t],
  )
  const filteredEntries = useMemo(
    () => timeline ? filterTimelineEntries(timeline.entries, filter) : [],
    [filter, timeline],
  )
  const summaryTokens = timeline ? actualTokenTotal(timeline.summary) : null
  const selectedSession = useMemo(
    () => sessions?.find((session) => session.id === selected) ?? null,
    [selected, sessions],
  )
  const formatDateTime = useCallback(
    (value: string) => {
      const parsed = Date.parse(value)
      if (Number.isNaN(parsed)) return t('advanced.traffic_unknown')
      return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-US', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(parsed))
    },
    [lang, t],
  )
  const unselectedCopy = sessionsError
    ? {
        description: t('advanced.traffic_select_unavailable_desc'),
        title: t('advanced.traffic_select_unavailable_title'),
      }
    : sessions === null
      ? {
          description: t('advanced.traffic_sessions_loading'),
          title: t('advanced.traffic_select_loading_title'),
        }
      : sessions.length === 0
        ? {
            description: t('advanced.traffic_sessions_empty'),
            title: t('advanced.traffic_select_empty_title'),
          }
        : {
            description: t('advanced.traffic_select_desc'),
            title: t('advanced.traffic_select_title'),
          }
  const hasSelectedSession = selected !== null && selectedSession !== null

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2.5" data-testid="traffic-panel" onKeyDown={handleKeyDown}>
      <p className="m-0 font-mono text-micro text-text-3" data-testid="traffic-note">
        {t('advanced.traffic_local_note')}
      </p>

      <div
        className="grid min-w-0 grid-cols-1 gap-3 min-[1024px]:grid-cols-[clamp(15.5rem,28%,18rem)_minmax(0,1fr)]"
        data-testid="traffic-workspace"
      >
        <TrafficSessionRail
          formatDateTime={formatDateTime}
          formatNumber={formatNumber}
          loadSessions={loadSessions}
          onSelect={(id) => loadTimeline(id, true)}
          selected={selected}
          sessions={sessions}
          sessionsError={sessionsError}
          setButtonRef={(id, node) => {
            if (node) sessionButtons.current.set(id, node)
            else sessionButtons.current.delete(id)
          }}
          t={t}
        />

        <section
          aria-label={t('advanced.traffic_timeline_label')}
          className={`${hasSelectedSession ? 'mt-1 flex min-w-0 flex-col gap-2.5 border-t border-border pt-3' : 'hidden'} min-[1024px]:mt-0 min-[1024px]:flex min-[1024px]:min-h-[18rem] min-[1024px]:min-w-0 min-[1024px]:flex-col min-[1024px]:gap-0 min-[1024px]:rounded-md min-[1024px]:border min-[1024px]:border-border min-[1024px]:bg-card min-[1024px]:p-3`}
          data-testid="traffic-detail"
        >
          {!selected || !selectedSession ? (
            <div
              className="flex min-h-[15rem] flex-1 flex-col items-center justify-center rounded-sm border border-dashed border-border bg-fill/40 px-6 text-center"
              data-testid="traffic-detail-unselected"
            >
              <p className="m-0 text-base font-bold text-text">{unselectedCopy.title}</p>
              <p className="mt-1.5 mb-0 max-w-md text-caption leading-5 text-text-3">
                {unselectedCopy.description}
              </p>
            </div>
          ) : (
            <div
              className="contents min-[1024px]:flex min-[1024px]:min-w-0 min-[1024px]:flex-col min-[1024px]:gap-3"
              data-testid="traffic-timeline"
            >
              <header
                className="hidden min-[1024px]:flex min-[1024px]:min-w-0 min-[1024px]:flex-wrap min-[1024px]:items-start min-[1024px]:justify-between min-[1024px]:gap-3 min-[1024px]:border-b min-[1024px]:border-border min-[1024px]:pb-3"
                data-testid="traffic-session-identity"
              >
                <div className="min-w-0">
                  <p className="m-0 text-micro font-semibold tracking-[0.12em] text-text-3 uppercase">
                    {t('advanced.traffic_current_session')}
                  </p>
                  <p className="mt-1 mb-0 truncate font-mono text-base font-bold text-text">
                    {selectedSession.client || t('advanced.traffic_unknown_client')}
                  </p>
                  <p className="mt-1 mb-0 truncate font-mono text-micro text-text-3" title={selectedSession.id}>
                    {selectedSession.id}
                  </p>
                </div>
                <div className="flex min-w-0 max-w-[45%] flex-col items-end gap-1.5">
                  <SessionStatusBadge status={selectedSession.status} t={t} />
                  <span
                    className="max-w-full truncate font-mono text-micro text-text-3"
                    data-testid="traffic-detail-proxy"
                    title={selectedSession.proxy_mode || t('advanced.traffic_unknown_proxy')}
                  >
                    {selectedSession.proxy_mode || t('advanced.traffic_unknown_proxy')}
                  </span>
                </div>
                <dl className="m-0 grid w-full grid-cols-2 gap-x-4 gap-y-1 text-micro text-text-3 min-[1280px]:w-auto">
                  <div className="flex min-w-0 gap-1.5">
                    <dt>{t('advanced.traffic_started')}</dt>
                    <dd className="m-0 truncate font-mono" title={selectedSession.started_at}>
                      {formatDateTime(selectedSession.started_at)}
                    </dd>
                  </div>
                  <div className="flex min-w-0 gap-1.5">
                    <dt>{t('advanced.traffic_updated')}</dt>
                    <dd className="m-0 truncate font-mono" title={selectedSession.updated_at}>
                      {formatDateTime(selectedSession.updated_at)}
                    </dd>
                  </div>
                </dl>
              </header>

              {timelineError ? (
                <div className="rounded-sm border border-red-b bg-red-t p-3">
                  <p className="m-0 text-caption font-semibold text-red" data-testid="traffic-timeline-error" role="alert">
                    {t('advanced.traffic_timeline_error')}
                  </p>
                  <button className={`${buttonClass} mt-2`} type="button" onClick={() => loadTimeline(selected, false)}>
                    {t('advanced.traffic_retry_timeline')}
                  </button>
                </div>
              ) : timeline === null ? (
                <p
                  className="m-0 text-caption text-text-3"
                  data-testid="traffic-timeline-loading"
                  role="status"
                  aria-live="polite"
                >
                  {t('advanced.traffic_timeline_loading')}
                </p>
              ) : (
                <>
                  <div
                    className="grid grid-cols-2 gap-1.5 min-[640px]:max-[1023px]:grid-cols-4 min-[1280px]:grid-cols-4"
                    data-testid="traffic-summary"
                  >
                    {[
                      [t('advanced.traffic_summary_calls'), formatNumber(timeline.returned_count)],
                      [t('advanced.traffic_summary_errors'), formatNumber(timeline.summary.error_count)],
                      [t('advanced.traffic_summary_duration'), formatNumber(timeline.summary.total_duration_ms)],
                      [t('advanced.traffic_summary_tokens'), formatNumber(summaryTokens)],
                    ].map(([label, value]) => (
                      <div className="rounded-sm border border-border bg-fill px-2.5 py-2" key={label}>
                        <p className="m-0 text-micro font-semibold tracking-wide text-text-3 uppercase">{label}</p>
                        <p className="mt-0.5 mb-0 font-mono text-base font-bold text-text">{value}</p>
                        {label === t('advanced.traffic_summary_calls') && (
                          <p className="mt-0.5 mb-0 text-micro text-text-3">
                            {t('advanced.traffic_summary_unknown', {
                              n: formatNumber(timeline.summary.unknown_count),
                            })}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>

                  {(timeline.integrity === 'partial' || timeline.truncated) && (
                    <div className="rounded-sm border border-amber-b bg-amber-t p-2.5" data-testid="traffic-integrity">
                      <p className="m-0 text-caption font-semibold text-text">
                        {timeline.integrity === 'partial'
                          ? t('advanced.traffic_integrity_partial', { n: timeline.skipped_count })
                          : t('advanced.traffic_integrity_complete')}
                        {timeline.truncated ? ` ${t('advanced.traffic_integrity_truncated')}` : ''}
                      </p>
                      <p className="mt-1 mb-0 text-micro text-text-3">
                        {t('advanced.traffic_integrity_warnings', { codes: timeline.warnings.join(', ') })}
                      </p>
                      <button className={`${buttonClass} mt-2`} type="button" onClick={() => loadTimeline(selected, false)}>
                        {t('advanced.traffic_retry_timeline')}
                      </button>
                    </div>
                  )}

                  {timeline.entries.length === 0 && timeline.total_count === 0 && timeline.integrity === 'complete' ? (
                    <p className="m-0 text-caption text-text-3" data-testid="traffic-timeline-empty" role="status">
                      {t('advanced.traffic_timeline_empty')}
                    </p>
                  ) : timeline.entries.length === 0 ? (
                    <p className="m-0 text-caption text-text-3" data-testid="traffic-timeline-unavailable" role="status">
                      {t('advanced.traffic_timeline_unavailable')}
                    </p>
                  ) : (
                    <>
                      <div className="flex flex-wrap gap-1.5" aria-label={t('advanced.traffic_filter_label')}>
                        {([
                          ['all', 'traffic_filter_all'],
                          ['error', 'traffic_filter_errors'],
                          ['success', 'traffic_filter_success'],
                        ] as const).map(([value, key]) => (
                          <button
                            className={buttonClass}
                            type="button"
                            aria-pressed={filter === value}
                            key={value}
                            onClick={() => setFilter(value)}
                          >
                            {t(`advanced.${key}`)}
                          </button>
                        ))}
                      </div>
                      {filteredEntries.length === 0 ? (
                        <div className="rounded-sm border border-dashed border-border bg-fill p-3" data-testid="traffic-filter-empty">
                          <p className="m-0 text-caption text-text-3">{t('advanced.traffic_filter_empty')}</p>
                          <button className={`${buttonClass} mt-2`} type="button" onClick={() => setFilter('all')}>
                            {t('advanced.traffic_filter_clear')}
                          </button>
                        </div>
                      ) : (
                        <ol
                          className="m-0 flex list-none flex-col gap-1.5 p-0 min-[1024px]:block min-[1024px]:divide-y min-[1024px]:divide-border min-[1024px]:overflow-hidden min-[1024px]:rounded-sm min-[1024px]:border min-[1024px]:border-border min-[1024px]:bg-card"
                          data-testid="traffic-entries"
                        >
                          {filteredEntries.map((entry, index) => (
                            <TimelineEntry
                              entry={entry}
                              formatNumber={formatNumber}
                              key={`${entry.sequence}-${index}`}
                              t={t}
                            />
                          ))}
                        </ol>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
