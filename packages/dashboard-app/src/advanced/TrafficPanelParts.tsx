import type { TraceSessionRow, TraceTimelineEntry } from './trafficData'

export const trafficButtonClass =
  'cursor-pointer rounded-sm border border-border bg-card px-2.5 py-1.5 text-caption font-semibold text-text outline-none transition-[border-color,box-shadow] hover:border-accent-b focus-visible:border-(--accent) focus-visible:ring-[3px] focus-visible:ring-(--ring-blue) aria-pressed:border-(--accent) aria-pressed:bg-accent-t'

const SESSION_STATUS_KEYS: Readonly<Record<string, string>> = {
  active: 'traffic_status_active',
  complete: 'traffic_status_complete',
  empty: 'traffic_status_empty',
  error: 'traffic_status_error',
}

type Translate = (key: string, vars?: Record<string, string | number>) => string

function shortSessionId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id
}

export function SessionStatusBadge({
  className = '',
  status,
  t,
}: {
  className?: string
  status: string
  t: Translate
}): JSX.Element {
  return (
    <span
      className={`shrink-0 rounded-full bg-fill px-2 py-0.5 text-micro font-bold text-text-3 data-[state=active]:bg-green-t data-[state=active]:text-green-d data-[state=error]:bg-red-t data-[state=error]:text-red ${className}`}
      data-state={status}
    >
      {t(`advanced.${SESSION_STATUS_KEYS[status] ?? 'traffic_status_unknown'}`)}
    </span>
  )
}

