import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nProvider } from '../i18n'
import { TrafficPanel } from './TrafficPanel'

const SESSIONS = {
  generated_at: '2026-07-29T00:00:00Z',
  outbound: 'local-only',
  count: 2,
  sessions: [
    {
      id: 'sess-A',
      started_at: '2026-07-29T00:00:00Z',
      updated_at: '2026-07-29T00:00:02Z',
      date_key: '2026-07-29',
      client: 'claude',
      proxy_mode: 'reverse',
      status: 'complete',
      record_count: 3,
      summary: null,
    },
    {
      id: 'sess-B',
      started_at: '2026-07-29T01:00:00Z',
      updated_at: '2026-07-29T01:00:01Z',
      date_key: '2026-07-29',
      client: 'codex',
      proxy_mode: 'forward',
      status: 'active',
      record_count: 0,
      summary: null,
    },
  ],
}

function timeline(
  session = 'sess-A',
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    generated_at: '2026-07-29T00:00:03Z',
    outbound: 'local-only',
    content: 'metadata-only',
    session: {
      id: session,
      client: session === 'sess-B' ? 'codex' : 'claude',
      proxy_mode: session === 'sess-B' ? 'forward' : 'reverse',
      status: 'complete',
      started_at: '2026-07-29T00:00:00Z',
      updated_at: '2026-07-29T00:00:03Z',
    },
    total_count: 3,
    returned_count: 3,
    skipped_count: 0,
    truncated: false,
    integrity: 'complete',
    warnings: [],
    summary: {
      success_count: 1,
      error_count: 1,
      unknown_count: 1,
      total_duration_ms: 1625,
      input_tokens: 18,
      output_tokens: 9,
      cached_input_tokens: 4,
    },
    entries: [
      {
        sequence: 1,
        request_id: 'req-1',
        turn: 1,
        timestamp: '2026-07-29T00:00:01Z',
        duration_ms: 400,
        transport: 'sse',
        method: 'POST',
        path: '/v1/messages',
        status_code: 200,
        outcome: 'success',
        model: 'claude-sonnet-4',
        input_tokens: 18,
        output_tokens: 9,
        cached_input_tokens: 4,
        stream_event_count: 5,
      },
      {
        sequence: 2,
        request_id: 'req-2',
        turn: 2,
        timestamp: '2026-07-29T00:00:02Z',
        duration_ms: 1200,
        transport: 'sse',
        method: 'POST',
        path: '/v1/messages',
        status_code: 429,
        outcome: 'error',
        model: null,
        input_tokens: null,
        output_tokens: null,
        cached_input_tokens: null,
        stream_event_count: 2,
      },
      {
        sequence: 3,
        request_id: null,
        turn: null,
        timestamp: null,
        duration_ms: 25,
        transport: null,
        method: 'GET',
        path: '/unknown',
        status_code: null,
        outcome: 'unknown',
        model: null,
        input_tokens: null,
        output_tokens: null,
        cached_input_tokens: null,
        stream_event_count: null,
      },
    ],
    ...overrides,
  }
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function renderTraffic(lang: 'zh' | 'en' = 'zh'): void {
  localStorage.setItem('tenon-dashboard-lang', lang)
  render(
    <I18nProvider>
      <TrafficPanel />
    </I18nProvider>,
  )
}

beforeEach(() => localStorage.clear())
afterEach(() => vi.unstubAllGlobals())

