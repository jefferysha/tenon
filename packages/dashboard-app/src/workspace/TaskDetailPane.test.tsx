import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { makeChange } from '../testkit'
import type { UserRefView } from '../types'
import { TaskDetailPane, type TaskDetailPaneProps } from './TaskDetailPane'
import type { TaskRow } from './taskModel'

const ann: UserRefView = { id: 'ann@x.io', name: 'Ann', slug: 'ann-at-x.io' }
const bob: UserRefView = { id: 'bob@x.io', name: 'Bob', slug: 'bob-at-x.io' }

const HISTORY = {
  entries: [
    { ts: '2026-09-16T01:00:00Z', kind: 'init', actor: { id: 'ann@x.io', name: 'Ann', trust: 'declared' } },
    { ts: '2026-09-16T02:00:00Z', kind: 'set', field: 'assignee', from: 'Ann <ann@x.io>', to: 'Bob <bob@x.io>', actor: { id: 'bob@x.io', name: 'Bob', trust: 'declared' } },
    { ts: '2026-09-16T03:00:00Z', kind: 'tool', raw: 'Skill: tenon-build' },
  ],
}

function row(owner: UserRefView | null): TaskRow {
  const change = makeChange('x', 'build', { owner })
  return { key: 'x@/repo', root: '/repo', change, rules: undefined, workflow: 'default', archived: false, owner, stages: [], summary: { kind: 'running' } }
}

function stubFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    if (url.startsWith('/api/change/x/history')) return new Response(JSON.stringify(HISTORY), { status: 200 })
    if (url === '/api/change/x/owner' && init?.method === 'POST') {
      return new Response(JSON.stringify({ ok: true, owner: bob, changed: true }), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: false, error: 'not found' }), { status: 404 })
  })
}

function renderPane(props: TaskDetailPaneProps) {
  return render(<I18nProvider><TaskDetailPane {...props} /></I18nProvider>)
}

afterEach(() => {
  vi.restoreAllMocks()
  delete window.__TENON_DASHBOARD_TOKEN__
})

describe('TaskDetailPane owner and records', () => {
  it('another owner + token + selected project shows 接手; clicking posts the owner route and refreshes', async () => {
    const fetchMock = stubFetch()
    window.__TENON_DASHBOARD_TOKEN__ = 'tok'
    const onRefresh = vi.fn()
    const onToast = vi.fn()
    renderPane({ row: row(ann), me: bob, onRefresh, onToast })
    expect(screen.getByTestId('task-detail-meta')).toHaveTextContent('Ann')
    await userEvent.click(screen.getByTestId('task-detail-take'))
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1))
    const post = fetchMock.mock.calls.find(([url, init]) => String(url) === '/api/change/x/owner' && init?.method === 'POST')
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ root: '/repo' })
    expect(onToast).toHaveBeenCalledWith('已接手')
  })

  it('hides 接手 for the owner, in the aggregate view, and without a token', () => {
    stubFetch()
    window.__TENON_DASHBOARD_TOKEN__ = 'tok'
    const own = renderPane({ row: row(bob), me: bob })
    expect(screen.queryByTestId('task-detail-take')).toBeNull()
    own.unmount()
    const aggregate = renderPane({ row: row(ann), me: bob, fetchDefinition: false })
    expect(screen.queryByTestId('task-detail-take')).toBeNull()
    expect(screen.queryByTestId('task-records')).toBeNull()
    aggregate.unmount()
    delete window.__TENON_DASHBOARD_TOKEN__
    renderPane({ row: row(ann), me: bob })
    expect(screen.queryByTestId('task-detail-take')).toBeNull()
  })

  it('记录 lists operator records with their actor names and skips host evidence rows', async () => {
    stubFetch()
    renderPane({ row: row(bob), me: bob })
    const records = await screen.findByTestId('task-records')
    expect([...records.querySelectorAll('li')].map((item) => item.getAttribute('data-kind'))).toEqual(['init', 'set'])
    expect([...records.querySelectorAll('[data-testid="task-record-actor"]')].map((item) => item.textContent)).toEqual(['Ann', 'Bob'])
    expect(records).toHaveTextContent('负责人 Bob')
  })
})