export function TimelineEntry({
  entry,
  formatNumber,
  t,
}: {
  entry: TraceTimelineEntry
  formatNumber: (value: number | null) => string
  t: Translate
}): JSX.Element {
  const parsedTimestamp = entry.timestamp === null ? Number.NaN : Date.parse(entry.timestamp)
  const time = Number.isNaN(parsedTimestamp)
    ? t('advanced.traffic_unknown')
    : new Date(parsedTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return (
    <li
      className="grid grid-cols-1 gap-2 rounded-sm border border-border bg-card px-3 py-2.5 text-caption min-[640px]:max-[1023px]:grid-cols-[7rem_minmax(0,1fr)_auto] min-[1024px]:min-w-0 min-[1024px]:rounded-none min-[1024px]:border-0 min-[1024px]:bg-transparent min-[1024px]:py-3 min-[1280px]:grid-cols-[6.5rem_minmax(0,1fr)_minmax(0,12rem)]"
      data-testid={`traffic-entry-${entry.sequence}`}
    >
      <div className="flex flex-col gap-0.5 font-mono text-micro text-text-3">
        <span>{entry.turn === null ? t('advanced.traffic_turn_unknown') : t('advanced.traffic_turn', { n: entry.turn })}</span>
        <time dateTime={entry.timestamp ?? undefined}>{time}</time>
      </div>
      <div className="min-w-0">
        <p className="m-0 truncate font-mono font-semibold text-text" title={`${entry.method ?? ''} ${entry.path ?? ''}`.trim()}>
          {entry.method ?? t('advanced.traffic_unknown')} {entry.path ?? t('advanced.traffic_unknown')}
        </p>
        <p className="mt-1 mb-0 flex flex-wrap gap-x-2 gap-y-0.5 text-micro text-text-3 min-[1024px]:min-w-0 min-[1024px]:overflow-hidden">
          {entry.model && (
            <span
              className="min-[1024px]:min-w-0 min-[1024px]:max-w-full min-[1024px]:flex-1 min-[1024px]:truncate"
              data-testid="traffic-model-value"
              title={entry.model}
            >
              {t('advanced.traffic_model', { value: entry.model })}
            </span>
          )}
          {entry.input_tokens !== null && (
            <span>{t('advanced.traffic_input_tokens', { n: formatNumber(entry.input_tokens) })}</span>
          )}
          {entry.output_tokens !== null && (
            <span>{t('advanced.traffic_output_tokens', { n: formatNumber(entry.output_tokens) })}</span>
          )}
          {entry.cached_input_tokens !== null && (
            <span>{t('advanced.traffic_cached_tokens', { n: formatNumber(entry.cached_input_tokens) })}</span>
          )}
          {entry.stream_event_count !== null && (
            <span>{t('advanced.traffic_stream_events', { n: formatNumber(entry.stream_event_count) })}</span>
          )}
        </p>
      </div>
      <div className="flex items-start gap-2 font-mono text-micro min-[1024px]:min-w-0">
        <span
          className="rounded-full bg-fill px-2 py-0.5 font-bold text-text-3 data-[outcome=error]:bg-red-t data-[outcome=error]:text-red data-[outcome=success]:bg-green-t data-[outcome=success]:text-green-d min-[1024px]:shrink-0"
          data-outcome={entry.outcome}
        >
          {entry.status_code ?? t('advanced.traffic_unknown')}
          {' · '}
          {t(`advanced.traffic_outcome_${entry.outcome}`)}
        </span>
        <span className="flex items-start gap-1 pt-0.5 text-text-3 min-[1024px]:min-w-0">
          <span className="min-[1024px]:shrink-0">
            {entry.duration_ms === null
              ? t('advanced.traffic_duration_unknown')
              : t('advanced.traffic_duration_ms', { n: formatNumber(entry.duration_ms) })}
          </span>
          {entry.transport && (
            <>
              <span aria-hidden="true">·</span>
              <span
                className="min-[1024px]:min-w-0 min-[1024px]:truncate"
                data-testid="traffic-transport-value"
                title={entry.transport}
              >
                {entry.transport}
              </span>
            </>
          )}
        </span>
      </div>
    </li>
  )
}

export function TrafficSessionRail({
  formatDateTime,
  formatNumber,
  loadSessions,
  onSelect,
  selected,
  sessions,
  sessionsError,
  setButtonRef,
  t,
}: {
  formatDateTime: (value: string) => string
  formatNumber: (value: number | null) => string
  loadSessions: () => void
  onSelect: (id: string) => void
  selected: string | null
  sessions: TraceSessionRow[] | null
  sessionsError: boolean
  setButtonRef: (id: string, node: HTMLButtonElement | null) => void
  t: Translate
}): JSX.Element {
  return (
    <section
      aria-label={t('advanced.traffic_sessions_label')}
      className="min-w-0 min-[1024px]:rounded-md min-[1024px]:border min-[1024px]:border-border min-[1024px]:bg-fill/30 min-[1024px]:p-2.5"
      data-testid="traffic-session-rail"
    >
      <header
        className="hidden min-[1024px]:mb-2.5 min-[1024px]:flex min-[1024px]:items-end min-[1024px]:justify-between min-[1024px]:gap-3 min-[1024px]:px-0.5"
        data-testid="traffic-session-rail-header"
      >
        <div>
          <p className="m-0 text-caption font-bold text-text">{t('advanced.traffic_sessions_heading')}</p>
          <p className="mt-0.5 mb-0 text-micro text-text-3">{t('advanced.traffic_sessions_hint')}</p>
        </div>
        {sessions !== null && !sessionsError && (
          <span className="rounded-full border border-border bg-card px-2 py-0.5 font-mono text-micro text-text-3">
            {formatNumber(sessions.length)}
          </span>
        )}
      </header>

      {sessionsError ? (
        <div className="rounded-sm border border-red-b bg-red-t p-3">
          <p className="m-0 text-caption font-semibold text-red" data-testid="traffic-error" role="alert">
            {t('advanced.traffic_sessions_error')}
          </p>
          <button className={`${trafficButtonClass} mt-2`} type="button" onClick={loadSessions}>
            {t('advanced.traffic_retry_sessions')}
          </button>
        </div>
      ) : sessions === null ? (
        <p
          className="m-0 text-caption text-text-3"
          data-testid="traffic-sessions-loading"
          role="status"
          aria-live="polite"
        >
          {t('advanced.traffic_sessions_loading')}
        </p>
      ) : sessions.length === 0 ? (
        <p className="m-0 text-caption text-text-3" data-testid="traffic-empty" role="status">
          {t('advanced.traffic_sessions_empty')}
        </p>
      ) : (
        <ul
          className="m-0 flex list-none flex-col gap-1.5 p-0 min-[1024px]:max-h-[42rem] min-[1024px]:overflow-y-auto min-[1024px]:pr-1"
          data-testid="traffic-sessions"
        >
          {sessions.map((session) => (
            <li data-testid={`traffic-session-${session.id}`} key={session.id}>
              <button
                ref={(node) => setButtonRef(session.id, node)}
                type="button"
                title={session.id}
                className="group flex w-full cursor-pointer items-center gap-2.5 rounded-sm border border-border bg-card px-2.5 py-2 text-left text-text outline-none transition-[border-color,box-shadow,background-color] hover:border-accent-b focus-visible:border-(--accent) focus-visible:ring-[3px] focus-visible:ring-(--ring-blue) aria-pressed:border-[1.5px] aria-pressed:border-(--accent) aria-pressed:bg-accent-t aria-pressed:shadow-[0_0_0_3px_var(--ring-blue)] min-[1024px]:flex-col min-[1024px]:items-stretch min-[1024px]:gap-1 min-[1024px]:py-2.5 min-[1024px]:aria-pressed:border-l-[3px]"
                aria-pressed={selected === session.id}
                onClick={() => onSelect(session.id)}
              >
                <span className="contents min-[1024px]:flex min-[1024px]:w-full min-[1024px]:min-w-0 min-[1024px]:items-center min-[1024px]:gap-2">
                  <span className="order-1 min-w-0 truncate font-mono text-caption font-semibold text-text min-[1024px]:order-none min-[1024px]:flex-1 min-[1024px]:font-bold">
                    {session.client || t('advanced.traffic_unknown_client')}
                  </span>
                  <SessionStatusBadge
                    className="order-3 ml-auto min-[1024px]:order-none min-[1024px]:ml-0"
                    status={session.status}
                    t={t}
                  />
                </span>
                <span className="hidden min-[1024px]:flex min-[1024px]:w-full min-[1024px]:min-w-0 min-[1024px]:items-center min-[1024px]:gap-1.5 min-[1024px]:font-mono min-[1024px]:text-micro min-[1024px]:text-text-3">
                  <span className="min-w-0 truncate">{shortSessionId(session.id)}</span>
                  <span aria-hidden="true">·</span>
                  <span
                    className="min-w-0 max-w-[45%] truncate"
                    data-testid="traffic-session-proxy"
                    title={session.proxy_mode || t('advanced.traffic_unknown_proxy')}
                  >
                    {session.proxy_mode || t('advanced.traffic_unknown_proxy')}
                  </span>
                </span>
                <span className="contents min-[1024px]:flex min-[1024px]:w-full min-[1024px]:items-center min-[1024px]:justify-between min-[1024px]:gap-2 min-[1024px]:text-micro min-[1024px]:text-text-3">
                  <span className="order-2 font-mono text-micro text-text-3 min-[1024px]:order-none min-[1024px]:font-sans">
                    {t(
                      session.record_count === 1
                        ? 'advanced.traffic_session_count_one'
                        : 'advanced.traffic_session_count_many',
                      { n: formatNumber(session.record_count) },
                    )}
                  </span>
                  <time
                    className="hidden min-[1024px]:block"
                    dateTime={session.updated_at}
                    title={session.updated_at}
                  >
                    {formatDateTime(session.updated_at)}
                  </time>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