describe('TrafficPanel metadata-only timeline', () => {
  it('keeps a stable desktop rail and detail without an implicit timeline request', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/traces/sessions') return response(SESSIONS)
      if (url.includes('/api/traces/timeline')) return response(timeline())
      throw new Error(`unexpected fetch ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    renderTraffic()

    const sessionButton = await screen.findByRole('button', { name: /claude/ })
    const workspace = screen.getByTestId('traffic-workspace')
    expect(workspace.className).toContain('min-[1024px]:grid-cols-[clamp(15.5rem,28%,18rem)_minmax(0,1fr)]')
    const rail = screen.getByTestId('traffic-session-rail')
    const unselectedDetail = screen.getByTestId('traffic-detail')
    expect(rail).toHaveAccessibleName('捕获会话')
    expect(rail.className).toContain('min-[1024px]:rounded-md')
    expect(screen.getByTestId('traffic-session-rail-header').className).toContain('hidden')
    expect(unselectedDetail.className).toContain('hidden')
    expect(unselectedDetail.className).toContain('min-[1024px]:flex')
    expect(screen.getByTestId('traffic-detail-unselected')).toHaveTextContent('选择一个会话')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    expect(sessionButton).toHaveAttribute('title', 'sess-A')
    expect(sessionButton).toHaveTextContent('sess-A')
    expect(sessionButton).toHaveTextContent('reverse')
    await userEvent.click(sessionButton)

    const identity = await screen.findByTestId('traffic-session-identity')
    expect(identity).toHaveTextContent('claude')
    expect(identity).toHaveTextContent('sess-A')
    expect(identity).toHaveTextContent('reverse')
    expect(identity.className).toContain('hidden')
    expect(identity.className).toContain('min-[1024px]:flex')
    expect(screen.getByTestId('traffic-detail').className).toContain('mt-1')
    expect(screen.getByTestId('traffic-summary').className).toContain('min-[640px]:max-[1023px]:grid-cols-4')
    const entries = screen.getByTestId('traffic-entries')
    expect(entries.className).toContain('flex')
    expect(entries.className).toContain('min-[1024px]:divide-y')
    expect(screen.getByTestId('traffic-entry-1').className).toContain(
      'min-[640px]:max-[1023px]:grid-cols-[7rem_minmax(0,1fr)_auto]',
    )
  })

  it('shows session loading, local-only sessions, summary, and ordered metadata without raw query', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/traces/sessions') return response(SESSIONS)
      if (url.includes('/api/traces/timeline')) return response(timeline())
      throw new Error(`unexpected fetch ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    renderTraffic()

    expect(screen.getByTestId('traffic-sessions-loading')).toHaveTextContent('加载捕获会话')
    const sessionButton = await screen.findByRole('button', { name: /claude/ })
    expect(screen.getByTestId('traffic-note')).toHaveTextContent('local-only')
    expect(sessionButton.className).toContain('focus-visible:ring-[3px]')
    expect(sessionButton).toHaveTextContent('已完成')
    expect(sessionButton).not.toHaveTextContent('complete')
    await userEvent.click(sessionButton)

    const rows = await screen.findAllByTestId(/traffic-entry-/)
    expect(screen.getByRole('button', { name: /失败/ }).className).toContain('focus-visible:ring-[3px]')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveTextContent('/v1/messages')
    expect(rows[0]).toHaveTextContent('缓存输入 4')
    expect(rows[0]).toHaveTextContent('流事件 5')
    expect(rows[0]).not.toHaveTextContent('cached')
    expect(rows[1]).toHaveTextContent('429')
    expect(rows[1]).toHaveTextContent('失败')
    expect(rows[2]).toHaveTextContent('未知')
    expect(screen.getByTestId('traffic-summary')).toHaveTextContent('3')
    expect(screen.getByTestId('traffic-summary')).toHaveTextContent('未知状态 1')
    expect(screen.getByTestId('traffic-summary')).toHaveTextContent('1,625')
    expect(screen.getByTestId('traffic-summary')).toHaveTextContent('27')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/traces/timeline?session=sess-A',
      { headers: { Accept: 'application/json' } },
    )
    expect(document.body.textContent).not.toContain('?api_key=')
  })

  it('filters failures and distinguishes filter-empty from an empty session', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (
      url === '/api/traces/sessions' ? response(SESSIONS) : response(timeline())
    )))
    renderTraffic()
    await userEvent.click(await screen.findByRole('button', { name: /claude/ }))

    await userEvent.click(await screen.findByRole('button', { name: /失败/ }))
    expect(screen.getAllByTestId(/traffic-entry-/)).toHaveLength(1)
    expect(screen.getByTestId('traffic-entry-2')).toHaveTextContent('429')
    expect(screen.getByTestId('traffic-summary')).toHaveTextContent('3')

    const successOnly = timeline('sess-A', {
      summary: {
        success_count: 1,
        error_count: 0,
        unknown_count: 0,
        total_duration_ms: 1,
        input_tokens: null,
        output_tokens: null,
        cached_input_tokens: null,
      },
      entries: [{
        sequence: 1,
        request_id: null,
        turn: null,
        timestamp: null,
        duration_ms: 1,
        transport: null,
        method: 'GET',
        path: '/health',
        status_code: 200,
        outcome: 'success',
        model: null,
        input_tokens: null,
        output_tokens: null,
        cached_input_tokens: null,
        stream_event_count: null,
      }],
      total_count: 1,
      returned_count: 1,
    })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (
      url === '/api/traces/sessions' ? response(SESSIONS) : response(successOnly)
    )))
    renderTraffic()
    const sessionButtons = await screen.findAllByRole('button', { name: /claude/ })
    await userEvent.click(sessionButtons.at(-1)!)
    const failureButtons = await screen.findAllByRole('button', { name: /失败/ })
    await userEvent.click(failureButtons.at(-1)!)
    expect(screen.getByTestId('traffic-filter-empty')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /清除筛选/ }))
    expect(screen.queryByTestId('traffic-filter-empty')).not.toBeInTheDocument()
  })

  it('supports independent sessions error retry and empty states', async () => {
    let attempts = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      attempts += 1
      return attempts === 1 ? response({ error: 'offline' }, 500) : response({ ...SESSIONS, count: 0, sessions: [] })
    }))
    renderTraffic()

    expect(await screen.findByTestId('traffic-error')).toHaveAttribute('role', 'alert')
    expect(screen.getByTestId('traffic-detail-unselected')).toHaveTextContent('会话列表不可用')
    await userEvent.click(screen.getByRole('button', { name: /重试/ }))
    expect(await screen.findByTestId('traffic-empty')).toHaveTextContent('暂无捕获会话')
    expect(screen.getByTestId('traffic-detail-unselected')).toHaveTextContent('当前没有可选择的会话')
  })

  it('supports timeline loading, failure retry, known-empty, and partial/truncated notices', async () => {
    let timelineAttempts = 0
    const firstTimeline = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/traces/sessions') return response(SESSIONS)
      timelineAttempts += 1
      if (timelineAttempts === 1) return firstTimeline.promise
      return response(timeline('sess-A', {
        integrity: 'partial',
        truncated: true,
        skipped_count: 1,
        warnings: ['record-limit', 'malformed-record'],
      }))
    }))
    renderTraffic()
    await userEvent.click(await screen.findByRole('button', { name: /claude/ }))
    expect(screen.getByTestId('traffic-timeline-loading')).toHaveTextContent('加载')
    firstTimeline.resolve(response({ error: 'read failed' }, 500))
    expect(await screen.findByTestId('traffic-timeline-error')).toHaveAttribute('role', 'alert')
    await userEvent.click(screen.getByRole('button', { name: /重试时间线/ }))
    expect(await screen.findByTestId('traffic-integrity')).toHaveTextContent('不完整')
    expect(screen.getByTestId('traffic-integrity')).toHaveTextContent('截断')

    vi.stubGlobal('fetch', vi.fn(async (url: string) => (
      url === '/api/traces/sessions'
        ? response(SESSIONS)
        : response(timeline('sess-B', {
          total_count: 0,
          returned_count: 0,
          summary: {
            success_count: 0,
            error_count: 0,
            unknown_count: 0,
            total_duration_ms: null,
            input_tokens: null,
            output_tokens: null,
            cached_input_tokens: null,
          },
          entries: [],
        }))
    )))
    renderTraffic()
    const codexButtons = await screen.findAllByRole('button', { name: /codex/ })
    await userEvent.click(codexButtons.at(-1)!)
    expect(await screen.findByTestId('traffic-timeline-empty')).toHaveTextContent('尚无捕获请求')
  })

  it('does not describe a partial window with no visible entries as an empty session', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (
      url === '/api/traces/sessions'
        ? response(SESSIONS)
        : response(timeline('sess-A', {
          total_count: 1,
          returned_count: 0,
          skipped_count: 1,
          truncated: true,
          integrity: 'partial',
          warnings: ['byte-limit'],
          summary: {
            success_count: 0,
            error_count: 0,
            unknown_count: 0,
            total_duration_ms: null,
            input_tokens: null,
            output_tokens: null,
            cached_input_tokens: null,
          },
          entries: [],
        }))
    )))
    renderTraffic()
    await userEvent.click(await screen.findByRole('button', { name: /claude/ }))
    expect(await screen.findByTestId('traffic-timeline-unavailable')).toHaveTextContent('会话并非空')
    expect(screen.queryByTestId('traffic-timeline-empty')).not.toBeInTheDocument()
  })

  it('does not infer an actual token total when one usage direction is unknown', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (
      url === '/api/traces/sessions'
        ? response(SESSIONS)
        : response(timeline('sess-A', {
          summary: {
            success_count: 1,
            error_count: 1,
            unknown_count: 1,
            total_duration_ms: 1625,
            input_tokens: 18,
            output_tokens: null,
            cached_input_tokens: 4,
          },
        }))
    )))
    renderTraffic()
    await userEvent.click(await screen.findByRole('button', { name: /claude/ }))
    expect(await screen.findByTestId('traffic-summary')).toHaveTextContent('实际 Tokens未知')
  })

  it('does not let an older session response overwrite a newer selection', async () => {
    const old = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/traces/sessions') return response(SESSIONS)
      if (url.includes('sess-A')) return old.promise
      return response(timeline('sess-B', {
        total_count: 0,
        returned_count: 0,
        summary: {
          success_count: 0,
          error_count: 0,
          unknown_count: 0,
          total_duration_ms: null,
          input_tokens: null,
          output_tokens: null,
          cached_input_tokens: null,
        },
        entries: [],
      }))
    }))
    renderTraffic()
    await userEvent.click(await screen.findByRole('button', { name: /claude/ }))
    await userEvent.click(screen.getByRole('button', { name: /codex/ }))
    expect(await screen.findByTestId('traffic-timeline-empty')).toBeInTheDocument()
    old.resolve(response(timeline('sess-A')))
    await waitFor(() => expect(screen.queryByTestId('traffic-entry-1')).not.toBeInTheDocument())
  })

  it('distinguishes same-client sessions and keeps full identity accessible', async () => {
    const longSessions = {
      ...SESSIONS,
      sessions: [
        {
          ...SESSIONS.sessions[0],
          id: '12345678-aaaa-bbbb-cccc-1234567890ab',
          client: 'claude',
        },
        {
          ...SESSIONS.sessions[1],
          id: '87654321-dddd-eeee-ffff-ba0987654321',
          client: 'claude',
          proxy_mode: '',
          updated_at: 'invalid',
        },
      ],
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (
      url === '/api/traces/sessions' ? response(longSessions) : response(timeline())
    )))
    renderTraffic()

    const sessionButtons = await screen.findAllByRole('button', { name: /claude/ })
    expect(sessionButtons).toHaveLength(2)
    expect(sessionButtons[0]).toHaveAttribute('title', '12345678-aaaa-bbbb-cccc-1234567890ab')
    expect(sessionButtons[0]).toHaveTextContent('12345678…7890ab')
    expect(sessionButtons[1]).toHaveAttribute('title', '87654321-dddd-eeee-ffff-ba0987654321')
    expect(sessionButtons[1]).toHaveTextContent('未知代理模式')
    expect(sessionButtons[1]).toHaveTextContent('未知')
  })

  it('bounds a long proxy plus maximum-length model and transport metadata without hiding full values', async () => {
    const longProxy = 'p'.repeat(64)
    const longModel = 'm'.repeat(256)
    const longTransport = 't'.repeat(64)
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (
      url === '/api/traces/sessions'
        ? response({
          ...SESSIONS,
          count: 1,
          sessions: [{ ...SESSIONS.sessions[0], proxy_mode: longProxy }],
        })
        : response(timeline('sess-A', {
          entries: [{
            ...((timeline().entries as Record<string, unknown>[])[0]),
            model: longModel,
            transport: longTransport,
          }],
          summary: {
            success_count: 1,
            error_count: 0,
            unknown_count: 0,
            total_duration_ms: 400,
            input_tokens: 18,
            output_tokens: 9,
            cached_input_tokens: 4,
          },
          total_count: 1,
          returned_count: 1,
        }))
    )))
    renderTraffic()

    const sessionButton = await screen.findByRole('button', { name: /claude/ })
    const railProxy = screen.getByTestId('traffic-session-proxy')
    expect(railProxy).toHaveAttribute('title', longProxy)
    expect(railProxy.className).toContain('min-w-0')
    expect(railProxy.className).toContain('truncate')

    await userEvent.click(sessionButton)
    const detailProxy = await screen.findByTestId('traffic-detail-proxy')
    const model = screen.getByTestId('traffic-model-value')
    const transport = screen.getByTestId('traffic-transport-value')
    expect(detailProxy).toHaveAttribute('title', longProxy)
    expect(model).toHaveAttribute('title', longModel)
    expect(transport).toHaveAttribute('title', longTransport)
    expect(model.className).toContain('min-[1024px]:flex-1')
    expect(model.className).toContain('truncate')
    expect(transport.className).toContain('truncate')
  })

  it('Escape closes the timeline and restores focus to the selected session button', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (
      url === '/api/traces/sessions' ? response(SESSIONS) : response(timeline())
    )))
    renderTraffic()
    const sessionButton = await screen.findByRole('button', { name: /claude/ })
    await userEvent.click(sessionButton)
    const errorFilter = await screen.findByRole('button', { name: /失败/ })
    errorFilter.focus()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByTestId('traffic-timeline')).not.toBeInTheDocument()
    expect(screen.getByTestId('traffic-detail-unselected')).toHaveTextContent('选择一个会话')
    expect(sessionButton).toHaveFocus()
  })

  it('does not reopen detail when a timeline response arrives after Escape', async () => {
    const pendingTimeline = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (
      url === '/api/traces/sessions' ? response(SESSIONS) : pendingTimeline.promise
    )))
    renderTraffic()
    const sessionButton = await screen.findByRole('button', { name: /claude/ })
    await userEvent.click(sessionButton)
    expect(screen.getByTestId('traffic-timeline-loading')).toBeInTheDocument()

    await userEvent.keyboard('{Escape}')
    pendingTimeline.resolve(response(timeline()))

    await waitFor(() => expect(screen.getByTestId('traffic-detail-unselected')).toBeInTheDocument())
    expect(screen.queryByTestId('traffic-timeline')).not.toBeInTheDocument()
    expect(sessionButton).toHaveFocus()
  })

  it('renders all new visible copy in English', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (
      url === '/api/traces/sessions'
        ? response({
          ...SESSIONS,
          count: 1,
          sessions: [{ ...SESSIONS.sessions[0], record_count: 1 }],
        })
        : response(timeline('sess-A', {
          integrity: 'partial',
          truncated: true,
          warnings: ['byte-limit'],
        }))
    )))
    renderTraffic('en')
    const sessionButton = await screen.findByRole('button', { name: /claude/ })
    expect(screen.getByTestId('traffic-session-rail')).toHaveAccessibleName('Capture sessions')
    expect(screen.getByTestId('traffic-detail-unselected')).toHaveTextContent('Select a session')
    expect(sessionButton).toHaveTextContent('1 record')
    expect(sessionButton).not.toHaveTextContent('1 records')
    expect(sessionButton).toHaveTextContent('Complete')
    await userEvent.click(sessionButton)
    expect(await screen.findByRole('button', { name: 'Errors' })).toBeInTheDocument()
    expect(screen.getByTestId('traffic-summary')).toHaveTextContent('HTTP errors')
    expect(screen.getByTestId('traffic-integrity')).toHaveTextContent('partial')
    expect(screen.getByRole('button', { name: 'Retry timeline' })).toBeInTheDocument()
  })
})
